const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_RATE_LIMIT_CAPACITY = 10_000;

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
  requestId: string;
};

export type ApiResponseOptions = {
  status?: number;
  headers?: HeadersInit;
  requestId?: string;
};

/** Create a server-owned correlation ID. Never use a caller-supplied ID as an audit identifier. */
export function createRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Return JSON with cache prevention and a correlation header suitable for API
 * responses containing contract metadata. The request ID is also returned so
 * support can correlate a public error with redacted server telemetry.
 */
export function apiJson<T>(payload: T, options: ApiResponseOptions = {}): Response {
  const requestId = options.requestId ?? createRequestId();
  const headers = new Headers(options.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Request-Id", requestId);

  return Response.json(payload, {
    status: options.status ?? 200,
    headers,
  });
}

export function apiError(
  code: string,
  message: string,
  options: ApiResponseOptions & { status: number },
): Response {
  const requestId = options.requestId ?? createRequestId();
  return apiJson<ApiErrorBody>(
    {
      error: { code, message },
      requestId,
    },
    { ...options, requestId },
  );
}

/**
 * Convert an unexpected exception into a generic response without exposing a
 * database error, stack, object key, token, or document content. The default
 * diagnostic intentionally records only the exception class. A production
 * logger may record richer redacted fields in its protected telemetry sink.
 */
export function safeInternalError(
  error: unknown,
  options: {
    requestId?: string;
    publicMessage?: string;
    onDiagnostic?: (diagnostic: { requestId: string; errorType: string }) => void;
  } = {},
): Response {
  const requestId = options.requestId ?? createRequestId();
  const diagnostic = {
    requestId,
    errorType: error instanceof Error ? error.name : typeof error,
  };

  if (options.onDiagnostic) {
    options.onDiagnostic(diagnostic);
  } else {
    console.error("API request failed", diagnostic);
  }

  return apiError(
    "internal_error",
    options.publicMessage ?? "The request could not be completed.",
    { status: 500, requestId },
  );
}

export type MutationGuardOptions = {
  /** Additional exact browser origins. Keep empty for a same-origin application. */
  allowedOrigins?: readonly string[];
  /**
   * Validate a session-bound anti-CSRF token from X-CSRF-Token. Supply this for
   * cookie-authenticated mutations; origin checking is retained as defense in depth.
   */
  validateCsrfToken?: (token: string | null, request: Request) => boolean | Promise<boolean>;
  requestId?: string;
};

export type MutationGuardResult =
  | { ok: true; requestId: string }
  | { ok: false; requestId: string; response: Response };

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Fail closed for browser mutations whose Origin does not exactly match the
 * request origin (or an explicitly configured origin). Token-authenticated
 * machine APIs should use a separate authentication path, not disable this
 * check globally.
 */
export async function guardMutationRequest(
  request: Request,
  options: MutationGuardOptions = {},
): Promise<MutationGuardResult> {
  const requestId = options.requestId ?? createRequestId();
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true, requestId };

  const requestOrigin = new URL(request.url).origin;
  const explicitAllowedOrigins = new Set(
    (options.allowedOrigins ?? [])
      .map(normalizedOrigin)
      .filter((origin): origin is string => origin !== null),
  );
  const origin = request.headers.get("origin");
  const normalizedRequestOrigin = origin ? normalizedOrigin(origin) : null;
  const originAllowed =
    normalizedRequestOrigin === requestOrigin ||
    (normalizedRequestOrigin !== null && explicitAllowedOrigins.has(normalizedRequestOrigin));

  if (!originAllowed) {
    return {
      ok: false,
      requestId,
      response: apiError("invalid_origin", "The request origin is not allowed.", { status: 403, requestId }),
    };
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" && (normalizedRequestOrigin === null || !explicitAllowedOrigins.has(normalizedRequestOrigin))) {
    return {
      ok: false,
      requestId,
      response: apiError("cross_site_request", "Cross-site requests are not allowed.", { status: 403, requestId }),
    };
  }

  if (options.validateCsrfToken) {
    const valid = await options.validateCsrfToken(request.headers.get("x-csrf-token"), request);
    if (!valid) {
      return {
        ok: false,
        requestId,
        response: apiError("invalid_csrf_token", "The request could not be verified.", { status: 403, requestId }),
      };
    }
  }

  return { ok: true, requestId };
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  /** Bound isolate memory; this does not change the distributed-control requirement. */
  capacity?: number;
  now?: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

function sweepRateLimitBuckets(now: number, capacity: number) {
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }

  while (rateLimitBuckets.size >= capacity) {
    const oldestKey = rateLimitBuckets.keys().next().value as string | undefined;
    if (!oldestKey) break;
    rateLimitBuckets.delete(oldestKey);
  }
}

/**
 * Best-effort defense in depth only. Worker/isolate memory is neither shared nor
 * durable, so this MUST be paired with a distributed edge/WAF rate limit keyed
 * by verified tenant and subject (plus IP where appropriate).
 */
export function checkBestEffortRateLimit(key: string, options: RateLimitOptions): RateLimitDecision {
  if (!key.trim()) throw new Error("A non-empty rate-limit key is required");
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("Rate-limit limit must be a positive integer");
  if (!Number.isFinite(options.windowMs) || options.windowMs < 1_000) throw new Error("Rate-limit window must be at least one second");

  const now = options.now ?? Date.now();
  const capacity = options.capacity !== undefined && Number.isFinite(options.capacity)
    ? Math.max(1, Math.floor(options.capacity))
    : DEFAULT_RATE_LIMIT_CAPACITY;
  let bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && rateLimitBuckets.size >= capacity) sweepRateLimitBuckets(now, capacity);
    bucket = { count: 0, resetAt: now + options.windowMs };
  }

  bucket.count += 1;
  // Refresh insertion order so capacity eviction approximates least recently used.
  rateLimitBuckets.delete(key);
  rateLimitBuckets.set(key, bucket);

  const allowed = bucket.count <= options.limit;
  return {
    allowed,
    limit: options.limit,
    remaining: Math.max(0, options.limit - bucket.count),
    resetAt: bucket.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
  };
}

export function rateLimitHeaders(decision: RateLimitDecision): Headers {
  return new Headers({
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(Math.ceil(decision.resetAt / 1_000)),
  });
}

export function rateLimitExceeded(decision: RateLimitDecision, requestId = createRequestId()): Response {
  const headers = rateLimitHeaders(decision);
  headers.set("Retry-After", String(decision.retryAfterSeconds));
  return apiError("rate_limit_exceeded", "Too many requests. Try again later.", {
    status: 429,
    requestId,
    headers,
  });
}

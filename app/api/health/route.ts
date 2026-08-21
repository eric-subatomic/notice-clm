import { env } from "cloudflare:workers";
import { NOTICE_SCHEMA_MARKER_ID, NOTICE_SCHEMA_VERSION } from "../../../db/schema-guard";
import { apiJson, createRequestId } from "../../lib/http";

type HealthEnv = {
  DB?: {
    prepare(query: string): { first<T = unknown>(): Promise<T | null> };
  };
  DOCUMENTS?: {
    head(key: string): Promise<unknown>;
  };
};

const READINESS_TIMEOUT_MS = 1_500;
const HEALTHCHECK_OBJECT_KEY = "_notice/healthcheck";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Health check timed out")), timeoutMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function isReady(): Promise<boolean> {
  const bindings = env as unknown as HealthEnv;
  if (!bindings.DB || !bindings.DOCUMENTS) return false;

  try {
    const [schemaMarker] = await withTimeout(
      Promise.all([
        bindings.DB.prepare(
          `SELECT version FROM notice_schema_state WHERE id = '${NOTICE_SCHEMA_MARKER_ID}' AND version = ${NOTICE_SCHEMA_VERSION} LIMIT 1`,
        ).first(),
        // A missing sentinel object is a successful R2 read. No customer object
        // name, document content, bucket identifier, or credential is exposed.
        bindings.DOCUMENTS.head(HEALTHCHECK_OBJECT_KEY),
      ]),
      READINESS_TIMEOUT_MS,
    );
    return Boolean(schemaMarker);
  } catch {
    return false;
  }
}

async function healthResponse(request: Request, includeBody: boolean): Promise<Response> {
  const requestId = createRequestId();
  const mode = new URL(request.url).searchParams.get("mode") === "ready" ? "readiness" : "liveness";
  const healthy = mode === "liveness" || await isReady();
  const status = healthy ? 200 : 503;
  const payload = {
    status: healthy ? "ok" : "unavailable",
    check: mode,
    checkedAt: new Date().toISOString(),
    requestId,
  } as const;

  if (includeBody) return apiJson(payload, { status, requestId });

  const probe = apiJson(payload, { status, requestId });
  return new Response(null, { status, headers: probe.headers });
}

/** Liveness is dependency-free. Use `?mode=ready` to verify D1 and R2 access. */
export async function GET(request: Request) {
  return healthResponse(request, true);
}

export async function HEAD(request: Request) {
  return healthResponse(request, false);
}

export const dynamic = "force-dynamic";

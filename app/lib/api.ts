import { NoticeAuthError, requirePermission, type Permission, type PermissionContext } from "./auth";
import { StorageSchemaError } from "../../db/schema-guard";
import { NoticeConfigurationError } from "./config";
import { DocumentSecurityError } from "./document-security";
import { isOptimisticConcurrencyConflict } from "./persistence";
import {
  apiError,
  apiJson,
  checkBestEffortRateLimit,
  createRequestId,
  guardMutationRequest,
  rateLimitExceeded,
  rateLimitHeaders,
  safeInternalError,
} from "./http";
import { RequestValidationError } from "./validation";

export type AuthorizedApiRequest = {
  ok: true;
  context: PermissionContext;
  requestId: string;
  headers: Headers;
};

export type RejectedApiRequest = { ok: false; response: Response };

export async function authorizeApiRequest(
  request: Request,
  permission: Permission,
  options: { limit?: number; windowMs?: number; guardOrigin?: boolean } = {},
): Promise<AuthorizedApiRequest | RejectedApiRequest> {
  const requestId = createRequestId();
  try {
    if (options.guardOrigin !== false) {
      const guard = await guardMutationRequest(request, { requestId });
      if (!guard.ok) return { ok: false, response: guard.response };
    }

    const context = await requirePermission(request, permission);
    const url = new URL(request.url);
    const decision = checkBestEffortRateLimit(
      `${context.workspace.id}:${context.user.id}:${request.method}:${url.pathname}`,
      { limit: options.limit ?? (request.method === "GET" ? 240 : 60), windowMs: options.windowMs ?? 60_000 },
    );
    if (!decision.allowed) return { ok: false, response: rateLimitExceeded(decision, requestId) };
    return { ok: true, context, requestId, headers: rateLimitHeaders(decision) };
  } catch (error) {
    return { ok: false, response: handleRouteError(error, requestId) };
  }
}

export function handleRouteError(error: unknown, requestId = createRequestId(), publicMessage?: string): Response {
  if (error instanceof RequestValidationError) {
    return apiJson({
      error: { code: error.code, message: error.message },
      issues: error.issues,
      requestId,
    }, { status: error.status, requestId });
  }
  if (error instanceof DocumentSecurityError) {
    return apiError(error.code, error.message, { status: error.status, requestId });
  }
  if (error instanceof NoticeAuthError) {
    return apiError(error.code.toLowerCase(), error.message, { status: error.status, requestId });
  }
  if (error instanceof StorageSchemaError) {
    return apiError("schema_incomplete", "Notice storage migrations are incomplete for this application revision.", { status: 503, requestId });
  }
  if (error instanceof NoticeConfigurationError) {
    return apiError("configuration_incomplete", "Notice is not configured for secure access.", { status: 503, requestId });
  }
  if (isOptimisticConcurrencyConflict(error)) {
    return apiError("version_conflict", "This record changed while the request was being saved. Reload before retrying.", { status: 409, requestId });
  }
  return safeInternalError(error, { requestId, publicMessage });
}

export function withResponseHeaders(response: Response, headers: Headers): Response {
  const merged = new Headers(response.headers);
  headers.forEach((value, key) => merged.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

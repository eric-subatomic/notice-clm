import { getPermissionContext, NoticeAuthError } from "../../lib/auth";
import { NoticeConfigurationError } from "../../lib/config";
import { StorageSchemaError } from "../../../db/schema-guard";

const responseHeaders = {
  "cache-control": "no-store, private",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

/** Returns only non-secret, server-authoritative session and permission data. */
export async function GET(request: Request) {
  try {
    const context = await getPermissionContext(request);
    return json({
      mode: context.mode,
      identitySource: context.identitySource,
      workspace: context.workspace,
      user: context.user,
      role: context.role,
      permissions: Array.from(context.permissions),
    });
  } catch (error) {
    if (error instanceof NoticeAuthError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof NoticeConfigurationError) {
      console.error("Notice production configuration is incomplete", { code: error.code });
      return json({ error: "Notice is not configured for secure access.", code: error.code }, 503);
    }
    if (error instanceof StorageSchemaError) {
      console.error("Notice storage migrations are incomplete", { code: error.code });
      return json({ error: "Notice storage migrations are incomplete for this application revision.", code: error.code }, error.status);
    }
    console.error("Unable to resolve Notice session", {
      errorKind: error instanceof Error ? "error" : typeof error,
    });
    return json({ error: "Unable to establish a secure session.", code: "SESSION_UNAVAILABLE" }, 503);
  }
}

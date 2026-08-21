import { env } from "cloudflare:workers";
import { and, eq, exists, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agreements, documents, negotiationSubmissions } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { apiError } from "../../../lib/http";
import { getNoticeConfig } from "../../../lib/config";
import { isDocumentReadable } from "../../../lib/document-access";
import { sha256Hex } from "../../../lib/document-security";

type DocumentEnv = { DOCUMENTS: R2Bucket };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "document:read");
  if (!auth.ok) return auth.response;
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("document_not_found", "Document was not found.", { status: 404, requestId: auth.requestId });
    await ensureStorageSchema();
    const db = getDb();
    const [document] = await db.select().from(documents).where(and(
      eq(documents.workspaceId, auth.context.workspace.id),
      eq(documents.id, id),
      isNull(documents.deletedAt),
      or(
        isNull(documents.agreementId),
        exists(db.select({ id: agreements.id }).from(agreements).where(and(
          eq(agreements.workspaceId, auth.context.workspace.id),
          eq(agreements.id, documents.agreementId),
          isNull(agreements.deletedAt),
        ))),
      ),
    )).limit(1);
    if (!document || !isDocumentReadable(document.scanStatus, getNoticeConfig().mode)) {
      return apiError("document_not_found", "Document was not found.", { status: 404, requestId: auth.requestId });
    }
    // A clean scanner verdict is necessary but not sufficient for an immutable
    // counterparty return. A freshly rescanned object remains quarantined at the
    // business layer until an authenticated reviewer marks that exact submission
    // ready. Requiring the complete D1 lineage here also fails closed if a return
    // row is ever orphaned from its submission record.
    if (document.role === "counterparty_return") {
      if (document.agreementId === null || document.negotiationRoundId === null || document.direction !== "inbound") {
        return apiError("document_not_found", "Document was not found.", { status: 404, requestId: auth.requestId });
      }
      const [eligibleSubmission] = await db.select({ id: negotiationSubmissions.id }).from(negotiationSubmissions).where(and(
        eq(negotiationSubmissions.workspaceId, auth.context.workspace.id),
        eq(negotiationSubmissions.agreementId, document.agreementId),
        eq(negotiationSubmissions.roundId, document.negotiationRoundId),
        eq(negotiationSubmissions.documentId, document.id),
        eq(negotiationSubmissions.documentSha256, document.sha256),
        inArray(negotiationSubmissions.status, ["sender_review", "ready", "promoted", "late"]),
      )).limit(1);
      if (!eligibleSubmission) {
        return apiError("document_not_found", "Document was not found.", { status: 404, requestId: auth.requestId });
      }
    }
    const object = await (env as unknown as DocumentEnv).DOCUMENTS.get(document.objectKey);
    if (!object) return apiError("document_bytes_missing", "Document content is unavailable.", { status: 410, requestId: auth.requestId });
    const bytes = new Uint8Array(await object.arrayBuffer());
    const actualSha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== document.size || actualSha256 !== document.sha256) {
      return apiError("document_integrity_failure", "Document content failed its saved size or SHA-256 integrity check.", {
        status: 409,
        requestId: auth.requestId,
      });
    }
    const encodedName = encodeURIComponent(document.fileName).replaceAll("'", "%27");
    const headers = new Headers(auth.headers);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("Content-Type", document.contentType);
    headers.set("Content-Length", String(bytes.byteLength));
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`);
    headers.set("Content-Security-Policy", "sandbox");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Document-SHA256", document.sha256);
    headers.set("X-Request-Id", auth.requestId);
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    return new Response(Uint8Array.from(bytes).buffer, { status: 200, headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Document could not be downloaded.");
  }
}

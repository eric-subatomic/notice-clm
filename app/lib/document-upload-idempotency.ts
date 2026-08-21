import { normalizedDocumentName, sha256Hex } from "./document-security";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const DOCUMENT_UPLOAD_RETENTION_DAYS = 7;
export const DOCUMENT_UPLOAD_RETENTION_MS = DOCUMENT_UPLOAD_RETENTION_DAYS * 86_400_000;

export function canonicalDocumentUploadIdempotencyKey(value: string | null): string | null {
  if (value === null || !CANONICAL_UUID.test(value)) return null;
  return value;
}

/**
 * The durable lookup value is one-way and bound to both authenticated scopes.
 * The caller's UUID is never persisted or returned by the upload endpoint.
 */
export function documentUploadKeyDigest(input: Readonly<{
  workspaceId: string;
  userId: string;
  idempotencyKey: string;
}>): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify({
    schema: "notice.document-upload-key.v1",
    workspaceId: input.workspaceId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
  })));
}

/**
 * Multipart framing and caller-provided MIME labels are deliberately excluded.
 * The semantic file identity is the normalized stored name, exact byte count,
 * and SHA-256 of the bytes that passed document inspection.
 */
export function documentUploadRequestDigest(input: Readonly<{
  fileName: string;
  size: number;
  sha256: string;
}>): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify({
    schema: "notice.document-upload-request.v1",
    fileName: normalizedDocumentName(input.fileName),
    size: input.size,
    sha256: input.sha256,
  })));
}

export function documentUploadExpiresAt(now: Date): string {
  return new Date(now.getTime() + DOCUMENT_UPLOAD_RETENTION_MS).toISOString();
}

export type DocumentUploadLinkReceiptState = "legacy-receiptless" | "staging" | "expired" | "reserved";

/**
 * Receiptless sources are the bounded compatibility case for v13 imports.
 * Keep this decision explicit: optional chaining combined with `!== null`
 * treats an absent receipt as present because `undefined !== null`.
 */
export function documentUploadLinkReceiptState(
  receipt: Readonly<{ expiresAt: string; linkedAt: string | null }> | null,
  nowIso: string,
): DocumentUploadLinkReceiptState {
  if (receipt === null) return "legacy-receiptless";
  if (receipt.linkedAt !== null) return "reserved";
  return receipt.expiresAt <= nowIso ? "expired" : "staging";
}

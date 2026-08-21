import { inspectDocument, sha256Hex, type SupportedDocument } from "./document-security";

type StoredDocumentObject = Readonly<{
  size: number;
  httpMetadata?: Readonly<{ contentType?: string }>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

type StoredDocumentExpectation = Readonly<{
  fileName: string;
  size: number;
  contentType: string;
  sha256: string;
}>;

export type StoredDocumentIntegrityResult =
  | Readonly<{ ok: true; bytes: Uint8Array; inspected: SupportedDocument }>
  | Readonly<{ ok: false; reason: "metadata" | "digest" | "signature" }>;

/**
 * Re-establishes the exact D1/R2 trust boundary before bytes covered by an
 * earlier scanner verdict can become governed working paper.
 */
export async function verifyStoredDocumentSource(
  object: StoredDocumentObject,
  expected: StoredDocumentExpectation,
): Promise<StoredDocumentIntegrityResult> {
  if (object.size !== expected.size || object.httpMetadata?.contentType !== expected.contentType) {
    return { ok: false, reason: "metadata" };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== expected.size || await sha256Hex(bytes) !== expected.sha256) {
    return { ok: false, reason: "digest" };
  }
  try {
    const inspected = inspectDocument(bytes, expected.fileName);
    if (inspected.contentType !== expected.contentType) return { ok: false, reason: "signature" };
    return { ok: true, bytes, inspected };
  } catch {
    return { ok: false, reason: "signature" };
  }
}

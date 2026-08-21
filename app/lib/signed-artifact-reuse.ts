import { isWorkspaceObjectKey } from "./records-governance";

export type SignedArtifactReuseScope = {
  workspaceId: string;
  agreementId: number;
  sha256: string;
  providerMessageId: string;
  parentSha256: string;
};

export type SignedArtifactReuseCandidate = {
  id: string;
  workspaceId: string;
  agreementId: number | null;
  sha256: string;
  objectKey: string;
  size: number;
  scanStatus: string;
  deletedAt: string | null;
  role: string;
  direction: string;
  providerMessageId: string | null;
  parentSha256: string | null;
};

type StoredArtifactBody = {
  size: number;
  customMetadata?: Record<string, string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

/**
 * Reuse is deliberately fail-closed: a database hash match is not evidence by
 * itself. The row must still be clean and live in the same tenant/agreement,
 * and the referenced R2 object must still exist with compatible metadata and
 * exact bytes. A HEAD response is not enough for retained signature evidence:
 * stale metadata on a same-size object must never activate an agreement.
 */
export async function findReusableSignedArtifact<T extends SignedArtifactReuseCandidate>(
  candidates: readonly T[],
  scope: SignedArtifactReuseScope,
  getObject: (objectKey: string) => Promise<StoredArtifactBody | null>,
): Promise<T | null> {
  for (const candidate of candidates) {
    if (
      candidate.workspaceId !== scope.workspaceId
      || candidate.agreementId !== scope.agreementId
      || candidate.sha256 !== scope.sha256
      || candidate.role !== "signed_artifact"
      || candidate.direction !== "inbound"
      || candidate.providerMessageId !== scope.providerMessageId
      || candidate.parentSha256 !== scope.parentSha256
      || candidate.scanStatus !== "clean"
      || candidate.deletedAt !== null
      || !isWorkspaceObjectKey(scope.workspaceId, candidate.objectKey)
    ) continue;

    let stored: StoredArtifactBody | null;
    try {
      stored = await getObject(candidate.objectKey);
    } catch {
      stored = null;
    }
    if (!stored || candidate.size <= 0 || stored.size !== candidate.size) continue;
    if (stored.customMetadata?.sha256 && stored.customMetadata.sha256 !== scope.sha256) continue;
    if (stored.customMetadata?.documentId && stored.customMetadata.documentId !== candidate.id) continue;
    if (stored.customMetadata?.source && stored.customMetadata.source !== "docuseal-signed-artifact") continue;
    if (stored.customMetadata?.scanStatus && stored.customMetadata.scanStatus !== "clean") continue;
    try {
      const bytes = await stored.arrayBuffer();
      if (bytes.byteLength !== candidate.size || await sha256Hex(bytes) !== scope.sha256) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

import { and, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { agreementDocumentVersions, documents, negotiationSubmissions, purgeJobs } from "../../db/schema";

type Database = ReturnType<typeof getDb>;
type ObjectStore = Pick<R2Bucket, "delete">;

export type StagedObjectIdentity = Readonly<{
  workspaceId: string;
  id: string;
  objectKey: string;
  sha256: string;
}>;

export type StagedObjectCleanupDisposition =
  | "deleted-uncommitted"
  | "retained-authoritative"
  | "retained-unknown";

/**
 * Cleanup for an R2 write followed by an ambiguous D1 outcome.
 *
 * The lookup must positively prove that the exact staged object is absent before
 * deletion is attempted. A failed lookup is an unknown commit state, so the
 * bytes are retained for reconciliation.
 */
export async function cleanupIfDefinitelyUncommitted(input: Readonly<{
  isAuthoritative: () => Promise<boolean>;
  deleteObject: () => Promise<unknown>;
  recordDeleteFailure?: () => Promise<unknown>;
}>): Promise<StagedObjectCleanupDisposition> {
  let authoritative: boolean;
  try {
    authoritative = await input.isAuthoritative();
  } catch {
    return "retained-unknown";
  }

  if (authoritative) return "retained-authoritative";
  try {
    await input.deleteObject();
    return "deleted-uncommitted";
  } catch {
    try { await input.recordDeleteFailure?.(); } catch { /* retain for operator reconciliation if D1 is also unavailable */ }
    return "retained-unknown";
  }
}

async function recordDurableStagedCleanup(db: Database, candidate: StagedObjectIdentity): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(purgeJobs).values({
    id,
    workspaceId: candidate.workspaceId,
    resourceType: "document",
    resourceId: `staged:${candidate.id}:${id}`,
    objectKeys: [candidate.objectKey],
    status: "storage_pending",
    guardChanges: 1,
    attempts: 0,
    lastError: "Immediate staged-object deletion failed; durable retry required.",
    lastAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
}

export function cleanupStagedDocumentObject(
  db: Database,
  bucket: ObjectStore,
  candidate: StagedObjectIdentity,
): Promise<StagedObjectCleanupDisposition> {
  return cleanupIfDefinitelyUncommitted({
    isAuthoritative: async () => {
      const [row] = await db.select({ id: documents.id }).from(documents).where(and(
        eq(documents.workspaceId, candidate.workspaceId),
        eq(documents.id, candidate.id),
        eq(documents.objectKey, candidate.objectKey),
        eq(documents.sha256, candidate.sha256),
      )).limit(1);
      return Boolean(row);
    },
    deleteObject: () => bucket.delete(candidate.objectKey),
    recordDeleteFailure: () => recordDurableStagedCleanup(db, candidate),
  });
}

export function cleanupStagedWorkingVersionObject(
  db: Database,
  bucket: ObjectStore,
  candidate: StagedObjectIdentity,
): Promise<StagedObjectCleanupDisposition> {
  return cleanupIfDefinitelyUncommitted({
    isAuthoritative: async () => {
      const [row] = await db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, candidate.workspaceId),
        eq(agreementDocumentVersions.id, candidate.id),
        eq(agreementDocumentVersions.objectKey, candidate.objectKey),
        eq(agreementDocumentVersions.sha256, candidate.sha256),
      )).limit(1);
      return Boolean(row);
    },
    deleteObject: () => bucket.delete(candidate.objectKey),
    recordDeleteFailure: () => recordDurableStagedCleanup(db, candidate),
  });
}

export function cleanupStagedReviewTextObject(
  db: Database,
  bucket: ObjectStore,
  candidate: StagedObjectIdentity,
): Promise<StagedObjectCleanupDisposition> {
  return cleanupIfDefinitelyUncommitted({
    isAuthoritative: async () => {
      const [row] = await db.select({ id: negotiationSubmissions.id }).from(negotiationSubmissions).where(and(
        eq(negotiationSubmissions.workspaceId, candidate.workspaceId),
        eq(negotiationSubmissions.reviewTextObjectKey, candidate.objectKey),
        eq(negotiationSubmissions.reviewTextSha256, candidate.sha256),
      )).limit(1);
      return Boolean(row);
    },
    deleteObject: () => bucket.delete(candidate.objectKey),
    recordDeleteFailure: () => recordDurableStagedCleanup(db, candidate),
  });
}

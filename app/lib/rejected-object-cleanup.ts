import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { agreements, documents, purgeJobs } from "../../db/schema";
import { REJECTED_OBJECT_DELETE_CLAIM, type PurgeStorageJob } from "./purge-storage";

type Database = ReturnType<typeof getDb>;

export type RejectedObjectCleanupPolicy =
  | { action: "allow"; resourceId: string; reason: "" }
  | { action: "defer"; resourceId: string; reason: string };

/**
 * Atomically reserve deletion only while both the rejected document and its
 * durable target-agreement policy remain unheld. Agreement/document hold
 * mutations fence on the same claim marker before they can report success.
 */
export async function claimRejectedObjectCleanup(
  db: Database,
  job: PurgeStorageJob,
): Promise<boolean> {
  const rejectedMatch = /^rejected:([^:]+):[^:]+$/.exec(job.resourceId);
  if (!rejectedMatch) return true;
  const documentId = rejectedMatch[1];
  const claimedAt = new Date().toISOString();
  const claimed = await db.update(purgeJobs).set({
    lastError: REJECTED_OBJECT_DELETE_CLAIM,
    lastAttemptAt: claimedAt,
    updatedAt: claimedAt,
  }).where(and(
    eq(purgeJobs.workspaceId, job.workspaceId),
    eq(purgeJobs.id, job.id),
    eq(purgeJobs.status, "storage_pending"),
    or(
      sql`${purgeJobs.lastError} <> ${REJECTED_OBJECT_DELETE_CLAIM}`,
      isNull(purgeJobs.lastError),
    ),
    sql`exists (
      select 1 from documents as rejected_cleanup_document
      where rejected_cleanup_document.workspace_id = ${job.workspaceId}
        and rejected_cleanup_document.id = ${documentId}
        and rejected_cleanup_document.scan_status = 'rejected'
        and rejected_cleanup_document.deleted_at is not null
        and rejected_cleanup_document.legal_hold = 0
        and json_array_length(${purgeJobs.objectKeys}) = 1
        and json_extract(${purgeJobs.objectKeys}, '$[0]') = rejected_cleanup_document.object_key
        and (
          rejected_cleanup_document.agreement_id is null
          or exists (
            select 1 from agreements as rejected_cleanup_parent
            where rejected_cleanup_parent.workspace_id = ${job.workspaceId}
              and rejected_cleanup_parent.id = rejected_cleanup_document.agreement_id
              and rejected_cleanup_parent.legal_hold = 0
          )
        )
    )`,
  ));
  return Boolean(claimed.meta.changes);
}

/** Fresh policy read used before both claim and the eventual R2 delete. */
export async function assessRejectedObjectCleanupPolicy(
  db: Database,
  job: PurgeStorageJob,
): Promise<RejectedObjectCleanupPolicy | null> {
  const rejectedMatch = /^rejected:([^:]+):[^:]+$/.exec(job.resourceId);
  if (!rejectedMatch) return null;
  const documentId = rejectedMatch[1];
  const [document] = await db.select({
    id: documents.id,
    agreementId: documents.agreementId,
    objectKey: documents.objectKey,
    scanStatus: documents.scanStatus,
    legalHold: documents.legalHold,
    deletedAt: documents.deletedAt,
  }).from(documents).where(and(
    eq(documents.workspaceId, job.workspaceId),
    eq(documents.id, documentId),
  )).limit(1);
  // A later guarded hard purge may already have removed the rejected row and
  // produced its own manifest. Deleting the still-listed exact object is safe.
  if (!document) return { action: "allow", resourceId: documentId, reason: "" };
  if (!Array.isArray(job.objectKeys) || job.objectKeys.length !== 1 || job.objectKeys[0] !== document.objectKey) {
    return { action: "defer", resourceId: documentId, reason: "rejected-document cleanup manifest no longer matches the authoritative object" };
  }
  if (document.scanStatus !== "rejected" || !document.deletedAt) {
    return { action: "defer", resourceId: documentId, reason: "document is no longer eligible for rejected-object cleanup" };
  }
  if (document.legalHold) {
    return { action: "defer", resourceId: documentId, reason: "document legal hold is active" };
  }
  if (document.agreementId) {
    const [parent] = await db.select({ legalHold: agreements.legalHold }).from(agreements).where(and(
      eq(agreements.workspaceId, job.workspaceId),
      eq(agreements.id, document.agreementId),
    )).limit(1);
    if (!parent) {
      return { action: "defer", resourceId: documentId, reason: "linked agreement policy is unavailable" };
    }
    if (parent.legalHold) {
      return { action: "defer", resourceId: documentId, reason: "agreement legal hold is active" };
    }
  }
  return { action: "allow", resourceId: documentId, reason: "" };
}

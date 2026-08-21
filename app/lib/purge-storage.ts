import { isWorkspaceObjectKey } from "./records-governance";

export type PurgeStorageJob = Readonly<{
  id: string;
  workspaceId: string;
  resourceType: "agreement" | "document";
  resourceId: string;
  objectKeys: unknown;
  attempts: number;
}>;

type StorageAttemptUpdate = Readonly<{
  attempts: number;
  attemptedAt: string;
  lastError: string | null;
  completedAt: string | null;
}>;

export type PurgeStorageActions = Readonly<{
  deleteObjects: (objectKeys: readonly string[]) => Promise<void>;
  markCompleted: (update: StorageAttemptUpdate) => Promise<void>;
  markPending: (update: StorageAttemptUpdate) => Promise<void>;
}>;

export type PurgeStorageAttemptResult = Readonly<{
  jobId: string;
  resourceType: "agreement" | "document";
  resourceId: string;
  status: "completed" | "storage_pending";
  attempts: number;
}>;

export const INVALID_PURGE_MANIFEST_ERROR = "Storage purge manifest failed workspace validation.";
export const PURGE_STORAGE_RETRY_ERROR = "Object storage deletion did not complete; retry is required.";
export const REJECTED_OBJECT_DELETE_CLAIM = "Rejected object storage deletion is in progress.";

function validatedObjectKeys(workspaceId: string, value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) return null;
  const keys = Array.from(new Set(value as string[]));
  return keys.every((key) => isWorkspaceObjectKey(workspaceId, key)) ? keys : null;
}

/**
 * Execute only the storage half of a D1-committed purge. Failures update the
 * durable manifest but never attempt to recreate the already-purged D1 rows.
 */
export async function attemptPurgeStorage(
  job: PurgeStorageJob,
  actions: PurgeStorageActions,
  now = new Date(),
): Promise<PurgeStorageAttemptResult> {
  const attempts = job.attempts + 1;
  const attemptedAt = now.toISOString();
  const objectKeys = validatedObjectKeys(job.workspaceId, job.objectKeys);

  if (!objectKeys) {
    await actions.markPending({ attempts, attemptedAt, lastError: INVALID_PURGE_MANIFEST_ERROR, completedAt: null });
    return { jobId: job.id, resourceType: job.resourceType, resourceId: job.resourceId, status: "storage_pending", attempts };
  }

  try {
    if (objectKeys.length > 0) await actions.deleteObjects(objectKeys);
    await actions.markCompleted({ attempts, attemptedAt, lastError: null, completedAt: attemptedAt });
    return { jobId: job.id, resourceType: job.resourceType, resourceId: job.resourceId, status: "completed", attempts };
  } catch {
    await actions.markPending({ attempts, attemptedAt, lastError: PURGE_STORAGE_RETRY_ERROR, completedAt: null });
    return { jobId: job.id, resourceType: job.resourceType, resourceId: job.resourceId, status: "storage_pending", attempts };
  }
}

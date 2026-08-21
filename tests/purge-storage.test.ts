import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  attemptPurgeStorage,
  INVALID_PURGE_MANIFEST_ERROR,
  PURGE_STORAGE_RETRY_ERROR,
  type PurgeStorageJob,
} from "../app/lib/purge-storage";
import { purgeJobs } from "../db/schema";

const job: PurgeStorageJob = {
  id: "purge-1",
  workspaceId: "workspace-a",
  resourceType: "document",
  resourceId: "document-a",
  objectKeys: ["workspaces/workspace-a/documents/document-a.pdf"],
  attempts: 2,
};

test("the durable manifest insert preserves SQLite changes() as a CHECK guard", () => {
  const query = drizzle({} as D1Database).insert(purgeJobs).values({
    id: job.id,
    workspaceId: job.workspaceId,
    resourceType: job.resourceType,
    resourceId: job.resourceId,
    objectKeys: job.objectKeys as string[],
    status: "storage_pending",
    guardChanges: sql<number>`changes()`,
    attempts: 0,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
  }).toSQL();

  assert.match(query.sql, /"guard_changes"[\s\S]*values \([\s\S]*changes\(\)/i);
  assert.equal(query.params.includes("changes()"), false);
});

test("storage purge deletes only validated workspace keys before completing the durable job", async () => {
  const calls: string[] = [];
  const result = await attemptPurgeStorage(job, {
    deleteObjects: async (keys) => { calls.push(`delete:${keys.join(",")}`); },
    markCompleted: async (update) => { calls.push(`complete:${update.attempts}:${update.completedAt}`); },
    markPending: async () => { calls.push("pending"); },
  }, new Date("2026-08-01T12:00:00.000Z"));

  assert.equal(result.status, "completed");
  assert.equal(result.attempts, 3);
  assert.deepEqual(calls, [
    "delete:workspaces/workspace-a/documents/document-a.pdf",
    "complete:3:2026-08-01T12:00:00.000Z",
  ]);
});

test("R2 failure leaves the purge job pending with a safe retry record", async () => {
  let pending: unknown;
  const result = await attemptPurgeStorage(job, {
    deleteObjects: async () => { throw new Error("synthetic object-store outage"); },
    markCompleted: async () => { assert.fail("failed storage deletion must not complete the job"); },
    markPending: async (update) => { pending = update; },
  }, new Date("2026-08-01T12:00:00.000Z"));

  assert.equal(result.status, "storage_pending");
  assert.deepEqual(pending, {
    attempts: 3,
    attemptedAt: "2026-08-01T12:00:00.000Z",
    lastError: PURGE_STORAGE_RETRY_ERROR,
    completedAt: null,
  });
  assert.doesNotMatch(JSON.stringify(pending), /synthetic object-store outage/);
});

test("a cross-workspace manifest never reaches object storage", async () => {
  let deleteCalls = 0;
  let pending: unknown;
  const result = await attemptPurgeStorage({
    ...job,
    objectKeys: ["workspaces/workspace-b/documents/document-a.pdf"],
  }, {
    deleteObjects: async () => { deleteCalls += 1; },
    markCompleted: async () => { assert.fail("invalid manifest must not complete"); },
    markPending: async (update) => { pending = update; },
  });

  assert.equal(deleteCalls, 0);
  assert.equal(result.status, "storage_pending");
  assert.equal((pending as { lastError: string }).lastError, INVALID_PURGE_MANIFEST_ERROR);
});

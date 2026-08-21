import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getActionDefinition } from "../app/lib/action-registry";
import { advanceObligationReminder } from "../app/lib/obligation-recurrence";
import { reminderEventId } from "../app/lib/reminder-policy";
import { operationMutationSchema } from "../app/lib/validation";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const agreementId = 42;
const scheduleId = "123e4567-e89b-42d3-a456-426614174000";
const obligationId = "223e4567-e89b-42d3-a456-426614174000";

const validRecords = [
  {
    entity: "obligation",
    action: "create",
    record: {
      agreementId,
      title: "File annual report",
      dueDate: "2027-01-31",
      source: "Section 9",
      recurrence: {
        unit: "year",
        interval: 1,
        timezone: "America/Detroit",
        reminderLeadDays: [30, 7, 0],
      },
      confirmed: true,
    },
  },
  {
    entity: "obligation",
    action: "complete",
    record: { id: obligationId, version: 1, evidence: "Receipt 42", confirmed: true },
  },
  {
    entity: "obligation",
    action: "reassign",
    record: {
      scheduleId,
      version: 1,
      newOwnerUserId: "323e4567-e89b-42d3-a456-426614174000",
      reason: "Coverage changed after team reorganization",
      includeOpenOccurrences: true,
      confirmed: true,
    },
  },
  {
    entity: "obligation",
    action: "schedule_status",
    record: {
      scheduleId,
      version: 1,
      status: "paused",
      reason: "Awaiting an executed amendment",
      confirmed: true,
    },
  },
] as const;

test("every human-only obligation mutation requires explicit true confirmation", () => {
  for (const candidate of validRecords) {
    assert.equal(operationMutationSchema.safeParse(candidate).success, true, `${candidate.action} valid`);
    const withoutConfirmation = structuredClone(candidate) as { record: Record<string, unknown> };
    delete withoutConfirmation.record.confirmed;
    assert.equal(operationMutationSchema.safeParse(withoutConfirmation).success, false, `${candidate.action} omission`);
    const falseConfirmation = structuredClone(candidate) as { record: Record<string, unknown> };
    falseConfirmation.record.confirmed = false;
    assert.equal(operationMutationSchema.safeParse(falseConfirmation).success, false, `${candidate.action} false`);
  }
  for (const actionId of [
    "obligation.schedule.create",
    "obligation.schedule.reassign",
    "obligation.schedule.status",
    "obligation.complete",
  ] as const) {
    const definition = getActionDefinition(actionId);
    assert.equal(definition.executionPolicy, "human_only");
    assert.equal(definition.confirmationPolicy, "human_confirmation");
  }
});

test("schedule creation is receipt-idempotent and completion appends digest-bound evidence atomically", async () => {
  const operations = await source("../app/api/operations/route.ts");
  assert.match(operations, /rawIdempotencyKey === null[\s\S]*idempotency_key_required/);
  assert.match(operations, /canonicalDocumentUploadIdempotencyKey[\s\S]*invalid_idempotency_key/);
  assert.match(operations, /replayObligationCreation[\s\S]*idempotency_key_conflict/);
  assert.match(operations, /db\.insert\(obligationCreationReceipts\)\.values\(creationReceipt\)/);
  assert.match(operations, /innerJoin\(agreements,[\s\S]*isNull\(agreements\.deletedAt\)/);
  assert.match(operations, /db\.insert\(obligationEvidence\)\.values\(evidence\)/);
  assert.match(operations, /evidenceSha256: await sha256Hex\(input\.record\.evidence\)/);
  assert.ok(operations.indexOf("db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: \"obligation.complete\"")
    < operations.indexOf("db.insert(obligationEvidence).values(evidence)"));
});

test("automatic catch-up and a manual reminder converge on one local-day identity", async () => {
  const advance = advanceObligationReminder({
    dueDate: "2026-12-31",
    leadDays: [30, 7, 0],
    currentReminderDate: "2026-12-01",
    localDate: "2026-12-20",
  });
  assert.deepEqual(advance, { queue: true, nextReminderDate: "2026-12-24" });
  const identity = {
    workspaceId: "workspace-a",
    topic: "notification.obligation_reminder",
    aggregateId: obligationId,
    recipientUserId: "owner-a",
    aggregateVersion: 1,
    calendarWindow: "2026-12-20",
  };
  assert.equal(await reminderEventId(identity), await reminderEventId({ ...identity }));

  const [automatic, manual] = await Promise.all([
    source("../app/api/jobs/obligations/route.ts"),
    source("../app/api/reminders/route.ts"),
  ]);
  assert.match(automatic, /calendarWindow: localDate/);
  assert.match(manual, /calendarWindow: obligationWindow/);
  assert.match(manual, /row\.nextReminderDate === null && isReminderDue\(row\.dueDate, obligationWindow\)/);
  assert.match(manual, /manualOverdue[\s\S]*onConflictDoNothing/);
});

test("materialization, delivery, and offboarding all fence active eligible ownership", async () => {
  const [job, outbox, memberships] = await Promise.all([
    source("../app/api/jobs/obligations/route.ts"),
    source("../app/api/jobs/outbox/route.ts"),
    source("../app/api/admin/memberships/route.ts"),
  ]);
  assert.match(job, /operation: "obligation\.schedule\.materialize"/);
  assert.match(job, /eq\(obligationSchedules\.version, schedule\.version\)/);
  assert.match(job, /inArray\(workspaceMemberships\.role, OBLIGATION_OWNER_ROLES\)/);
  assert.match(outbox, /obligationReminderDeliveryIsCurrent[\s\S]*eq\(workspaceMemberships\.status, "active"\)/);
  assert.match(outbox, /inArray\(workspaceMemberships\.role, \["admin", "legal", "approver", "requester"\]\)/);
  assert.match(memberships, /owned_obligations_require_reassignment/);
  assert.match(memberships, /notExists\(db\.select\(\{ id: obligationSchedules\.id \}\)/);
  assert.match(memberships, /operation: "membership\.update"[\s\S]*guardChanges: sql<number>`changes\(\)`/);
});

import { and, asc, eq, exists, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import {
  agreementEvents,
  agreements,
  mutationGuards,
  obligationSchedules,
  obligations,
  outboxEvents,
  users,
  workspaceMemberships,
} from "../../../../db/schema";
import { handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import { apiError, apiJson, checkBestEffortRateLimit, createRequestId, rateLimitExceeded } from "../../../lib/http";
import { prepareIntegrationOutboxEvent } from "../../../lib/integration-events";
import {
  addObligationCalendarDays,
  advanceObligationReminder,
  obligationCalendarDateInTimeZone,
} from "../../../lib/obligation-recurrence";
import { buildNextObligationMaterializationState } from "../../../lib/obligation-scheduler";
import {
  isAgreementEventSequenceConflict,
  isMutationGuardConflict,
  prepareAgreementEvent,
  prepareOutboxEvent,
} from "../../../lib/persistence";
import { getJobRunnerSecret } from "../../../lib/providers";
import { reminderEventId } from "../../../lib/reminder-policy";
import { constantTimeSecretEqual } from "../../../lib/records-governance";

const MATERIALIZATION_BATCH_SIZE = 25;
const REMINDER_BATCH_SIZE = 50;
const OBLIGATION_OWNER_ROLES = ["admin", "legal", "approver", "requester"] as const;
const SYSTEM_ACTOR = Object.freeze({
  userId: "system:obligation-scheduler",
  email: "obligation-scheduler@notice.invalid",
  displayName: "Notice obligation scheduler",
});

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const expected = getJobRunnerSecret();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!constantTimeSecretEqual(expected, supplied)) {
      return apiError("authentication_required", "Job runner authentication failed.", { status: 401, requestId });
    }
    const rate = checkBestEffortRateLimit("job:obligations", { limit: 12, windowMs: 60_000 });
    if (!rate.allowed) return rateLimitExceeded(rate, requestId);

    const workspaceId = getNoticeConfig().workspace.id;
    await ensureStorageSchema();
    const db = getDb();
    const now = new Date();
    const nowIso = now.toISOString();
    // IANA zones span both sides of UTC. One calendar day of SQL lookahead is
    // bounded; the exact per-schedule local-date comparison below is decisive.
    const candidateDate = addObligationCalendarDays(nowIso.slice(0, 10), 1);
    let materialized = 0;
    let remindersQueued = 0;
    let reminderDuplicates = 0;
    let conflicts = 0;

    const scheduleRows = await db.select({ schedule: obligationSchedules }).from(obligationSchedules)
      .innerJoin(agreements, and(
        eq(agreements.workspaceId, obligationSchedules.workspaceId),
        eq(agreements.id, obligationSchedules.agreementId),
        isNull(agreements.deletedAt),
      )).where(and(
        eq(obligationSchedules.workspaceId, workspaceId),
        eq(obligationSchedules.status, "active"),
        isNotNull(obligationSchedules.nextMaterializationDate),
        lte(obligationSchedules.nextMaterializationDate, candidateDate),
        or(eq(agreements.stage, "Active"), eq(agreements.signatureStatus, "Completed")),
      )).orderBy(asc(obligationSchedules.nextMaterializationDate), asc(obligationSchedules.createdAt)).limit(MATERIALIZATION_BATCH_SIZE);

    for (const { schedule } of scheduleRows) {
      if (
        schedule.nextOccurrenceNumber === null
        || schedule.nextOccurrenceDate === null
        || schedule.nextMaterializationDate === null
        || schedule.nextMaterializationDate > obligationCalendarDateInTimeZone(now, schedule.timezone)
      ) continue;
      const [owner] = await db.select({
        userId: users.id,
        displayName: users.displayName,
      }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, schedule.ownerUserId ?? ""),
        eq(workspaceMemberships.status, "active"),
        eq(users.status, "active"),
        inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
      )).limit(1);
      // Ownership must be repaired explicitly. Leaving the cursor in place is
      // the durable signal; silently creating unowned occurrences is forbidden.
      if (!owner) continue;

      const next = buildNextObligationMaterializationState({
        recurrenceUnit: schedule.recurrenceUnit,
        recurrenceInterval: schedule.recurrenceInterval,
        anchorDate: schedule.anchorDate,
        endDate: schedule.endDate,
        timezone: schedule.timezone,
        reminderLeadDays: schedule.reminderLeadDays,
        status: schedule.status,
        nextOccurrenceNumber: schedule.nextOccurrenceNumber,
        nextOccurrenceDate: schedule.nextOccurrenceDate,
        nextMaterializationDate: schedule.nextMaterializationDate,
      });
      const occurrence = {
        id: crypto.randomUUID(),
        workspaceId,
        version: 1,
        agreementId: schedule.agreementId,
        scheduleId: schedule.id,
        occurrenceNumber: next.occurrence.occurrenceNumber,
        title: schedule.title,
        dueDate: next.occurrence.dueDate,
        owner: owner.displayName,
        ownerUserId: owner.userId,
        status: "Open" as const,
        completedByUserId: null,
        completedAt: null,
        completionEvidence: null,
        cadence: next.occurrence.cadence,
        source: schedule.source,
        timezone: next.occurrence.timezone,
        reminderLeadDays: [...next.occurrence.reminderLeadDays],
        nextReminderDate: next.occurrence.nextReminderDate,
        createdByUserId: null,
        createdAt: nowIso,
      } satisfies typeof obligations.$inferInsert;
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: schedule.agreementId,
        type: "Obligation",
        detail: `Materialized occurrence ${occurrence.occurrenceNumber} for “${occurrence.title}” due ${occurrence.dueDate}.`,
        actor: SYSTEM_ACTOR,
        createdAt: nowIso,
      });
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "obligation.created",
        aggregateType: "obligation",
        aggregateId: occurrence.id,
        payload: {
          obligationId: occurrence.id,
          scheduleId: schedule.id,
          occurrenceNumber: occurrence.occurrenceNumber,
          agreementId: schedule.agreementId,
          ownerUserId: occurrence.ownerUserId,
          dueDate: occurrence.dueDate,
          aggregateVersion: occurrence.version,
          causationId: requestId,
        },
      }));
      const guardId = crypto.randomUUID();
      try {
        await db.batch([
          db.update(obligationSchedules).set({
            status: next.cursor.status,
            nextOccurrenceNumber: next.cursor.nextOccurrenceNumber,
            nextOccurrenceDate: next.cursor.nextOccurrenceDate,
            nextMaterializationDate: next.cursor.nextMaterializationDate,
            version: schedule.version + 1,
            updatedByUserId: null,
            updatedAt: nowIso,
          }).where(and(
            eq(obligationSchedules.workspaceId, workspaceId),
            eq(obligationSchedules.id, schedule.id),
            eq(obligationSchedules.version, schedule.version),
            eq(obligationSchedules.status, "active"),
            eq(obligationSchedules.nextOccurrenceNumber, schedule.nextOccurrenceNumber),
            eq(obligationSchedules.nextOccurrenceDate, schedule.nextOccurrenceDate),
            eq(obligationSchedules.nextMaterializationDate, schedule.nextMaterializationDate),
            exists(db.select({ id: agreements.id }).from(agreements).where(and(
              eq(agreements.workspaceId, workspaceId),
              eq(agreements.id, schedule.agreementId),
              isNull(agreements.deletedAt),
              or(eq(agreements.stage, "Active"), eq(agreements.signatureStatus, "Completed")),
            ))),
            exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
              .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
                eq(workspaceMemberships.workspaceId, workspaceId),
                eq(workspaceMemberships.userId, owner.userId),
                eq(workspaceMemberships.status, "active"),
                eq(users.status, "active"),
                inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
              ))),
          )),
          db.insert(mutationGuards).values({
            id: guardId,
            workspaceId,
            operation: "obligation.schedule.materialize",
            guardChanges: sql<number>`changes()`,
            createdAt: nowIso,
          }),
          db.insert(obligations).values(occurrence),
          db.insert(agreementEvents).values(event),
          db.insert(outboxEvents).values(outbox),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, workspaceId),
            eq(mutationGuards.id, guardId),
          )),
        ]);
        materialized += 1;
      } catch (error) {
        if (!isMutationGuardConflict(error) && !isAgreementEventSequenceConflict(error)) throw error;
        conflicts += 1;
      }
    }

    const reminderRows = await db.select({
      obligation: obligations,
      recipient: {
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
      },
    }).from(obligations)
      .innerJoin(agreements, and(
        eq(agreements.workspaceId, obligations.workspaceId),
        eq(agreements.id, obligations.agreementId),
        isNull(agreements.deletedAt),
      ))
      .innerJoin(workspaceMemberships, and(
        eq(workspaceMemberships.workspaceId, obligations.workspaceId),
        eq(workspaceMemberships.userId, obligations.ownerUserId),
        eq(workspaceMemberships.status, "active"),
        inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
      ))
      .innerJoin(users, and(
        eq(users.id, workspaceMemberships.userId),
        eq(users.status, "active"),
      )).where(and(
        eq(obligations.workspaceId, workspaceId),
        eq(obligations.status, "Open"),
        isNotNull(obligations.nextReminderDate),
        lte(obligations.nextReminderDate, candidateDate),
        or(eq(agreements.stage, "Active"), eq(agreements.signatureStatus, "Completed")),
      )).orderBy(asc(obligations.nextReminderDate), asc(obligations.dueDate)).limit(REMINDER_BATCH_SIZE);

    for (const { obligation, recipient } of reminderRows) {
      if (!obligation.nextReminderDate) continue;
      const localDate = obligationCalendarDateInTimeZone(now, obligation.timezone);
      const advance = advanceObligationReminder({
        dueDate: obligation.dueDate,
        leadDays: obligation.reminderLeadDays,
        localDate,
        currentReminderDate: obligation.nextReminderDate,
      });
      if (!advance.queue) continue;
      const topic = "notification.obligation_reminder";
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic,
        aggregateType: "obligation",
        aggregateId: obligation.id,
        payload: {
          obligationId: obligation.id,
          agreementId: obligation.agreementId,
          title: obligation.title.slice(0, 200),
          dueDate: obligation.dueDate,
          recipient,
          aggregateVersion: obligation.version,
          causationId: requestId,
        },
      }));
      outbox.id = await reminderEventId({
        workspaceId,
        topic,
        aggregateId: obligation.id,
        recipientUserId: recipient.userId,
        aggregateVersion: obligation.version,
        calendarWindow: localDate,
      });
      const guardId = crypto.randomUUID();
      try {
        const [outboxResult] = await db.batch([
          db.insert(outboxEvents).values(outbox).onConflictDoNothing(),
          db.update(obligations).set({
            nextReminderDate: advance.nextReminderDate,
          }).where(and(
            eq(obligations.workspaceId, workspaceId),
            eq(obligations.id, obligation.id),
            eq(obligations.version, obligation.version),
            eq(obligations.status, "Open"),
            eq(obligations.ownerUserId, recipient.userId),
            eq(obligations.nextReminderDate, obligation.nextReminderDate),
            exists(db.select({ id: agreements.id }).from(agreements).where(and(
              eq(agreements.workspaceId, workspaceId),
              eq(agreements.id, obligation.agreementId),
              isNull(agreements.deletedAt),
            ))),
            exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
              .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
                eq(workspaceMemberships.workspaceId, workspaceId),
                eq(workspaceMemberships.userId, recipient.userId),
                eq(workspaceMemberships.status, "active"),
                eq(users.status, "active"),
                inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
              ))),
          )),
          db.insert(mutationGuards).values({
            id: guardId,
            workspaceId,
            operation: "obligation.reminder.advance",
            guardChanges: sql<number>`changes()`,
            createdAt: nowIso,
          }),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, workspaceId),
            eq(mutationGuards.id, guardId),
          )),
        ]);
        if (outboxResult.meta.changes) remindersQueued += 1;
        else reminderDuplicates += 1;
      } catch (error) {
        if (!isMutationGuardConflict(error)) throw error;
        conflicts += 1;
      }
    }

    return apiJson({
      materialized,
      remindersQueued,
      reminderDuplicates,
      conflicts,
      requestId,
    }, { status: 202, requestId });
  } catch (error) {
    return handleRouteError(error, requestId, "Obligation schedules could not be processed.");
  }
}

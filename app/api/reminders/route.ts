import { and, eq, exists, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import { agreements, approvalRequests, mutationGuards, obligations, outboxEvents, users, workspaceMemberships } from "../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../lib/api";
import { apiJson } from "../../lib/http";
import { prepareIntegrationOutboxEvent } from "../../lib/integration-events";
import { prepareOutboxEvent } from "../../lib/persistence";
import { advanceObligationReminder, obligationCalendarDateInTimeZone } from "../../lib/obligation-recurrence";
import { isMutationGuardConflict } from "../../lib/persistence";
import { isReminderDue, reminderCalendarWindow, reminderEventId } from "../../lib/reminder-policy";
import { parseJson } from "../../lib/validation";

const reminderSchema = z.object({
  kind: z.enum(["approvals", "obligations"]),
  ids: z.array(z.string().uuid()).max(50).optional(),
  dryRun: z.boolean().default(false),
});
const OBLIGATION_OWNER_ROLES = ["admin", "legal", "approver", "requester"] as const;

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "notification:send", { limit: 20 });
  if (!auth.ok) return auth.response;
  const workspaceId = auth.context.workspace.id;
  try {
    const input = await parseJson(request, reminderSchema, 16_000);
    await ensureStorageSchema();
    const db = getDb();
    let queued = 0;
    let skipped = 0;
    let duplicate = 0;
    const candidates: Array<{ id: string; dueDate: string; recipientUserId: string }> = [];
    const calendarWindow = reminderCalendarWindow();
    if (input.kind === "approvals") {
      const filters = [
        eq(approvalRequests.workspaceId, auth.context.workspace.id),
        eq(approvalRequests.status, "Pending"),
        ...(input.ids?.length ? [inArray(approvalRequests.id, input.ids)] : []),
      ];
      const rows = await db.select().from(approvalRequests).where(and(...filters)).limit(50);
      for (const row of rows) {
        const recipient = row.approverUserId ? await findUser(row.approverUserId) : null;
        if (!recipient || !isReminderDue(row.due, calendarWindow)) { skipped += 1; continue; }
        candidates.push({ id: row.id, dueDate: row.due, recipientUserId: recipient.id });
        if (input.dryRun) continue;
        const topic = "notification.approval_reminder";
        const event = prepareOutboxEvent(prepareIntegrationOutboxEvent({
          workspaceId: auth.context.workspace.id,
          topic,
          aggregateType: "approval",
          aggregateId: row.id,
          payload: {
            approvalId: row.id,
            agreementId: row.agreementId,
            role: row.role,
            due: row.due,
            recipient: { userId: recipient.id, email: recipient.email, displayName: recipient.displayName },
            aggregateVersion: row.version,
            causationId: auth.requestId,
          },
        }));
        event.id = await reminderEventId({ workspaceId, topic, aggregateId: row.id, recipientUserId: recipient.id, aggregateVersion: row.version, calendarWindow });
        const result = await db.insert(outboxEvents).values(event).onConflictDoNothing();
        if (result.meta.changes) queued += 1;
        else duplicate += 1;
      }
    } else {
      const filters = [
        eq(obligations.workspaceId, auth.context.workspace.id),
        eq(obligations.status, "Open"),
        eq(agreements.workspaceId, auth.context.workspace.id),
        isNull(agreements.deletedAt),
        ...(input.ids?.length ? [inArray(obligations.id, input.ids)] : []),
      ];
      const rows = await db.select({ ...getTableColumns(obligations) }).from(obligations).innerJoin(agreements, and(
        eq(agreements.workspaceId, obligations.workspaceId),
        eq(agreements.id, obligations.agreementId),
      )).where(and(...filters)).limit(50);
      for (const row of rows) {
        const recipient = row.ownerUserId ? await findUser(row.ownerUserId, true) : null;
        const obligationWindow = obligationCalendarDateInTimeZone(new Date(), row.timezone);
        if (!recipient) { skipped += 1; continue; }
        const advance = row.nextReminderDate && isReminderDue(row.nextReminderDate, obligationWindow)
          ? advanceObligationReminder({
              dueDate: row.dueDate,
              leadDays: row.reminderLeadDays,
              localDate: obligationWindow,
              currentReminderDate: row.nextReminderDate,
            })
          : null;
        const manualOverdue = row.nextReminderDate === null && isReminderDue(row.dueDate, obligationWindow);
        if (!manualOverdue && !advance?.queue) { skipped += 1; continue; }
        candidates.push({ id: row.id, dueDate: row.dueDate, recipientUserId: recipient.id });
        if (input.dryRun) continue;
        const topic = "notification.obligation_reminder";
        const event = prepareOutboxEvent(prepareIntegrationOutboxEvent({
          workspaceId: auth.context.workspace.id,
          topic,
          aggregateType: "obligation",
          aggregateId: row.id,
          payload: {
            obligationId: row.id,
            agreementId: row.agreementId,
            title: row.title.slice(0, 200),
            dueDate: row.dueDate,
            recipient: { userId: recipient.id, email: recipient.email, displayName: recipient.displayName },
            aggregateVersion: row.version,
            causationId: auth.requestId,
          },
        }));
        event.id = await reminderEventId({
          workspaceId,
          topic,
          aggregateId: row.id,
          recipientUserId: recipient.id,
          aggregateVersion: row.version,
          calendarWindow: obligationWindow,
        });
        // Once every configured cursor has been consumed, an explicit human
        // reminder remains available for a due/overdue occurrence. Its local
        // calendar-day identity bounds retries without reviving automation.
        if (manualOverdue) {
          const result = await db.insert(outboxEvents).values(event).onConflictDoNothing();
          if (result.meta.changes) queued += 1;
          else duplicate += 1;
          continue;
        }
        if (!row.nextReminderDate || !advance) { skipped += 1; continue; }
        const guardId = crypto.randomUUID();
        try {
          const [result] = await db.batch([
            db.insert(outboxEvents).values(event).onConflictDoNothing(),
            db.update(obligations).set({ nextReminderDate: advance.nextReminderDate }).where(and(
              eq(obligations.workspaceId, workspaceId),
              eq(obligations.id, row.id),
              eq(obligations.version, row.version),
              eq(obligations.status, "Open"),
              eq(obligations.ownerUserId, recipient.id),
              eq(obligations.nextReminderDate, row.nextReminderDate),
              exists(db.select({ id: agreements.id }).from(agreements).where(and(
                eq(agreements.workspaceId, workspaceId),
                eq(agreements.id, row.agreementId),
                isNull(agreements.deletedAt),
              ))),
              exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
                .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
                  eq(workspaceMemberships.workspaceId, workspaceId),
                  eq(workspaceMemberships.userId, recipient.id),
                  eq(workspaceMemberships.status, "active"),
                  eq(users.status, "active"),
                  inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES),
                ))),
            )),
            db.insert(mutationGuards).values({
              id: guardId,
              workspaceId,
              operation: "obligation.reminder.manual",
              guardChanges: sql<number>`changes()`,
              createdAt: new Date().toISOString(),
            }),
            db.delete(mutationGuards).where(and(
              eq(mutationGuards.workspaceId, workspaceId),
              eq(mutationGuards.id, guardId),
            )),
          ]);
          if (result.meta.changes) queued += 1;
          else duplicate += 1;
        } catch (error) {
          if (!isMutationGuardConflict(error)) throw error;
          skipped += 1;
        }
      }
    }
    return apiJson({ queued, skipped, duplicate, dryRun: input.dryRun, candidates, requestId: auth.requestId }, { status: input.dryRun ? 200 : 202, requestId: auth.requestId, headers: auth.headers });

    async function findUser(userId: string, requireObligationOwner = false) {
      const [user] = await db.select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
      }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.status, "active"),
        eq(users.status, "active"),
        ...(requireObligationOwner ? [inArray(workspaceMemberships.role, OBLIGATION_OWNER_ROLES)] : []),
      )).limit(1);
      return user ?? null;
    }
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Reminders could not be queued.");
  }
}

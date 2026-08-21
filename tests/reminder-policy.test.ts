import assert from "node:assert/strict";
import test from "node:test";
import { isReminderDue, reminderCalendarWindow, reminderEventId } from "../app/lib/reminder-policy";

const identity = {
  workspaceId: "workspace-1",
  topic: "notification.approval_reminder",
  aggregateId: "approval-1",
  recipientUserId: "user-1",
  aggregateVersion: 3,
  calendarWindow: "2026-08-19",
};

test("reminder IDs converge for retries and change at every delivery boundary", async () => {
  const original = await reminderEventId(identity);
  assert.equal(await reminderEventId({ ...identity }), original);
  assert.notEqual(await reminderEventId({ ...identity, recipientUserId: "user-2" }), original);
  assert.notEqual(await reminderEventId({ ...identity, aggregateVersion: 4 }), original);
  assert.notEqual(await reminderEventId({ ...identity, calendarWindow: "2026-08-20" }), original);
});

test("reminder policy accepts only canonical due dates at or before the UTC window", () => {
  assert.equal(reminderCalendarWindow(new Date("2026-08-19T23:59:59.999Z")), "2026-08-19");
  assert.equal(isReminderDue("2026-08-18", "2026-08-19"), true);
  assert.equal(isReminderDue("2026-08-19", "2026-08-19"), true);
  assert.equal(isReminderDue("2026-08-20", "2026-08-19"), false);
  assert.equal(isReminderDue("Today", "2026-08-19"), false);
  assert.equal(isReminderDue("2026-02-30", "2026-08-19"), false);
});

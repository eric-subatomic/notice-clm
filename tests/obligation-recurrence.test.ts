import assert from "node:assert/strict";
import test from "node:test";
import {
  addObligationCalendarDays,
  advanceObligationReminder,
  isValidObligationTimeZone,
  normalizeObligationReminderLeadDays,
  obligationCadenceLabel,
  obligationCalendarDateInTimeZone,
  obligationMaterializationDate,
  obligationOccurrenceDate,
  obligationReminderDates,
  ObligationRecurrenceError,
} from "../app/lib/obligation-recurrence";
import {
  buildInitialObligationScheduleState,
  buildNextObligationMaterializationState,
} from "../app/lib/obligation-scheduler";

test("monthly recurrence clamps to month end without permanently drifting", () => {
  const rule = { unit: "month", interval: 1, anchorDate: "2024-01-31" } as const;
  assert.equal(obligationOccurrenceDate(rule, 1), "2024-01-31");
  assert.equal(obligationOccurrenceDate(rule, 2), "2024-02-29");
  assert.equal(obligationOccurrenceDate(rule, 3), "2024-03-31");
  assert.equal(obligationOccurrenceDate(rule, 4), "2024-04-30");
});

test("annual leap-day recurrence clamps from the original anchor", () => {
  const rule = { unit: "year", interval: 1, anchorDate: "2024-02-29" } as const;
  assert.equal(obligationOccurrenceDate(rule, 2), "2025-02-28");
  assert.equal(obligationOccurrenceDate(rule, 5), "2028-02-29");
});

test("weekly, quarterly, intervals, and inclusive end dates are deterministic", () => {
  assert.equal(obligationOccurrenceDate({ unit: "week", interval: 2, anchorDate: "2026-08-19" }, 3), "2026-09-16");
  assert.equal(obligationOccurrenceDate({ unit: "month", interval: 3, anchorDate: "2026-01-31" }, 2), "2026-04-30");
  assert.equal(obligationOccurrenceDate({ unit: "month", interval: 3, anchorDate: "2026-01-31", endDate: "2026-04-30" }, 2), "2026-04-30");
  assert.throws(
    () => obligationOccurrenceDate({ unit: "month", interval: 3, anchorDate: "2026-01-31", endDate: "2026-04-30" }, 3),
    (error) => error instanceof ObligationRecurrenceError && error.code === "OBLIGATION_OCCURRENCE_AFTER_END",
  );
});

test("one-time and malformed recurrence rules fail closed", () => {
  assert.equal(obligationOccurrenceDate({ unit: "once", interval: 1, anchorDate: "2026-08-19" }, 1), "2026-08-19");
  assert.throws(() => obligationOccurrenceDate({ unit: "once", interval: 1, anchorDate: "2026-08-19" }, 2));
  assert.throws(() => obligationOccurrenceDate({ unit: "month", interval: 0, anchorDate: "2026-08-19" }, 1));
  assert.throws(() => obligationOccurrenceDate({ unit: "month", interval: 1, anchorDate: "2026-02-30" }, 1));
  assert.throws(() => obligationOccurrenceDate({ unit: "year", interval: 1, anchorDate: "9999-01-01" }, 2));
});

test("calendar arithmetic crosses leap and year boundaries without local time", () => {
  assert.equal(addObligationCalendarDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addObligationCalendarDays("2024-02-29", 1), "2024-03-01");
  assert.equal(addObligationCalendarDays("2026-01-01", -1), "2025-12-31");
});

test("IANA time zones produce distinct exact local calendar dates at one instant", () => {
  const instant = new Date("2026-08-19T02:30:00.000Z");
  assert.equal(obligationCalendarDateInTimeZone(instant, "Etc/UTC"), "2026-08-19");
  assert.equal(obligationCalendarDateInTimeZone(instant, "America/Detroit"), "2026-08-18");
  assert.equal(obligationCalendarDateInTimeZone(instant, "Pacific/Kiritimati"), "2026-08-19");
  assert.equal(isValidObligationTimeZone("America/Detroit"), true);
  assert.equal(isValidObligationTimeZone("Not/A_Timezone"), false);
  assert.throws(() => obligationCalendarDateInTimeZone(instant, "Not/A_Timezone"));
});

test("reminder leads normalize, materialize early, and expose exact windows", () => {
  assert.deepEqual(normalizeObligationReminderLeadDays([0, 30, 7, 30]), [30, 7, 0]);
  assert.deepEqual(obligationReminderDates("2026-12-31", [0, 30, 7]), ["2026-12-01", "2026-12-24", "2026-12-31"]);
  assert.equal(obligationMaterializationDate("2026-12-31", [0, 30, 7]), "2026-12-01");
  assert.throws(() => normalizeObligationReminderLeadDays([]));
  assert.throws(() => normalizeObligationReminderLeadDays([366]));
});

test("missed reminder windows collapse to one catch-up delivery", () => {
  assert.deepEqual(advanceObligationReminder({
    dueDate: "2026-12-31",
    leadDays: [30, 7, 0],
    currentReminderDate: "2026-12-01",
    localDate: "2026-12-20",
  }), { queue: true, nextReminderDate: "2026-12-24" });
  assert.deepEqual(advanceObligationReminder({
    dueDate: "2026-12-31",
    leadDays: [30, 7, 0],
    currentReminderDate: "2026-12-01",
    localDate: "2027-01-02",
  }), { queue: true, nextReminderDate: null });
  assert.deepEqual(advanceObligationReminder({
    dueDate: "2026-12-31",
    leadDays: [30, 7, 0],
    currentReminderDate: "2026-12-24",
    localDate: "2026-12-20",
  }), { queue: false, nextReminderDate: "2026-12-24" });
});

test("cadence labels stay bounded and server-derived", () => {
  assert.equal(obligationCadenceLabel("once", 1), "One-time");
  assert.equal(obligationCadenceLabel("month", 3), "Quarterly");
  assert.equal(obligationCadenceLabel("year", 2), "Every 2 years");
});

test("initial schedule state creates one immutable occurrence and an exact next cursor", () => {
  const initial = buildInitialObligationScheduleState({
    recurrenceUnit: "month",
    recurrenceInterval: 1,
    anchorDate: "2024-01-31",
    endDate: "2024-03-31",
    timezone: "America/Detroit",
    reminderLeadDays: [0, 7, 30],
  });
  assert.deepEqual(initial.occurrence, {
    occurrenceNumber: 1,
    dueDate: "2024-01-31",
    cadence: "Monthly",
    timezone: "America/Detroit",
    reminderLeadDays: [30, 7, 0],
    nextReminderDate: "2024-01-01",
  });
  assert.deepEqual(initial.cursor, {
    status: "active",
    nextOccurrenceNumber: 2,
    nextOccurrenceDate: "2024-02-29",
    nextMaterializationDate: "2024-01-30",
  });
});

test("materialization validates the persisted cursor and ends at the inclusive boundary", () => {
  const materialized = buildNextObligationMaterializationState({
    recurrenceUnit: "month",
    recurrenceInterval: 1,
    anchorDate: "2024-01-31",
    endDate: "2024-02-29",
    timezone: "Etc/UTC",
    reminderLeadDays: [7, 0],
    status: "active",
    nextOccurrenceNumber: 2,
    nextOccurrenceDate: "2024-02-29",
    nextMaterializationDate: "2024-02-22",
  });
  assert.equal(materialized.occurrence.occurrenceNumber, 2);
  assert.equal(materialized.occurrence.dueDate, "2024-02-29");
  assert.equal(materialized.cursor.status, "ended");
  assert.equal(materialized.cursor.nextOccurrenceNumber, null);

  assert.throws(
    () => buildNextObligationMaterializationState({
      recurrenceUnit: "month",
      recurrenceInterval: 1,
      anchorDate: "2024-01-31",
      timezone: "Etc/UTC",
      reminderLeadDays: [7, 0],
      status: "active",
      nextOccurrenceNumber: 2,
      nextOccurrenceDate: "2024-02-28",
      nextMaterializationDate: "2024-02-21",
    }),
    (error) => error instanceof ObligationRecurrenceError && error.code === "OBLIGATION_SCHEDULE_CURSOR_INVALID",
  );
});

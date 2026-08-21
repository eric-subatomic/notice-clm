import {
  obligationCadenceLabel,
  obligationMaterializationDate,
  obligationOccurrenceDate,
  obligationReminderDates,
  normalizeObligationReminderLeadDays,
  ObligationRecurrenceError,
  type ObligationRecurrenceRule,
  type ObligationRecurrenceUnit,
} from "./obligation-recurrence";

export type ObligationScheduleCursor = Readonly<{
  status: "active" | "paused" | "ended";
  nextOccurrenceNumber: number | null;
  nextOccurrenceDate: string | null;
  nextMaterializationDate: string | null;
}>;

export type ObligationOccurrenceSnapshot = Readonly<{
  occurrenceNumber: number;
  dueDate: string;
  cadence: string;
  timezone: string;
  reminderLeadDays: readonly number[];
  nextReminderDate: string;
}>;

export type ObligationScheduleSeed = Readonly<{
  recurrenceUnit: ObligationRecurrenceUnit;
  recurrenceInterval: number;
  anchorDate: string;
  endDate?: string | null;
  timezone: string;
  reminderLeadDays?: readonly number[];
}>;

export type InitialObligationScheduleState = Readonly<{
  reminderLeadDays: readonly number[];
  occurrence: ObligationOccurrenceSnapshot;
  cursor: ObligationScheduleCursor;
}>;

function ruleFor(input: ObligationScheduleSeed): ObligationRecurrenceRule {
  return {
    unit: input.recurrenceUnit,
    interval: input.recurrenceInterval,
    anchorDate: input.anchorDate,
    endDate: input.endDate,
  };
}

function nextCursor(
  input: ObligationScheduleSeed,
  occurrenceNumber: number,
  reminderLeadDays: readonly number[],
): ObligationScheduleCursor {
  if (input.recurrenceUnit === "once") {
    return {
      status: "ended",
      nextOccurrenceNumber: null,
      nextOccurrenceDate: null,
      nextMaterializationDate: null,
    };
  }
  const nextOccurrenceNumber = occurrenceNumber + 1;
  try {
    const nextOccurrenceDate = obligationOccurrenceDate(ruleFor(input), nextOccurrenceNumber);
    return {
      status: "active",
      nextOccurrenceNumber,
      nextOccurrenceDate,
      nextMaterializationDate: obligationMaterializationDate(nextOccurrenceDate, reminderLeadDays),
    };
  } catch (error) {
    if (error instanceof ObligationRecurrenceError && error.code === "OBLIGATION_OCCURRENCE_AFTER_END") {
      return {
        status: "ended",
        nextOccurrenceNumber: null,
        nextOccurrenceDate: null,
        nextMaterializationDate: null,
      };
    }
    throw error;
  }
}

function occurrenceSnapshot(
  input: ObligationScheduleSeed,
  occurrenceNumber: number,
  dueDate: string,
  reminderLeadDays: readonly number[],
): ObligationOccurrenceSnapshot {
  return {
    occurrenceNumber,
    dueDate,
    cadence: obligationCadenceLabel(input.recurrenceUnit, input.recurrenceInterval),
    timezone: input.timezone,
    reminderLeadDays,
    nextReminderDate: obligationReminderDates(dueDate, reminderLeadDays)[0]!,
  };
}

/** Build the immutable first occurrence and the mutable cursor in one step. */
export function buildInitialObligationScheduleState(
  input: ObligationScheduleSeed,
): InitialObligationScheduleState {
  const reminderLeadDays = normalizeObligationReminderLeadDays(input.reminderLeadDays);
  const dueDate = obligationOccurrenceDate(ruleFor(input), 1);
  return {
    reminderLeadDays,
    occurrence: occurrenceSnapshot(input, 1, dueDate, reminderLeadDays),
    cursor: nextCursor(input, 1, reminderLeadDays),
  };
}

export type NextObligationMaterializationState = Readonly<{
  occurrence: ObligationOccurrenceSnapshot;
  cursor: ObligationScheduleCursor;
}>;

/**
 * Materialize exactly the schedule's persisted cursor. Callers must protect
 * the returned cursor advance with a compare-and-swap on schedule version and
 * the three prior cursor fields.
 */
export function buildNextObligationMaterializationState(input: ObligationScheduleSeed & Readonly<{
  status: "active" | "paused" | "ended";
  nextOccurrenceNumber: number | null;
  nextOccurrenceDate: string | null;
  nextMaterializationDate: string | null;
}>): NextObligationMaterializationState {
  if (
    input.status !== "active"
    || input.nextOccurrenceNumber === null
    || input.nextOccurrenceDate === null
    || input.nextMaterializationDate === null
  ) {
    throw new ObligationRecurrenceError(
      "OBLIGATION_SCHEDULE_NOT_MATERIALIZABLE",
      "Only an active schedule with a complete next-occurrence cursor can be materialized.",
    );
  }
  const reminderLeadDays = normalizeObligationReminderLeadDays(input.reminderLeadDays);
  const derivedDueDate = obligationOccurrenceDate(ruleFor(input), input.nextOccurrenceNumber);
  if (
    derivedDueDate !== input.nextOccurrenceDate
    || obligationMaterializationDate(derivedDueDate, reminderLeadDays) !== input.nextMaterializationDate
  ) {
    throw new ObligationRecurrenceError(
      "OBLIGATION_SCHEDULE_CURSOR_INVALID",
      "The persisted schedule cursor does not match its immutable recurrence rule.",
    );
  }
  return {
    occurrence: occurrenceSnapshot(input, input.nextOccurrenceNumber, derivedDueDate, reminderLeadDays),
    cursor: nextCursor(input, input.nextOccurrenceNumber, reminderLeadDays),
  };
}

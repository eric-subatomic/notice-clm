import { parseIsoDate, type ParsedIsoDate } from "./iso-date";

export const obligationRecurrenceUnits = ["once", "week", "month", "year"] as const;
export type ObligationRecurrenceUnit = (typeof obligationRecurrenceUnits)[number];

export class ObligationRecurrenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ObligationRecurrenceError";
  }
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function requireDate(value: string, field: string): ParsedIsoDate {
  const parsed = parseIsoDate(value);
  if (!parsed.ok) {
    throw new ObligationRecurrenceError(
      "OBLIGATION_DATE_INVALID",
      `${field} must be an exact valid YYYY-MM-DD calendar date.`,
    );
  }
  return parsed.value;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function monthDays(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

function dateValue(year: number, month: number, day: number): string {
  if (year < 1 || year > 9_999) {
    throw new ObligationRecurrenceError(
      "OBLIGATION_DATE_RANGE_INVALID",
      "The derived obligation date must remain between 0001-01-01 and 9999-12-31.",
    );
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function utcDate(parsed: ParsedIsoDate): Date {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  return value;
}

/** Add whole proleptic-Gregorian calendar days without local-time/DST drift. */
export function addObligationCalendarDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days)) {
    throw new ObligationRecurrenceError("OBLIGATION_DAY_OFFSET_INVALID", "Calendar-day offsets must be safe integers.");
  }
  const date = utcDate(requireDate(value, "date"));
  date.setUTCDate(date.getUTCDate() + days);
  return dateValue(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function isValidObligationTimeZone(value: string): boolean {
  if (!value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Return the calendar date currently observed in an exact IANA time zone. */
export function obligationCalendarDateInTimeZone(now: Date, timeZone: string): string {
  if (!Number.isFinite(now.getTime())) {
    throw new ObligationRecurrenceError("OBLIGATION_NOW_INVALID", "A valid instant is required.");
  }
  if (!isValidObligationTimeZone(timeZone)) {
    throw new ObligationRecurrenceError("OBLIGATION_TIMEZONE_INVALID", "A valid IANA time zone is required.");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) {
    throw new ObligationRecurrenceError("OBLIGATION_TIMEZONE_INVALID", "The IANA time zone did not produce a calendar date.");
  }
  const value = `${year}-${month}-${day}`;
  requireDate(value, "calendar date");
  return value;
}

export type ObligationRecurrenceRule = Readonly<{
  unit: ObligationRecurrenceUnit;
  interval: number;
  anchorDate: string;
  endDate?: string | null;
}>;

/**
 * Derive occurrence n from the original anchor. Deriving from the prior
 * occurrence would make Jan 31 -> Feb 28 -> Mar 28 drift permanently.
 */
export function obligationOccurrenceDate(rule: ObligationRecurrenceRule, occurrenceNumber: number): string {
  if (!obligationRecurrenceUnits.includes(rule.unit)) {
    throw new ObligationRecurrenceError("OBLIGATION_RECURRENCE_UNIT_INVALID", "The recurrence unit is not supported.");
  }
  if (!Number.isSafeInteger(rule.interval) || rule.interval < 1 || rule.interval > 12) {
    throw new ObligationRecurrenceError("OBLIGATION_RECURRENCE_INTERVAL_INVALID", "The recurrence interval must be from 1 through 12.");
  }
  if (rule.unit === "once" && rule.interval !== 1) {
    throw new ObligationRecurrenceError("OBLIGATION_RECURRENCE_INTERVAL_INVALID", "A one-time schedule must use interval 1.");
  }
  if (!Number.isSafeInteger(occurrenceNumber) || occurrenceNumber < 1) {
    throw new ObligationRecurrenceError("OBLIGATION_OCCURRENCE_NUMBER_INVALID", "Occurrence numbers begin at 1.");
  }
  if (rule.unit === "once" && occurrenceNumber !== 1) {
    throw new ObligationRecurrenceError("OBLIGATION_OCCURRENCE_AFTER_END", "A one-time schedule has exactly one occurrence.");
  }

  const anchor = requireDate(rule.anchorDate, "anchorDate");
  let candidate: string;
  const offset = rule.interval * (occurrenceNumber - 1);
  if (rule.unit === "once") {
    candidate = anchor.value;
  } else if (rule.unit === "week") {
    candidate = addObligationCalendarDays(anchor.value, offset * 7);
  } else if (rule.unit === "month") {
    const absoluteMonth = anchor.year * 12 + anchor.month - 1 + offset;
    const year = Math.floor(absoluteMonth / 12);
    const month = absoluteMonth % 12 + 1;
    candidate = dateValue(year, month, Math.min(anchor.day, monthDays(year, month)));
  } else {
    const year = anchor.year + offset;
    candidate = dateValue(year, anchor.month, Math.min(anchor.day, monthDays(year, anchor.month)));
  }

  if (rule.endDate) {
    const end = requireDate(rule.endDate, "endDate").value;
    if (end < anchor.value) {
      throw new ObligationRecurrenceError("OBLIGATION_RECURRENCE_RANGE_INVALID", "endDate cannot be before anchorDate.");
    }
    if (candidate > end) {
      throw new ObligationRecurrenceError("OBLIGATION_OCCURRENCE_AFTER_END", "The derived occurrence is after the inclusive schedule end date.");
    }
  }
  return candidate;
}

export function normalizeObligationReminderLeadDays(values: readonly number[] | undefined): readonly number[] {
  const candidates = values ?? [0];
  if (candidates.length < 1 || candidates.length > 8) {
    throw new ObligationRecurrenceError("OBLIGATION_REMINDER_LIMIT_INVALID", "Provide from one through eight reminder lead days.");
  }
  if (candidates.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 365)) {
    throw new ObligationRecurrenceError("OBLIGATION_REMINDER_DAY_INVALID", "Reminder lead days must be whole numbers from 0 through 365.");
  }
  return Object.freeze([...new Set(candidates)].sort((left, right) => right - left));
}

export function obligationReminderDates(dueDate: string, leadDays: readonly number[]): readonly string[] {
  const due = requireDate(dueDate, "dueDate").value;
  return Object.freeze(normalizeObligationReminderLeadDays(leadDays).map((lead) => addObligationCalendarDays(due, -lead)));
}

export function obligationMaterializationDate(dueDate: string, leadDays: readonly number[]): string {
  return obligationReminderDates(dueDate, leadDays)[0]!;
}

export type ObligationReminderAdvance = Readonly<{
  queue: boolean;
  nextReminderDate: string | null;
}>;

/**
 * Advance a reminder cursor. Missed windows collapse into one catch-up send so
 * a recovered job cannot emit a burst of stale reminders.
 */
export function advanceObligationReminder(input: Readonly<{
  dueDate: string;
  leadDays: readonly number[];
  localDate: string;
  currentReminderDate: string;
}>): ObligationReminderAdvance {
  const localDate = requireDate(input.localDate, "localDate").value;
  const current = requireDate(input.currentReminderDate, "currentReminderDate").value;
  const windows = obligationReminderDates(input.dueDate, input.leadDays);
  if (!windows.includes(current)) {
    throw new ObligationRecurrenceError("OBLIGATION_REMINDER_CURSOR_INVALID", "The reminder cursor is not a configured delivery window.");
  }
  if (localDate < current) return { queue: false, nextReminderDate: current };
  return {
    queue: true,
    nextReminderDate: windows.find((window) => window > localDate) ?? null,
  };
}

export function obligationCadenceLabel(unit: ObligationRecurrenceUnit, interval: number): string {
  if (unit === "once") return "One-time";
  if (unit === "week" && interval === 1) return "Weekly";
  if (unit === "month" && interval === 1) return "Monthly";
  if (unit === "month" && interval === 3) return "Quarterly";
  if (unit === "year" && interval === 1) return "Annual";
  const noun = unit === "week" ? "weeks" : unit === "month" ? "months" : "years";
  return `Every ${interval} ${noun}`;
}

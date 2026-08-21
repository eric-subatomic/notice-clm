export const DEFAULT_PURGE_GRACE_DAYS = 30;
export const MIN_PURGE_GRACE_DAYS = 7;
export const MAX_PURGE_GRACE_DAYS = 365;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIMEZONE_AWARE_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Converts a customer-approved retention boundary to a comparable UTC value.
 * Date-only policies expire at the end of that UTC day so a record is never
 * removed at the start of the date an administrator selected.
 */
export function normalizeRetentionUntil(value: string | null): string | null {
  if (value === null) return null;
  const candidate = value.trim();
  const syntacticallyValid = DATE_ONLY.test(candidate)
    ? validCalendarDate(candidate)
    : TIMEZONE_AWARE_DATE_TIME.test(candidate) && validDateTimeParts(candidate);
  const date = syntacticallyValid
    ? new Date(DATE_ONLY.test(candidate) ? `${candidate}T23:59:59.999Z` : candidate)
    : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new RetentionPolicyError("Retention must be a valid YYYY-MM-DD date or timezone-aware ISO timestamp.");
  }
  return date.toISOString();
}

function validCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDateTimeParts(value: string): boolean {
  const [datePart, timeAndZone] = value.split("T");
  if (!datePart || !timeAndZone || !validCalendarDate(datePart)) return false;
  const timePart = timeAndZone.replace(/(?:Z|[+-]\d{2}:\d{2})$/i, "");
  const [hour, minute, second = "0"] = timePart.split(":");
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) < 60;
}

export function retentionHasExpired(retentionUntil: string | null, now: Date): boolean {
  if (!retentionUntil) return false;
  const timestamp = Date.parse(retentionUntil);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

export function isHardPurgeEligible(
  record: { legalHold: boolean; retentionUntil: string | null; deletedAt: string | null },
  now: Date,
  purgeCutoff: Date,
): boolean {
  if (record.legalHold || !record.deletedAt || !retentionHasExpired(record.retentionUntil, now)) return false;
  const deletedAt = Date.parse(record.deletedAt);
  return Number.isFinite(deletedAt) && deletedAt <= purgeCutoff.getTime();
}

/** Only fully executed/active agreements may enter automatic retention deletion. */
export function isTerminalAgreementStage(stage: string): boolean {
  return stage === "Active";
}

export function resolvePurgeGraceDays(value: string | null | undefined): number {
  if (!value) return DEFAULT_PURGE_GRACE_DAYS;
  if (!/^\d+$/.test(value.trim())) {
    throw new RetentionPolicyError("NOTICE_RETENTION_PURGE_GRACE_DAYS must be a whole number.");
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < MIN_PURGE_GRACE_DAYS || days > MAX_PURGE_GRACE_DAYS) {
    throw new RetentionPolicyError(
      `NOTICE_RETENTION_PURGE_GRACE_DAYS must be between ${MIN_PURGE_GRACE_DAYS} and ${MAX_PURGE_GRACE_DAYS}.`,
    );
  }
  return days;
}

/**
 * A final defense against deleting a blob that is not owned by the configured
 * workspace, even if a malformed or legacy database row contains another key.
 */
export function isWorkspaceObjectKey(workspaceId: string, objectKey: string): boolean {
  return objectKey.startsWith(`workspaces/${workspaceId}/`) && !objectKey.includes("../");
}

export function constantTimeSecretEqual(expected: string, supplied: string): boolean {
  if (!expected || expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return mismatch === 0;
}

export class RetentionPolicyError extends Error {
  readonly code = "RETENTION_POLICY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type IsoDateIssueCode =
  | "ISO_DATE_REQUIRED"
  | "ISO_DATE_FORMAT_INVALID"
  | "ISO_DATE_CALENDAR_INVALID"
  | "ISO_DATE_RANGE_INVALID";

export type IsoDateIssue = Readonly<{
  code: IsoDateIssueCode;
  field: "effectiveDate" | "expirationDate";
  message: string;
}>;

export type ParsedIsoDate = Readonly<{
  /** The canonical YYYY-MM-DD representation. */
  value: string;
  year: number;
  month: number;
  day: number;
}>;

export type IsoDateParseResult =
  | Readonly<{ ok: true; value: ParsedIsoDate }>
  | Readonly<{
    ok: false;
    code: "ISO_DATE_FORMAT_INVALID" | "ISO_DATE_CALENDAR_INVALID";
  }>;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * Parse an exact proleptic-Gregorian calendar date. This intentionally does
 * not delegate to `Date.parse`, which accepts implementation-dependent date
 * shapes and silently normalizes impossible calendar dates.
 */
export function parseIsoDate(input: string): IsoDateParseResult {
  const match = ISO_DATE_PATTERN.exec(input);
  if (!match) return { ok: false, code: "ISO_DATE_FORMAT_INVALID" };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { ok: false, code: "ISO_DATE_CALENDAR_INVALID" };
  }

  return { ok: true, value: { value: input, year, month, day } };
}

/** Return a canonical date, or null when the input is not an exact valid date. */
export function normalizeIsoDate(input: string): string | null {
  const parsed = parseIsoDate(input);
  return parsed.ok ? parsed.value.value : null;
}

export type AgreementDatePairValidation = Readonly<{
  valid: boolean;
  value: Readonly<{
    effectiveDate: string | null;
    expirationDate: string | null;
  }>;
  issues: readonly IsoDateIssue[];
}>;

function validateField(
  field: "effectiveDate" | "expirationDate",
  input: unknown,
  allowEmpty: boolean,
): Readonly<{ value: string | null; issue: IsoDateIssue | null }> {
  if (input === "" || input === null || input === undefined) {
    return allowEmpty
      ? { value: null, issue: null }
      : {
        value: null,
        issue: { code: "ISO_DATE_REQUIRED", field, message: `${field} is required.` },
      };
  }
  if (typeof input !== "string") {
    return {
      value: null,
      issue: { code: "ISO_DATE_FORMAT_INVALID", field, message: `${field} must use YYYY-MM-DD.` },
    };
  }
  const parsed = parseIsoDate(input);
  if (!parsed.ok) {
    return {
      value: null,
      issue: {
        code: parsed.code,
        field,
        message: parsed.code === "ISO_DATE_FORMAT_INVALID"
          ? `${field} must use YYYY-MM-DD.`
          : `${field} is not a valid calendar date.`,
      },
    };
  }
  return { value: parsed.value.value, issue: null };
}

/**
 * Validate and normalize the agreement term. Empty dates may be permitted for
 * an incomplete draft, but any supplied value is always held to the strict
 * calendar grammar. Canonical strings sort in calendar order.
 */
export function validateAgreementDatePair(
  input: Readonly<{ effectiveDate: unknown; expirationDate: unknown }>,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): AgreementDatePairValidation {
  const allowEmpty = options.allowEmpty ?? false;
  const effective = validateField("effectiveDate", input.effectiveDate, allowEmpty);
  const expiration = validateField("expirationDate", input.expirationDate, allowEmpty);
  const issues: IsoDateIssue[] = [];
  if (effective.issue) issues.push(effective.issue);
  if (expiration.issue) issues.push(expiration.issue);

  if (
    effective.value !== null
    && expiration.value !== null
    && effective.value > expiration.value
  ) {
    issues.push({
      code: "ISO_DATE_RANGE_INVALID",
      field: "expirationDate",
      message: "expirationDate must be on or after effectiveDate.",
    });
  }

  return {
    valid: issues.length === 0,
    value: {
      effectiveDate: effective.value,
      expirationDate: expiration.value,
    },
    issues,
  };
}

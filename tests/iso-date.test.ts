import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIsoDate, parseIsoDate, validateAgreementDatePair } from "../app/lib/iso-date";

test("strict ISO dates accept real calendar days and preserve their canonical form", () => {
  assert.deepEqual(parseIsoDate("2028-02-29"), {
    ok: true,
    value: { value: "2028-02-29", year: 2028, month: 2, day: 29 },
  });
  assert.equal(normalizeIsoDate("2000-02-29"), "2000-02-29");
  assert.equal(normalizeIsoDate("9999-12-31"), "9999-12-31");
});

test("strict ISO dates reject normalization tricks and impossible dates", () => {
  for (const value of [
    "2026-2-03",
    "2026-02-3",
    " 2026-02-03",
    "2026-02-03 ",
    "2026-02-03T00:00:00Z",
    "26-02-03",
  ]) {
    assert.deepEqual(parseIsoDate(value), { ok: false, code: "ISO_DATE_FORMAT_INVALID" });
    assert.equal(normalizeIsoDate(value), null);
  }
  for (const value of ["0000-01-01", "1900-02-29", "2026-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00"]) {
    assert.deepEqual(parseIsoDate(value), { ok: false, code: "ISO_DATE_CALENDAR_INVALID" });
    assert.equal(normalizeIsoDate(value), null);
  }
});

test("agreement date pairs require canonical dates and permit equal endpoints", () => {
  assert.deepEqual(validateAgreementDatePair({
    effectiveDate: "2026-09-01",
    expirationDate: "2026-09-01",
  }), {
    valid: true,
    value: { effectiveDate: "2026-09-01", expirationDate: "2026-09-01" },
    issues: [],
  });

  const invalid = validateAgreementDatePair({
    effectiveDate: "2026-9-01",
    expirationDate: "soon",
  });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.issues.map((issue) => issue.code), ["ISO_DATE_FORMAT_INVALID", "ISO_DATE_FORMAT_INVALID"]);
  assert.deepEqual(invalid.value, { effectiveDate: null, expirationDate: null });
});

test("agreement terms fail closed when effective date is after expiration", () => {
  const result = validateAgreementDatePair({
    effectiveDate: "2027-01-01",
    expirationDate: "2026-12-31",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((issue) => [issue.code, issue.field]), [["ISO_DATE_RANGE_INVALID", "expirationDate"]]);
});

test("draft callers can explicitly permit absent dates without weakening supplied dates", () => {
  assert.deepEqual(validateAgreementDatePair(
    { effectiveDate: "", expirationDate: null },
    { allowEmpty: true },
  ), {
    valid: true,
    value: { effectiveDate: null, expirationDate: null },
    issues: [],
  });
  assert.deepEqual(
    validateAgreementDatePair({ effectiveDate: "", expirationDate: "" }).issues.map((issue) => issue.code),
    ["ISO_DATE_REQUIRED", "ISO_DATE_REQUIRED"],
  );
  assert.equal(validateAgreementDatePair(
    { effectiveDate: undefined, expirationDate: "2026-02-30" },
    { allowEmpty: true },
  ).issues[0]?.code, "ISO_DATE_CALENDAR_INVALID");
});

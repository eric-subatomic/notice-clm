import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCurrencyCode,
  currencyMinorDigits,
  formatMoney,
  minorUnitsFromWholeUnits,
  wholeUnitProjection,
} from "../app/lib/money";

test("currency codes and minor-unit exponents are canonical and deterministic", () => {
  assert.equal(canonicalCurrencyCode(" usd "), "USD");
  assert.equal(canonicalCurrencyCode("US"), null);
  assert.equal(canonicalCurrencyCode("US1"), null);
  assert.equal(currencyMinorDigits("USD"), 2);
  assert.equal(currencyMinorDigits("JPY"), 0);
  assert.equal(currencyMinorDigits("KWD"), 3);
});

test("whole and minor amount projections preserve supported currency semantics", () => {
  assert.equal(minorUnitsFromWholeUnits(125_000, "USD"), 12_500_000);
  assert.equal(minorUnitsFromWholeUnits(125_000, "JPY"), 125_000);
  assert.equal(minorUnitsFromWholeUnits(12, "KWD"), 12_000);
  assert.equal(wholeUnitProjection(12_550, "USD"), 126);
  assert.equal(formatMoney(12_550, "USD"), "$125.50");
  assert.throws(() => minorUnitsFromWholeUnits(-1, "USD"), /non-negative/);
  assert.throws(() => wholeUnitProjection(Number.MAX_SAFE_INTEGER, "USD"), /supported/);
});

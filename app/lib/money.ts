const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export const DEFAULT_CURRENCY_CODE = "USD" as const;
export const MAX_MONEY_MINOR = 9_000_000_000_000_000;

/** Canonical ISO-4217-shaped code. Deployment policy may restrict this set
 * further, but business records never accept mixed case or arbitrary labels. */
export function canonicalCurrencyCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

export function currencyMinorDigits(currencyCode: string): 0 | 2 | 3 {
  const code = canonicalCurrencyCode(currencyCode);
  if (!code) throw new TypeError("Currency code must contain exactly three letters");
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export function minorUnitsFromWholeUnits(value: number, currencyCode: string = DEFAULT_CURRENCY_CODE): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Whole-unit amount must be a non-negative safe integer");
  const result = value * 10 ** currencyMinorDigits(currencyCode);
  if (!Number.isSafeInteger(result) || result > MAX_MONEY_MINOR) throw new RangeError("Amount exceeds the supported minor-unit range");
  return result;
}

export function wholeUnitProjection(valueMinor: number, currencyCode: string = DEFAULT_CURRENCY_CODE): number {
  if (!Number.isSafeInteger(valueMinor) || valueMinor < 0 || valueMinor > MAX_MONEY_MINOR) {
    throw new TypeError("Minor-unit amount must be a supported non-negative safe integer");
  }
  return Math.round(valueMinor / 10 ** currencyMinorDigits(currencyCode));
}

export function formatMoney(valueMinor: number, currencyCode: string, locale = "en-US"): string {
  const code = canonicalCurrencyCode(currencyCode);
  if (!code) throw new TypeError("Currency code must contain exactly three letters");
  const digits = currencyMinorDigits(code);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(valueMinor / 10 ** digits);
}

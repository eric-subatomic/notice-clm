import {
  CrmProviderError,
  type AgreementProjection,
  type AgreementTombstone,
  type CanonicalCrmEvent,
} from "./types";

const PLACEHOLDER_PATTERN = /(?:change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|placeholder|todo)/i;
const TOPIC_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAPPING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LEGACY_WHOLE_UNIT_MAX = 9_000_000_000_000;
const MAX_MONEY_MINOR = 9_000_000_000_000_000;
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const EVENT_KEYS = new Set([
  "eventId",
  "workspaceId",
  "topic",
  "occurredAt",
  "agreementId",
  "externalKey",
  "aggregateVersion",
  "mappingVersion",
  "deleted",
  "projection",
  "tombstone",
]);

const PROJECTION_KEYS = new Set([
  "externalKey",
  "workspaceId",
  "agreementId",
  "version",
  "party",
  "type",
  "value",
  "valueMinor",
  "currencyCode",
  "stage",
  "owner",
  "department",
  "risk",
  "approvalStatus",
  "signatureStatus",
  "effectiveDate",
  "expirationDate",
  "crm",
  "crmRecord",
  "updatedAt",
]);

const TOMBSTONE_KEYS = new Set([
  "externalKey",
  "workspaceId",
  "agreementId",
  "version",
  "deletedAt",
  "crm",
  "crmRecord",
]);

function invalidConfig(): never {
  throw new CrmProviderError("CRM_CONFIG_INVALID", false);
}

function invalidEvent(): never {
  throw new CrmProviderError("CRM_EVENT_INVALID", false);
}

export function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const candidate = source[key];
  if (candidate === undefined || candidate === null || candidate === "") return null;
  if (typeof candidate !== "string") invalidConfig();
  const value = candidate.trim();
  if (value.length === 0 || value.length > maxLength || value.includes("\0")) invalidConfig();
  return value;
}

export function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  limits: Readonly<{ min: number; max: number; secret?: boolean }>,
): string {
  const candidate = source[key];
  if (typeof candidate !== "string") invalidConfig();
  const value = candidate.trim();
  if (
    value.length < limits.min
    || value.length > limits.max
    || value.includes("\0")
    || (limits.secret === true && PLACEHOLDER_PATTERN.test(value))
  ) invalidConfig();
  return value;
}

export function readProviderName(source: Record<string, unknown>): "hubspot" | "salesforce" | "custom" {
  const value = readRequiredString(source, "NOTICE_CRM_PROVIDER", { min: 1, max: 32 }).toLowerCase();
  if (value !== "hubspot" && value !== "salesforce" && value !== "custom") invalidConfig();
  return value;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const values = octets.map(Number);
  if (values.some((value) => value < 0 || value > 255)) return true;
  return values[0] === 0
    || values[0] === 10
    || values[0] === 127
    || (values[0] === 169 && values[1] === 254)
    || (values[0] === 172 && values[1] >= 16 && values[1] <= 31)
    || (values[0] === 192 && values[1] === 168)
    || values[0] >= 224;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isUnsafeHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower.length === 0
    || lower.length > 253
    || lower.endsWith(".local")
    || lower.endsWith(".internal")
    || lower.endsWith(".localhost")
    || lower.endsWith(".invalid")
    || lower.endsWith(".example")
    || lower.endsWith(".test")
    || isPrivateIpv4(lower)
    || lower.includes(":")
  ) return true;
  return lower.split(".").some((label) => !SAFE_HOST_LABEL_PATTERN.test(label));
}

export function parseRemoteHttpsUrl(
  raw: string,
  options: Readonly<{
    allowTestLocalhost?: boolean;
    testEnvironment?: boolean;
    allowedHostname?: (hostname: string) => boolean;
    requireOriginOnly?: boolean;
  }> = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalidConfig();
  }

  const localTest = options.allowTestLocalhost === true
    && options.testEnvironment === true
    && isLocalHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !(localTest && url.protocol === "http:"))
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
    || (url.port !== "" && !(localTest && /^\d{2,5}$/.test(url.port)))
    || (!localTest && isUnsafeHostname(url.hostname))
    || (options.allowedHostname !== undefined && !options.allowedHostname(url.hostname.toLowerCase()))
    || (options.requireOriginOnly === true && (url.pathname !== "/" || url.search !== ""))
  ) invalidConfig();
  return url;
}

export function requirePattern(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) invalidConfig();
  return value;
}

function boundedText(candidate: unknown, max: number, allowEmpty = false): string {
  if (typeof candidate !== "string" || candidate.length > max || candidate.includes("\0")) invalidEvent();
  if (!allowEmpty && candidate.length === 0) invalidEvent();
  return candidate;
}

function positiveInteger(candidate: unknown): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) invalidEvent();
  return candidate as number;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) invalidEvent();
}

function wholeUnitProjection(valueMinor: number, currencyCode: string): number {
  const digits = ZERO_DECIMAL_CURRENCIES.has(currencyCode)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(currencyCode)
      ? 3
      : 2;
  return Math.round(valueMinor / 10 ** digits);
}

function validateProjection(candidate: unknown): AgreementProjection {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) invalidEvent();
  const value = candidate as Record<string, unknown>;
  exactKeys(value, PROJECTION_KEYS);
  const updatedAt = boundedText(value.updatedAt, 64);
  if (!updatedAt.includes("T") || !Number.isFinite(Date.parse(updatedAt))) invalidEvent();
  const monetaryValue = value.value;
  if (!Number.isSafeInteger(monetaryValue) || (monetaryValue as number) < 0) {
    invalidEvent();
  }
  if ((value.valueMinor === undefined) !== (value.currencyCode === undefined)) invalidEvent();
  const valueMinor = value.valueMinor ?? (monetaryValue as number) * 100;
  if (!Number.isSafeInteger(valueMinor) || (valueMinor as number) < 0 || (valueMinor as number) > MAX_MONEY_MINOR) {
    invalidEvent();
  }
  const currencyCode = value.currencyCode ?? "USD";
  if (typeof currencyCode !== "string" || !/^[A-Z]{3}$/.test(currencyCode)) invalidEvent();
  if (value.valueMinor === undefined) {
    if ((monetaryValue as number) > LEGACY_WHOLE_UNIT_MAX) invalidEvent();
  } else if ((monetaryValue as number) !== wholeUnitProjection(valueMinor as number, currencyCode)) {
    invalidEvent();
  }
  return {
    externalKey: boundedText(value.externalKey, 256),
    workspaceId: boundedText(value.workspaceId, 128),
    agreementId: positiveInteger(value.agreementId),
    version: positiveInteger(value.version),
    party: boundedText(value.party, 200),
    type: boundedText(value.type, 200),
    value: monetaryValue as number,
    valueMinor: valueMinor as number,
    currencyCode,
    stage: boundedText(value.stage, 64),
    owner: boundedText(value.owner, 200),
    department: boundedText(value.department, 100),
    risk: boundedText(value.risk, 64),
    approvalStatus: boundedText(value.approvalStatus, 64),
    signatureStatus: boundedText(value.signatureStatus, 64),
    effectiveDate: boundedText(value.effectiveDate, 100, true),
    expirationDate: boundedText(value.expirationDate, 100, true),
    crm: boundedText(value.crm, 64),
    crmRecord: boundedText(value.crmRecord, 500, true),
    updatedAt,
  };
}

function validateIsoTimestamp(candidate: unknown): string {
  const value = boundedText(candidate, 64);
  if (!value.includes("T") || !Number.isFinite(Date.parse(value))) invalidEvent();
  return value;
}

function validateTombstone(candidate: unknown): AgreementTombstone {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) invalidEvent();
  const value = candidate as Record<string, unknown>;
  exactKeys(value, TOMBSTONE_KEYS);
  return {
    externalKey: boundedText(value.externalKey, 256),
    workspaceId: boundedText(value.workspaceId, 128),
    agreementId: positiveInteger(value.agreementId),
    version: positiveInteger(value.version),
    deletedAt: validateIsoTimestamp(value.deletedAt),
    crm: boundedText(value.crm, 64),
    crmRecord: boundedText(value.crmRecord, 500, true),
  };
}

export function validateCanonicalEvent(candidate: CanonicalCrmEvent): CanonicalCrmEvent {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) invalidEvent();
  const value = candidate as unknown as Record<string, unknown>;
  exactKeys(value, EVENT_KEYS);
  const workspaceId = boundedText(value.workspaceId, 128);
  const agreementId = positiveInteger(value.agreementId);
  const expectedExternalKey = `notice:${workspaceId}:agreement:${agreementId}`;
  const externalKey = boundedText(value.externalKey, 256);
  if (externalKey !== expectedExternalKey) invalidEvent();
  const eventId = boundedText(value.eventId, 256);
  const topic = boundedText(value.topic, 128);
  const occurredAt = validateIsoTimestamp(value.occurredAt);
  const mappingVersion = boundedText(value.mappingVersion, 64);
  if (!TOPIC_PATTERN.test(topic) || !MAPPING_VERSION_PATTERN.test(mappingVersion)) invalidEvent();
  if (typeof value.deleted !== "boolean") invalidEvent();
  const aggregateVersion = positiveInteger(value.aggregateVersion);
  const projection = value.projection === null ? null : validateProjection(value.projection);
  const tombstone = value.tombstone === null ? null : validateTombstone(value.tombstone);
  if (projection === null && value.deleted !== true) invalidEvent();
  if (value.deleted === true && tombstone === null) invalidEvent();
  if (value.deleted === false && tombstone !== null) invalidEvent();
  if (
    projection !== null
    && (
      projection.externalKey !== externalKey
      || projection.workspaceId !== workspaceId
      || projection.agreementId !== agreementId
      || projection.version !== aggregateVersion
    )
  ) invalidEvent();
  if (
    tombstone !== null
    && (
      tombstone.externalKey !== externalKey
      || tombstone.workspaceId !== workspaceId
      || tombstone.agreementId !== agreementId
      || tombstone.version !== aggregateVersion
    )
  ) invalidEvent();
  return {
    eventId,
    workspaceId,
    topic,
    occurredAt,
    agreementId,
    externalKey,
    aggregateVersion,
    mappingVersion,
    deleted: value.deleted,
    projection,
    tombstone,
  };
}

export function isTestEnvironment(source: Record<string, unknown>): boolean {
  return source.NOTICE_ENVIRONMENT === "test";
}

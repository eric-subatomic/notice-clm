export type EnterpriseErrorStatus = 400 | 403 | 404 | 409 | 422;

export class EnterpriseError extends Error {
  constructor(
    readonly status: EnterpriseErrorStatus,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "EnterpriseError";
  }
}

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertSafeEnterpriseText(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (UNSAFE_TEXT.test(normalized)) {
    throw new EnterpriseError(400, "unsafe_text", `${label} contains unsafe formatting characters.`);
  }
  return normalized;
}

export function omitEnterpriseProperties<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

function normalizePartyToken(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeCounterpartyDomain(value: string): string {
  const candidate = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!candidate) return "";
  const withoutProtocol = candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = withoutProtocol.split(/[/?#]/, 1)[0]?.replace(/:\d+$/, "") ?? "";
  return host.replace(/^www\./, "").replace(/\.+$/, "");
}

/**
 * Produce the sole server-owned counterparty identity key. Strong identifiers
 * take precedence over names so display-name edits never bypass deduplication.
 */
export function counterpartyDedupeKey(input: Readonly<{
  legalName: string;
  domain?: string;
  jurisdiction?: string;
  registrationNumber?: string;
  externalId?: string;
}>): string {
  const registrationNumber = normalizePartyToken(input.registrationNumber ?? "").replace(/\s/g, "");
  const jurisdiction = normalizePartyToken(input.jurisdiction ?? "");
  if (registrationNumber) return `v1:registration:${jurisdiction}:${registrationNumber}`;

  const domain = normalizeCounterpartyDomain(input.domain ?? "");
  if (domain) return `v1:domain:${domain}`;

  const externalId = normalizePartyToken(input.externalId ?? "");
  if (externalId) return `v1:external:${externalId}`;

  return `v1:name:${jurisdiction}:${normalizePartyToken(input.legalName)}`;
}

export type JsonBounds = Readonly<{
  maxBytes: number;
  maxDepth?: number;
  maxNodes?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}>;

/** Validate JSON recursively without recursion, getters, or lossy coercion. */
export function assertBoundedJson(value: unknown, bounds: JsonBounds): void {
  const maxDepth = bounds.maxDepth ?? 12;
  const maxNodes = bounds.maxNodes ?? 5_000;
  const maxArrayLength = bounds.maxArrayLength ?? 500;
  const maxObjectKeys = bounds.maxObjectKeys ?? 200;
  const maxStringLength = bounds.maxStringLength ?? 20_000;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) {
      throw new EnterpriseError(400, "json_too_complex", "JSON content contains too many values.");
    }
    if (entry.depth > maxDepth) {
      throw new EnterpriseError(400, "json_too_deep", "JSON content is nested too deeply.");
    }
    const candidate = entry.value;
    if (candidate === null || typeof candidate === "boolean") continue;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new EnterpriseError(400, "invalid_json_number", "JSON numbers must be finite.");
      }
      continue;
    }
    if (typeof candidate === "string") {
      if (candidate.length > maxStringLength) {
        throw new EnterpriseError(400, "json_string_too_long", "JSON text exceeds the allowed length.");
      }
      continue;
    }
    if (typeof candidate !== "object") {
      throw new EnterpriseError(400, "invalid_json_value", "Only JSON values are accepted.");
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > maxArrayLength) {
        throw new EnterpriseError(400, "json_array_too_large", "A JSON array exceeds the allowed item count.");
      }
      for (const item of candidate) stack.push({ value: item, depth: entry.depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EnterpriseError(400, "invalid_json_object", "JSON objects must be plain records.");
    }
    const keys = Object.keys(candidate);
    if (keys.length > maxObjectKeys) {
      throw new EnterpriseError(400, "json_object_too_large", "A JSON object has too many properties.");
    }
    for (const key of keys) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new EnterpriseError(400, "unsafe_json_key", "JSON content contains a reserved property name.");
      }
      if (key.length > 200 || UNSAFE_TEXT.test(key)) {
        throw new EnterpriseError(400, "invalid_json_key", "JSON property names must be short, safe text.");
      }
      stack.push({ value: (candidate as Record<string, unknown>)[key], depth: entry.depth + 1 });
    }
  }

  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > bounds.maxBytes) {
    throw new EnterpriseError(400, "json_too_large", `JSON content exceeds ${bounds.maxBytes} bytes.`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export async function enterpriseContentDigest(value: unknown, maxBytes = 65_536): Promise<string> {
  assertBoundedJson(value, { maxBytes });
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertExpectedVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new EnterpriseError(409, "version_conflict", "This record changed. Reload before retrying.");
  }
}

export function assertLifecycleTransition(
  current: "draft" | "published" | "retired",
  next: "published" | "retired",
): void {
  const allowed = (current === "draft" && next === "published") || (current === "published" && next === "retired");
  if (!allowed) {
    throw new EnterpriseError(409, "invalid_lifecycle_transition", `A ${current} record cannot transition to ${next}.`);
  }
}

export function assertDistinctPublisher(createdByUserId: string, publisherUserId: string): void {
  if (createdByUserId === publisherUserId) {
    throw new EnterpriseError(409, "independent_review_required", "A different active workspace member must publish this draft.");
  }
}

export function nextTimestampAfter(previous: string, now = new Date()): string {
  const previousMs = Date.parse(previous);
  const nowMs = now.getTime();
  return new Date(Number.isFinite(previousMs) ? Math.max(nowMs, previousMs + 1) : nowMs).toISOString();
}

export type EnterpriseFieldDataType = "text" | "number" | "date" | "boolean" | "single_select" | "multi_select";

export type EnterpriseFieldDefinition = Readonly<{
  dataType: EnterpriseFieldDataType;
  options: readonly string[];
  required: boolean;
}>;

function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateTypedFieldValue(definition: EnterpriseFieldDefinition, value: unknown): void {
  const fail = (message: string): never => {
    throw new EnterpriseError(422, "custom_field_type_mismatch", message);
  };
  if (value === null) {
    if (definition.required) fail("A value is required for this custom field.");
    return;
  }
  switch (definition.dataType) {
    case "text":
      if (typeof value !== "string" || value.length > 10_000 || UNSAFE_TEXT.test(value) || (definition.required && !value.trim())) {
        fail("The custom field value must be bounded text.");
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 9_000_000_000_000_000) {
        fail("The custom field value must be a finite bounded number.");
      }
      break;
    case "date":
      if (typeof value !== "string" || !isRealIsoDate(value)) fail("The custom field value must be a real YYYY-MM-DD date.");
      break;
    case "boolean":
      if (typeof value !== "boolean") fail("The custom field value must be true or false.");
      break;
    case "single_select":
      if (typeof value !== "string" || !definition.options.includes(value)) fail("The custom field value must be an allowed option.");
      break;
    case "multi_select": {
      if (!Array.isArray(value)) fail("The custom field value must contain only allowed options.");
      const items = value as unknown[];
      if (items.length > 100 || items.some((item) => typeof item !== "string" || !definition.options.includes(item))) {
        fail("The custom field value must contain only allowed options.");
      }
      if (new Set(items).size !== items.length) fail("Multi-select values must be unique.");
      if (definition.required && items.length === 0) fail("At least one custom field option is required.");
      break;
    }
  }
}

export function validateDefinitionOptions(dataType: EnterpriseFieldDataType, options: readonly string[]): void {
  const unique = new Set(options);
  if (unique.size !== options.length) {
    throw new EnterpriseError(400, "duplicate_field_option", "Custom field options must be unique.");
  }
  if (options.some((option) => !option.trim() || option.length > 200 || UNSAFE_TEXT.test(option))) {
    throw new EnterpriseError(400, "invalid_field_option", "Custom field options must be short, safe text.");
  }
  if (new TextEncoder().encode(JSON.stringify(options)).byteLength > 8_192) {
    throw new EnterpriseError(400, "field_options_too_large", "Custom field options exceed 8192 JSON bytes.");
  }
  const selectable = dataType === "single_select" || dataType === "multi_select";
  if (selectable !== (options.length > 0)) {
    throw new EnterpriseError(400, "invalid_field_options", selectable
      ? "Select fields require at least one option."
      : "Only select fields may define options.");
  }
}

export type IntakeField = Readonly<{
  key: string;
  label: string;
  type: EnterpriseFieldDataType;
  required: boolean;
  options: readonly string[];
}>;

export type IntakeFormSchema = Readonly<{
  fields: readonly IntakeField[];
  submitLabel?: string;
}>;

export function validateIntakeAnswers(
  schema: IntakeFormSchema,
  answers: Record<string, unknown>,
  options: Readonly<{ requireComplete?: boolean }> = {},
): void {
  assertBoundedJson(answers, { maxBytes: 131_072, maxObjectKeys: 200 });
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  const unknownKey = Object.keys(answers).find((key) => !fields.has(key));
  if (unknownKey) {
    throw new EnterpriseError(422, "unknown_intake_answer", `Answer ${unknownKey} is not defined by this intake form.`);
  }
  for (const field of schema.fields) {
    const supplied = Object.prototype.hasOwnProperty.call(answers, field.key);
    if (!supplied && options.requireComplete === false) continue;
    const value = supplied ? answers[field.key] : null;
    try {
      validateTypedFieldValue({
        dataType: field.type,
        options: field.options,
        required: options.requireComplete === false ? false : field.required,
      }, value);
    } catch (error) {
      if (error instanceof EnterpriseError) {
        throw new EnterpriseError(422, "invalid_intake_answer", `${field.label}: ${error.message}`, { field: field.key });
      }
      throw error;
    }
  }
}

export function databaseErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function isUniqueConstraintError(error: unknown, fragments: readonly string[]): boolean {
  const message = databaseErrorMessage(error);
  return message.includes("unique constraint failed") && fragments.every((fragment) => message.includes(fragment.toLowerCase()));
}

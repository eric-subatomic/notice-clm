import { boundedResponseId, providerFetch, readBoundedJson, throwForProviderStatus, type FetchLike } from "./http";
import { buildFieldMapping, mapCanonicalEvent, type FieldMapping, type MappedValue } from "./mapping";
import { CrmProviderError, type CanonicalCrmEvent, type CrmAdapter, type CrmUpsertResult } from "./types";
import { parseRemoteHttpsUrl, readOptionalString, readRequiredString, requirePattern, validateCanonicalEvent } from "./validation";

const HUBSPOT_OBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HUBSPOT_PROPERTY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;

type HubSpotConfig = Readonly<{
  apiBaseUrl: URL;
  accessToken: string;
  objectType: string;
  idProperty: string;
  mapping: FieldMapping;
}>;

type HubSpotProperty = Readonly<{
  name: string;
  type: string;
  archived: boolean;
  calculated: boolean;
  hasUniqueValue: boolean;
  readOnlyValue: boolean;
}>;

function isHubSpotApiHost(hostname: string): boolean {
  return hostname === "api.hubapi.com" || /^api-[a-z0-9-]+\.hubapi\.com$/.test(hostname);
}

function parseHubSpotConfig(source: Record<string, unknown>): HubSpotConfig {
  const apiBaseRaw = readOptionalString(source, "NOTICE_CRM_HUBSPOT_API_BASE_URL", 300)
    ?? "https://api.hubapi.com";
  const apiBaseUrl = parseRemoteHttpsUrl(apiBaseRaw, {
    allowedHostname: isHubSpotApiHost,
    requireOriginOnly: true,
  });
  const accessToken = readRequiredString(source, "NOTICE_CRM_HUBSPOT_ACCESS_TOKEN", {
    min: 20,
    max: 4_096,
    secret: true,
  });
  const objectType = requirePattern(
    readRequiredString(source, "NOTICE_CRM_HUBSPOT_OBJECT_TYPE", { min: 1, max: 80 }),
    HUBSPOT_OBJECT_PATTERN,
  );
  const idProperty = requirePattern(
    readRequiredString(source, "NOTICE_CRM_HUBSPOT_ID_PROPERTY", { min: 1, max: 100 }),
    HUBSPOT_PROPERTY_PATTERN,
  );
  return {
    apiBaseUrl,
    accessToken,
    objectType,
    idProperty,
    mapping: buildFieldMapping("hubspot", source.NOTICE_CRM_FIELD_MAPPING_JSON, idProperty),
  };
}

function hubSpotProperties(values: Readonly<Record<string, MappedValue>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === null ? "" : String(value)]),
  );
}

function upsertResult(payload: unknown): CrmUpsertResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }
  const record = payload as Record<string, unknown>;
  if (record.status === "PENDING" || record.status === "PROCESSING" || record.status === "CANCELED") {
    // The request is idempotent by external ID, so retrying is safer than
    // acknowledging a batch that has not proved completion.
    throw new CrmProviderError("CRM_PROVIDER_UNAVAILABLE", true);
  }
  if (record.status !== "COMPLETE") {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }

  const errors = record.errors;
  const numErrors = record.numErrors;
  if (
    (errors !== undefined && (!Array.isArray(errors) || errors.length > 0))
    || (numErrors !== undefined && (!Number.isSafeInteger(numErrors) || (numErrors as number) !== 0))
  ) {
    throw new CrmProviderError("CRM_PROVIDER_REJECTED", false);
  }

  const results = record.results;
  if (!Array.isArray(results) || results.length !== 1) {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }
  const first = results[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }
  const providerRecordId = boundedResponseId((first as { id?: unknown }).id);
  if (providerRecordId === null) throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  return { providerRecordId };
}

function invalidProviderResponse(): never {
  throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
}

function incompatibleProviderSchema(): never {
  throw new CrmProviderError("CRM_PROVIDER_SCHEMA_INCOMPATIBLE", false);
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") invalidProviderResponse();
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") invalidProviderResponse();
  return value;
}

function hubSpotPropertyCatalog(payload: unknown): ReadonlyMap<string, HubSpotProperty> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    invalidProviderResponse();
  }
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length > 2_000) invalidProviderResponse();

  const properties = new Map<string, HubSpotProperty>();
  for (const candidate of results) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      invalidProviderResponse();
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== "string" || !HUBSPOT_PROPERTY_PATTERN.test(record.name)) {
      invalidProviderResponse();
    }
    if (typeof record.type !== "string" || record.type.length === 0 || record.type.length > 64) {
      invalidProviderResponse();
    }
    if (
      typeof record.modificationMetadata !== "object"
      || record.modificationMetadata === null
      || Array.isArray(record.modificationMetadata)
      || properties.has(record.name)
    ) {
      invalidProviderResponse();
    }
    properties.set(record.name, {
      name: record.name,
      type: record.type,
      // The list endpoint filters archived properties server-side and older
      // response shapes omit these two otherwise-useful flags.
      archived: readOptionalBoolean(record, "archived"),
      calculated: readOptionalBoolean(record, "calculated"),
      hasUniqueValue: readBoolean(record, "hasUniqueValue"),
      readOnlyValue: readBoolean(record.modificationMetadata as Record<string, unknown>, "readOnlyValue"),
    });
  }
  return properties;
}

function verifyHubSpotSchema(
  payload: unknown,
  mapping: FieldMapping,
  externalIdProperty: string,
): void {
  const properties = hubSpotPropertyCatalog(payload);
  for (const propertyName of Object.values(mapping)) {
    const property = properties.get(propertyName);
    if (
      property === undefined
      || property.archived
      || property.calculated
      || property.readOnlyValue
    ) {
      incompatibleProviderSchema();
    }
  }
  const externalId = properties.get(externalIdProperty);
  if (externalId === undefined || externalId.type !== "string" || !externalId.hasUniqueValue) {
    incompatibleProviderSchema();
  }
}

export class HubSpotAdapter implements CrmAdapter {
  readonly provider = "hubspot" as const;
  readonly #config: HubSpotConfig;
  readonly #fetcher: FetchLike;

  constructor(source: Record<string, unknown>, fetcher: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.#config = parseHubSpotConfig(source);
    this.#fetcher = fetcher;
  }

  async upsert(candidate: CanonicalCrmEvent): Promise<CrmUpsertResult> {
    const event = validateCanonicalEvent(candidate);
    const url = new URL(
      `/crm/v3/objects/${encodeURIComponent(this.#config.objectType)}/batch/upsert`,
      this.#config.apiBaseUrl,
    );
    const response = await providerFetch(this.#fetcher, url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        inputs: [{
          id: event.externalKey,
          idProperty: this.#config.idProperty,
          properties: hubSpotProperties(mapCanonicalEvent(event, this.#config.mapping)),
        }],
      }),
    });
    throwForProviderStatus(response);
    return upsertResult(await readBoundedJson(response));
  }

  async testConnection(): Promise<void> {
    const url = new URL(
      `/crm/v3/properties/${encodeURIComponent(this.#config.objectType)}`,
      this.#config.apiBaseUrl,
    );
    url.searchParams.set("archived", "false");
    const response = await providerFetch(this.#fetcher, url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#config.accessToken}`,
      },
    });
    throwForProviderStatus(response);
    verifyHubSpotSchema(
      await readBoundedJson(response, 256 * 1_024),
      this.#config.mapping,
      this.#config.idProperty,
    );
  }
}

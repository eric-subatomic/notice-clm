import {
  boundedResponseId,
  providerFetch,
  readBoundedJson,
  throwForProviderStatus,
  type FetchLike,
} from "./http";
import { buildFieldMapping, mapCanonicalEvent, type FieldMapping } from "./mapping";
import { CrmProviderError, type CanonicalCrmEvent, type CrmAdapter, type CrmUpsertResult } from "./types";
import { parseRemoteHttpsUrl, readOptionalString, readRequiredString, requirePattern, validateCanonicalEvent } from "./validation";

const SALESFORCE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const SALESFORCE_API_VERSION_PATTERN = /^v(?:[3-9]\d)\.0$/;
const MAPPING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1_000;
const MIN_TOKEN_TTL_MS = 60 * 1_000;
const MAX_TOKEN_TTL_MS = 60 * 60 * 1_000;
const MAX_SHARED_TOKEN_PROFILES = 16;

type SalesforceConfig = Readonly<{
  loginUrl: URL;
  clientId: string;
  clientSecret: string;
  objectName: string;
  externalIdField: string;
  apiVersion: string;
  mappingVersion: string;
  mapping: FieldMapping;
}>;

type CachedToken = Readonly<{
  accessToken: string;
  instanceUrl: URL;
  expiresAt: number;
}>;

type SharedTokenState = {
  cachedToken: CachedToken | null;
  tokenRequest: Promise<CachedToken> | null;
};

type SalesforceField = Readonly<{
  name: string;
  createable: boolean;
  updateable: boolean;
  externalId: boolean;
}>;

const defaultFetcher: FetchLike = (input, init) => globalThis.fetch(input, init);
const sharedTokenStates = new WeakMap<FetchLike, Map<string, SharedTokenState>>();

function isSalesforceHost(hostname: string): boolean {
  return hostname === "salesforce.com"
    || hostname.endsWith(".salesforce.com")
    || hostname === "salesforce.mil"
    || hostname.endsWith(".salesforce.mil");
}

function parseSalesforceConfig(source: Record<string, unknown>): SalesforceConfig {
  const loginUrl = parseRemoteHttpsUrl(
    readOptionalString(source, "NOTICE_CRM_SALESFORCE_LOGIN_URL", 300) ?? "https://login.salesforce.com",
    { allowedHostname: isSalesforceHost, requireOriginOnly: true },
  );
  const clientId = readRequiredString(source, "NOTICE_CRM_SALESFORCE_CLIENT_ID", {
    min: 10,
    max: 512,
    secret: true,
  });
  const clientSecret = readRequiredString(source, "NOTICE_CRM_SALESFORCE_CLIENT_SECRET", {
    min: 16,
    max: 4_096,
    secret: true,
  });
  const objectName = requirePattern(
    readRequiredString(source, "NOTICE_CRM_SALESFORCE_OBJECT", { min: 1, max: 80 }),
    SALESFORCE_NAME_PATTERN,
  );
  const externalIdField = requirePattern(
    readRequiredString(source, "NOTICE_CRM_SALESFORCE_EXTERNAL_ID_FIELD", { min: 1, max: 80 }),
    SALESFORCE_NAME_PATTERN,
  );
  const apiVersion = requirePattern(
    readOptionalString(source, "NOTICE_CRM_SALESFORCE_API_VERSION", 16) ?? "v65.0",
    SALESFORCE_API_VERSION_PATTERN,
  );
  const mappingVersion = requirePattern(
    readOptionalString(source, "NOTICE_CRM_MAPPING_VERSION", 64) ?? "v1",
    MAPPING_VERSION_PATTERN,
  );
  return {
    loginUrl,
    clientId,
    clientSecret,
    objectName,
    externalIdField,
    apiVersion,
    mappingVersion,
    mapping: buildFieldMapping("salesforce", source.NOTICE_CRM_FIELD_MAPPING_JSON, externalIdField),
  };
}

async function tokenProfileFingerprint(config: SalesforceConfig): Promise<string> {
  const material = new TextEncoder().encode([
    "notice-salesforce-token-profile-v1",
    config.loginUrl.origin,
    config.clientId,
    config.clientSecret,
    config.objectName,
    config.externalIdField,
    config.apiVersion,
    config.mappingVersion,
    JSON.stringify(Object.entries(config.mapping).sort(([left], [right]) => left.localeCompare(right))),
  ].join("\u0000"));
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    material.fill(0);
  }
}

async function sharedTokenState(fetcher: FetchLike, config: SalesforceConfig): Promise<SharedTokenState> {
  const fingerprint = await tokenProfileFingerprint(config);
  let profiles = sharedTokenStates.get(fetcher);
  if (profiles === undefined) {
    profiles = new Map();
    sharedTokenStates.set(fetcher, profiles);
  }
  const existing = profiles.get(fingerprint);
  if (existing !== undefined) {
    profiles.delete(fingerprint);
    profiles.set(fingerprint, existing);
    return existing;
  }

  while (profiles.size >= MAX_SHARED_TOKEN_PROFILES) {
    const evictable = [...profiles].find(([, state]) => state.tokenRequest === null);
    if (evictable === undefined) break;
    profiles.delete(evictable[0]);
  }
  const created: SharedTokenState = { cachedToken: null, tokenRequest: null };
  profiles.set(fingerprint, created);
  return created;
}

function tokenTtlMs(payload: Record<string, unknown>): number {
  const seconds = payload.expires_in;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return DEFAULT_TOKEN_TTL_MS;
  return Math.min(MAX_TOKEN_TTL_MS, Math.max(MIN_TOKEN_TTL_MS, Math.floor(seconds * 1_000)));
}

function nullableSalesforceFields(
  values: Readonly<Record<string, string | number | boolean | null>>,
  mapping: FieldMapping,
): Record<string, string | number | boolean | null> {
  const result = { ...values };
  for (const field of [mapping.effectiveDate, mapping.expirationDate, mapping.crmRecord]) {
    if (result[field] === "") result[field] = null;
  }
  return result;
}

function salesforceResultId(payload: unknown): string | null {
  if (payload === null) return null;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
  }
  return boundedResponseId((payload as { id?: unknown }).id);
}

function invalidProviderResponse(): never {
  throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
}

function incompatibleProviderSchema(): never {
  throw new CrmProviderError("CRM_PROVIDER_SCHEMA_INCOMPATIBLE", false);
}

function salesforceFieldCatalog(payload: unknown): ReadonlyMap<string, SalesforceField> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    invalidProviderResponse();
  }
  const description = payload as Record<string, unknown>;
  if (typeof description.createable !== "boolean" || typeof description.updateable !== "boolean") {
    invalidProviderResponse();
  }
  if (!description.createable || !description.updateable) incompatibleProviderSchema();
  const fields = description.fields;
  if (!Array.isArray(fields) || fields.length > 5_000) invalidProviderResponse();

  const catalog = new Map<string, SalesforceField>();
  for (const candidate of fields) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      invalidProviderResponse();
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.name !== "string"
      || !SALESFORCE_NAME_PATTERN.test(record.name)
      || typeof record.createable !== "boolean"
      || typeof record.updateable !== "boolean"
      || typeof record.externalId !== "boolean"
      || catalog.has(record.name)
    ) {
      invalidProviderResponse();
    }
    catalog.set(record.name, {
      name: record.name,
      createable: record.createable,
      updateable: record.updateable,
      externalId: record.externalId,
    });
  }
  return catalog;
}

function verifySalesforceSchema(
  payload: unknown,
  mapping: FieldMapping,
  externalIdField: string,
): void {
  const fields = salesforceFieldCatalog(payload);
  for (const fieldName of Object.values(mapping)) {
    const field = fields.get(fieldName);
    // A PATCH external-ID upsert may either create or update a record, and the
    // adapter sends every mapped field in both cases.
    if (field === undefined || !field.createable || !field.updateable) {
      incompatibleProviderSchema();
    }
  }
  if (fields.get(externalIdField)?.externalId !== true) incompatibleProviderSchema();
}

export class SalesforceAdapter implements CrmAdapter {
  readonly provider = "salesforce" as const;
  readonly #config: SalesforceConfig;
  readonly #fetcher: FetchLike;
  readonly #clock: () => number;
  readonly #tokenState: Promise<SharedTokenState>;

  constructor(
    source: Record<string, unknown>,
    fetcher: FetchLike = defaultFetcher,
    clock: () => number = Date.now,
  ) {
    this.#config = parseSalesforceConfig(source);
    this.#fetcher = fetcher;
    this.#clock = clock;
    this.#tokenState = sharedTokenState(fetcher, this.#config);
  }

  async #requestToken(): Promise<CachedToken> {
    const tokenUrl = new URL("/services/oauth2/token", this.#config.loginUrl);
    const response = await providerFetch(this.#fetcher, tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
      }).toString(),
    });
    throwForProviderStatus(response);
    const payload = await readBoundedJson(response, 32 * 1_024);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
    }
    const record = payload as Record<string, unknown>;
    if (
      typeof record.access_token !== "string"
      || record.access_token.length < 8
      || record.access_token.length > 8_192
      || (record.token_type !== undefined && String(record.token_type).toLowerCase() !== "bearer")
      || typeof record.instance_url !== "string"
      || record.instance_url.length > 300
    ) {
      throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
    }
    let instanceUrl: URL;
    try {
      instanceUrl = parseRemoteHttpsUrl(record.instance_url, {
        allowedHostname: isSalesforceHost,
        requireOriginOnly: true,
      });
    } catch {
      throw new CrmProviderError("CRM_PROVIDER_RESPONSE_INVALID", false);
    }
    return {
      accessToken: record.access_token,
      instanceUrl,
      // Subtract a small safety margin without making a short token immediately stale.
      expiresAt: this.#clock() + Math.max(30_000, tokenTtlMs(record) - 30_000),
    };
  }

  async #token(): Promise<CachedToken> {
    const state = await this.#tokenState;
    if (state.cachedToken !== null && state.cachedToken.expiresAt > this.#clock()) {
      return state.cachedToken;
    }
    if (state.tokenRequest === null) {
      state.tokenRequest = this.#requestToken().then((token) => {
        state.cachedToken = token;
        return token;
      }).finally(() => {
        state.tokenRequest = null;
      });
    }
    return state.tokenRequest;
  }

  async #invalidateToken(token: CachedToken): Promise<void> {
    const state = await this.#tokenState;
    if (state.cachedToken === token) state.cachedToken = null;
  }

  async #authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    let token = await this.#token();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const url = new URL(path, token.instanceUrl);
      const response = await providerFetch(this.#fetcher, url, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token.accessToken}`,
        },
      });
      if (response.status !== 401) return response;
      await this.#invalidateToken(token);
      if (attempt === 0) token = await this.#token();
    }
    throw new CrmProviderError("CRM_PROVIDER_AUTH_FAILED", false);
  }

  async upsert(candidate: CanonicalCrmEvent): Promise<CrmUpsertResult> {
    const event = validateCanonicalEvent(candidate);
    const path = [
      "",
      "services",
      "data",
      this.#config.apiVersion,
      "sobjects",
      encodeURIComponent(this.#config.objectName),
      encodeURIComponent(this.#config.externalIdField),
      encodeURIComponent(event.externalKey),
    ].join("/");
    const fields = nullableSalesforceFields(mapCanonicalEvent(event, this.#config.mapping), this.#config.mapping);
    const response = await this.#authorizedFetch(path, {
      method: "PATCH",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(fields),
    });
    throwForProviderStatus(response);
    const payload = response.status === 204 ? null : await readBoundedJson(response);
    return { providerRecordId: salesforceResultId(payload) };
  }

  async testConnection(): Promise<void> {
    const path = [
      "",
      "services",
      "data",
      this.#config.apiVersion,
      "sobjects",
      encodeURIComponent(this.#config.objectName),
      "describe",
    ].join("/");
    const response = await this.#authorizedFetch(path, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    throwForProviderStatus(response);
    verifySalesforceSchema(
      await readBoundedJson(response, 512 * 1_024),
      this.#config.mapping,
      this.#config.externalIdField,
    );
  }
}

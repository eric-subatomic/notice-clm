import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { CustomWebhookAdapter } from "../integrations/crm-gateway/src/providers/custom";
import { HubSpotAdapter } from "../integrations/crm-gateway/src/providers/hubspot";
import { SalesforceAdapter } from "../integrations/crm-gateway/src/providers/salesforce";
import { buildFieldMapping } from "../integrations/crm-gateway/src/providers/mapping";
import { CrmProviderError, type CanonicalCrmEvent } from "../integrations/crm-gateway/src/providers/types";
import { validateCanonicalEvent } from "../integrations/crm-gateway/src/providers/validation";
import {
  PROVIDER_REQUEST_TIMEOUT_MS,
  providerFetch,
  readBoundedJson,
  type FetchLike,
} from "../integrations/crm-gateway/src/providers/http";

const HUBSPOT_ENV = {
  NOTICE_CRM_PROVIDER: "hubspot",
  NOTICE_CRM_HUBSPOT_ACCESS_TOKEN: "synthetic-hubspot-credential-for-unit-tests-only",
  NOTICE_CRM_HUBSPOT_OBJECT_TYPE: "2-1234567",
  NOTICE_CRM_HUBSPOT_ID_PROPERTY: "notice_external_id",
};

const SALESFORCE_ENV = {
  NOTICE_CRM_PROVIDER: "salesforce",
  NOTICE_CRM_SALESFORCE_LOGIN_URL: "https://login.salesforce.com",
  NOTICE_CRM_SALESFORCE_CLIENT_ID: "salesforce-client-id-012345",
  NOTICE_CRM_SALESFORCE_CLIENT_SECRET: "salesforce-client-secret-0123456789",
  NOTICE_CRM_SALESFORCE_OBJECT: "Agreement__c",
  NOTICE_CRM_SALESFORCE_EXTERNAL_ID_FIELD: "Notice_External_Id__c",
  NOTICE_CRM_SALESFORCE_API_VERSION: "v65.0",
};

// Provider responses require a Salesforce-shaped instance host. This unique,
// explicitly inert fixture is never resolved because every provider call is mocked.
const SALESFORCE_INSTANCE_URL = "https://notice-fixture-do-not-route.my.salesforce.com";

const CUSTOM_SECRET = "custom-webhook-signing-secret-at-least-32-bytes";
const credentialedHttpsUrl = (host: string, path = "") =>
  `https://${["user", "password"].join(":")}@${host}${path}`;
const CUSTOM_ENV = {
  NOTICE_ENVIRONMENT: "test",
  NOTICE_CRM_PROVIDER: "custom",
  NOTICE_CRM_CUSTOM_URL: "http://localhost:8788/crm/events",
  NOTICE_CRM_CUSTOM_SECRET: CUSTOM_SECRET,
  NOTICE_CRM_MAPPING_VERSION: "2026-08-01",
};

type HubSpotPropertyFixture = {
  name: string;
  type: string;
  archived: boolean;
  calculated: boolean;
  hasUniqueValue: boolean;
  modificationMetadata: { readOnlyValue: boolean };
};

type SalesforceFieldFixture = {
  name: string;
  createable: boolean;
  updateable: boolean;
  externalId: boolean;
};

const HUBSPOT_PROPERTY_NAMES = Object.values(buildFieldMapping(
  "hubspot",
  undefined,
  HUBSPOT_ENV.NOTICE_CRM_HUBSPOT_ID_PROPERTY,
));
const SALESFORCE_FIELD_NAMES = Object.values(buildFieldMapping(
  "salesforce",
  undefined,
  SALESFORCE_ENV.NOTICE_CRM_SALESFORCE_EXTERNAL_ID_FIELD,
));

function hubSpotSchema(
  mutate?: (properties: HubSpotPropertyFixture[]) => void,
): { results: HubSpotPropertyFixture[] } {
  const results = HUBSPOT_PROPERTY_NAMES.map((name) => ({
    name,
    type: "string",
    archived: false,
    calculated: false,
    hasUniqueValue: name === HUBSPOT_ENV.NOTICE_CRM_HUBSPOT_ID_PROPERTY,
    modificationMetadata: { readOnlyValue: false },
  }));
  mutate?.(results);
  return { results };
}

function salesforceSchema(
  mutate?: (fields: SalesforceFieldFixture[]) => void,
): {
  name: string;
  createable: boolean;
  updateable: boolean;
  fields: SalesforceFieldFixture[];
} {
  const fields = SALESFORCE_FIELD_NAMES.map((name) => ({
    name,
    createable: true,
    updateable: true,
    externalId: name === SALESFORCE_ENV.NOTICE_CRM_SALESFORCE_EXTERNAL_ID_FIELD,
  }));
  mutate?.(fields);
  return {
    name: SALESFORCE_ENV.NOTICE_CRM_SALESFORCE_OBJECT,
    createable: true,
    updateable: true,
    fields,
  };
}

function canonicalEvent(overrides: Partial<CanonicalCrmEvent> = {}): CanonicalCrmEvent {
  const base: CanonicalCrmEvent = {
    eventId: "01JNOTICECRM000000000000001",
    workspaceId: "wm-emea",
    topic: "agreement.updated",
    occurredAt: "2026-08-01T12:30:00.000Z",
    agreementId: 42,
    externalKey: "notice:wm-emea:agreement:42",
    aggregateVersion: 7,
    mappingVersion: "2026-08-01",
    deleted: false,
    projection: {
      externalKey: "notice:wm-emea:agreement:42",
      workspaceId: "wm-emea",
      agreementId: 42,
      version: 7,
      party: "Orchid Capital",
      type: "Investment management agreement",
      value: 12_500_000,
      valueMinor: 1_250_000_025,
      currencyCode: "EUR",
      stage: "Approved",
      owner: "A. Counsel",
      department: "Legal",
      risk: "Medium",
      approvalStatus: "Approved",
      signatureStatus: "Pending",
      effectiveDate: "2026-09-01",
      expirationDate: "2028-09-01",
      crm: "Salesforce",
      crmRecord: "006xx0000012345",
      updatedAt: "2026-08-01T12:29:59.000Z",
    },
    tombstone: null,
  };
  return { ...base, ...overrides };
}

function responseJson(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function assertProviderError(
  candidate: unknown,
  expected: Readonly<{ code: string; retryable: boolean; retryAfterMs?: number | null }>,
): boolean {
  assert.ok(candidate instanceof CrmProviderError);
  assert.equal(candidate.code, expected.code);
  assert.equal(candidate.retryable, expected.retryable);
  if ("retryAfterMs" in expected) assert.equal(candidate.retryAfterMs, expected.retryAfterMs);
  assert.equal(candidate.message, expected.code);
  return true;
}

test("gateway validation upgrades legacy money projections before provider mapping", () => {
  const projection = { ...canonicalEvent().projection } as Record<string, unknown>;
  delete projection.valueMinor;
  delete projection.currencyCode;
  const validated = validateCanonicalEvent({
    ...canonicalEvent(),
    projection: projection as CanonicalCrmEvent["projection"],
  });
  assert.equal(validated.projection?.valueMinor, 1_250_000_000);
  assert.equal(validated.projection?.currencyCode, "USD");
});

test("gateway accepts the full canonical minor-unit range while retaining the legacy value bound", () => {
  const jpyProjection = {
    ...canonicalEvent().projection!,
    value: 9_000_000_000_001,
    valueMinor: 9_000_000_000_001,
    currencyCode: "JPY",
  };
  assert.equal(validateCanonicalEvent({
    ...canonicalEvent(),
    projection: jpyProjection,
  }).projection?.valueMinor, 9_000_000_000_001);

  const maxUsdProjection = {
    ...canonicalEvent().projection!,
    value: 90_000_000_000_000,
    valueMinor: 9_000_000_000_000_000,
    currencyCode: "USD",
  };
  assert.equal(validateCanonicalEvent({
    ...canonicalEvent(),
    projection: maxUsdProjection,
  }).projection?.value, 90_000_000_000_000);

  assert.throws(() => validateCanonicalEvent({
    ...canonicalEvent(),
    projection: { ...maxUsdProjection, value: maxUsdProjection.value + 1 },
  }), (error) => assertProviderError(error, { code: "CRM_EVENT_INVALID", retryable: false }));

  const oversizedLegacy = { ...canonicalEvent().projection! } as Record<string, unknown>;
  oversizedLegacy.value = 9_000_000_000_001;
  delete oversizedLegacy.valueMinor;
  delete oversizedLegacy.currencyCode;
  assert.throws(() => validateCanonicalEvent({
    ...canonicalEvent(),
    projection: oversizedLegacy as CanonicalCrmEvent["projection"],
  }), (error) => assertProviderError(error, { code: "CRM_EVENT_INVALID", retryable: false }));
});

test("HubSpot uses CRM v3 batch upsert with stable external ID and bounded canonical fields", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetcher: FetchLike = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return responseJson({ status: "COMPLETE", numErrors: 0, errors: [], results: [{ id: "hubspot-record-88" }] });
  };
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, fetcher);
  const result = await adapter.upsert(canonicalEvent());

  assert.deepEqual(result, { providerRecordId: "hubspot-record-88" });
  assert.equal(capturedUrl, "https://api.hubapi.com/crm/v3/objects/2-1234567/batch/upsert");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "manual");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${HUBSPOT_ENV.NOTICE_CRM_HUBSPOT_ACCESS_TOKEN}`);
  const body = JSON.parse(String(capturedInit?.body)) as {
    inputs: Array<{ id: string; idProperty: string; properties: Record<string, string> }>;
  };
  assert.equal(body.inputs.length, 1);
  assert.equal(body.inputs[0]?.id, "notice:wm-emea:agreement:42");
  assert.equal(body.inputs[0]?.idProperty, "notice_external_id");
  assert.equal(body.inputs[0]?.properties.notice_external_id, "notice:wm-emea:agreement:42");
  assert.equal(body.inputs[0]?.properties.notice_aggregate_version, "7");
  assert.equal(body.inputs[0]?.properties.notice_mapping_version, "2026-08-01");
  assert.equal(body.inputs[0]?.properties.notice_party, "Orchid Capital");
  assert.equal(body.inputs[0]?.properties.notice_contract_value, "12500000");
  assert.equal(body.inputs[0]?.properties.notice_contract_value_minor, "1250000025");
  assert.equal(body.inputs[0]?.properties.notice_contract_currency, "EUR");
});

test("HubSpot accepts a 207 only when the one-item batch proves complete success", async () => {
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => responseJson({
    status: "COMPLETE",
    numErrors: 0,
    errors: [],
    results: [{ id: "hubspot-record-207" }],
  }, { status: 207 }));
  assert.deepEqual(await adapter.upsert(canonicalEvent()), { providerRecordId: "hubspot-record-207" });
});

test("HubSpot rejects 207 partial or per-input error responses instead of acknowledging delivery", async () => {
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => responseJson({
    status: "COMPLETE",
    numErrors: 1,
    errors: [{ status: "error", message: "sensitive provider details" }],
    results: [{ id: "ambiguous-partial-id" }],
  }, { status: 207 }));
  await assert.rejects(
    adapter.upsert(canonicalEvent()),
    (error) => assertProviderError(error, { code: "CRM_PROVIDER_REJECTED", retryable: false }),
  );
});

test("HubSpot pending, processing, and canceled batches remain retryable", async (t) => {
  for (const status of ["PENDING", "PROCESSING", "CANCELED"] as const) {
    await t.test(status, async () => {
      const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => responseJson({
        status,
        numErrors: 0,
        results: [],
      }));
      await assert.rejects(
        adapter.upsert(canonicalEvent()),
        (error) => assertProviderError(error, { code: "CRM_PROVIDER_UNAVAILABLE", retryable: true }),
      );
    });
  }
});

test("HubSpot connection test verifies every mapped property with a bounded read-only schema query", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, async (input, init) => {
    calls.push({ url: String(input), init });
    return responseJson(hubSpotSchema());
  });
  await adapter.testConnection();
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(calls[0]!.init?.body, undefined);
  assert.equal(calls[0]!.init?.redirect, "manual");
  assert.equal(url.pathname, "/crm/v3/properties/2-1234567");
  assert.equal(url.searchParams.get("archived"), "false");
  assert.equal((calls[0]!.init?.headers as Record<string, string>).authorization, `Bearer ${HUBSPOT_ENV.NOTICE_CRM_HUBSPOT_ACCESS_TOKEN}`);
});

test("HubSpot connection test rejects missing, read-only, calculated, or non-unique mapped properties", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (properties: HubSpotPropertyFixture[]) => void;
  }> = [
    {
      name: "missing mapped property",
      mutate: (properties) => {
        const index = properties.findIndex(({ name }) => name === "notice_party");
        properties.splice(index, 1);
      },
    },
    {
      name: "read-only mapped property",
      mutate: (properties) => {
        properties.find(({ name }) => name === "notice_party")!.modificationMetadata.readOnlyValue = true;
      },
    },
    {
      name: "calculated mapped property",
      mutate: (properties) => {
        properties.find(({ name }) => name === "notice_contract_value")!.calculated = true;
      },
    },
    {
      name: "external ID without uniqueness",
      mutate: (properties) => {
        properties.find(({ name }) => name === HUBSPOT_ENV.NOTICE_CRM_HUBSPOT_ID_PROPERTY)!.hasUniqueValue = false;
      },
    },
    {
      name: "external ID with an incompatible type",
      mutate: (properties) => {
        properties.find(({ name }) => name === HUBSPOT_ENV.NOTICE_CRM_HUBSPOT_ID_PROPERTY)!.type = "number";
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => responseJson(hubSpotSchema(scenario.mutate)));
      await assert.rejects(
        adapter.testConnection(),
        (error) => assertProviderError(error, {
          code: "CRM_PROVIDER_SCHEMA_INCOMPATIBLE",
          retryable: false,
        }),
      );
    });
  }
});

test("HubSpot connection test rejects oversized schema responses without parsing provider details", async () => {
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => new Response("{}", {
    status: 200,
    headers: { "content-length": String(256 * 1_024 + 1) },
  }));
  await assert.rejects(
    adapter.testConnection(),
    (error) => assertProviderError(error, {
      code: "CRM_PROVIDER_RESPONSE_INVALID",
      retryable: false,
    }),
  );
});

test("HubSpot rate limits are retryable, bounded, and provider bodies stay redacted", async () => {
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => new Response(
    "access token pat-na1-should-never-be-exposed",
    { status: 429, headers: { "retry-after": "900" } },
  ));
  await assert.rejects(
    adapter.upsert(canonicalEvent()),
    (error) => assertProviderError(error, {
      code: "CRM_PROVIDER_RATE_LIMITED",
      retryable: true,
      retryAfterMs: 300_000,
    }),
  );
});

test("HubSpot treats ordinary provider 4xx responses as permanent", async () => {
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => new Response("validation details", { status: 400 }));
  await assert.rejects(
    adapter.upsert(canonicalEvent()),
    (error) => assertProviderError(error, { code: "CRM_PROVIDER_REJECTED", retryable: false }),
  );
});

test("Salesforce obtains and caches a client-credentials token then PATCH-upserts by external ID", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return responseJson({
        access_token: "salesforce-access-token-A",
        token_type: "Bearer",
        instance_url: SALESFORCE_INSTANCE_URL,
        expires_in: 1_800,
      });
    }
    return calls.length === 2
      ? responseJson({ id: "a01xx0000000042" }, { status: 201 })
      : new Response(null, { status: 204 });
  };
  const adapter = new SalesforceAdapter(SALESFORCE_ENV, fetcher);
  assert.deepEqual(await adapter.upsert(canonicalEvent()), { providerRecordId: "a01xx0000000042" });
  assert.deepEqual(await adapter.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000002" })), { providerRecordId: null });

  assert.equal(calls.length, 3, "the second upsert reuses the cached token");
  assert.equal(calls[0]!.url, "https://login.salesforce.com/services/oauth2/token");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(calls[0]!.init?.redirect, "manual");
  const tokenForm = new URLSearchParams(String(calls[0]!.init?.body));
  assert.equal(tokenForm.get("grant_type"), "client_credentials");
  assert.equal(tokenForm.get("client_id"), SALESFORCE_ENV.NOTICE_CRM_SALESFORCE_CLIENT_ID);
  assert.equal(tokenForm.get("client_secret"), SALESFORCE_ENV.NOTICE_CRM_SALESFORCE_CLIENT_SECRET);
  assert.equal(
    calls[1]!.url,
    `${SALESFORCE_INSTANCE_URL}/services/data/v65.0/sobjects/Agreement__c/Notice_External_Id__c/notice%3Awm-emea%3Aagreement%3A42`,
  );
  assert.equal(calls[1]!.init?.method, "PATCH");
  assert.equal((calls[1]!.init?.headers as Record<string, string>).authorization, "Bearer salesforce-access-token-A");
  const body = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>;
  assert.equal(body.Notice_External_Id__c, "notice:wm-emea:agreement:42");
  assert.equal(body.Notice_Aggregate_Version__c, 7);
  assert.equal(body.Notice_Mapping_Version__c, "2026-08-01");
  assert.equal(body.Notice_Contract_Value__c, 12_500_000);
  assert.equal(body.Notice_Contract_Value_Minor__c, 1_250_000_025);
  assert.equal(body.Notice_Contract_Currency__c, "EUR");
});

test("concurrent Salesforce adapters share one in-flight OAuth request for the same configuration", async () => {
  let tokenCalls = 0;
  const authorizationHeaders: string[] = [];
  let releaseToken!: () => void;
  const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
  const fetcher: FetchLike = async (input, init) => {
    if (new URL(String(input)).pathname === "/services/oauth2/token") {
      tokenCalls += 1;
      await tokenGate;
      return responseJson({
        access_token: "salesforce-shared-concurrent-token",
        token_type: "Bearer",
        instance_url: SALESFORCE_INSTANCE_URL,
        expires_in: 1_800,
      });
    }
    authorizationHeaders.push((init?.headers as Record<string, string>).authorization);
    return new Response(null, { status: 204 });
  };
  const environment = { ...SALESFORCE_ENV, NOTICE_CRM_MAPPING_VERSION: "concurrency-profile-v1" };
  const first = new SalesforceAdapter(environment, fetcher);
  const second = new SalesforceAdapter(environment, fetcher);
  const writes = [
    first.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000101" })),
    second.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000102" })),
  ];

  for (let index = 0; index < 20 && tokenCalls === 0; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const callsWhileBlocked = tokenCalls;
  releaseToken();
  await Promise.all(writes);
  assert.equal(callsWhileBlocked, 1);
  assert.equal(tokenCalls, 1);
  assert.deepEqual(authorizationHeaders, [
    "Bearer salesforce-shared-concurrent-token",
    "Bearer salesforce-shared-concurrent-token",
  ]);
});

test("Salesforce token reuse stops at expiry and refreshes once", async () => {
  let now = Date.parse("2026-08-02T12:00:00.000Z");
  let tokenCalls = 0;
  const authorizationHeaders: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    if (new URL(String(input)).pathname === "/services/oauth2/token") {
      tokenCalls += 1;
      return responseJson({
        access_token: `salesforce-expiry-token-${tokenCalls}`,
        token_type: "Bearer",
        instance_url: SALESFORCE_INSTANCE_URL,
        expires_in: 60,
      });
    }
    authorizationHeaders.push((init?.headers as Record<string, string>).authorization);
    return new Response(null, { status: 204 });
  };
  const adapter = new SalesforceAdapter(
    { ...SALESFORCE_ENV, NOTICE_CRM_MAPPING_VERSION: "expiry-profile-v1" },
    fetcher,
    () => now,
  );
  await adapter.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000111" }));
  now += 29_999;
  await adapter.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000112" }));
  now += 2;
  await adapter.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000113" }));

  assert.equal(tokenCalls, 2);
  assert.deepEqual(authorizationHeaders, [
    "Bearer salesforce-expiry-token-1",
    "Bearer salesforce-expiry-token-1",
    "Bearer salesforce-expiry-token-2",
  ]);
});

test("Salesforce token sharing is isolated across credential and mapping profiles", async () => {
  let tokenCalls = 0;
  const authorizationHeaders: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    if (new URL(String(input)).pathname === "/services/oauth2/token") {
      tokenCalls += 1;
      return responseJson({
        access_token: `salesforce-isolated-token-${tokenCalls}`,
        token_type: "Bearer",
        instance_url: SALESFORCE_INSTANCE_URL,
      });
    }
    authorizationHeaders.push((init?.headers as Record<string, string>).authorization);
    return new Response(null, { status: 204 });
  };
  const base = { ...SALESFORCE_ENV, NOTICE_CRM_MAPPING_VERSION: "isolated-profile-v1" };
  const credentialChange = {
    ...base,
    NOTICE_CRM_SALESFORCE_CLIENT_SECRET: "salesforce-client-secret-rotated-0123456789",
  };
  const mappingChange = { ...base, NOTICE_CRM_MAPPING_VERSION: "isolated-profile-v2" };

  await new SalesforceAdapter(base, fetcher).upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000121" }));
  await new SalesforceAdapter(credentialChange, fetcher).upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000122" }));
  await new SalesforceAdapter(mappingChange, fetcher).upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000123" }));

  assert.equal(tokenCalls, 3);
  assert.deepEqual(authorizationHeaders, [
    "Bearer salesforce-isolated-token-1",
    "Bearer salesforce-isolated-token-2",
    "Bearer salesforce-isolated-token-3",
  ]);
});

test("Salesforce refreshes exactly once after an upsert 401", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new SalesforceAdapter(SALESFORCE_ENV, async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1 || calls.length === 3) {
      return responseJson({
        access_token: calls.length === 1 ? "salesforce-token-old" : "salesforce-token-new",
        token_type: "Bearer",
        instance_url: SALESFORCE_INSTANCE_URL,
      });
    }
    if (calls.length === 2) return new Response(null, { status: 401 });
    return new Response(null, { status: 204 });
  });
  await adapter.upsert(canonicalEvent());
  assert.equal(calls.length, 4);
  assert.equal((calls[1]!.init?.headers as Record<string, string>).authorization, "Bearer salesforce-token-old");
  assert.equal((calls[3]!.init?.headers as Record<string, string>).authorization, "Bearer salesforce-token-new");
});

test("concurrent Salesforce 401 responses share one refresh without invalidating the fresh token", async () => {
  let tokenCalls = 0;
  let rejectOldToken = false;
  let blockedOldWrites = 0;
  let freshWrites = 0;
  let releaseOldWrites!: () => void;
  const oldWriteGate = new Promise<void>((resolve) => { releaseOldWrites = resolve; });
  const fetcher: FetchLike = async (input, init) => {
    if (new URL(String(input)).pathname === "/services/oauth2/token") {
      tokenCalls += 1;
      return responseJson({
        access_token: tokenCalls === 1 ? "salesforce-shared-old-token" : "salesforce-shared-new-token",
        token_type: "Bearer",
        instance_url: SALESFORCE_INSTANCE_URL,
      });
    }
    const authorization = (init?.headers as Record<string, string>).authorization;
    if (rejectOldToken && authorization === "Bearer salesforce-shared-old-token") {
      blockedOldWrites += 1;
      await oldWriteGate;
      return new Response(null, { status: 401 });
    }
    if (authorization === "Bearer salesforce-shared-new-token") freshWrites += 1;
    return new Response(null, { status: 204 });
  };
  const environment = { ...SALESFORCE_ENV, NOTICE_CRM_MAPPING_VERSION: "concurrent-401-profile-v1" };
  const first = new SalesforceAdapter(environment, fetcher);
  const second = new SalesforceAdapter(environment, fetcher);
  await first.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000131" }));
  rejectOldToken = true;
  const writes = [
    first.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000132" })),
    second.upsert(canonicalEvent({ eventId: "01JNOTICECRM000000000000133" })),
  ];
  for (let index = 0; index < 20 && blockedOldWrites < 2; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const writesBlockedTogether = blockedOldWrites;
  releaseOldWrites();
  await Promise.all(writes);

  assert.equal(writesBlockedTogether, 2);
  assert.equal(tokenCalls, 2);
  assert.equal(freshWrites, 2);
});

test("Salesforce rejects an unsafe instance URL without sending the CRM write", async () => {
  let calls = 0;
  const adapter = new SalesforceAdapter(SALESFORCE_ENV, async () => {
    calls += 1;
    return responseJson({
      access_token: "salesforce-access-token-A",
      instance_url: "https://127.0.0.1/admin",
    });
  });
  await assert.rejects(
    adapter.upsert(canonicalEvent()),
    (error) => assertProviderError(error, { code: "CRM_PROVIDER_RESPONSE_INVALID", retryable: false }),
  );
  assert.equal(calls, 1);
});

test("Salesforce connection test uses describe and never writes an object", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new SalesforceAdapter(SALESFORCE_ENV, async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return responseJson({
        access_token: "salesforce-access-token-A",
        instance_url: SALESFORCE_INSTANCE_URL,
      });
    }
    return responseJson(salesforceSchema());
  });
  await adapter.testConnection();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.init?.method, "GET");
  assert.equal(calls[1]!.init?.body, undefined);
  assert.equal(calls[1]!.init?.redirect, "manual");
  assert.equal(calls[1]!.url, `${SALESFORCE_INSTANCE_URL}/services/data/v65.0/sobjects/Agreement__c/describe`);
});

test("Salesforce connection test rejects incomplete or unusable mapped field schemas", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (fields: SalesforceFieldFixture[]) => void;
  }> = [
    {
      name: "missing mapped field",
      mutate: (fields) => {
        const index = fields.findIndex(({ name }) => name === "Notice_Party__c");
        fields.splice(index, 1);
      },
    },
    {
      name: "mapped field unavailable during create",
      mutate: (fields) => {
        fields.find(({ name }) => name === "Notice_Party__c")!.createable = false;
      },
    },
    {
      name: "mapped field unavailable during update",
      mutate: (fields) => {
        fields.find(({ name }) => name === "Notice_Contract_Value__c")!.updateable = false;
      },
    },
    {
      name: "configured key is not an external ID",
      mutate: (fields) => {
        fields.find(({ name }) => name === SALESFORCE_ENV.NOTICE_CRM_SALESFORCE_EXTERNAL_ID_FIELD)!.externalId = false;
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const adapter = new SalesforceAdapter(SALESFORCE_ENV, async () => {
        calls += 1;
        return calls === 1
          ? responseJson({
            access_token: "salesforce-access-token-A",
            instance_url: SALESFORCE_INSTANCE_URL,
          })
          : responseJson(salesforceSchema(scenario.mutate));
      });
      await assert.rejects(
        adapter.testConnection(),
        (error) => assertProviderError(error, {
          code: "CRM_PROVIDER_SCHEMA_INCOMPATIBLE",
          retryable: false,
        }),
      );
      assert.equal(calls, 2);
    });
  }
});

test("Salesforce connection test requires create and update access to the configured object", async (t) => {
  for (const permission of ["createable", "updateable"] as const) {
    await t.test(`${permission} access`, async () => {
      let calls = 0;
      const adapter = new SalesforceAdapter(SALESFORCE_ENV, async () => {
        calls += 1;
        if (calls === 1) {
          return responseJson({
            access_token: "salesforce-access-token-A",
            instance_url: SALESFORCE_INSTANCE_URL,
          });
        }
        return responseJson({ ...salesforceSchema(), [permission]: false });
      });
      await assert.rejects(
        adapter.testConnection(),
        (error) => assertProviderError(error, {
          code: "CRM_PROVIDER_SCHEMA_INCOMPATIBLE",
          retryable: false,
        }),
      );
    });
  }
});

test("custom adapter emits deterministic normalized fields, stable IDs, and a verifiable HMAC", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new CustomWebhookAdapter(CUSTOM_ENV, async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(null, {
      status: 202,
      headers: { "x-notice-provider-record-id": "custom-42" },
    });
  });
  assert.deepEqual(await adapter.upsert(canonicalEvent()), { providerRecordId: "custom-42" });
  assert.deepEqual(await adapter.upsert(canonicalEvent()), { providerRecordId: "custom-42" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "http://localhost:8788/crm/events");
  assert.equal(calls[0]!.init?.redirect, "manual");
  assert.equal(calls[0]!.init?.body, calls[1]!.init?.body, "canonical body is stable across delivery attempts");
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers["x-notice-event-id"], canonicalEvent().eventId);
  assert.equal(headers["idempotency-key"], canonicalEvent().eventId);
  assert.equal(headers["x-notice-dry-run"], "false");
  const body = String(calls[0]!.init?.body);
  const payload = JSON.parse(body) as Record<string, unknown>;
  assert.equal(payload.externalId, "notice:wm-emea:agreement:42");
  assert.equal(payload.aggregateVersion, 7);
  assert.equal(payload.mappingVersion, "2026-08-01");
  assert.equal((payload.fields as Record<string, unknown>).party, "Orchid Capital");
  assert.equal((payload.fields as Record<string, unknown>).valueMinor, 1_250_000_025);
  assert.equal((payload.fields as Record<string, unknown>).currencyCode, "EUR");
  const expectedSignature = createHmac("sha256", CUSTOM_SECRET)
    .update(`${headers["x-notice-timestamp"]}.${body}`)
    .digest("hex");
  assert.equal(headers["x-notice-signature"], `v1=${expectedSignature}`);
});

test("custom connection test carries an explicit dry-run marker and stable probe ID", async () => {
  let captured: RequestInit | undefined;
  const adapter = new CustomWebhookAdapter(CUSTOM_ENV, async (_input, init) => {
    captured = init;
    return new Response(null, { status: 204 });
  });
  await adapter.testConnection();
  const headers = captured?.headers as Record<string, string>;
  assert.equal(headers["x-notice-dry-run"], "true");
  assert.equal(headers["x-notice-event-id"], "notice.crm.connection-test");
  assert.equal(headers["idempotency-key"], "notice.crm.connection-test");
  const payload = JSON.parse(String(captured?.body)) as Record<string, unknown>;
  assert.equal(payload.dryRun, true);
  assert.equal(payload.mappingVersion, "2026-08-01");
});

test("custom adapter defaults its mapping version to the gateway v1 profile", async () => {
  let captured: RequestInit | undefined;
  const environment = { ...CUSTOM_ENV } as Record<string, unknown>;
  delete environment.NOTICE_CRM_MAPPING_VERSION;
  const adapter = new CustomWebhookAdapter(environment, async (_input, init) => {
    captured = init;
    return new Response(null, { status: 204 });
  });
  await adapter.testConnection();
  const payload = JSON.parse(String(captured?.body)) as Record<string, unknown>;
  assert.equal(payload.mappingVersion, "v1");
});

test("network errors and redirects are classified without leaking provider details", async () => {
  const networkAdapter = new CustomWebhookAdapter(CUSTOM_ENV, async () => {
    throw new TypeError("socket failure to secret upstream");
  });
  await assert.rejects(
    networkAdapter.upsert(canonicalEvent()),
    (error) => assertProviderError(error, { code: "CRM_PROVIDER_NETWORK_ERROR", retryable: true }),
  );

  const redirectAdapter = new CustomWebhookAdapter(CUSTOM_ENV, async () => new Response(null, {
    status: 302,
    headers: { location: "https://attacker.example/collect" },
  }));
  await assert.rejects(
    redirectAdapter.upsert(canonicalEvent()),
    (error) => assertProviderError(error, { code: "CRM_PROVIDER_REDIRECT_REJECTED", retryable: false }),
  );
});

test("provider requests enforce their own deadline while preserving a caller signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const callerController = new AbortController();
  const providerSignals: AbortSignal[] = [];
  const request = providerFetch(
    async (_input, init) => {
      const providerSignal = init?.signal;
      assert.ok(providerSignal);
      providerSignals.push(providerSignal);
      return await new Promise<Response>((_resolve, reject) => {
        providerSignal.addEventListener("abort", () => reject(new Error("redacted timeout detail")), { once: true });
      });
    },
    "https://crm.vendor.example.invalid/events",
    { method: "GET", signal: callerController.signal },
  );

  await Promise.resolve();
  t.mock.timers.tick(PROVIDER_REQUEST_TIMEOUT_MS);
  await assert.rejects(
    request,
    (error) => assertProviderError(error, { code: "CRM_PROVIDER_TIMEOUT", retryable: true }),
  );
  assert.equal(providerSignals.length, 1);
  assert.notEqual(providerSignals[0], callerController.signal);
  assert.equal(providerSignals[0]?.aborted, true);
  assert.equal(callerController.signal.aborted, false);
});

test("provider response bodies cannot stall after headers arrive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let canceled = false;
  const response = await providerFetch(
    async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    "https://api.hubapi.com/crm/v3/properties/2-1234567",
    { method: "GET" },
  );
  const body = readBoundedJson(response);

  await Promise.resolve();
  t.mock.timers.tick(PROVIDER_REQUEST_TIMEOUT_MS);
  await assert.rejects(
    body,
    (error) => assertProviderError(error, { code: "CRM_PROVIDER_TIMEOUT", retryable: true }),
  );
  await Promise.resolve();
  assert.equal(canceled, true);
});

test("unsafe endpoints, credentials in URLs, placeholders, and malformed mapping fail closed", () => {
  assert.throws(
    () => new CustomWebhookAdapter({ ...CUSTOM_ENV, NOTICE_ENVIRONMENT: "production" }),
    (error) => assertProviderError(error, { code: "CRM_CONFIG_INVALID", retryable: false }),
  );
  assert.throws(
    () => new CustomWebhookAdapter({
      ...CUSTOM_ENV,
      NOTICE_CRM_CUSTOM_URL: credentialedHttpsUrl("crm.vendor.example", "/events"),
    }),
    (error) => assertProviderError(error, { code: "CRM_CONFIG_INVALID", retryable: false }),
  );
  assert.throws(
    () => new CustomWebhookAdapter({ ...CUSTOM_ENV, NOTICE_CRM_CUSTOM_SECRET: "replace-me-with-a-real-secret-000000" }),
    (error) => assertProviderError(error, { code: "CRM_CONFIG_INVALID", retryable: false }),
  );
  assert.throws(
    () => new HubSpotAdapter({ ...HUBSPOT_ENV, NOTICE_CRM_HUBSPOT_API_BASE_URL: "https://127.0.0.1" }),
    (error) => assertProviderError(error, { code: "CRM_CONFIG_INVALID", retryable: false }),
  );
  assert.throws(
    () => new HubSpotAdapter({ ...HUBSPOT_ENV, NOTICE_CRM_FIELD_MAPPING_JSON: '{"unknown":"field"}' }),
    (error) => assertProviderError(error, { code: "CRM_MAPPING_INVALID", retryable: false }),
  );
  assert.throws(
    () => new SalesforceAdapter({
      ...SALESFORCE_ENV,
      NOTICE_CRM_FIELD_MAPPING_JSON: '{"party":"Duplicate__c","type":"Duplicate__c"}',
    }),
    (error) => assertProviderError(error, { code: "CRM_MAPPING_INVALID", retryable: false }),
  );
});

test("invalid or oversized canonical projections are rejected before any provider call", async () => {
  let calls = 0;
  const adapter = new HubSpotAdapter(HUBSPOT_ENV, async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  });
  const invalid = canonicalEvent({
    projection: {
      ...canonicalEvent().projection!,
      party: "x".repeat(201),
    },
  });
  await assert.rejects(
    adapter.upsert(invalid),
    (error) => assertProviderError(error, { code: "CRM_EVENT_INVALID", retryable: false }),
  );
  await assert.rejects(
    adapter.upsert(canonicalEvent({ externalKey: "wm-emea:42" })),
    (error) => assertProviderError(error, { code: "CRM_EVENT_INVALID", retryable: false }),
  );
  await assert.rejects(
    adapter.upsert(canonicalEvent({
      projection: { ...canonicalEvent().projection!, currencyCode: undefined },
    })),
    (error) => assertProviderError(error, { code: "CRM_EVENT_INVALID", retryable: false }),
  );
  assert.equal(calls, 0);
});

test("deletion tombstones retain version fencing and provider identity fields", async () => {
  let body = "";
  const adapter = new CustomWebhookAdapter(CUSTOM_ENV, async (_input, init) => {
    body = String(init?.body);
    return new Response(null, { status: 202 });
  });
  const deleted = canonicalEvent({
    eventId: "01JNOTICECRM000000000000099",
    topic: "agreement.deleted",
    occurredAt: "2026-08-02T09:00:00.000Z",
    aggregateVersion: 8,
    deleted: true,
    projection: null,
    tombstone: {
      externalKey: "notice:wm-emea:agreement:42",
      workspaceId: "wm-emea",
      agreementId: 42,
      version: 8,
      deletedAt: "2026-08-02T08:59:59.000Z",
      crm: "Salesforce",
      crmRecord: "006xx0000012345",
    },
  });
  await adapter.upsert(deleted);
  const payload = JSON.parse(body) as { deleted: boolean; fields: Record<string, unknown> };
  assert.equal(payload.deleted, true);
  assert.equal(payload.fields.aggregateVersion, 8);
  assert.equal(payload.fields.deletedAt, "2026-08-02T08:59:59.000Z");
  assert.equal(payload.fields.crmRecord, "006xx0000012345");
  assert.equal(payload.fields.party, null);
});

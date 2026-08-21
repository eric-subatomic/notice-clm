import { boundedResponseId, providerFetch, throwForProviderStatus, type FetchLike } from "./http";
import { buildFieldMapping, mapCanonicalEvent, type FieldMapping } from "./mapping";
import type { CanonicalCrmEvent, CrmAdapter, CrmUpsertResult } from "./types";
import {
  isTestEnvironment,
  parseRemoteHttpsUrl,
  readOptionalString,
  readRequiredString,
  requirePattern,
  validateCanonicalEvent,
} from "./validation";

const CUSTOM_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
const MAPPING_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CUSTOM_SCHEMA_VERSION = "1.0" as const;
const CONNECTION_TEST_EVENT_ID = "notice.crm.connection-test";

type CustomConfig = Readonly<{
  endpoint: URL;
  secret: string;
  mappingVersion: string;
  mapping: FieldMapping;
}>;

function parseCustomConfig(source: Record<string, unknown>): CustomConfig {
  const endpoint = parseRemoteHttpsUrl(
    readRequiredString(source, "NOTICE_CRM_CUSTOM_URL", { min: 1, max: 500 }),
    { allowTestLocalhost: true, testEnvironment: isTestEnvironment(source) },
  );
  const secret = readRequiredString(source, "NOTICE_CRM_CUSTOM_SECRET", {
    min: 32,
    max: 4_096,
    secret: true,
  });
  const externalIdField = requirePattern(
    readOptionalString(source, "NOTICE_CRM_CUSTOM_EXTERNAL_ID_FIELD", 100) ?? "externalId",
    CUSTOM_FIELD_PATTERN,
  );
  const mappingVersion = requirePattern(
    readOptionalString(source, "NOTICE_CRM_MAPPING_VERSION", 64) ?? "v1",
    MAPPING_VERSION_PATTERN,
  );
  return {
    endpoint,
    secret,
    mappingVersion,
    mapping: buildFieldMapping("custom", source.NOTICE_CRM_FIELD_MAPPING_JSON, externalIdField),
  };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export class CustomWebhookAdapter implements CrmAdapter {
  readonly provider = "custom" as const;
  readonly #config: CustomConfig;
  readonly #fetcher: FetchLike;

  constructor(source: Record<string, unknown>, fetcher: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.#config = parseCustomConfig(source);
    this.#fetcher = fetcher;
  }

  async #send(body: string, eventId: string, dryRun: boolean): Promise<Response> {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = await hmac(this.#config.secret, `${timestamp}.${body}`);
    return providerFetch(this.#fetcher, this.#config.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": eventId,
        "x-notice-dry-run": String(dryRun),
        "x-notice-event-id": eventId,
        "x-notice-signature": `v1=${signature}`,
        "x-notice-timestamp": timestamp,
      },
      body,
    });
  }

  async upsert(candidate: CanonicalCrmEvent): Promise<CrmUpsertResult> {
    const event = validateCanonicalEvent(candidate);
    const body = JSON.stringify({
      schemaVersion: CUSTOM_SCHEMA_VERSION,
      eventId: event.eventId,
      idempotencyKey: event.eventId,
      topic: event.topic,
      occurredAt: event.occurredAt,
      externalId: event.externalKey,
      workspaceId: event.workspaceId,
      agreementId: event.agreementId,
      aggregateVersion: event.aggregateVersion,
      mappingVersion: event.mappingVersion,
      deleted: event.deleted,
      dryRun: false,
      fields: mapCanonicalEvent(event, this.#config.mapping),
    });
    const response = await this.#send(body, event.eventId, false);
    throwForProviderStatus(response);
    return {
      providerRecordId: boundedResponseId(response.headers.get("x-notice-provider-record-id")),
    };
  }

  async testConnection(): Promise<void> {
    const body = JSON.stringify({
      schemaVersion: CUSTOM_SCHEMA_VERSION,
      eventId: CONNECTION_TEST_EVENT_ID,
      idempotencyKey: CONNECTION_TEST_EVENT_ID,
      topic: "notice.crm.connection_test",
      mappingVersion: this.#config.mappingVersion,
      dryRun: true,
    });
    const response = await this.#send(body, CONNECTION_TEST_EVENT_ID, true);
    throwForProviderStatus(response);
  }
}

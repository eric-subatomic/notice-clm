import {
  CanonicalCrmEventError,
  normalizeCrmIntegrationEvent,
  parseCanonicalCrmEvent,
  type CanonicalCrmEvent,
} from "./canonical-event";
import { NoticeRequestError, verifyNoticeRequest } from "./notice-request";
import type { ReceiptRecord, ReceiptStore } from "./receipt-store";
import type {
  CanonicalCrmEvent as ProviderCanonicalCrmEvent,
  CrmAdapter,
} from "./providers/types";

export const CRM_GATEWAY_MAX_ATTEMPTS = 8;
export const CRM_GATEWAY_LEASE_MS = 5 * 60_000;
export const CRM_GATEWAY_BASE_RETRY_MS = 15_000;
export const CRM_GATEWAY_MAX_RETRY_MS = 6 * 60 * 60_000;
export const CRM_GATEWAY_TERMINAL_PAYLOAD_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const CRM_GATEWAY_TERMINAL_METADATA_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const CRM_GATEWAY_SCHEDULED_BATCH_SIZE = 50;

export type WaitUntilContext = Readonly<{
  waitUntil(promise: Promise<unknown>): void;
}>;

export type CrmGatewayServiceOptions = Readonly<{
  ingressSecrets: readonly string[];
  mappingVersion: string;
  store: ReceiptStore;
  adapter: CrmAdapter;
  now?: () => Date;
  maxAttempts?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  terminalPayloadRetentionMs?: number;
  terminalMetadataRetentionMs?: number;
  scheduledBatchSize?: number;
}>;

export type ScheduledRunResult = Readonly<{
  examined: number;
  processingErrors: number;
}>;

export class CrmGatewayService {
  private readonly ingressSecrets: readonly string[];
  private readonly mappingVersion: string;
  private readonly store: ReceiptStore;
  private readonly adapter: CrmAdapter;
  private readonly clock: () => Date;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly terminalPayloadRetentionMs: number;
  private readonly terminalMetadataRetentionMs: number;
  private readonly scheduledBatchSize: number;

  constructor(options: CrmGatewayServiceOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.mappingVersion)) {
      throw new Error("CRM mapping version is invalid");
    }
    this.ingressSecrets = Object.freeze([...options.ingressSecrets]);
    this.mappingVersion = options.mappingVersion;
    this.store = options.store;
    this.adapter = options.adapter;
    this.clock = options.now ?? (() => new Date());
    this.maxAttempts = boundedInteger(options.maxAttempts, CRM_GATEWAY_MAX_ATTEMPTS, 1, 100);
    this.leaseMs = boundedInteger(options.leaseMs, CRM_GATEWAY_LEASE_MS, 1_000, 24 * 60 * 60_000);
    this.baseRetryMs = boundedInteger(options.baseRetryMs, CRM_GATEWAY_BASE_RETRY_MS, 1_000, CRM_GATEWAY_MAX_RETRY_MS);
    this.maxRetryMs = boundedInteger(options.maxRetryMs, CRM_GATEWAY_MAX_RETRY_MS, this.baseRetryMs, 24 * 60 * 60_000);
    this.terminalPayloadRetentionMs = boundedInteger(
      options.terminalPayloadRetentionMs,
      CRM_GATEWAY_TERMINAL_PAYLOAD_RETENTION_MS,
      24 * 60 * 60_000,
      10 * 365 * 24 * 60 * 60_000,
    );
    this.terminalMetadataRetentionMs = boundedInteger(
      options.terminalMetadataRetentionMs,
      CRM_GATEWAY_TERMINAL_METADATA_RETENTION_MS,
      this.terminalPayloadRetentionMs,
      10 * 365 * 24 * 60 * 60_000,
    );
    this.scheduledBatchSize = boundedInteger(options.scheduledBatchSize, CRM_GATEWAY_SCHEDULED_BATCH_SIZE, 1, 100);
  }

  async handleEvent(request: Request, context: WaitUntilContext): Promise<Response> {
    let verified;
    try {
      verified = await verifyNoticeRequest(request, {
        secrets: this.ingressSecrets,
        now: this.clock(),
      });
    } catch (error) {
      if (error instanceof NoticeRequestError) return errorResponse(error.status, error.code);
      return errorResponse(400, "invalid_request");
    }

    let normalized;
    try {
      normalized = normalizeCrmIntegrationEvent(verified.event);
    } catch (error) {
      const code = error instanceof CanonicalCrmEventError ? error.code : "invalid_event";
      return errorResponse(422, code);
    }

    if (
      verified.profile.provider !== this.adapter.provider
      || verified.profile.mappingVersion !== this.mappingVersion
    ) {
      return errorResponse(409, "crm_profile_mismatch");
    }

    if (verified.connectionTest || normalized.kind === "connection_test") {
      if (!verified.connectionTest || normalized.kind !== "connection_test") {
        return errorResponse(422, "connection_test_mismatch");
      }
      try {
        await this.adapter.testConnection();
        return jsonResponse(200, {
          status: "ok",
          dryRun: true,
          provider: this.adapter.provider,
          mappingVersion: this.mappingVersion,
        });
      } catch {
        return errorResponse(503, "provider_unavailable");
      }
    }

    const event = normalized.event;
    const targetProvider = crmTargetProvider(event);
    if (targetProvider === null) {
      return errorResponse(422, "crm_target_not_configured");
    }
    if (targetProvider !== this.adapter.provider) {
      return errorResponse(422, "crm_target_mismatch");
    }
    const now = this.clock().toISOString();
    let acceptance;
    try {
      acceptance = await this.store.accept({
        workspaceId: event.workspaceId,
        eventId: event.eventId,
        bodyDigest: verified.bodyDigest,
        // Persist the bounded provider-neutral event, not the ingress envelope
        // or its headers/secrets.
        eventJson: JSON.stringify(event),
        topic: event.topic,
        agreementId: String(event.agreementId),
        aggregateVersion: event.aggregateVersion,
        provider: this.adapter.provider,
        mappingVersion: this.mappingVersion,
        now,
      });
    } catch {
      return errorResponse(503, "receipt_unavailable");
    }

    if (acceptance.kind === "collision") {
      return errorResponse(409, "event_id_conflict");
    }
    if (acceptance.kind === "profile_conflict") {
      return errorResponse(409, "event_profile_conflict");
    }

    this.defer(context, acceptance.receipt);
    return jsonResponse(acceptance.kind === "new" ? 202 : 200, {
      status: acceptance.kind === "new" ? "accepted" : "duplicate",
    });
  }

  async processReceipt(receipt: ReceiptRecord): Promise<void> {
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    const staleBefore = new Date(nowDate.getTime() - this.leaseMs).toISOString();
    const claim = await this.store.claim(receipt, now, staleBefore);
    if (claim.kind !== "claimed") return;

    const claimed = claim.receipt;
    const leaseToken = claimed.leaseToken;
    if (!leaseToken) throw new Error("CRM receipt claim did not produce a lease");

    let event: CanonicalCrmEvent;
    try {
      event = parseCanonicalCrmEvent(JSON.parse(claimed.eventJson));
    } catch {
      await this.store.fail(claimed, leaseToken, {
        terminal: true,
        code: "receipt_event_invalid",
        availableAt: now,
        now,
      });
      return;
    }

    if (claimed.provider !== this.adapter.provider) {
      await this.store.fail(claimed, leaseToken, {
        terminal: true,
        code: "provider_configuration_changed",
        availableAt: now,
        now,
      });
      return;
    }
    if (claimed.mappingVersion !== this.mappingVersion) {
      await this.store.fail(claimed, leaseToken, {
        terminal: true,
        code: "mapping_configuration_changed",
        availableAt: now,
        now,
      });
      return;
    }
    const targetProvider = crmTargetProvider(event);
    if (targetProvider === null || targetProvider !== this.adapter.provider) {
      await this.store.fail(claimed, leaseToken, {
        terminal: true,
        code: targetProvider === null ? "receipt_target_not_configured" : "receipt_target_mismatch",
        availableAt: now,
        now,
      });
      return;
    }

    try {
      const result = await this.adapter.upsert(toProviderEvent(event, claimed.mappingVersion));
      await this.store.complete(claimed, leaseToken, result.providerRecordId, this.clock().toISOString());
    } catch (error) {
      const failure = classifyProviderFailure(error);
      const terminal = !failure.retryable || claimed.attempts >= this.maxAttempts;
      const failureNow = this.clock();
      const delay = terminal ? 0 : retryDelayMilliseconds(
        claimed.attempts,
        failure.retryAfterMs,
        this.baseRetryMs,
        this.maxRetryMs,
      );
      await this.store.fail(claimed, leaseToken, {
        terminal,
        code: failure.code,
        availableAt: new Date(failureNow.getTime() + delay).toISOString(),
        now: failureNow.toISOString(),
      });
    }
  }

  async runScheduled(): Promise<ScheduledRunResult> {
    const nowDate = this.clock();
    const now = nowDate.toISOString();
    const profile = { provider: this.adapter.provider, mappingVersion: this.mappingVersion };
    await this.store.recoverStale(new Date(nowDate.getTime() - this.leaseMs).toISOString(), now, profile);
    const due = await this.store.listDue(now, this.scheduledBatchSize, profile);
    let processingErrors = 0;
    // Sequential processing intentionally respects upstream API rate limits.
    for (const receipt of due) {
      try {
        await this.processReceipt(receipt);
      } catch {
        processingErrors += 1;
      }
    }
    await this.store.redactTerminalPayloads(
      new Date(nowDate.getTime() - this.terminalPayloadRetentionMs).toISOString(),
      now,
      this.scheduledBatchSize,
      profile,
    );
    await this.store.pruneTerminalMetadata(
      new Date(nowDate.getTime() - this.terminalMetadataRetentionMs).toISOString(),
      this.scheduledBatchSize,
      profile,
    );
    return Object.freeze({ examined: due.length, processingErrors });
  }

  private defer(context: WaitUntilContext, receipt: ReceiptRecord): void {
    // A failed immediate attempt remains durable and the scheduled worker will
    // recover it. Keep the deferred rejection out of platform error logs.
    const work = this.processReceipt(receipt).catch(() => undefined);
    try {
      context.waitUntil(work);
    } catch {
      // Receipt acceptance already committed; the scheduler is the fallback.
    }
  }
}

function crmTargetProvider(event: CanonicalCrmEvent): CrmAdapter["provider"] | null {
  const selection = event.operation === "upsert" ? event.agreement.crm : event.tombstone.crm;
  switch (selection) {
    case "HubSpot": return "hubspot";
    case "Salesforce": return "salesforce";
    case "Custom CRM": return "custom";
    case "None": return null;
  }
}

function toProviderEvent(event: CanonicalCrmEvent, mappingVersion: string): ProviderCanonicalCrmEvent {
  return {
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    topic: event.topic,
    agreementId: event.agreementId,
    externalKey: event.externalKey,
    aggregateVersion: event.aggregateVersion,
    mappingVersion,
    deleted: event.operation === "delete",
    projection: event.operation === "upsert" ? event.agreement : null,
    occurredAt: event.occurredAt,
    tombstone: event.operation === "delete" ? event.tombstone : null,
  };
}

function classifyProviderFailure(error: unknown): {
  code: string;
  retryable: boolean;
  retryAfterMs: number | null;
} {
  if (isRecord(error) && typeof error.retryable === "boolean") {
    return {
      code: safeErrorCode(error.code),
      retryable: error.retryable,
      retryAfterMs: safeRetryAfter(error.retryAfterMs),
    };
  }
  return { code: "provider_unexpected", retryable: true, retryAfterMs: null };
}

function retryDelayMilliseconds(
  attempts: number,
  retryAfterMs: number | null,
  baseRetryMs: number,
  maxRetryMs: number,
): number {
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  const exponential = Math.min(maxRetryMs, baseRetryMs * (2 ** exponent));
  const requested = retryAfterMs === null ? 0 : Math.min(maxRetryMs, Math.max(0, retryAfterMs));
  return Math.min(maxRetryMs, Math.max(exponential, requested));
}

function safeRetryAfter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string") return "provider_error";
  const normalized = value.toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized) ? normalized : "provider_error";
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("CRM gateway numeric option is out of range");
  }
  return value;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(status, { error: { code: safeErrorCode(code) } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

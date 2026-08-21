import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { signaturePackets, webhookReceipts } from "../../../../db/schema";
import { handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import { archiveSubmission, closeSubmission, completeSubmission, partiallyCompleteSubmission } from "../../../lib/docuseal-reconciliation";
import { docuSealProviderEventId, verifyDocuSealWebhook } from "../../../lib/docuseal";
import { apiError, apiJson, checkBestEffortRateLimit, createRequestId, rateLimitExceeded } from "../../../lib/http";
import { getDocuSealConfiguration } from "../../../lib/providers";
import { readBoundedBody } from "../../../lib/validation";
import {
  classifyWebhookReceipt,
  webhookAcknowledgement,
  type WebhookAcknowledgementOutcome,
} from "../../../lib/webhook-receipts";

const webhookSchema = z.object({
  event_type: z.enum([
    "form.viewed",
    "form.started",
    "form.completed",
    "form.declined",
    "submission.created",
    "submission.completed",
    "submission.expired",
    "submission.archived",
  ]),
  timestamp: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
});

const RECEIPT_AGGREGATE_TYPE = "signature_packet" as const;

export async function POST(request: Request) {
  const requestId = createRequestId();
  let receiptId: string | null = null;
  let receiptWorkspaceId: string | null = null;
  let receiptClaimedAt: string | null = null;
  let ownsReceipt = false;
  try {
    const configuration = getDocuSealConfiguration();
    const notice = getNoticeConfig();
    receiptWorkspaceId = notice.workspace.id;
    const rawBytes = await readBoundedBody(request, 1_000_000, "Maximum webhook body size is 1000000 bytes");
    let rawBody: string;
    try {
      rawBody = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    } catch {
      return apiError("invalid_payload", "Webhook payload must be valid UTF-8 JSON.", { status: 400, requestId });
    }
    const verification = await verifyDocuSealWebhook(rawBody, request.headers.get("x-docuseal-signature"), configuration.webhookSecret);
    if (!verification.valid) return apiError("invalid_signature", "Webhook signature is invalid.", { status: 401, requestId });
    // Only authenticated provider traffic consumes the shared callback quota;
    // invalid internet traffic must not be able to starve genuine callbacks.
    const rate = checkBestEffortRateLimit("webhook:docuseal", { limit: 300, windowMs: 60_000 });
    if (!rate.allowed) return rateLimitExceeded(rate, requestId);
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return apiError("invalid_payload", "Webhook payload must be valid JSON.", { status: 400, requestId });
    }
    const parsed = webhookSchema.safeParse(json);
    if (!parsed.success) return apiError("invalid_payload", "Webhook payload is invalid.", { status: 400, requestId });
    const submissionId = submissionIdFromPayload(parsed.data.event_type, parsed.data.data);
    if (!submissionId) return apiError("submission_id_missing", "Webhook submission identifier is missing.", { status: 400, requestId });

    await ensureStorageSchema();
    const db = getDb();
    const providerEventId = docuSealProviderEventId(parsed.data.event_type, submissionId, parsed.data.timestamp, parsed.data.data);
    if (!providerEventId) return apiError("provider_event_id_missing", "Webhook form identity is invalid.", { status: 400, requestId });
    const matchingPackets = await db.select().from(signaturePackets).where(and(
      eq(signaturePackets.workspaceId, notice.workspace.id),
      eq(signaturePackets.provider, "docuseal"),
      eq(signaturePackets.submissionId, submissionId),
    )).limit(2);
    if (matchingPackets.length !== 1) throw new Error("Webhook does not match exactly one Notice signature packet");
    const packet = matchingPackets[0];

    const claim = await claimWebhookReceipt(
      db,
      notice.workspace.id,
      packet.id,
      submissionId,
      providerEventId,
      verification.digest,
    );
    receiptId = claim.id;
    receiptClaimedAt = claim.claimedAt;
    ownsReceipt = claim.owned;
    if (claim.disposition === "collision") {
      return apiError("webhook_identity_collision", "The webhook identifier does not match its previously signed payload.", { status: 409, requestId });
    }
    if (claim.disposition === "aggregate_missing") throw new Error("Signature packet was removed before the webhook receipt could be claimed");
    if (claim.disposition === "processed") return completedWebhookResponse(requestId, true);
    if (claim.disposition === "busy") {
      return retryableWebhookResponse(requestId, "busy");
    }
    if (!claim.owned || !claim.claimedAt) throw new Error("Webhook receipt claim is unavailable");
    const claimToken = claim.claimedAt;

    if (parsed.data.event_type === "submission.completed") {
      const result = await completeSubmission(packet, configuration, notice.workspace.id);
      if (result === "busy") {
        const released = await db.update(webhookReceipts).set({ status: "received", error: null }).where(and(
          eq(webhookReceipts.id, receiptId),
          eq(webhookReceipts.workspaceId, notice.workspace.id),
          eq(webhookReceipts.provider, "docuseal"),
          eq(webhookReceipts.status, "processing"),
          eq(webhookReceipts.receivedAt, claimToken),
        ));
        if (!released.meta.changes) throw new Error("Webhook receipt ownership changed before retry release");
        ownsReceipt = false;
        return retryableWebhookResponse(requestId, "busy");
      }
    } else if (parsed.data.event_type === "form.completed") {
      await partiallyCompleteSubmission(packet, notice.workspace.id, parsed.data.data);
    } else if (parsed.data.event_type === "submission.archived") {
      await archiveSubmission(packet, notice.workspace.id);
    } else if (new Set(["form.declined", "submission.expired"]).has(parsed.data.event_type)) {
      const status = parsed.data.event_type === "form.declined"
        ? "declined"
        : "expired";
      const result = await closeSubmission(packet, notice.workspace.id, status, parsed.data.event_type === "form.declined" ? parsed.data.data : null);
      if (result === "busy") {
        const released = await db.update(webhookReceipts).set({ status: "received", error: null }).where(and(
          eq(webhookReceipts.id, receiptId),
          eq(webhookReceipts.workspaceId, notice.workspace.id),
          eq(webhookReceipts.provider, "docuseal"),
          eq(webhookReceipts.status, "processing"),
          eq(webhookReceipts.receivedAt, claimToken),
        ));
        if (!released.meta.changes) throw new Error("Webhook receipt ownership changed before retry release");
        ownsReceipt = false;
        return retryableWebhookResponse(requestId, "busy");
      }
    }

    const finalizedReceipt = await db.update(webhookReceipts).set({ status: "processed", processedAt: new Date().toISOString(), error: null }).where(and(
      eq(webhookReceipts.id, receiptId),
      eq(webhookReceipts.workspaceId, notice.workspace.id),
      eq(webhookReceipts.provider, "docuseal"),
      eq(webhookReceipts.status, "processing"),
      eq(webhookReceipts.receivedAt, claimToken),
    ));
    if (!finalizedReceipt.meta.changes) throw new Error("Webhook receipt ownership changed during processing");
    return completedWebhookResponse(requestId, false);
  } catch (error) {
    if (receiptId && receiptWorkspaceId && receiptClaimedAt && ownsReceipt) {
      try {
        await getDb().update(webhookReceipts).set({ status: "failed", error: "Processing failed" }).where(and(
          eq(webhookReceipts.id, receiptId),
          eq(webhookReceipts.workspaceId, receiptWorkspaceId),
          eq(webhookReceipts.provider, "docuseal"),
          eq(webhookReceipts.status, "processing"),
          eq(webhookReceipts.receivedAt, receiptClaimedAt),
        ));
      } catch { /* provider retry remains the recovery path */ }
    }
    if (receiptId && receiptWorkspaceId) return retryableWebhookResponse(requestId, "failed");
    return handleRouteError(error, requestId, "Webhook processing failed and will be retried.");
  }
}

function completedWebhookResponse(requestId: string, replay: boolean): Response {
  const acknowledgement = webhookAcknowledgement(replay ? "replay" : "processed");
  return apiJson({ accepted: true, replay, requestId }, { status: acknowledgement.status, requestId });
}

function retryableWebhookResponse(
  requestId: string,
  outcome: Extract<WebhookAcknowledgementOutcome, "busy" | "failed">,
): Response {
  const acknowledgement = webhookAcknowledgement(outcome);
  if (acknowledgement.retryAfterSeconds === null) throw new Error("Retryable webhook acknowledgement is invalid");
  return apiError(
    outcome === "busy" ? "webhook_processing" : "webhook_retry_required",
    outcome === "busy"
      ? "Webhook processing is still in progress and must be retried."
      : "Webhook processing failed and must be retried.",
    {
      status: acknowledgement.status,
      requestId,
      headers: { "Retry-After": String(acknowledgement.retryAfterSeconds) },
    },
  );
}

type Database = ReturnType<typeof getDb>;
type ReceiptClaim = {
  id: string;
  claimedAt: string | null;
  owned: boolean;
  disposition: "claimed" | "processed" | "busy" | "collision" | "aggregate_missing";
};

async function claimWebhookReceipt(
  db: Database,
  workspaceId: string,
  packetId: string,
  submissionId: string,
  providerEventId: string,
  payloadDigest: string,
): Promise<ReceiptClaim> {
  const id = crypto.randomUUID();
  const claimStartedAt = Date.now();
  const receivedAt = new Date(claimStartedAt).toISOString();
  // The receipt is created from the authoritative packet row. This makes a
  // concurrent hard purge serialize cleanly: either the receipt exists and
  // changes the purge count fence, or the packet is already gone and no
  // unbound provider identifier can be stranded after retention.
  const inserted = await db.insert(webhookReceipts).select(db.select({
    id: sql<string>`${id}`.as("id"),
    workspaceId: signaturePackets.workspaceId,
    provider: sql<string>`'docuseal'`.as("provider"),
    providerEventId: sql<string>`${providerEventId}`.as("provider_event_id"),
    payloadDigest: sql<string>`${payloadDigest}`.as("payload_digest"),
    aggregateType: sql<string>`${RECEIPT_AGGREGATE_TYPE}`.as("aggregate_type"),
    aggregateId: signaturePackets.id,
    status: sql<string>`'processing'`.as("status"),
    receivedAt: sql<string>`${receivedAt}`.as("received_at"),
    processedAt: sql<string | null>`null`.as("processed_at"),
    error: sql<string | null>`null`.as("error"),
  }).from(signaturePackets).where(and(
    eq(signaturePackets.workspaceId, workspaceId),
    eq(signaturePackets.id, packetId),
    eq(signaturePackets.provider, "docuseal"),
    eq(signaturePackets.submissionId, submissionId),
  ))).onConflictDoNothing();
  if (inserted.meta.changes) return { id, claimedAt: receivedAt, owned: true, disposition: "claimed" };

  const matches = await db.select().from(webhookReceipts).where(and(
    eq(webhookReceipts.workspaceId, workspaceId),
    eq(webhookReceipts.provider, "docuseal"),
    or(
      eq(webhookReceipts.providerEventId, providerEventId),
      eq(webhookReceipts.payloadDigest, payloadDigest),
    ),
  )).limit(2);
  const existing = matches[0] ?? null;
  if (!existing) return { id, claimedAt: null, owned: false, disposition: "aggregate_missing" };
  if (
    matches.length !== 1
    || existing.aggregateType !== RECEIPT_AGGREGATE_TYPE
    || existing.aggregateId !== packetId
    || classifyWebhookReceipt(existing, providerEventId, payloadDigest, { nowMs: claimStartedAt }) === "collision"
  ) {
    return { id: existing?.id ?? id, claimedAt: null, owned: false, disposition: "collision" };
  }
  const disposition = classifyWebhookReceipt(existing, providerEventId, payloadDigest, { nowMs: claimStartedAt });
  if (disposition === "processed") return { id: existing.id, claimedAt: null, owned: false, disposition };
  if (disposition === "busy") return { id: existing.id, claimedAt: null, owned: false, disposition };

  const claimed = await db.update(webhookReceipts).set({
    status: "processing",
    receivedAt,
    processedAt: null,
    error: null,
  }).where(and(
    eq(webhookReceipts.id, existing.id),
    eq(webhookReceipts.workspaceId, workspaceId),
    eq(webhookReceipts.provider, "docuseal"),
    eq(webhookReceipts.aggregateType, RECEIPT_AGGREGATE_TYPE),
    eq(webhookReceipts.aggregateId, packetId),
    eq(webhookReceipts.status, existing.status),
    eq(webhookReceipts.receivedAt, existing.receivedAt),
  ));
  if (claimed.meta.changes) return { id: existing.id, claimedAt: receivedAt, owned: true, disposition: "claimed" };

  const [current] = await db.select().from(webhookReceipts).where(and(
    eq(webhookReceipts.id, existing.id),
    eq(webhookReceipts.workspaceId, workspaceId),
    eq(webhookReceipts.provider, "docuseal"),
  )).limit(1);
  if (current?.aggregateType !== RECEIPT_AGGREGATE_TYPE || current.aggregateId !== packetId) {
    return { id: existing.id, claimedAt: null, owned: false, disposition: "collision" };
  }
  const currentDisposition = classifyWebhookReceipt(current ?? null, providerEventId, payloadDigest);
  return {
    id: existing.id,
    claimedAt: null,
    owned: false,
    disposition: currentDisposition === "processed" ? "processed" : currentDisposition === "collision" ? "collision" : "busy",
  };
}

function submissionIdFromPayload(eventType: string, data: Record<string, unknown>): string | null {
  const direct = data.submission_id ?? (eventType.startsWith("submission.") ? data.id : undefined);
  if (typeof direct === "number" || typeof direct === "string") return String(direct);
  const nested = data.submission;
  if (nested && typeof nested === "object" && "id" in nested) {
    const value = (nested as { id?: unknown }).id;
    if (typeof value === "number" || typeof value === "string") return String(value);
  }
  return null;
}

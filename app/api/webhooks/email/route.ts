import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { negotiationRounds, webhookReceipts } from "../../../../db/schema";
import { handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import { sha256Hex } from "../../../lib/document-security";
import { apiError, apiJson, checkBestEffortRateLimit, createRequestId, rateLimitExceeded } from "../../../lib/http";
import {
  parseNegotiationAliasAddress,
  normalizeNegotiationEmail,
  verifyNegotiationInboundPayload,
} from "../../../lib/negotiation-exchange";
import {
  NegotiationServiceError,
  findNegotiationRoundByAlias,
  ingestNegotiationSubmissions,
} from "../../../lib/negotiation-service";
import { getCounterpartyExchangeConfiguration } from "../../../lib/providers";
import { readBoundedBody } from "../../../lib/validation";
import { classifyWebhookReceipt, webhookAcknowledgement } from "../../../lib/webhook-receipts";

const EVENT_PROVIDER = "inbound-email-gateway";
const MESSAGE_PROVIDER = "inbound-email-message";
const RECEIPT_AGGREGATE_TYPE = "negotiation_round" as const;
const MAX_MULTIPART_BODY_BYTES = 21 * 1_024 * 1_024;
const MAX_ATTACHMENTS = 5;

const authenticationResult = z.enum(["pass", "fail", "neutral", "unknown"]);
const messageHeader = z.string().max(500).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "Message headers cannot contain control characters",
);
const attachmentManifestSchema = z.object({
  fieldName: z.string().regex(/^attachment_[0-4]$/),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(200),
  size: z.number().int().positive().max(20 * 1_024 * 1_024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  providerEventId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  providerMessageId: z.string().min(1).max(500).refine(
    (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
    "Provider message id must be canonical non-control text",
  ),
  internetMessageId: messageHeader.optional(),
  inReplyTo: messageHeader.optional(),
  from: z.object({
    email: z.string().min(3).max(320),
    name: z.string().max(200).refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Sender name cannot contain control characters",
    ).optional(),
  }).strict(),
  to: z.string().min(3).max(320),
  authentication: z.object({
    aligned: z.boolean(),
    spf: authenticationResult.optional(),
    dkim: authenticationResult.optional(),
    dmarc: authenticationResult.optional(),
  }).strict(),
  attachments: z.array(attachmentManifestSchema).max(MAX_ATTACHMENTS),
}).strict().superRefine((value, context) => {
  const names = value.attachments.map((attachment) => attachment.fieldName);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Attachment field names must be unique" });
  }
});

type Database = ReturnType<typeof getDb>;
type ReceiptClaim = Readonly<{
  id: string;
  provider: string;
  aggregateType: typeof RECEIPT_AGGREGATE_TYPE;
  aggregateId: string;
  claimedAt: string | null;
  owned: boolean;
  disposition: "claimed" | "processed" | "rejected" | "busy" | "collision" | "aggregate_missing";
  rejection: Readonly<{ code: string; status: number }> | null;
}>;

function persistedRejection(value: string | null): { code: string; status: number } | null {
  const match = /^([4][0-9]{2}):([a-z0-9_]{1,100})$/.exec(value ?? "");
  return match ? { status: Number(match[1]), code: match[2]! } : null;
}

function boundedMultipartRequest(request: Request, body: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: body.buffer as ArrayBuffer });
}

async function claimWebhookReceipt(
  db: Database,
  workspaceId: string,
  provider: string,
  providerEventId: string,
  payloadDigest: string,
  aggregateType: typeof RECEIPT_AGGREGATE_TYPE,
  aggregateId: string,
): Promise<ReceiptClaim> {
  const id = crypto.randomUUID();
  const claimStartedAt = Date.now();
  const receivedAt = new Date(claimStartedAt).toISOString();
  const inserted = await db.insert(webhookReceipts).select(db.select({
    id: sql<string>`${id}`.as("id"),
    workspaceId: negotiationRounds.workspaceId,
    provider: sql<string>`${provider}`.as("provider"),
    providerEventId: sql<string>`${providerEventId}`.as("provider_event_id"),
    payloadDigest: sql<string>`${payloadDigest}`.as("payload_digest"),
    aggregateType: sql<string>`${aggregateType}`.as("aggregate_type"),
    aggregateId: negotiationRounds.id,
    status: sql<string>`'processing'`.as("status"),
    receivedAt: sql<string>`${receivedAt}`.as("received_at"),
    processedAt: sql<string | null>`null`.as("processed_at"),
    error: sql<string | null>`null`.as("error"),
  }).from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, workspaceId),
    eq(negotiationRounds.id, aggregateId),
  ))).onConflictDoNothing();
  if (inserted.meta.changes) return { id, provider, aggregateType, aggregateId, claimedAt: receivedAt, owned: true, disposition: "claimed", rejection: null };

  const matches = await db.select().from(webhookReceipts).where(and(
    eq(webhookReceipts.workspaceId, workspaceId),
    eq(webhookReceipts.provider, provider),
    or(
      eq(webhookReceipts.providerEventId, providerEventId),
      eq(webhookReceipts.payloadDigest, payloadDigest),
    ),
  )).limit(2);
  const existing = matches[0] ?? null;
  if (!existing) {
    return { id, provider, aggregateType, aggregateId, claimedAt: null, owned: false, disposition: "aggregate_missing", rejection: null };
  }
  if (
    matches.length !== 1
    || existing?.providerEventId !== providerEventId
    || existing.payloadDigest !== payloadDigest
    || existing.aggregateType !== aggregateType
    || existing.aggregateId !== aggregateId
  ) {
    return { id: existing?.id ?? id, provider, aggregateType, aggregateId, claimedAt: null, owned: false, disposition: "collision", rejection: null };
  }
  const rejection = existing.status === "rejected" ? persistedRejection(existing.error) : null;
  if (rejection) return { id: existing.id, provider, aggregateType, aggregateId, claimedAt: null, owned: false, disposition: "rejected", rejection };
  const disposition = classifyWebhookReceipt(existing, providerEventId, payloadDigest, { nowMs: claimStartedAt });
  if (disposition === "processed" || disposition === "busy") {
    return { id: existing.id, provider, aggregateType, aggregateId, claimedAt: null, owned: false, disposition, rejection: null };
  }
  const claimed = await db.update(webhookReceipts).set({
    status: "processing",
    receivedAt,
    processedAt: null,
    error: null,
  }).where(and(
    eq(webhookReceipts.id, existing.id),
    eq(webhookReceipts.workspaceId, workspaceId),
    eq(webhookReceipts.provider, provider),
    eq(webhookReceipts.aggregateType, aggregateType),
    eq(webhookReceipts.aggregateId, aggregateId),
    eq(webhookReceipts.status, existing.status),
    eq(webhookReceipts.receivedAt, existing.receivedAt),
  ));
  if (claimed.meta.changes) return { id: existing.id, provider, aggregateType, aggregateId, claimedAt: receivedAt, owned: true, disposition: "claimed", rejection: null };
  const [current] = await db.select().from(webhookReceipts).where(and(
    eq(webhookReceipts.id, existing.id),
    eq(webhookReceipts.workspaceId, workspaceId),
    eq(webhookReceipts.provider, provider),
  )).limit(1);
  const currentRejection = current?.status === "rejected" ? persistedRejection(current.error) : null;
  if (currentRejection) {
    return { id: existing.id, provider, aggregateType, aggregateId, claimedAt: null, owned: false, disposition: "rejected", rejection: currentRejection };
  }
  if (current?.aggregateType !== aggregateType || current.aggregateId !== aggregateId) {
    return { id: existing.id, provider, aggregateType, aggregateId, claimedAt: null, owned: false, disposition: "collision", rejection: null };
  }
  const currentDisposition = classifyWebhookReceipt(current ?? null, providerEventId, payloadDigest);
  return {
    id: existing.id,
    provider,
    aggregateType,
    aggregateId,
    claimedAt: null,
    owned: false,
    disposition: currentDisposition === "processed" ? "processed" : currentDisposition === "collision" ? "collision" : "busy",
    rejection: null,
  };
}

async function finalizeReceipts(
  db: Database,
  workspaceId: string,
  receipts: readonly ReceiptClaim[],
  outcome: Readonly<{ status: "processed" | "failed" | "rejected"; error: string | null }>,
): Promise<boolean> {
  const owned = receipts.filter((candidate) => candidate.owned && candidate.claimedAt);
  if (!owned.length) return false;
  const processedAt = outcome.status === "processed" || outcome.status === "rejected" ? new Date().toISOString() : null;
  const statements = owned.map((candidate) => db.update(webhookReceipts).set({
    status: outcome.status,
    processedAt,
    error: outcome.error,
  }).where(and(
    eq(webhookReceipts.id, candidate.id),
    eq(webhookReceipts.workspaceId, workspaceId),
    eq(webhookReceipts.provider, candidate.provider),
    eq(webhookReceipts.aggregateType, candidate.aggregateType),
    eq(webhookReceipts.aggregateId, candidate.aggregateId),
    eq(webhookReceipts.status, "processing"),
    eq(webhookReceipts.receivedAt, candidate.claimedAt!),
  )));
  const results = await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  return results.every((result) => result.meta.changes === 1);
}

function completed(requestId: string, replay: boolean): Response {
  return apiJson({ accepted: true, replay, requestId }, {
    status: webhookAcknowledgement(replay ? "replay" : "processed").status,
    requestId,
  });
}

function retryable(requestId: string, outcome: "busy" | "failed"): Response {
  const acknowledgement = webhookAcknowledgement(outcome);
  return apiError(
    outcome === "busy" ? "webhook_processing" : "webhook_retry_required",
    outcome === "busy" ? "Webhook processing is still in progress and must be retried." : "Webhook processing failed and must be retried.",
    {
      status: acknowledgement.status,
      requestId,
      headers: { "Retry-After": String(acknowledgement.retryAfterSeconds) },
    },
  );
}

export async function POST(request: Request) {
  const requestId = createRequestId();
  let receipt: ReceiptClaim | null = null;
  let messageReceipt: ReceiptClaim | null = null;
  let workspaceId: string | null = null;
  try {
    const configuration = getCounterpartyExchangeConfiguration();
    if (!configuration.inboundEmail) {
      return apiError("email_capture_disabled", "Inbound email capture is unavailable.", { status: 503, requestId });
    }
    workspaceId = getNoticeConfig().workspace.id;
    const rawBytes = await readBoundedBody(
      request,
      MAX_MULTIPART_BODY_BYTES,
      `Maximum multipart body size is ${MAX_MULTIPART_BODY_BYTES} bytes`,
    );
    const contentSha256 = await sha256Hex(rawBytes);
    const declaredSha256 = request.headers.get("x-notice-content-sha256") ?? "";
    const timestamp = request.headers.get("x-notice-timestamp") ?? "";
    const signature = request.headers.get("x-notice-signature") ?? "";
    const eventIdHeader = request.headers.get("x-notice-email-event-id") ?? "";
    if (!/^[0-9a-f]{64}$/.test(declaredSha256) || declaredSha256 !== contentSha256) {
      return apiError("content_hash_mismatch", "Signed content hash does not match the exact request body.", { status: 401, requestId });
    }
    if (!/^[1-9][0-9]{0,12}$/.test(timestamp) || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
      return apiError("invalid_signature", "Inbound email signature is invalid or expired.", { status: 401, requestId });
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(eventIdHeader)) {
      return apiError("invalid_event_id", "Inbound email event identifier is invalid.", { status: 400, requestId });
    }
    const signatureValid = await verifyNegotiationInboundPayload({
      secret: configuration.inboundEmail.secret,
      timestampSeconds: timestamp,
      rawBodySha256: contentSha256,
      signature,
    });
    if (!signatureValid) return apiError("invalid_signature", "Inbound email signature is invalid or expired.", { status: 401, requestId });
    const rate = checkBestEffortRateLimit(`webhook:email:${workspaceId}`, { limit: 120, windowMs: 60_000 });
    if (!rate.allowed) return rateLimitExceeded(rate, requestId);
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      return apiError("unsupported_media_type", "Inbound email callbacks must use multipart/form-data.", { status: 415, requestId });
    }

    let form: FormData;
    try {
      form = await boundedMultipartRequest(request, rawBytes).formData();
    } catch {
      return apiError("invalid_multipart", "Inbound email callback is not valid multipart form data.", { status: 400, requestId });
    }
    const manifestFields = form.getAll("manifest");
    if (manifestFields.length !== 1 || typeof manifestFields[0] !== "string") {
      return apiError("invalid_manifest", "Inbound email callback requires exactly one JSON manifest field.", { status: 400, requestId });
    }
    const manifestText = manifestFields[0];
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(manifestText); } catch {
      return apiError("invalid_manifest", "Inbound email manifest must be valid JSON.", { status: 400, requestId });
    }
    const parsed = manifestSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.providerEventId !== eventIdHeader) {
      return apiError("invalid_manifest", "Inbound email manifest is invalid or does not match its event header.", { status: 400, requestId });
    }
    const manifest = parsed.data;
    try { normalizeNegotiationEmail(manifest.from.email); } catch {
      return apiError("invalid_sender", "Inbound sender address is invalid.", { status: 400, requestId });
    }
    const files = new Map<string, File>();
    for (const [name, value] of form.entries()) {
      if (name === "manifest") continue;
      if (!(value instanceof File) || files.has(name)) {
        return apiError("invalid_attachments", "Every non-manifest multipart field must be one uniquely named attachment.", { status: 400, requestId });
      }
      files.set(name, value);
    }
    if (files.size !== manifest.attachments.length || files.size > MAX_ATTACHMENTS) {
      return apiError("attachment_manifest_mismatch", "Attachment count does not match the signed manifest.", { status: 400, requestId });
    }
    const attachments = [];
    for (const expected of manifest.attachments) {
      const file = files.get(expected.fieldName);
      if (!file || file.name !== expected.fileName || file.size !== expected.size || file.type !== expected.contentType) {
        return apiError("attachment_manifest_mismatch", "Attachment metadata does not match the signed manifest.", { status: 400, requestId });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (await sha256Hex(bytes) !== expected.sha256) {
        return apiError("attachment_hash_mismatch", "Attachment bytes do not match the signed manifest.", { status: 400, requestId });
      }
      attachments.push({
        fileName: file.name,
        declaredContentType: expected.contentType,
        declaredSize: expected.size,
        declaredSha256: expected.sha256,
        bytes,
      });
    }
    const aliasCode = parseNegotiationAliasAddress(manifest.to, configuration.inboundEmail.domain);
    if (!aliasCode) return apiError("unknown_exchange_alias", "Inbound email alias is invalid.", { status: 404, requestId });
    await ensureStorageSchema();
    const round = await findNegotiationRoundByAlias(workspaceId, aliasCode);
    if (!round) return apiError("unknown_exchange_alias", "Inbound email alias is invalid.", { status: 404, requestId });
    const db = getDb();
    const payloadDigest = contentSha256;
    receipt = await claimWebhookReceipt(
      db,
      workspaceId,
      EVENT_PROVIDER,
      manifest.providerEventId,
      payloadDigest,
      RECEIPT_AGGREGATE_TYPE,
      round.id,
    );
    if (receipt.disposition === "collision") {
      return apiError("webhook_identity_collision", "The event identifier does not match its previously signed manifest.", { status: 409, requestId });
    }
    if (receipt.disposition === "aggregate_missing") {
      return apiError("exchange_closed", "This negotiation exchange no longer accepts inbound messages.", { status: 410, requestId });
    }
    if (receipt.disposition === "processed") return completed(requestId, true);
    if (receipt.disposition === "rejected" && receipt.rejection) {
      return apiError(receipt.rejection.code, "This signed inbound event was previously rejected.", { status: receipt.rejection.status, requestId });
    }
    if (receipt.disposition === "busy") return retryable(requestId, "busy");
    if (!receipt.owned || !receipt.claimedAt) throw new Error("Inbound email receipt claim is unavailable");
    const messageBindingDigest = await sha256Hex(`${round.id}.${contentSha256}`);
    messageReceipt = await claimWebhookReceipt(
      db,
      workspaceId,
      MESSAGE_PROVIDER,
      manifest.providerMessageId,
      messageBindingDigest,
      RECEIPT_AGGREGATE_TYPE,
      round.id,
    );
    if (messageReceipt.disposition === "aggregate_missing") {
      return apiError("exchange_closed", "This negotiation exchange no longer accepts inbound messages.", { status: 410, requestId });
    }
    if (messageReceipt.disposition === "collision" || messageReceipt.disposition === "processed" || messageReceipt.disposition === "rejected") {
      throw new NegotiationServiceError(
        "provider_message_collision",
        "This provider message identifier was already used by a different signed event.",
      );
    }
    if (messageReceipt.disposition === "busy") throw new Error("Inbound provider message claim is busy");
    if (!messageReceipt.owned || !messageReceipt.claimedAt) throw new Error("Inbound provider message claim is unavailable");
    if (!round.activeKey || round.status === "resolved" || round.status === "closed") {
      throw new NegotiationServiceError(
        "exchange_closed",
        "This negotiation exchange no longer accepts inbound messages.",
        410,
      );
    }

    await ingestNegotiationSubmissions({
      workspaceId,
      agreementId: round.agreementId,
      roundId: round.id,
      source: "email",
      senderEmail: manifest.from.email,
      senderName: manifest.from.name,
      providerMessageId: manifest.providerMessageId,
      authenticationAligned: manifest.authentication.aligned,
      emailEvidence: {
        internetMessageId: manifest.internetMessageId,
        inReplyTo: manifest.inReplyTo,
        aligned: manifest.authentication.aligned,
        spf: manifest.authentication.spf,
        dkim: manifest.authentication.dkim,
        dmarc: manifest.authentication.dmarc,
      },
      receiptClaims: [receipt, messageReceipt].map((claim) => ({
        id: claim.id,
        provider: claim.provider,
        aggregateType: claim.aggregateType,
        aggregateId: claim.aggregateId,
        claimedAt: claim.claimedAt!,
      })),
      attachments,
    });
    return completed(requestId, false);
  } catch (error) {
    if (receipt?.owned && receipt.claimedAt && workspaceId) {
      const ownedReceipts = [receipt, messageReceipt].filter((candidate): candidate is ReceiptClaim => Boolean(candidate));
      if (error instanceof NegotiationServiceError && error.status >= 400 && error.status < 500) {
        try {
          const finalized = await finalizeReceipts(getDb(), workspaceId, ownedReceipts, {
            status: "rejected",
            error: `${error.status}:${error.code}`.slice(0, 500),
          });
          if (!finalized) return retryable(requestId, "failed");
          return apiError(error.code, error.message, { status: error.status, requestId });
        } catch { return retryable(requestId, "failed"); }
      }
      try {
        await finalizeReceipts(getDb(), workspaceId, ownedReceipts, { status: "failed", error: "Processing failed" });
      } catch { /* signed provider retry remains the recovery path */ }
      return retryable(requestId, "failed");
    }
    if (error instanceof NegotiationServiceError) {
      return apiError(error.code, error.message, { status: error.status, requestId });
    }
    return handleRouteError(error, requestId, "Inbound email processing failed and will be retried.");
  }
}

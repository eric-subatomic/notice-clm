export type WebhookReceiptState = {
  id: string;
  providerEventId: string | null;
  payloadDigest: string;
  status: string;
  receivedAt: string;
};

export type WebhookReceiptDisposition = "new" | "processed" | "busy" | "retry" | "collision";

export const WEBHOOK_RECEIPT_PROCESSING_TIMEOUT_MS = 15 * 60_000;
export const WEBHOOK_RETRY_AFTER_SECONDS = 5;

export type WebhookAcknowledgementOutcome = "processed" | "replay" | "busy" | "failed";
export type WebhookAcknowledgement = Readonly<{
  status: 200 | 503;
  retryAfterSeconds: number | null;
}>;

/**
 * Provider callbacks may receive 2xx only after durable completion or a
 * replay-safe processed receipt. Busy and failed work must remain retryable.
 */
export function webhookAcknowledgement(outcome: WebhookAcknowledgementOutcome): WebhookAcknowledgement {
  if (outcome === "processed" || outcome === "replay") {
    return Object.freeze({ status: 200, retryAfterSeconds: null });
  }
  return Object.freeze({ status: 503, retryAfterSeconds: WEBHOOK_RETRY_AFTER_SECONDS });
}

type WebhookReceiptClassificationOptions = {
  nowMs?: number;
  processingTimeoutMs?: number;
};

/**
 * Classify an existing provider receipt before any state transition. Provider
 * identifiers and signed payload digests must continue to identify the same
 * delivery; mismatches are evidence of a collision, not a retry. While a
 * receipt is processing, receivedAt is the current claim's lease timestamp
 * and is refreshed by the compare-and-swap reclaim operation.
 */
export function classifyWebhookReceipt(
  existing: WebhookReceiptState | null,
  providerEventId: string,
  payloadDigest: string,
  options: WebhookReceiptClassificationOptions = {},
): WebhookReceiptDisposition {
  if (!existing) return "new";
  if (existing.providerEventId !== providerEventId || existing.payloadDigest !== payloadDigest) return "collision";
  if (existing.status === "processed") return "processed";
  if (existing.status === "failed" || existing.status === "received") return "retry";
  if (existing.status === "processing") {
    const receivedAt = Date.parse(existing.receivedAt);
    const nowMs = options.nowMs ?? Date.now();
    const processingTimeoutMs = options.processingTimeoutMs ?? WEBHOOK_RECEIPT_PROCESSING_TIMEOUT_MS;
    if (
      Number.isFinite(receivedAt)
      && Number.isFinite(nowMs)
      && Number.isFinite(processingTimeoutMs)
      && processingTimeoutMs > 0
      && nowMs >= receivedAt
      && nowMs - receivedAt >= processingTimeoutMs
    ) return "retry";
  }
  return "busy";
}

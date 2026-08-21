import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWebhookReceipt,
  webhookAcknowledgement,
  WEBHOOK_RECEIPT_PROCESSING_TIMEOUT_MS,
  WEBHOOK_RETRY_AFTER_SECONDS,
} from "../app/lib/webhook-receipts";

const nowMs = Date.parse("2026-08-01T12:30:00.000Z");

const receipt = {
  id: "receipt-1",
  providerEventId: "submission.completed:42:2026-08-01T12:00:00Z",
  payloadDigest: "digest-1",
  status: "processing",
  receivedAt: new Date(nowMs - WEBHOOK_RECEIPT_PROCESSING_TIMEOUT_MS + 1).toISOString(),
};

test("webhook receipts distinguish new, completed, in-flight, and retryable deliveries", () => {
  assert.equal(classifyWebhookReceipt(null, receipt.providerEventId, receipt.payloadDigest), "new");
  assert.equal(classifyWebhookReceipt(receipt, receipt.providerEventId, receipt.payloadDigest, { nowMs }), "busy");
  assert.equal(classifyWebhookReceipt({ ...receipt, status: "processed" }, receipt.providerEventId, receipt.payloadDigest), "processed");
  assert.equal(classifyWebhookReceipt({ ...receipt, status: "failed" }, receipt.providerEventId, receipt.payloadDigest), "retry");
  assert.equal(classifyWebhookReceipt({ ...receipt, status: "received" }, receipt.providerEventId, receipt.payloadDigest), "retry");
});

test("webhook receipts recover a processing claim only after the bounded timeout", () => {
  assert.equal(classifyWebhookReceipt({
    ...receipt,
    receivedAt: new Date(nowMs - WEBHOOK_RECEIPT_PROCESSING_TIMEOUT_MS).toISOString(),
  }, receipt.providerEventId, receipt.payloadDigest, { nowMs }), "retry");
  assert.equal(classifyWebhookReceipt({
    ...receipt,
    receivedAt: "not-a-date",
  }, receipt.providerEventId, receipt.payloadDigest, { nowMs }), "busy");
  assert.equal(classifyWebhookReceipt({
    ...receipt,
    receivedAt: new Date(nowMs + 1).toISOString(),
  }, receipt.providerEventId, receipt.payloadDigest, { nowMs }), "busy");
});

test("webhook receipt identity collisions fail closed", () => {
  const stale = {
    ...receipt,
    receivedAt: new Date(nowMs - WEBHOOK_RECEIPT_PROCESSING_TIMEOUT_MS).toISOString(),
  };
  assert.equal(classifyWebhookReceipt(stale, receipt.providerEventId, "changed-digest", { nowMs }), "collision");
  assert.equal(classifyWebhookReceipt(stale, "changed-event", receipt.payloadDigest, { nowMs }), "collision");
});

test("only durable completion and replay are acknowledged while busy or crashed work remains retryable", () => {
  assert.deepEqual(webhookAcknowledgement("processed"), { status: 200, retryAfterSeconds: null });
  assert.deepEqual(webhookAcknowledgement("replay"), { status: 200, retryAfterSeconds: null });
  for (const outcome of ["busy", "failed"] as const) {
    const acknowledgement = webhookAcknowledgement(outcome);
    assert.equal(acknowledgement.status, 503);
    assert.equal(acknowledgement.retryAfterSeconds, WEBHOOK_RETRY_AFTER_SECONDS);
    assert.ok((acknowledgement.retryAfterSeconds ?? 0) >= 1 && (acknowledgement.retryAfterSeconds ?? 0) <= 60);
  }
});

test("a crashed processing claim is busy until stale, then becomes reclaimable without a 2xx acknowledgement", () => {
  const crashed = { ...receipt, receivedAt: new Date(nowMs).toISOString() };
  assert.equal(classifyWebhookReceipt(crashed, receipt.providerEventId, receipt.payloadDigest, { nowMs }), "busy");
  assert.equal(webhookAcknowledgement("busy").status, 503);

  const afterTimeout = nowMs + WEBHOOK_RECEIPT_PROCESSING_TIMEOUT_MS;
  assert.equal(classifyWebhookReceipt(crashed, receipt.providerEventId, receipt.payloadDigest, { nowMs: afterTimeout }), "retry");
  assert.equal(webhookAcknowledgement("failed").status, 503);
});

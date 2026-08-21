import assert from "node:assert/strict";
import test from "node:test";
import { deriveNegotiationRoundAction, negotiationDeliveryState } from "../app/lib/negotiation-round-state";

test("round action priority preserves the most important current submission", () => {
  const base = { roundNumber: 4, currentStatus: "outbound" as const };
  assert.deepEqual(
    deriveNegotiationRoundAction({ ...base, submissionStatuses: ["ready", "quarantined", "rejected", "no_attachment"] }),
    { roundStatus: "returned", nextAction: "Review returned counterparty file for negotiation round 4" },
  );
  assert.equal(deriveNegotiationRoundAction({ ...base, submissionStatuses: ["quarantined", "sender_review"] }).roundStatus, "review");
  assert.match(deriveNegotiationRoundAction({ ...base, submissionStatuses: ["quarantined", "sender_review"] }).nextAction, /Verify the sender/);
  assert.match(deriveNegotiationRoundAction({ ...base, submissionStatuses: ["rejected", "no_attachment"] }).nextAction, /safe replacement/);
});

test("delivery state drives an honest queue when no return needs review", () => {
  const base = { roundNumber: 2, currentStatus: "outbound" as const, submissionStatuses: [] };
  assert.match(deriveNegotiationRoundAction({ ...base, deliveryState: "queued" }).nextAction, /Confirm gateway delivery/);
  assert.match(deriveNegotiationRoundAction({ ...base, deliveryState: "dead" }).nextAction, /Close failed delivery round/);
  assert.match(deriveNegotiationRoundAction({ ...base, deliveryState: "accepted" }).nextAction, /Await counterparty response/);
  assert.equal(deriveNegotiationRoundAction({ ...base, currentStatus: "prepared" }).roundStatus, "prepared");
});

test("persisted outbox states map to a bounded public delivery state", () => {
  assert.equal(negotiationDeliveryState({ deliveryMethod: null }), "not_queued");
  assert.equal(negotiationDeliveryState({ deliveryMethod: "manual" }), "manual_recorded");
  assert.equal(negotiationDeliveryState({ deliveryMethod: "email_gateway", outboxStatus: "pending" }), "queued");
  assert.equal(negotiationDeliveryState({ deliveryMethod: "email_gateway", outboxStatus: "processing" }), "processing");
  assert.equal(negotiationDeliveryState({ deliveryMethod: "email_gateway", outboxStatus: "processed" }), "accepted");
  assert.equal(negotiationDeliveryState({ deliveryMethod: "email_gateway", outboxStatus: "dead" }), "dead");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveNegotiationRoundAction } from "../app/lib/negotiation-round-state";

const routeSource = () => readFile(new URL("../app/api/jobs/outbox/route.ts", import.meta.url), "utf8");

test("terminal delivery outcomes cannot hide a more important returned-file action", () => {
  for (const deliveryState of ["accepted", "dead"] as const) {
    assert.deepEqual(deriveNegotiationRoundAction({
      roundNumber: 7,
      currentStatus: "outbound",
      submissionStatuses: ["no_attachment", "rejected", "quarantined", "sender_review", "ready"],
      deliveryState,
    }), {
      roundStatus: "returned",
      nextAction: "Review returned counterparty file for negotiation round 7",
    });
    assert.match(deriveNegotiationRoundAction({
      roundNumber: 7,
      currentStatus: "outbound",
      submissionStatuses: ["quarantined", "sender_review"],
      deliveryState,
    }).nextAction, /Verify the sender/);
  }

  assert.match(deriveNegotiationRoundAction({
    roundNumber: 7,
    currentStatus: "outbound",
    submissionStatuses: [],
    deliveryState: "dead",
  }).nextAction, /Close failed delivery round 7 and prepare a new review round/);
  assert.match(deriveNegotiationRoundAction({
    roundNumber: 7,
    currentStatus: "outbound",
    submissionStatuses: [],
    deliveryState: "accepted",
  }).nextAction, /Await counterparty response/);
});

test("the parent outbox terminal CAS and negotiation projection share one guarded batch", async () => {
  const route = await routeSource();
  const finalizer = route.slice(
    route.indexOf("async function finalizeTerminalOutboxEvent"),
    route.indexOf("export async function POST"),
  );

  assert.match(finalizer, /deliveryState: input\.outcome/);
  assert.match(finalizer, /const statements:[\s\S]*= \[\s*terminalOutboxUpdate,[\s\S]*await input\.db\.batch\(statements\)/);
  assert.match(finalizer, /eq\(outboxEvents\.status, "processing"\)[\s\S]*eq\(outboxEvents\.lockedAt, input\.lockTime\)/);
  assert.match(finalizer, /operation: `outbox\.negotiation\.\$\{input\.outcome\}`[\s\S]*guardChanges: sql<number>`changes\(\)`/);
  assert.match(finalizer, /eq\(agreements\.version, snapshot\.agreement\.version\)[\s\S]*eq\(agreements\.updatedAt, snapshot\.agreement\.updatedAt\)/);
  assert.match(finalizer, /eq\(negotiationRounds\.status, snapshot\.round\.status\)[\s\S]*eq\(negotiationRounds\.updatedAt, snapshot\.round\.updatedAt\)/);
  assert.match(finalizer, /notExists\([\s\S]*gt\(negotiationRounds\.roundNumber, snapshot\.round\.roundNumber\)/);
  assert.match(finalizer, /negotiationSubmissionStatuses\.map\(\(status\) => sql`\([\s\S]*terminal_submission[\s\S]*submissionStatusCounts\[status\]/);
  assert.match(finalizer, /isMutationGuardConflict\(error\)[\s\S]*negotiation_state_reconciliation_conflict/);
});

test("accepted, exhausted, and pre-delivery superseded paths all use terminal reconciliation", async () => {
  const route = await routeSource();
  assert.equal((route.match(/await finalizeTerminalOutboxEvent\(\{/g) ?? []).length, 3);
  assert.match(route, /!await externalDeliveryIsCurrent[\s\S]*const supersededCode = row\.topic === "negotiation\.round_requested"[\s\S]*"negotiation_delivery_superseded"[\s\S]*outcome: "dead"[\s\S]*pendingDeliveryFailure: supersededCode/);
  assert.match(route, /externalDeliveryIsCurrent[\s\S]*negotiationDeliveryIsCurrent[\s\S]*obligationReminderDeliveryIsCurrent/);
  assert.match(route, /if \(allAccepted\)[\s\S]*outcome: "accepted"/);
  assert.match(route, /if \(anyDead\)[\s\S]*outcome: "dead"/);

  const sinkAcceptance = route.indexOf("await db.update(outboxDeliveries).set({\n            status: \"accepted\"");
  const parentFinalization = route.lastIndexOf("outcome: \"accepted\"");
  assert.ok(sinkAcceptance >= 0 && parentFinalization > sinkAcceptance, "sink acceptance must precede parent finalization");
  assert.match(route, /destination\.status !== "pending"[\s\S]*continue/);
});

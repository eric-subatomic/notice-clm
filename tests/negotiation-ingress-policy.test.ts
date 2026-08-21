import assert from "node:assert/strict";
import test from "node:test";
import { decideNegotiationSubmissionStatus } from "../app/lib/negotiation-exchange";
import { roundAcceptsNegotiationIngress, shouldAdvanceNegotiationRound } from "../app/lib/negotiation-ingress-policy";

test("an alias response cannot advance a prepared round before approved delivery", () => {
  const accepts = roundAcceptsNegotiationIngress({ source: "email", roundStatus: "prepared", active: true });
  const status = decideNegotiationSubmissionStatus({
    source: "email",
    hasAttachment: true,
    scanStatus: "clean",
    roundAcceptingSubmissions: accepts,
    senderMatchesExpected: true,
  });
  assert.equal(status, "late");
  assert.equal(shouldAdvanceNegotiationRound([status]), false);
});

test("blank, mismatched, quarantined, and malicious email do not advance an outbound round", () => {
  const accepting = roundAcceptsNegotiationIngress({ source: "email", roundStatus: "outbound", active: true });
  const statuses = [
    decideNegotiationSubmissionStatus({ source: "email", hasAttachment: false, roundAcceptingSubmissions: accepting }),
    decideNegotiationSubmissionStatus({ source: "email", hasAttachment: true, scanStatus: "clean", roundAcceptingSubmissions: accepting, senderMatchesExpected: false }),
    decideNegotiationSubmissionStatus({ source: "email", hasAttachment: true, scanStatus: "scanner-unavailable", roundAcceptingSubmissions: accepting, senderMatchesExpected: true }),
    decideNegotiationSubmissionStatus({ source: "email", hasAttachment: true, scanStatus: "malicious", roundAcceptingSubmissions: accepting, senderMatchesExpected: true }),
  ];
  assert.deepEqual(statuses, ["no_attachment", "sender_review", "quarantined", "rejected"]);
  assert.equal(shouldAdvanceNegotiationRound(statuses), false);
});

test("only a clean authorized ready attachment advances the round", () => {
  assert.equal(shouldAdvanceNegotiationRound(["ready", "quarantined"]), true);
});

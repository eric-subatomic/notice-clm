import assert from "node:assert/strict";
import test from "node:test";
import { canMarkNegotiationSubmissionReady } from "../app/lib/negotiation-review-policy";

test("staff may mark only clean sender-review or rescanned-quarantine returns ready", () => {
  for (const submissionStatus of ["sender_review", "quarantined"]) {
    assert.equal(canMarkNegotiationSubmissionReady({ submissionStatus, documentScanStatus: "clean", roundIsCurrentAndActive: true }), true);
  }
  for (const submissionStatus of ["rejected", "ready", "promoted", "late", "no_attachment"]) {
    assert.equal(canMarkNegotiationSubmissionReady({ submissionStatus, documentScanStatus: "clean", roundIsCurrentAndActive: true }), false);
  }
  assert.equal(canMarkNegotiationSubmissionReady({ submissionStatus: "quarantined", documentScanStatus: "quarantined", roundIsCurrentAndActive: true }), false);
  assert.equal(canMarkNegotiationSubmissionReady({ submissionStatus: "sender_review", documentScanStatus: "clean", roundIsCurrentAndActive: false }), false);
});

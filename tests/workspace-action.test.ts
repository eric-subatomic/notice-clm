import assert from "node:assert/strict";
import test from "node:test";
import { deriveWorkspaceAction } from "../app/lib/workspace-action";

const baseline = {
  stage: "Negotiation" as const,
  approvalStatus: "Required" as const,
  openChanges: 0,
  canRequestApprovals: true,
  canUpdateAgreement: true,
  signatureInFlight: false,
  nextStage: "Signature",
};

test("workspace action matrix separates active, resolved, and closed negotiation rounds", () => {
  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    nextAction: "Review returned counterparty file for negotiation round 3",
  }), {
    kind: "counterparty_exchange",
    label: "Review counterparty exchange",
    available: true,
  });

  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    stage: "Signature",
    nextAction: "Close failed delivery round 3 and prepare a new review round",
  }), {
    kind: "counterparty_exchange",
    label: "Review counterparty exchange",
    available: true,
  });

  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    nextAction: "Request approval for the promoted counterparty revision",
  }), {
    kind: "request_approval",
    label: "Request approval",
    available: true,
  });

  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    nextAction: "Review the current working paper and determine the next contract action",
  }), {
    kind: "request_approval",
    label: "Request approval",
    available: true,
  });
});

test("signature work distinguishes read-only status from packet creation", () => {
  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    stage: "Signature",
    approvalStatus: "Approved",
    signatureInFlight: true,
    canUpdateAgreement: false,
    nextAction: "Monitor provider signature status",
  }), {
    kind: "signature_status",
    label: "View signature status",
    available: true,
  });

  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    stage: "Signature",
    approvalStatus: "Approved",
    canUpdateAgreement: false,
    nextAction: "Prepare signature packet",
  }), {
    kind: "signature",
    label: "Create signature packet",
    available: false,
  });
});

test("new records lead with paper review before approval routing", () => {
  for (const [nextAction, label] of [
    ["Review the generated working draft", "Review working draft"],
    ["Review the imported source and prepare the working paper", "Review imported contract"],
    ["Add a source document or create a working paper", "Add working paper"],
  ] as const) {
    assert.deepEqual(deriveWorkspaceAction({
      ...baseline,
      nextAction,
    }), {
      kind: "document_review",
      label,
      available: true,
    });
  }
});

test("evaluation redlines and approved paper keep their distinct next steps", () => {
  assert.equal(deriveWorkspaceAction({
    ...baseline,
    nextAction: "Resolve 2 open redlines",
    openChanges: 2,
  }).kind, "changes");

  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    approvalStatus: "Approved",
    nextAction: "Advance the approved paper",
  }), {
    kind: "advance",
    label: "Advance to Signature",
    available: true,
  });

  assert.deepEqual(deriveWorkspaceAction({
    ...baseline,
    stage: "Review",
    approvalStatus: "Not required",
    nextStage: "Negotiation",
    nextAction: "Advance the reviewed working paper",
  }), {
    kind: "advance",
    label: "Advance to Negotiation",
    available: true,
  });
});

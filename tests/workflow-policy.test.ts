import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateGovernedWorkflowApprovalLanes,
  governedWorkflowSnapshot,
  parseGovernedWorkflowDefinition,
} from "../app/lib/workflow-policy";

const definition = {
  schemaVersion: "1.0",
  approvalLanes: [
    { lane: "Legal" },
    { lane: "Finance", when: { minimumValueMinor: 10_000_000, currencyCodes: ["USD"] } },
    { lane: "Privacy", when: { agreementTypes: ["DPA"], sides: ["Buy-side", "Corporate"] } },
    { lane: "Executive", when: { riskLevels: ["High"], riskDispositions: ["assessed"] } },
    { lane: "Waiver review", when: { riskDispositions: ["waived"] } },
  ],
} as const;

test("governed workflow evaluates deterministic conditional approval lanes", () => {
  const parsed = parseGovernedWorkflowDefinition(definition);
  assert.deepEqual(evaluateGovernedWorkflowApprovalLanes(parsed, {
    side: "Buy-side", type: "DPA", department: "Security", risk: "High", riskDisposition: "assessed",
    value: 125_000, valueMinor: 12_500_000, currencyCode: "USD",
  }), ["Legal", "Finance", "Privacy", "Executive"]);
  assert.deepEqual(evaluateGovernedWorkflowApprovalLanes(parsed, {
    side: "Sell-side", type: "NDA", department: "Sales", risk: "Unassessed", riskDisposition: "waived",
    value: 1, valueMinor: 1, currencyCode: "EUR",
  }), ["Legal", "Waiver review"]);
});

test("governed workflow rejects ambiguous or open routing policies", () => {
  assert.throws(() => parseGovernedWorkflowDefinition({
    schemaVersion: "1.0", approvalLanes: [{ lane: "Legal", when: { riskLevels: ["High"] } }],
  }), /supported governed approval-policy format/);
  assert.throws(() => parseGovernedWorkflowDefinition({
    schemaVersion: "1.0", approvalLanes: [{ lane: "Legal" }, { lane: "legal" }],
  }), /supported governed approval-policy format/);
  assert.throws(() => parseGovernedWorkflowDefinition({
    schemaVersion: "1.0", approvalLanes: [{ lane: "Legal" }], extra: true,
  }), /supported governed approval-policy format/);
});

test("workflow snapshots normalize defaults and bind the canonical policy digest", async () => {
  const first = await governedWorkflowSnapshot(definition, {
    side: "Corporate", type: "NDA", department: "Legal", risk: "Low", riskDisposition: "assessed",
    value: 5, currencyCode: "USD",
  });
  const reordered = await governedWorkflowSnapshot({
    approvalLanes: definition.approvalLanes,
    schemaVersion: "1.0",
  }, {
    side: "Corporate", type: "NDA", department: "Legal", risk: "Low", riskDisposition: "assessed",
    value: 5, valueMinor: 500, currencyCode: "USD",
  });
  assert.equal(first.policySha256, reordered.policySha256);
  assert.match(first.policySha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.approvalLanes, ["Legal"]);
});

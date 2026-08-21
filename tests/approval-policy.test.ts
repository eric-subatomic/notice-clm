import assert from "node:assert/strict";
import test from "node:test";
import { approvalsSatisfyPolicy, evaluateApprovalPolicy, repositoryRequiresApproval, requiredApprovalRoles } from "../app/lib/approval-policy";

const basis = { hash: "basis-current", documentVersion: 3, documentSha256: "a".repeat(64) };
const request = (role: string, status = "Approved", overrides = {}) => ({
  role,
  status,
  requestedByUserId: "requester",
  decidedByUserId: status === "Pending" ? null : "decider",
  basisConfirmedAt: status === "Pending" ? null : "2026-08-19T12:00:00.000Z",
  basisHash: basis.hash,
  documentVersion: basis.documentVersion,
  documentSha256: basis.documentSha256,
  ...overrides,
});

test("repository policy requires Legal and adds Finance for high-risk, high-value, or waived work", () => {
  assert.deepEqual(requiredApprovalRoles({ value: 25_000, risk: "Low", riskDisposition: "assessed" }), ["Legal"]);
  assert.deepEqual(requiredApprovalRoles({ value: 100_001, risk: "Low", riskDisposition: "assessed" }), ["Legal", "Finance"]);
  assert.deepEqual(requiredApprovalRoles({ value: 10, risk: "High", riskDisposition: "assessed" }), ["Legal", "Finance"]);
  assert.deepEqual(requiredApprovalRoles({ value: 10, risk: "Unassessed", riskDisposition: "waived" }), ["Legal", "Finance"]);
  assert.equal(repositoryRequiresApproval({ value: 25_000, risk: "Low", riskDisposition: "assessed" }), false);
  assert.equal(repositoryRequiresApproval({ value: 100_001, risk: "Low", riskDisposition: "assessed" }), true);
  assert.equal(repositoryRequiresApproval({ value: 10, risk: "High", riskDisposition: "assessed" }), true);
  assert.equal(repositoryRequiresApproval({ value: 10, risk: "Unassessed", riskDisposition: "waived" }), true);
});

test("mandatory-risk policy cannot be bypassed with a Not required aggregate flag", () => {
  assert.equal(approvalsSatisfyPolicy({ value: 100_001, risk: "Low", riskDisposition: "assessed", approvalStatus: "Not required" }, [], basis), false);
  assert.equal(approvalsSatisfyPolicy({ value: 10, risk: "High", riskDisposition: "assessed", approvalStatus: "Not required" }, [], basis), false);
  assert.equal(approvalsSatisfyPolicy({ value: 10, risk: "Low", riskDisposition: "assessed", approvalStatus: "Not required" }, [], basis), true);
  assert.equal(approvalsSatisfyPolicy({ value: 10, risk: "Unassessed", riskDisposition: null, approvalStatus: "Not required" }, [], basis), false);
});

test("a governed workflow snapshot replaces starter routing and remains fail closed", () => {
  const governed = {
    value: 10,
    risk: "Low",
    riskDisposition: "assessed",
    approvalStatus: "Approved",
    workflowPolicySha256: "b".repeat(64),
    workflowApprovalLanes: ["Legal", "Privacy"],
  };
  assert.deepEqual(requiredApprovalRoles(governed), ["Legal", "Privacy"]);
  assert.equal(repositoryRequiresApproval(governed), true);
  assert.equal(evaluateApprovalPolicy(governed, [
    request("Legal", "Approved", { decidedByUserId: "legal-decider" }),
    request("Privacy", "Approved", { decidedByUserId: "privacy-decider" }),
  ], basis), "Approved");
  assert.deepEqual(requiredApprovalRoles({ ...governed, workflowApprovalLanes: [] }), ["Workflow policy repair required"]);
});

test("an arbitrary approval cannot substitute for required server-side roles", () => {
  const agreement = { value: 50_000, risk: "Low", riskDisposition: "assessed", approvalStatus: "Approved" };
  assert.equal(evaluateApprovalPolicy(agreement, [request("Risk")], basis), "Pending");
  assert.equal(approvalsSatisfyPolicy(agreement, [request("Risk")], basis), false);
  assert.equal(approvalsSatisfyPolicy(agreement, [request("Legal")], basis), true);
});

test("stale paper, pending extra review, and changes requested fail closed", () => {
  const agreement = { value: 250_000, risk: "Low", riskDisposition: "assessed", approvalStatus: "Approved" };
  assert.equal(evaluateApprovalPolicy(agreement, [request("Legal"), request("Finance", "Pending")], basis), "Pending");
  assert.equal(evaluateApprovalPolicy(agreement, [request("Legal"), request("Finance"), request("Risk", "Changes requested")], basis), "Changes requested");
  assert.equal(evaluateApprovalPolicy(agreement, [request("Legal"), request("Finance", "Approved", { basisHash: "old" })], basis), "Pending");
});

test("legacy or self-approved rows cannot satisfy policy", () => {
  const agreement = { value: 50_000, risk: "Low", riskDisposition: "assessed", approvalStatus: "Approved" };
  assert.equal(approvalsSatisfyPolicy(agreement, [request("Legal", "Approved", { requestedByUserId: null })], basis), false);
  assert.equal(approvalsSatisfyPolicy(agreement, [request("Legal", "Approved", { decidedByUserId: null })], basis), false);
  assert.equal(approvalsSatisfyPolicy(agreement, [request("Legal", "Approved", { requestedByUserId: "same", decidedByUserId: "same" })], basis), false);
  assert.equal(approvalsSatisfyPolicy(agreement, [request("Legal", "Approved", {
    sourceAgentPlanReviewerUserId: "plan-reviewer",
    decidedByUserId: "plan-reviewer",
  })], basis), false);
  assert.equal(approvalsSatisfyPolicy(agreement, [request("Legal", "Approved", { basisConfirmedAt: null })], basis), false);
});

test("each required lane needs a distinct attributable decider", () => {
  const agreement = { value: 250_000, risk: "High", riskDisposition: "assessed", approvalStatus: "Approved" };
  const samePerson = [
    request("Legal", "Approved", { decidedByUserId: "same-decider" }),
    request("Finance", "Approved", { decidedByUserId: "same-decider" }),
  ];
  assert.equal(evaluateApprovalPolicy(agreement, samePerson, basis), "Pending");
  assert.equal(approvalsSatisfyPolicy(agreement, samePerson, basis), false);
  assert.equal(evaluateApprovalPolicy(agreement, [
    request("Legal", "Approved", { decidedByUserId: "legal-decider" }),
    request("Finance", "Approved", { decidedByUserId: "finance-decider" }),
  ], basis), "Approved");
});

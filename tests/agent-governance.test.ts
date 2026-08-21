import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPlanStatuses,
  bindPlanDecision,
  canTransitionAgentPlan,
  canonicalJson,
  canonicalJsonDigest,
  classifyIdempotency,
  computeAgentActionPlanDigest,
  computeIdempotencyRequestDigest,
  computeIdempotencyScopeDigest,
  evaluateAgentGrant,
  evaluateAgentPlanTransition,
  evaluatePlanDecisionBinding,
  validateAgentExecutionProvenance,
  type AgentActionPlanMaterial,
  type AgentExecutionProvenance,
  type AgentGrant,
  type IdempotencyReceipt,
  type IdempotencyScope,
} from "../app/lib/agent-governance";

test("canonical JSON is stable across recursively reordered object keys", async () => {
  const first = {
    z: true,
    nested: { b: [3, { y: null, x: "value" }], a: -0 },
    "2": "two",
    "10": "ten",
  };
  const second = {
    "10": "ten",
    "2": "two",
    nested: { a: 0, b: [3, { x: "value", y: null }] },
    z: true,
  };
  assert.equal(
    canonicalJson(first),
    "{\"10\":\"ten\",\"2\":\"two\",\"nested\":{\"a\":0,\"b\":[3,{\"x\":\"value\",\"y\":null}]},\"z\":true}",
  );
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(await canonicalJsonDigest(first), await canonicalJsonDigest(second));
});

test("canonical JSON rejects values that JSON.stringify would silently coerce or omit", () => {
  for (const value of [
    { missing: undefined },
    { bad: Number.NaN },
    { bad: Number.POSITIVE_INFINITY },
    new Date("2026-08-19T00:00:00.000Z"),
    { bad: BigInt(1) },
  ]) {
    assert.throws(() => canonicalJson(value), TypeError);
  }
  const sparse = Array(2);
  sparse[1] = "present";
  assert.throws(() => canonicalJson(sparse), /sparse/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycles/);
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "value" });
  assert.throws(() => canonicalJson(accessor), /accessors/);
  const hidden = Object.defineProperty({}, "secret", { enumerable: false, value: "value" });
  assert.throws(() => canonicalJson(hidden), /non-enumerable/);
  const decoratedArray = ["value"] as string[] & { extra?: string };
  decoratedArray.extra = "not JSON";
  assert.throws(() => canonicalJson(decoratedArray), /extra properties/);
  const accessorArray: unknown[] = ["value"];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => "value" });
  assert.throws(() => canonicalJson(accessorArray), /accessors/);
});

const grant: AgentGrant = {
  id: "grant-1",
  workspaceId: "workspace-a",
  serviceAccountId: "agent-contract-ops",
  delegatorPrincipalId: "human-owner-1",
  scopes: ["approval.request", "agreement.read"],
  permissions: ["agreement:read", "approval:request"],
  resources: [{ type: "agreement", id: "agreement-42" }],
  notBefore: "2026-08-19T10:00:00.000Z",
  expiresAt: "2026-08-20T10:00:00.000Z",
  revokedAt: null,
};

function evaluateGrant(overrides: Partial<Parameters<typeof evaluateAgentGrant>[0]> = {}) {
  return evaluateAgentGrant({
    grant,
    serviceAccountId: "agent-contract-ops",
    delegatorPrincipalId: "human-owner-1",
    workspaceId: "workspace-a",
    scope: "approval.request",
    resource: { type: "agreement", id: "agreement-42" },
    requiredPermissions: ["approval:request"],
    delegatorPermissions: ["agreement:read", "approval:request", "workspace:admin"],
    now: "2026-08-19T12:00:00.000Z",
    ...overrides,
  });
}

test("agent grants authorize only the current scope, resource, time, and delegator intersection", () => {
  const evaluation = evaluateGrant();
  assert.equal(evaluation.authorized, true);
  assert.deepEqual(evaluation.blockers, []);
  assert.deepEqual(evaluation.effectivePermissions, ["agreement:read", "approval:request"]);

  const scope = evaluateGrant({ scope: "signature.create" });
  assert.deepEqual(scope.blockers.map((blocker) => blocker.code), ["AGENT_GRANT_SCOPE_DENIED"]);
  const workspace = evaluateGrant({ workspaceId: "workspace-b" });
  assert.equal(workspace.blockers.some((blocker) => blocker.code === "AGENT_GRANT_WORKSPACE_MISMATCH"), true);
  const principal = evaluateGrant({ serviceAccountId: "different-agent" });
  assert.equal(principal.blockers.some((blocker) => blocker.code === "AGENT_GRANT_PRINCIPAL_MISMATCH"), true);
  const delegator = evaluateGrant({ delegatorPrincipalId: "different-human" });
  assert.equal(delegator.blockers.some((blocker) => blocker.code === "AGENT_GRANT_DELEGATOR_MISMATCH"), true);
});

test("grant resource constraints prevent cross-resource and cross-type execution", () => {
  for (const resource of [
    { type: "agreement", id: "agreement-43" },
    { type: "document", id: "agreement-42" },
  ]) {
    const evaluation = evaluateGrant({ resource });
    assert.equal(evaluation.authorized, false);
    assert.equal(evaluation.blockers.some((blocker) => blocker.code === "AGENT_GRANT_RESOURCE_DENIED"), true);
  }

  const broad = evaluateGrant({ grant: { ...grant, resources: [{ type: "agreement", id: "*" }] } });
  assert.equal(broad.authorized, true);
});

test("not-before, expiry, and revocation boundaries fail closed", () => {
  assert.equal(evaluateGrant({ now: "2026-08-19T09:59:59.999Z" }).blockers[0]?.code, "AGENT_GRANT_NOT_ACTIVE");
  assert.equal(evaluateGrant({ now: grant.expiresAt }).blockers[0]?.code, "AGENT_GRANT_EXPIRED");
  assert.equal(evaluateGrant({ now: "2026-08-21T00:00:00.000Z" }).blockers[0]?.code, "AGENT_GRANT_EXPIRED");
  const revoked = evaluateGrant({ grant: { ...grant, revokedAt: "2026-08-19T11:00:00.000Z" } });
  assert.equal(revoked.blockers.some((blocker) => blocker.code === "AGENT_GRANT_REVOKED"), true);
  const malformedRevocation = evaluateGrant({ grant: { ...grant, revokedAt: "not-an-instant" } });
  assert.equal(malformedRevocation.blockers.some((blocker) => blocker.code === "AGENT_GRANT_INVALID"), true);
  assert.equal(evaluateGrant({ now: "not-an-instant" }).blockers[0]?.code, "AGENT_GRANT_INVALID");
});

test("a grant cannot preserve a permission its delegating human has lost", () => {
  const removedFromDelegator = evaluateGrant({ delegatorPermissions: ["agreement:read"] });
  assert.equal(removedFromDelegator.authorized, false);
  assert.equal(removedFromDelegator.blockers.some((blocker) => blocker.code === "AGENT_GRANT_DELEGATOR_PERMISSION_DENIED" && blocker.permission === "approval:request"), true);

  const absentFromGrant = evaluateGrant({
    grant: { ...grant, permissions: ["agreement:read"] },
    delegatorPermissions: ["agreement:read", "approval:request"],
  });
  assert.equal(absentFromGrant.blockers.some((blocker) => blocker.code === "AGENT_GRANT_PERMISSION_DENIED"), true);
});

const plan: AgentActionPlanMaterial = {
  schemaVersion: "1.0",
  planId: "plan-1",
  workspaceId: "workspace-a",
  serviceAccountId: "agent-contract-ops",
  grantId: "grant-1",
  delegatorPrincipalId: "human-owner-1",
  actionId: "approval.request",
  target: {
    resourceType: "agreement",
    resourceId: "agreement-42",
    version: 7,
    basisHash: "a".repeat(64),
  },
  input: { routing: { Finance: "user-2", Legal: "user-1" }, note: "Review exact paper" },
  policyVersion: "approval-policy-3",
  actionDefinition: { catalogVersion: "2026-08-19", id: "approval.request", executionPolicy: "plan_required" },
  riskTier: "high",
  beforeSnapshot: { agreement: { id: 42, version: 7 } },
  proposedDiff: { approvalStatus: "Pending" },
  blockers: [],
  provenance: { modelId: "gpt-test", toolVersion: "1" },
  createdAt: "2026-08-19T12:00:00.000Z",
  expiresAt: "2026-08-19T13:00:00.000Z",
};

test("plan digests bind every field while ignoring input object insertion order", async () => {
  const reordered: AgentActionPlanMaterial = {
    ...plan,
    input: { note: "Review exact paper", routing: { Legal: "user-1", Finance: "user-2" } },
  };
  const digest = await computeAgentActionPlanDigest(plan);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, await computeAgentActionPlanDigest(reordered));
  assert.notEqual(digest, await computeAgentActionPlanDigest({ ...plan, target: { ...plan.target, version: 8 } }));
  assert.notEqual(digest, await computeAgentActionPlanDigest({ ...plan, policyVersion: "approval-policy-4" }));
  assert.notEqual(digest, await computeAgentActionPlanDigest({ ...plan, proposedDiff: { approvalStatus: "Approved" } }));
  assert.notEqual(digest, await computeAgentActionPlanDigest({ ...plan, blockers: [{ code: "NEW_BLOCKER" }] }));
  assert.notEqual(digest, await computeAgentActionPlanDigest({ ...plan, provenance: { modelId: "other-model", toolVersion: "1" } }));
});

test("human decisions bind the exact plan digest and fail after any plan mutation", async () => {
  const decision = await bindPlanDecision(plan, {
    decision: "approved",
    decidedByHumanPrincipalId: "human-approver-1",
    decidedAt: "2026-08-19T12:10:00.000Z",
    rationale: "Exact routing and paper confirmed.",
  });
  assert.equal((await evaluatePlanDecisionBinding(plan, decision)).valid, true);

  const changedPlan = { ...plan, input: { ...plan.input as Record<string, unknown>, note: "Changed after approval" } };
  const stale = await evaluatePlanDecisionBinding(changedPlan, decision);
  assert.equal(stale.valid, false);
  assert.equal(stale.blockers.some((blocker) => blocker.code === "PLAN_DECISION_DIGEST_MISMATCH"), true);

  const tampered = await evaluatePlanDecisionBinding(plan, { ...decision, planDigest: "f".repeat(64) });
  assert.equal(tampered.blockers.some((blocker) => blocker.code === "PLAN_DECISION_DIGEST_MISMATCH"), true);
  const agentDecision = await evaluatePlanDecisionBinding(plan, { ...decision, decidedByHumanPrincipalId: "" });
  assert.equal(agentDecision.blockers.some((blocker) => blocker.code === "PLAN_DECISION_HUMAN_REQUIRED"), true);
  for (const outcome of ["approved", "rejected"] as const) {
    const selfDecision = await evaluatePlanDecisionBinding(plan, {
      ...decision,
      decision: outcome,
      decidedByHumanPrincipalId: plan.delegatorPrincipalId,
    });
    assert.equal(selfDecision.valid, false);
    assert.equal(
      selfDecision.blockers.some((blocker) => blocker.code === "PLAN_DECISION_REVIEWER_SEPARATION_REQUIRED"),
      true,
    );
  }
  const expiredDecision = await evaluatePlanDecisionBinding(plan, { ...decision, decidedAt: plan.expiresAt });
  assert.equal(expiredDecision.blockers.some((blocker) => blocker.code === "PLAN_DECISION_INVALID"), true);
});

test("plan state transitions permit only explicit workflow edges", () => {
  for (const [from, to] of [
    ["draft", "pending_approval"],
    ["pending_approval", "approved"],
    ["approved", "executing"],
    ["executing", "failed_retryable"],
    ["failed_retryable", "executing"],
    ["executing", "succeeded"],
  ] as const) {
    assert.equal(canTransitionAgentPlan(from, to), true);
    assert.deepEqual(evaluateAgentPlanTransition(from, to), { allowed: true, code: "PLAN_TRANSITION_ALLOWED" });
  }
  for (const [from, to] of [
    ["draft", "executing"],
    ["approved", "succeeded"],
    ["succeeded", "executing"],
    ["rejected", "approved"],
    ["cancelled", "draft"],
  ] as const) {
    assert.equal(canTransitionAgentPlan(from, to), false);
    assert.equal(evaluateAgentPlanTransition(from, to).code, "PLAN_TRANSITION_INVALID");
  }
  for (const terminal of ["succeeded", "failed_terminal", "superseded", "expired", "rejected", "cancelled"] as const) {
    for (const target of agentPlanStatuses) assert.equal(canTransitionAgentPlan(terminal, target), false);
  }
});

test("execution provenance is complete and exact-context bound", async () => {
  const planDigest = await computeAgentActionPlanDigest(plan);
  const provenance: AgentExecutionProvenance = {
    schemaVersion: "1.0",
    workspaceId: plan.workspaceId,
    serviceAccountId: plan.serviceAccountId,
    delegatorPrincipalId: plan.delegatorPrincipalId,
    grantId: plan.grantId,
    agentRunId: "agent-run-1",
    planId: plan.planId,
    planDigest,
    actionId: plan.actionId,
    target: plan.target,
    policyVersion: plan.policyVersion,
    modelId: "gpt-5.6-sol-2026-08-01",
    toolId: "notice.approval.request@1",
    inputDigest: "c".repeat(64),
    startedAt: "2026-08-19T12:20:00.000Z",
  };
  const expected = {
    workspaceId: plan.workspaceId,
    serviceAccountId: plan.serviceAccountId,
    delegatorPrincipalId: plan.delegatorPrincipalId,
    grantId: plan.grantId,
    planId: plan.planId,
    planDigest,
    actionId: plan.actionId,
    resourceType: plan.target.resourceType,
    resourceId: plan.target.resourceId,
    version: plan.target.version,
    basisHash: plan.target.basisHash,
    policyVersion: plan.policyVersion,
  };
  assert.deepEqual(validateAgentExecutionProvenance(provenance, expected), { valid: true, blockers: [] });

  const stale = validateAgentExecutionProvenance({
    ...provenance,
    target: { ...provenance.target, version: 6 },
    inputDigest: "not-a-digest",
  }, expected);
  assert.equal(stale.valid, false);
  assert.equal(stale.blockers.some((blocker) => blocker.code === "PROVENANCE_MISMATCH" && blocker.field === "version"), true);
  assert.equal(stale.blockers.some((blocker) => blocker.code === "PROVENANCE_DIGEST_INVALID" && blocker.field === "inputDigest"), true);
});

test("idempotency distinguishes canonical replay from payload and scope collisions", async () => {
  const scope: IdempotencyScope = {
    workspaceId: "workspace-a",
    principalId: "agent-contract-ops",
    actionId: "approval.request",
    resourceType: "agreement",
    resourceId: "agreement-42",
  };
  const scopeDigest = await computeIdempotencyScopeDigest(scope);
  const requestDigest = await computeIdempotencyRequestDigest(scope, { note: "same", routing: { Legal: 1, Finance: 2 } });
  assert.equal(requestDigest, await computeIdempotencyRequestDigest(scope, { routing: { Finance: 2, Legal: 1 }, note: "same" }));
  const receipt: IdempotencyReceipt = {
    key: "retry-key-1",
    scopeDigest,
    requestDigest,
    resultDigest: "d".repeat(64),
  };
  assert.equal(classifyIdempotency(null, receipt).kind, "new");
  assert.deepEqual(classifyIdempotency(receipt, receipt), { kind: "replay", code: "IDEMPOTENCY_REPLAY", receipt });

  const changedPayload = await computeIdempotencyRequestDigest(scope, { note: "different" });
  assert.deepEqual(classifyIdempotency(receipt, { ...receipt, requestDigest: changedPayload }), {
    kind: "collision",
    code: "IDEMPOTENCY_KEY_COLLISION",
  });

  const otherResource = { ...scope, resourceId: "agreement-43" };
  const otherScopeDigest = await computeIdempotencyScopeDigest(otherResource);
  assert.deepEqual(classifyIdempotency(receipt, { ...receipt, scopeDigest: otherScopeDigest }), {
    kind: "collision",
    code: "IDEMPOTENCY_KEY_COLLISION",
  });
  assert.deepEqual(classifyIdempotency(receipt, { ...receipt, key: "another-key" }), {
    kind: "collision",
    code: "IDEMPOTENCY_KEY_COLLISION",
  });
});

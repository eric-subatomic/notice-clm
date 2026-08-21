import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE,
  actionIds,
  actionRegistry,
  agentApiV1ActionIds,
  evaluateAction,
  evaluateActionRegistry,
  getAgentApiV1ActionCapability,
  getActionDefinition,
  isAgentApiV1ActionId,
  type ActionEvaluationContext,
  type ActionTargetPrecondition,
} from "../app/lib/action-registry";

const basisHash = "a".repeat(64);
const planDigest = "b".repeat(64);
const allPreconditions: readonly ActionTargetPrecondition[] = [
  "working_document_present",
  "risk_cleared",
  "no_open_changes",
  "approvals_satisfied",
  "assigned_approval",
  "separation_of_duties",
  "candidate_document_clean",
  "human_review_complete",
  "signature_not_in_flight",
];

function agreementContext(overrides: Partial<ActionEvaluationContext> = {}): ActionEvaluationContext {
  return {
    actor: { kind: "human", permissions: ["agreement:read", "agreement:update", "approval:request", "document:read"] },
    target: {
      type: "agreement",
      id: "agreement-42",
      version: 7,
      basisHash,
      stage: "Signature",
      satisfiedPreconditions: allPreconditions,
    },
    attempt: {
      expectedVersion: 7,
      expectedBasisHash: basisHash,
      approvedPlanDigest: planDigest,
      confirmation: { by: "human", basisHash },
    },
    ...overrides,
  };
}

test("the shared action registry has stable unique IDs and complete governance metadata", () => {
  assert.deepEqual(actionRegistry.map((action) => action.id), actionIds);
  assert.equal(new Set(actionRegistry.map((action) => action.id)).size, actionRegistry.length);
  assert.equal(Object.isFrozen(actionRegistry), true);
  for (const action of actionRegistry) {
    assert.equal(Object.isFrozen(action), true);
    assert.ok(action.permissions.length > 0);
    assert.ok(action.targetTypes.length > 0);
    assert.match(action.implementationVersion, /^[a-z][a-z0-9.-]+\.v\d+$/);
    assert.ok(["low", "medium", "high", "critical"].includes(action.riskTier));
    assert.ok(["direct", "plan_required", "human_only"].includes(action.executionPolicy));
    assert.equal(getActionDefinition(action.id), action);
  }
});

test("the v1 agent allowlist is explicit and narrower than the human/domain registry", () => {
  assert.deepEqual(agentApiV1ActionIds, ["agreement.read", "approval.request"]);
  assert.equal(isAgentApiV1ActionId("agreement.read"), true);
  assert.equal(isAgentApiV1ActionId("approval.request"), true);
  assert.deepEqual(getAgentApiV1ActionCapability("agreement.read"), {
    plannable: true,
    executable: true,
    inputMode: null,
    blocker: null,
  });
  assert.deepEqual(getAgentApiV1ActionCapability("approval.request"), {
    plannable: true,
    executable: true,
    inputMode: "ensure_required",
    blocker: null,
  });
  for (const actionId of actionIds.filter((candidate) => !isAgentApiV1ActionId(candidate))) {
    const capability = getAgentApiV1ActionCapability(actionId);
    assert.equal(capability.plannable, false, actionId);
    assert.equal(capability.executable, false, actionId);
    assert.equal(capability.blocker?.code, AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE, actionId);
  }
});

test("the evaluator returns every action, including unavailable actions with stable blockers", () => {
  const evaluations = evaluateActionRegistry({
    actor: { kind: "human", permissions: ["agreement:read"] },
    target: { type: "agreement", id: "agreement-42" },
  });
  assert.deepEqual(evaluations.map((evaluation) => evaluation.action.id), actionIds);
  assert.equal(evaluations.find((evaluation) => evaluation.action.id === "agreement.read")?.allowed, true);
  const update = evaluations.find((evaluation) => evaluation.action.id === "agreement.update");
  assert.equal(update?.allowed, false);
  assert.equal(update?.blockers.some((blocker) => blocker.code === "ACTION_PERMISSION_REQUIRED" && blocker.permission === "agreement:update"), true);
  assert.equal(update?.blockers.some((blocker) => blocker.code === "ACTION_TARGET_VERSION_UNAVAILABLE"), true);
  assert.equal(update?.blockers.some((blocker) => blocker.code === "ACTION_BASIS_UNAVAILABLE"), true);
});

test("optimistic version and exact paper basis are returned and enforced", () => {
  const definition = getActionDefinition("agreement.update");
  const stale = evaluateAction(definition, agreementContext({
    attempt: {
      expectedVersion: 6,
      expectedBasisHash: "c".repeat(64),
      confirmation: { by: "human", basisHash: "c".repeat(64) },
    },
  }));
  assert.equal(stale.requiredVersion, 7);
  assert.equal(stale.requiredBasisHash, basisHash);
  assert.equal(stale.allowed, false);
  assert.equal(stale.blockers.some((blocker) => blocker.code === "ACTION_TARGET_VERSION_STALE"), true);
  assert.equal(stale.blockers.some((blocker) => blocker.code === "ACTION_BASIS_STALE"), true);

  const missing = evaluateAction(definition, agreementContext({ attempt: { confirmation: { by: "human", basisHash } } }));
  assert.equal(missing.blockers.some((blocker) => blocker.code === "ACTION_TARGET_VERSION_REQUIRED"), true);
  assert.equal(missing.blockers.some((blocker) => blocker.code === "ACTION_BASIS_REQUIRED"), true);
});

test("plan-required agent work needs an exact approved plan and human exact-basis confirmation", () => {
  const definition = getActionDefinition("approval.request");
  const context = agreementContext({
    actor: { kind: "agent", permissions: ["agreement:read", "approval:request"] },
  });
  const permitted = evaluateAction(definition, context);
  assert.equal(permitted.allowed, true);
  assert.equal(permitted.requiresHuman, true);

  const noPlan = evaluateAction(definition, { ...context, attempt: { ...context.attempt, approvedPlanDigest: undefined } });
  assert.equal(noPlan.blockers.some((blocker) => blocker.code === "ACTION_APPROVED_PLAN_REQUIRED"), true);
  const fakePlan = evaluateAction(definition, { ...context, attempt: { ...context.attempt, approvedPlanDigest: "approved" } });
  assert.equal(fakePlan.blockers.some((blocker) => blocker.code === "ACTION_APPROVED_PLAN_INVALID"), true);
  const agentConfirmation = evaluateAction(definition, {
    ...context,
    attempt: { ...context.attempt, confirmation: { by: "agent", basisHash } },
  });
  assert.equal(agentConfirmation.blockers.some((blocker) => blocker.code === "ACTION_HUMAN_REQUIRED"), true);
});

test("human-only actions cannot be converted into agent actions by broad permissions or a plan", () => {
  const result = evaluateAction(getActionDefinition("risk.waive"), agreementContext({
    actor: { kind: "agent", permissions: ["agreement:read", "risk:waive"] },
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.requiresHuman, true);
  assert.equal(result.blockers.some((blocker) => blocker.code === "ACTION_HUMAN_REQUIRED"), true);

  const human = evaluateAction(getActionDefinition("risk.waive"), agreementContext({
    actor: { kind: "human", permissions: ["agreement:read", "risk:waive"] },
  }));
  assert.equal(human.allowed, true);
});

test("target type, stage, and every named precondition are independently enforced", () => {
  const signature = getActionDefinition("signature.create");
  const context = agreementContext({
    target: {
      type: "document",
      id: "document-1",
      version: 7,
      basisHash,
      stage: "Review",
      satisfiedPreconditions: ["working_document_present"],
    },
  });
  const result = evaluateAction(signature, context);
  assert.equal(result.blockers.some((blocker) => blocker.code === "ACTION_TARGET_TYPE_INVALID"), true);
  assert.equal(result.blockers.some((blocker) => blocker.code === "ACTION_STAGE_INVALID"), true);
  assert.deepEqual(
    result.blockers.filter((blocker) => blocker.code === "ACTION_PRECONDITION_FAILED").map((blocker) => blocker.precondition),
    ["risk_cleared", "no_open_changes", "approvals_satisfied", "signature_not_in_flight"],
  );
});

test("direct actions still bind explicit confirmation to the executing actor", () => {
  const update = getActionDefinition("agreement.update");
  const result = evaluateAction(update, agreementContext({
    actor: { kind: "agent", permissions: ["agreement:read", "agreement:update"] },
    attempt: {
      expectedVersion: 7,
      expectedBasisHash: basisHash,
      confirmation: { by: "human", basisHash },
    },
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.requiresHuman, false);
  assert.equal(result.blockers.some((blocker) => blocker.code === "ACTION_CONFIRMATION_ACTOR_MISMATCH"), true);
});

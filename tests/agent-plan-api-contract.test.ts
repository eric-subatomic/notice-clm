import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateAction, getActionDefinition } from "../app/lib/action-registry";
import {
  classifyIdempotency,
  computeAgentActionPlanDigest,
  computeIdempotencyRequestDigest,
  computeIdempotencyScopeDigest,
  evaluatePlanDecisionBinding,
  type AgentActionPlanMaterial,
  type IdempotencyReceipt,
} from "../app/lib/agent-governance";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const basisHash = "a".repeat(64);

function plan(overrides: Partial<AgentActionPlanMaterial> = {}): AgentActionPlanMaterial {
  return {
    schemaVersion: "1.0",
    planId: "2d51d4ef-83bc-44df-89d6-e052a40bdcdd",
    workspaceId: "workspace-a",
    serviceAccountId: "service-a",
    grantId: "grant-a",
    delegatorPrincipalId: "sponsor-a",
    actionId: "agreement.read",
    target: { resourceType: "agreement", resourceId: "42", version: 7, basisHash },
    input: { include: ["summary", "workingDocumentEvidence"] },
    policyVersion: "policy-4",
    actionDefinition: { catalogVersion: "2026-08-19", id: "agreement.read", executionPolicy: "direct" },
    riskTier: "low",
    beforeSnapshot: { agreement: { id: 42, version: 7 } },
    proposedDiff: {},
    blockers: [],
    provenance: { modelId: "gpt-test", toolVersion: "1" },
    createdAt: "2026-08-19T12:00:00.000Z",
    expiresAt: "2026-08-19T13:00:00.000Z",
    ...overrides,
  };
}

test("durable plan digests bind canonical input, exact basis, version, grant, and expiry", async () => {
  const original = plan();
  const digest = await computeAgentActionPlanDigest(original);
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const changed of [
    plan({ input: { include: ["summary"] } }),
    plan({ target: { ...original.target, version: 8 } }),
    plan({ target: { ...original.target, basisHash: "b".repeat(64) } }),
    plan({ grantId: "grant-b" }),
    plan({ expiresAt: "2026-08-19T12:30:00.000Z" }),
    plan({ beforeSnapshot: { agreement: { id: 42, version: 8 } } }),
    plan({ proposedDiff: { owner: "Changed" } }),
    plan({ blockers: [{ code: "ACTION_PRECONDITION_FAILED" }] }),
    plan({ provenance: { modelId: "other-model", toolVersion: "1" } }),
  ]) assert.notEqual(await computeAgentActionPlanDigest(changed), digest);
});

test("human decision binding rejects a mismatched digest and the exact expiry boundary", async () => {
  const material = plan();
  const digest = await computeAgentActionPlanDigest(material);
  const valid = await evaluatePlanDecisionBinding(material, {
    planId: material.planId,
    workspaceId: material.workspaceId,
    planDigest: digest,
    decision: "approved",
    decidedByHumanPrincipalId: "human-admin",
    decidedAt: "2026-08-19T12:30:00.000Z",
    rationale: "Reviewed the exact target and plan digest.",
  });
  assert.equal(valid.valid, true);
  const mismatched = await evaluatePlanDecisionBinding(material, {
    planId: material.planId,
    workspaceId: material.workspaceId,
    planDigest: "f".repeat(64),
    decision: "approved",
    decidedByHumanPrincipalId: "human-admin",
    decidedAt: "2026-08-19T12:30:00.000Z",
    rationale: "Wrong digest.",
  });
  assert.equal(mismatched.blockers.some((blocker) => blocker.code === "PLAN_DECISION_DIGEST_MISMATCH"), true);
  const expired = await evaluatePlanDecisionBinding(material, {
    planId: material.planId,
    workspaceId: material.workspaceId,
    planDigest: digest,
    decision: "approved",
    decidedByHumanPrincipalId: "human-admin",
    decidedAt: material.expiresAt,
    rationale: "Too late.",
  });
  assert.equal(expired.valid, false);
});

test("human-only actions stay blocked even with broad agent permissions and an apparent plan", () => {
  const result = evaluateAction(getActionDefinition("risk.waive"), {
    actor: { kind: "agent", permissions: ["risk:waive", "workspace:admin"] },
    target: {
      type: "agreement",
      id: "42",
      version: 7,
      basisHash,
      satisfiedPreconditions: ["working_document_present"],
    },
    attempt: {
      expectedVersion: 7,
      expectedBasisHash: basisHash,
      approvedPlanDigest: "b".repeat(64),
      confirmation: { by: "agent", basisHash },
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.blockers.some((blocker) => blocker.code === "ACTION_HUMAN_REQUIRED"), true);
});

test("read execution idempotency replays only an identical scoped request", async () => {
  const scope = {
    workspaceId: "workspace-a",
    principalId: "service-a",
    actionId: "agreement.read",
    resourceType: "agreement",
    resourceId: "42",
  };
  const scopeDigest = await computeIdempotencyScopeDigest(scope);
  const requestDigest = await computeIdempotencyRequestDigest(scope, { planId: "plan-a", planDigest: "c".repeat(64) });
  const receipt: IdempotencyReceipt = {
    key: "retry-key",
    scopeDigest,
    requestDigest,
    resultDigest: "d".repeat(64),
  };
  assert.equal(classifyIdempotency(receipt, { key: "retry-key", scopeDigest, requestDigest }).kind, "replay");
  const mismatch = await computeIdempotencyRequestDigest(scope, { planId: "plan-b", planDigest: "e".repeat(64) });
  assert.equal(classifyIdempotency(receipt, { key: "retry-key", scopeDigest, requestDigest: mismatch }).kind, "collision");
  const crossTenantScope = await computeIdempotencyScopeDigest({ ...scope, workspaceId: "workspace-b" });
  assert.equal(classifyIdempotency(receipt, { key: "retry-key", scopeDigest: crossTenantScope, requestDigest }).kind, "collision");
});

test("plan routes preserve exact authority, tenant, basis, approval, and replay controls", async () => {
  const [collection, detail, decisions, execute] = await Promise.all([
    source("../app/api/v1/plans/route.ts"),
    source("../app/api/v1/plans/[id]/route.ts"),
    source("../app/api/v1/plans/[id]/decisions/route.ts"),
    source("../app/api/v1/plans/[id]/execute/route.ts"),
  ]);

  assert.match(collection, /authorizeServicePrincipalRequest\(request, input\.actionId, resource, input\.grantId\)/);
  assert.match(collection, /authorizeServicePrincipalRequest\(request, parsed\.data\.actionId, resource, parsed\.data\.grantId\)/);
  assert.ok(
    (collection.match(/!isAgentApiV1ActionId\(/g) ?? []).length >= 2,
    "plan collection and proposal must both reject registry actions outside the v1 allowlist",
  );
  assert.match(collection, /AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE/);
  assert.match(collection, /computeAgentActionPlanDigest\(material\)/);
  assert.match(collection, /computeAgreementBasisHash/);
  assert.match(collection, /eq\(agentActionPlans\.workspaceId, auth\.workspace\.id\)/);
  assert.match(collection, /pending_approval/);
  assert.match(collection, /definition\.executionPolicy === "human_only"\s*\? "draft"/);
  assert.match(collection, /status: "succeeded"/);
  assert.match(collection, /completedAt: now/);
  assert.match(collection, /isPlanInsertConflict\(error\)/);
  assert.match(collection, /const \[winner\] = await db\.select\(\)\.from\(agentActionPlans\)/);
  assert.match(collection, /winner && isExactProposalReplay\(winner/);

  assert.match(detail, /authorizeServicePrincipalRequest\(request, actionId, resource, plan\.grantId\)/);
  assert.match(detail, /identity\.actor\.kind === "human" && !identity\.actor\.context\.permissions\.has\("agent:admin"\)/);
  assert.match(detail, /eq\(agentActionPlans\.workspaceId, workspaceId\)/);
  assert.match(detail, /evaluatePersistedAgentPlanReview\(db, plan\)/);
  assert.match(detail, /durableStatus: plan\.status/);
  assert.match(detail, /effectiveStatus: review\.effectiveStatus/);

  assert.match(decisions, /request\.headers\.has\(EVALUATION_SERVICE_PRINCIPAL_HEADER\)/);
  assert.match(decisions, /authorizeApiRequest\(request, "agent:admin"/);
  assert.match(decisions, /evaluatePersistedAgentPlanReview\(db, plan, now\)/);
  assert.match(decisions, /!review\.eligible \|\| !review\.material/);
  assert.match(decisions, /eq\(agentActionPlans\.status, input\.expectedStatus\)/);
  assert.match(decisions, /ne\(agentGrants\.delegatorUserId, auth\.context\.user\.id\)/);
  assert.match(decisions, /eq\(workspaceMemberships\.userId, auth\.context\.user\.id\)/);
  assert.match(decisions, /eq\(workspaceMemberships\.role, "admin"\)/);

  assert.match(execute, /authorizeServicePrincipalRequest\(request, actionId, resource, plan\.grantId\)/);
  assert.match(execute, /authority\.grant\.id !== plan\.grantId/);
  assert.match(execute, /getAgentApiV1ActionCapability\(actionId\)/);
  assert.match(execute, /!agentApiV1\.executable/);
  assert.match(execute, /"action_not_executable"/);
  assert.ok(
    execute.indexOf("!agentApiV1.executable") < execute.indexOf("authorizeServicePrincipalRequest(request, actionId, resource, plan.grantId)"),
    "legacy unsupported plans must fail the v1 capability gate before execution authority is evaluated",
  );
  assert.match(execute, /currentBasisHash !== plan\.basisHash/);
  assert.match(execute, /"idempotency_key_conflict"/);
  assert.match(execute, /Idempotency-Replayed/);
  assert.match(execute, /isExactExecutionRetry\(winner/);
  assert.match(execute, /eq\(agentActionExecutions\.idempotencyKeySha256, keySha256\)/);
  assert.match(execute, /"execution_in_progress"/);
  assert.ok(
    execute.indexOf("const [existing]") < execute.indexOf("now >= plan.expiresAt"),
    "an exact committed replay must be returned before mutable expiry or basis checks",
  );
  assert.match(execute, /eq\(agentActionExecutions\.workspaceId, authority\.workspace\.id\)/);
  assert.match(execute, /eq\(agentActionPlans\.status, "approved"\)/);
  assert.match(collection, /deriveAgentActionPlanFields/);
  assert.match(collection, /inspectRequiredApprovalRouting/);
  assert.match(collection, /"caller_authored_effect_forbidden"/);
  assert.match(collection, /"action_no_effect"/);
  assert.match(execute, /buildRequiredApprovalRoutingStatements/);
  assert.match(execute, /canonicalJson\(inspection\.preview\) !== canonicalJson\(plan\.proposedDiff\)/);
  assert.match(execute, /matchesCurrentActionDefinition\(savedActionDefinition, plan\.riskTier, definition\)/);
  assert.match(execute, /plan\.policyVersion !== authority\.grant\.policyVersion/);
  assert.match(execute, /eq\(agentGrants\.policyVersion, plan\.policyVersion\)/);
  assert.match(execute, /sourceAgentPlanReviewerUserId: decision\.decidedByUserId/);
  assert.match(execute, /requestedByUserId: authority\.sponsor\.id/);
  assert.ok(
    (execute.match(/ne\(agentPlanDecisions\.decidedByUserId, authority\.sponsor\.id\)/g) ?? []).length >= 2,
    "self-sponsored decisions must be rejected both before routing and in its atomic claim",
  );
  assert.match(execute, /activeExecutionAuthorityFence/);
  assert.match(execute, /exactAgreementReadTargetFence/);
  assert.match(execute, /gt\(agentActionPlans\.expiresAt, now\)/);
  assert.match(execute, /operation: "agent-plan\.execute\.approval-routing\.claim"/);
  assert.match(execute, /\.\.\.routing\.statements/);
  assert.match(execute, /operation: "agent-plan\.execute\.approval-routing\.receipt"/);
  assert.match(execute, /operation: "agent-plan\.execute\.approval-routing\.complete"/);
});

test("service plan disclosures fail closed on agreement tombstones without removing human oversight", async () => {
  const [collection, detail, execute] = await Promise.all([
    source("../app/api/v1/plans/route.ts"),
    source("../app/api/v1/plans/[id]/route.ts"),
    source("../app/api/v1/plans/[id]/execute/route.ts"),
  ]);

  assert.match(
    collection,
    /async function loadActiveAgreementTarget[\s\S]*eq\(agreements\.workspaceId, workspaceId\)[\s\S]*eq\(agreements\.id, agreementId\)[\s\S]*isNull\(agreements\.deletedAt\)/,
  );
  const collectionGet = collection.slice(
    collection.indexOf("export async function GET"),
    collection.indexOf("export async function POST"),
  );
  const firstCollectionTargetCheck = collectionGet.indexOf("await loadActiveAgreementTarget");
  const collectionPlanRead = collectionGet.indexOf("const rows = await db.select().from(agentActionPlans)");
  const lastCollectionTargetCheck = collectionGet.lastIndexOf("await loadActiveAgreementTarget");
  const collectionResponse = collectionGet.indexOf("return apiJson({");
  assert.ok(firstCollectionTargetCheck >= 0 && firstCollectionTargetCheck < collectionPlanRead);
  assert.ok(lastCollectionTargetCheck > collectionPlanRead && lastCollectionTargetCheck < collectionResponse);

  const proposal = collection.slice(collection.indexOf("export async function POST"));
  const exactProposal = proposal.indexOf("if (existingPlan)");
  const proposalCollision = proposal.indexOf('return apiError("idempotency_key_conflict"', exactProposal);
  const proposalTargetCheck = proposal.indexOf("await loadActiveAgreementTarget", exactProposal);
  const proposalReplay = proposal.indexOf("plan: planProjection(existingPlan)", exactProposal);
  assert.ok(exactProposal >= 0);
  assert.ok(proposalCollision > exactProposal && proposalCollision < proposalTargetCheck);
  assert.ok(proposalTargetCheck < proposalReplay);

  assert.match(detail, /identity\.actor\.kind === "human" && !identity\.actor\.context\.permissions\.has\("agent:admin"\)/);
  assert.match(
    detail,
    /if \(identity\.actor\.kind === "service"\) \{[\s\S]*authorizeServicePrincipalRequest[\s\S]*hasActiveAgreementTarget/,
  );
  assert.match(detail, /plan\.resourceType !== "agreement"[\s\S]*String\(plan\.agreementId\) !== plan\.resourceId/);
  assert.match(
    detail,
    /identity\.actor\.kind === "service"[\s\S]*hasActiveAgreementTarget\(db, workspaceId, plan\.agreementId\)[\s\S]*return apiJson/,
  );
  assert.match(detail, /evaluatePersistedAgentPlanReview\(db, plan\)/);

  assert.match(
    execute,
    /async function loadActiveAgreementTarget[\s\S]*eq\(agreements\.workspaceId, workspaceId\)[\s\S]*eq\(agreements\.id, agreementId\)[\s\S]*isNull\(agreements\.deletedAt\)/,
  );
  assert.match(execute, /plan\.resourceType !== "agreement"[\s\S]*String\(plan\.agreementId\) !== plan\.resourceId/);
  const executeBody = execute.slice(execute.indexOf("export async function POST"));
  const executionReceiptRead = executeBody.indexOf("const [existing]");
  const executionCollision = executeBody.indexOf('return apiError("idempotency_key_conflict"', executionReceiptRead);
  const executionTargetCheck = executeBody.indexOf("loadActiveAgreementTarget(db, authority.workspace.id, plan.agreementId)", executionReceiptRead);
  const executionReplay = executeBody.indexOf('if (existing.status === "succeeded" && existing.result)', executionReceiptRead);
  assert.ok(executionReceiptRead >= 0);
  assert.ok(executionCollision > executionReceiptRead && executionCollision < executionTargetCheck);
  assert.ok(executionTargetCheck < executionReplay);
  assert.ok(
    (executeBody.match(/loadActiveAgreementTarget\(db, authority\.workspace\.id, plan\.agreementId\)/g) ?? []).length >= 3,
    "initial, concurrent-winner, and final execution disclosures must each retain an active-target fence",
  );
});

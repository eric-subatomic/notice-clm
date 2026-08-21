import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  currentActionDefinitionSnapshot,
  deriveAgentPlanReviewDisposition,
  isAgentPlanReviewExpired,
  matchesCurrentActionDefinition,
} from "../app/lib/agent-plan-review";
import { getActionDefinition } from "../app/lib/action-registry";
import { ACTION_CATALOG_VERSION } from "../app/lib/service-principal-auth";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("review expiry is fail-closed and exact at the decision boundary", () => {
  const expiresAt = "2026-08-19T13:00:00.000Z";
  assert.equal(isAgentPlanReviewExpired(expiresAt, "2026-08-19T12:59:59.999Z"), false);
  assert.equal(isAgentPlanReviewExpired(expiresAt, expiresAt), true);
  assert.equal(isAgentPlanReviewExpired(expiresAt, "2026-08-19T13:00:00.001Z"), true);
  assert.equal(isAgentPlanReviewExpired("invalid", "2026-08-19T12:00:00.000Z"), true);
  assert.equal(isAgentPlanReviewExpired(expiresAt, "invalid"), true);
});

test("derived review status never disguises durable terminal state or blockers", () => {
  assert.deepEqual(deriveAgentPlanReviewDisposition("pending_approval", []), {
    effectiveStatus: "pending_approval",
    eligible: true,
  });
  assert.deepEqual(deriveAgentPlanReviewDisposition("pending_approval", [{ code: "PLAN_EXPIRED", message: "expired" }]), {
    effectiveStatus: "expired",
    eligible: false,
  });
  assert.deepEqual(deriveAgentPlanReviewDisposition("pending_approval", [{ code: "PLAN_BASIS_DRIFT", message: "changed" }]), {
    effectiveStatus: "superseded",
    eligible: false,
  });
  assert.deepEqual(deriveAgentPlanReviewDisposition("approved", []), {
    effectiveStatus: "approved",
    eligible: false,
  });
  assert.deepEqual(deriveAgentPlanReviewDisposition("approved", [
    { code: "PLAN_NOT_PENDING", message: "already approved" },
  ]), {
    effectiveStatus: "approved",
    eligible: false,
  });
  assert.deepEqual(deriveAgentPlanReviewDisposition("approved", [
    { code: "PLAN_NOT_PENDING", message: "already approved" },
    { code: "PLAN_EXPIRED", message: "expired" },
  ]), {
    effectiveStatus: "expired",
    eligible: false,
  });
  assert.deepEqual(deriveAgentPlanReviewDisposition("approved", [
    { code: "PLAN_NOT_PENDING", message: "already approved" },
    { code: "PLAN_BASIS_DRIFT", message: "changed" },
  ]), {
    effectiveStatus: "superseded",
    eligible: false,
  });
  assert.deepEqual(deriveAgentPlanReviewDisposition("succeeded", [{ code: "PLAN_EXPIRED", message: "expired later" }]), {
    effectiveStatus: "succeeded",
    eligible: false,
  });
});

test("review binds the exact current action catalog definition", () => {
  const definition = getActionDefinition("approval.request");
  const snapshot = currentActionDefinitionSnapshot(definition);
  assert.equal(snapshot.catalogVersion, ACTION_CATALOG_VERSION);
  assert.equal(snapshot.id, "approval.request");
  assert.equal(snapshot.implementationVersion, "approval.ensure-required.v1");
  assert.equal(snapshot.executionPolicy, "plan_required");
  assert.equal(snapshot.confirmationPolicy, "exact_basis_confirmation");
  assert.deepEqual(snapshot.permissions, ["agreement:read", "approval:request"]);
  assert.equal(matchesCurrentActionDefinition(snapshot, definition.riskTier, definition), true);
  assert.equal(matchesCurrentActionDefinition(
    { ...snapshot, implementationVersion: "approval.ensure-required.v2" },
    definition.riskTier,
    definition,
  ), false);
  assert.equal(matchesCurrentActionDefinition(snapshot, "critical", definition), false);
  assert.equal(matchesCurrentActionDefinition({ invalid: true }, definition.riskTier, definition), false);
});

test("human detail and decision share one read-only review basis", async () => {
  const [review, detail, decision] = await Promise.all([
    source("../app/lib/agent-plan-review.ts"),
    source("../app/api/v1/plans/[id]/route.ts"),
    source("../app/api/v1/plans/[id]/decisions/route.ts"),
  ]);
  assert.match(detail, /evaluatePersistedAgentPlanReview\(db, plan\)/);
  assert.match(decision, /evaluatePersistedAgentPlanReview\(db, plan, now\)/);
  assert.match(detail, /durableStatus: plan\.status/);
  assert.match(detail, /effectiveStatus: review\.effectiveStatus/);
  assert.match(detail, /eligible: review\.eligible/);
  assert.match(detail, /currentBasis: review\.currentBasis/);

  assert.doesNotMatch(detail, /db\.(?:insert|update|delete|batch)\(/);
  assert.doesNotMatch(review, /db\.(?:insert|update|delete|batch)\(/);
  assert.match(decision, /guardChanges: sql<number>`changes\(\)`/);
  assert.match(decision, /eq\(agentActionPlans\.status, input\.expectedStatus\)/);

  for (const blocker of [
    "PLAN_EXPIRED",
    "PLAN_NOT_PENDING",
    "PLAN_TARGET_MISSING",
    "PLAN_TARGET_DELETED",
    "PLAN_TARGET_VERSION_DRIFT",
    "PLAN_WORKING_DOCUMENT_MISSING",
    "PLAN_DOCUMENT_VERSION_DRIFT",
    "PLAN_DOCUMENT_HASH_DRIFT",
    "PLAN_BASIS_DRIFT",
    "PLAN_DIGEST_MISMATCH",
    "PLAN_ACTION_DEFINITION_DRIFT",
    "PLAN_ACTION_EFFECT_DRIFT",
    "PLAN_ACTION_NO_EFFECT",
    "PLAN_ACTION_INPUT_INVALID",
    "PLAN_POLICY_DRIFT",
    "PLAN_AUTHORITY_UNAVAILABLE",
    "ACTION_HUMAN_REQUIRED",
  ]) assert.match(review, new RegExp(`code: "${blocker}"`), blocker);
  assert.match(review, /evaluatePersistedAgentAuthority/);
  assert.match(review, /authority\.blockers/);
  assert.match(review, /const workingDocumentRequired = Boolean/);
  assert.match(review, /if \(!exactDocument && workingDocumentRequired\)/);
  assert.match(review, /inspectRequiredApprovalRouting/);
  assert.match(review, /canonicalJson\(plan\.proposedDiff\) !== canonicalJson\(routing\.preview\)/);
});

test("decision commit atomically re-proves reviewed authority and paper facts", async () => {
  const decision = await source("../app/api/v1/plans/[id]/decisions/route.ts");
  assert.ok(
    decision.indexOf("evaluatePersistedAgentPlanReview(db, plan, now)")
      < decision.indexOf("db.update(agentActionPlans)"),
    "the shared evaluator must run before the guarded decision update",
  );
  for (const fence of [
    "exists(db.select({ id: servicePrincipals.id })",
    "exists(db.select({ id: agentGrants.id })",
    "exists(db.select({ id: users.id })",
    "exists(db.select({ userId: workspaceMemberships.userId })",
    "exists(db.select({ id: agreements.id })",
    "exists(db.select({ id: agreementDocumentVersions.id })",
    "notExists(db.select({ id: agreementDocumentVersions.id })",
    "eq(agreements.version, fence.target.version)",
    "eq(agreements.party, fence.target.party)",
    "eq(agreements.risk, fence.target.risk)",
    "eq(agreements.effectiveDate, fence.target.effectiveDate)",
    "eq(agreementDocumentVersions.sha256, fence.target.documentSha256)",
    "eq(agentGrants.version, fence.grant.version)",
    "ne(agentGrants.delegatorUserId, auth.context.user.id)",
    "eq(workspaceMemberships.updatedAt, fence.membership.updatedAt)",
    "eq(workspaceMemberships.userId, auth.context.user.id)",
    'eq(workspaceMemberships.role, "admin")',
    "gt(agentActionPlans.expiresAt, now)",
    "approvalRoutingCommitFence(db, auth.context.workspace.id, plan)",
    "notExists(db.select({ id: negotiationRounds.id })",
    "exists(db.select({ id: approvalRequests.id })",
  ]) assert.ok(decision.includes(fence), fence);
  assert.match(decision, /guardChanges: sql<number>`changes\(\)`/);
  assert.ok(
    decision.indexOf("db.update(agentActionPlans)")
      < decision.indexOf("db.insert(agentPlanDecisions)"),
    "a zero-row fence must abort before the immutable decision is committed",
  );
});

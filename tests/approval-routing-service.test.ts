import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  approvalRequestInputSchema,
  deriveAgentActionPlanFields,
  parseAgentActionInput,
} from "../app/lib/agent-action-contracts";
import {
  deriveRequiredApprovalCoveragePlan,
  type RequiredApprovalRoutingInspection,
  type RequiredApprovalRoutingPreview,
} from "../app/lib/approval-routing-service";
import { RequestValidationError } from "../app/lib/validation";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-1",
    version: 1,
    agreementId: 41,
    basisHash: "a".repeat(64),
    documentVersion: 3,
    documentSha256: "b".repeat(64),
    role: "Legal",
    requestedByUserId: "20000000-0000-4000-8000-000000000001",
    approver: "Unassigned Legal",
    approverUserId: null,
    status: "Pending",
    decidedByUserId: null,
    decidedAt: null,
    basisConfirmedAt: null,
    sourceAgentPlanId: null,
    sourceAgentPlanReviewerUserId: null,
    comment: null,
    due: "2026-09-30",
    createdAt: "2026-08-19T12:00:00.000Z",
    ...overrides,
  };
}

test("required approval coverage replaces invalid lanes and preserves exact valid lanes", () => {
  const legacyLegal = approval({ requestedByUserId: "", id: "legacy-legal" });
  const validFinance = approval({
    id: "valid-finance",
    role: "Finance",
    status: "Approved",
    decidedByUserId: "30000000-0000-4000-8000-000000000001",
    basisConfirmedAt: "2026-08-19T13:00:00.000Z",
  });
  const plan = deriveRequiredApprovalCoveragePlan(
    { value: 250_000, risk: "Low", riskDisposition: "assessed" },
    [legacyLegal, validFinance] as never,
  );
  assert.deepEqual(plan.roles, ["Legal", "Finance"]);
  assert.deepEqual(plan.missingRoles, ["Legal"]);
  assert.deepEqual(plan.obsoleteApprovalIds, ["legacy-legal"]);
  assert.deepEqual(plan.survivingCurrent.map((lane) => lane.id), ["valid-finance"]);

  const complete = deriveRequiredApprovalCoveragePlan(
    { value: 250_000, risk: "Low", riskDisposition: "assessed" },
    [approval(), approval({ id: "finance", role: "Finance" })] as never,
  );
  assert.deepEqual(complete.missingRoles, []);
  assert.deepEqual(complete.obsoleteApprovalIds, []);

  const reviewerDecided = deriveRequiredApprovalCoveragePlan(
    { value: 1, risk: "Low", riskDisposition: "assessed" },
    [approval({
      status: "Approved",
      decidedByUserId: "30000000-0000-4000-8000-000000000001",
      basisConfirmedAt: "2026-08-19T13:00:00.000Z",
      sourceAgentPlanReviewerUserId: "30000000-0000-4000-8000-000000000001",
    })] as never,
  );
  assert.deepEqual(reviewerDecided.missingRoles, ["Legal"]);

  const sharedDecider = "30000000-0000-4000-8000-000000000009";
  const nonDistinct = deriveRequiredApprovalCoveragePlan(
    { value: 250_000, risk: "Low", riskDisposition: "assessed" },
    [
      approval({ status: "Approved", decidedByUserId: sharedDecider, basisConfirmedAt: "2026-08-19T13:00:00.000Z" }),
      approval({ id: "finance-shared", role: "Finance", status: "Approved", decidedByUserId: sharedDecider, basisConfirmedAt: "2026-08-19T13:00:00.000Z" }),
    ] as never,
  );
  assert.equal(nonDistinct.missingRoles.length, 1);
  assert.equal(nonDistinct.obsoleteApprovalIds.length, 1);
});

test("approval.request accepts only the exact server-owned input contract", () => {
  assert.deepEqual(parseAgentActionInput("approval.request", {
    mode: "ensure_required",
    due: "2026-09-30",
  }), { mode: "ensure_required", due: "2026-09-30" });
  assert.equal(approvalRequestInputSchema.safeParse({
    mode: "ensure_required",
    due: "2026-02-30",
  }).success, false);
  for (const attempted of [
    { mode: "ensure_required", due: "2026-09-30", createdRoles: ["Legal"] },
    { mode: "ensure_required", due: "2026-09-30", approvalStatus: "Approved" },
    { mode: "ensure_required", due: "2026-09-30", effect: { role: "Legal" } },
  ]) {
    assert.throws(
      () => parseAgentActionInput("approval.request", attempted),
      (error: unknown) => error instanceof RequestValidationError
        && error.code === "invalid_action_input",
    );
  }
});

test("approval.request binds the full server preview and rejects caller-authored effects", () => {
  const preview: RequiredApprovalRoutingPreview = {
    schemaVersion: "1.0",
    actionId: "approval.request",
    mode: "ensure_required",
    input: { mode: "ensure_required", due: "2026-09-30" },
    target: {
      resourceType: "agreement",
      resourceId: "41",
      version: 7,
      basisHash: "a".repeat(64),
      documentVersion: 3,
      documentSha256: "b".repeat(64),
    },
    policy: {
      requiredRoles: ["Legal", "Finance"],
      currentExactBasisLanes: [{ id: "lane-1", role: "Legal", status: "Pending", version: 1 }],
      missingRoles: ["Finance"],
      obsoleteApprovalIds: [],
      reasons: [{ code: "APPROVAL_POLICY_MISSING_ROLES", message: "Missing valid coverage for Finance." }],
    },
    effect: {
      kind: "ensure_required_approval_lanes",
      noOp: false,
      willMutate: true,
      createdRoles: ["Finance"],
      supersededApprovalIds: [],
      approvalStatus: "Pending",
      nextAction: "Complete Legal and Finance approval",
      agreementVersion: 8,
    },
    blockers: [],
  };
  const inspection = { preview } as RequiredApprovalRoutingInspection;
  const derived = deriveAgentActionPlanFields({
    actionId: "approval.request",
    actionInput: { mode: "ensure_required", due: "2026-09-30" },
    callerProposedDiff: {},
    approvalRouting: inspection,
  });
  assert.deepEqual(derived.input, preview.input);
  assert.deepEqual(derived.preview, preview);
  assert.deepEqual(derived.proposedDiff, preview);
  assert.deepEqual((derived.proposedDiff.policy as typeof preview.policy).currentExactBasisLanes, preview.policy.currentExactBasisLanes);

  assert.throws(
    () => deriveAgentActionPlanFields({
      actionId: "approval.request",
      actionInput: preview.input,
      callerProposedDiff: { approvalStatus: "Approved" },
      approvalRouting: inspection,
    }),
    (error: unknown) => error instanceof RequestValidationError
      && error.code === "caller_authored_effect_forbidden",
  );
});

test("non-approval actions retain bounded generic planning fields", () => {
  const derived = deriveAgentActionPlanFields({
    actionId: "agreement.update",
    actionInput: { owner: "Legal Ops" },
    callerProposedDiff: { owner: "Legal Ops" },
  });
  assert.deepEqual(derived.input, { owner: "Legal Ops" });
  assert.equal(derived.preview, null);
  assert.deepEqual(derived.proposedDiff, { owner: "Legal Ops" });
});

test("routing inspection and mutation builder fence every governed state dimension", async () => {
  const service = await source("../app/lib/approval-routing-service.ts");
  const operations = await source("../app/api/operations/route.ts");
  for (const evidence of [
    /candidate\.deletedAt !== null/,
    /evaluateAgreementRiskReadiness/,
    /OPEN_NEGOTIATION_STATUSES/,
    /currentApprovalBasisPredicate/,
    /limit\(MAX_CURRENT_APPROVAL_LANES \+ 1\)/,
    /approvalLaneLimitWouldBeExceeded/,
    /isNull\(agreements\.deletedAt\)/,
    /notExists\(input\.db\.select\(\{ id: negotiationRounds\.id \}\)/,
    /gt\(agreementDocumentVersions\.version, document\.version\)/,
    /currentApprovalLaneCapGuard/,
    /exactSurvivingApprovalLaneCommitGuard/,
    /finalStatements/,
    /sourceAgentPlanReviewerUserId/,
  ]) assert.match(service, evidence);
  assert.ok(
    service.indexOf("sourceAgentPlanId: input.attribution?.sourceAgentPlanId ?? null")
      < service.indexOf("eventHash: await computeAgreementEventHash(eventData)"),
    "agent-plan attribution must be present in canonical event data before hashing",
  );
  for (const field of ["$.id", "$.role", "$.status", "$.version"]) {
    assert.ok(service.includes(`json_extract(expected_lane.value, '${field}')`), `${field} must be commit-fenced`);
  }
  const routingStatements = service.slice(service.indexOf("const statements = ["));
  assert.ok(
    routingStatements.indexOf("status: \"Superseded\"") < routingStatements.indexOf("guardedAgreementUpdate,"),
    "obsolete replacements must be superseded before the exact surviving-lane guard runs",
  );
  assert.match(service, /if \(inspection\.noOp\)[\s\S]*no-op approval routing inspection/);
  assert.match(operations, /inspectRequiredApprovalRouting/);
  assert.match(operations, /buildRequiredApprovalRoutingStatements/);
  assert.ok((operations.match(/agent_plan_reviewer_separation_required/g) ?? []).length >= 2);
  assert.match(operations, /obligation_override_reason_required/);
  assert.match(operations, /exists\(db\.select\(\{ id: agreements\.id \}\)/);
});

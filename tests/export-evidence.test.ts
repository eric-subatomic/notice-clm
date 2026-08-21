import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  agreementEvents,
  agentActionExecutions,
  agentActionPlans,
  agentGrants,
  agentPlanDecisions,
  agentRuns,
  ingestionBatches,
  integrationDiagnostics,
  purgeJobs,
  servicePrincipals,
} from "../db/schema";
import {
  sanitizeAgentActionExecution,
  sanitizeAgentActionPlan,
  sanitizeIngestionBatch,
  sanitizeIntegrationDiagnostic,
  sanitizePurgeJob,
  verifyAgentEvidenceClosure,
} from "../app/lib/export-evidence";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const workspaceId = "workspace-export";
const planSha256 = "a".repeat(64);

function assertAllRouteDbCallsUseOneBatch(label: string, route: string): void {
  const sourceFile = ts.createSourceFile(`${label}.ts`, route, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const batchCalls: ts.CallExpression[] = [];
  const directDbCalls: ts.CallExpression[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === "db"
      ) {
        directDbCalls.push(node);
        if (expression.name.text === "batch") batchCalls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  assert.equal(batchCalls.length, 1, `${label} must use exactly one direct db.batch call`);
  const [batch] = batchCalls;
  assert.ok(batch, `${label} must have a D1 read batch`);
  for (const call of directDbCalls) {
    if (call === batch) continue;
    assert.ok(
      call.getStart(sourceFile) > batch.getStart(sourceFile) && call.end < batch.end,
      `${label} has a direct ${call.expression.getText(sourceFile)} call outside the one signed-evidence snapshot`,
    );
  }
}

const principal: typeof servicePrincipals.$inferSelect = {
  id: "principal-1",
  workspaceId,
  name: "Contract agent",
  issuer: "https://identity.example.test",
  subject: "notice-contract-agent",
  status: "active",
  version: 1,
  createdByUserId: "user-admin",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-02T00:00:00.000Z",
};

const grant: typeof agentGrants.$inferSelect = {
  id: "grant-1",
  workspaceId,
  principalId: principal.id,
  delegatorUserId: "user-admin",
  status: "active",
  actionIds: ["approval.request"],
  resourceConstraints: { agreementIds: [41] },
  policyVersion: "1.0",
  startsAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-31T00:00:00.000Z",
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null,
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const run: typeof agentRuns.$inferSelect = {
  id: "run-1",
  workspaceId,
  principalId: principal.id,
  grantId: grant.id,
  sponsorUserId: "user-admin",
  purpose: "Route exact required approvals",
  status: "succeeded",
  modelProvider: "customer",
  modelId: "model-1",
  toolVersion: "1.0.0",
  promptSha256: "b".repeat(64),
  contextSha256: "c".repeat(64),
  startedAt: "2026-08-02T00:00:00.000Z",
  completedAt: "2026-08-02T00:00:01.000Z",
};

const plan: typeof agentActionPlans.$inferSelect = {
  id: "00000000-0000-4000-8000-000000000041",
  workspaceId,
  principalId: principal.id,
  grantId: grant.id,
  runId: run.id,
  actionId: "approval.request",
  resourceType: "agreement",
  resourceId: "41",
  agreementId: 41,
  canonicalInput: { mode: "ensure_required", due: "2026-08-15" },
  inputSha256: "d".repeat(64),
  planSha256,
  expectedVersion: 2,
  basisHash: "e".repeat(64),
  documentVersion: 1,
  documentSha256: "f".repeat(64),
  policyVersion: "1.0",
  riskTier: "high",
  status: "succeeded",
  beforeSnapshot: { approvalStatus: "Not requested" },
  proposedDiff: { approvalStatus: "Pending" },
  blockers: [],
  provenance: {
    schemaVersion: "1.0",
    run: { id: run.id },
    idempotency: {
      keySha256: "1".repeat(64),
      requestSha256: "2".repeat(64),
      rawRetryToken: "never-export-this-token",
    },
  },
  createdByUserId: null,
  expiresAt: "2026-08-03T00:00:00.000Z",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:02.000Z",
};

const decision: typeof agentPlanDecisions.$inferSelect = {
  id: "decision-1",
  workspaceId,
  planId: plan.id,
  planSha256,
  decision: "approved",
  reason: "Exact policy-derived approval lanes confirmed.",
  decidedByUserId: "user-reviewer",
  decidedAt: "2026-08-02T00:00:01.000Z",
};

const execution: typeof agentActionExecutions.$inferSelect = {
  id: "execution-1",
  workspaceId,
  planId: plan.id,
  principalId: principal.id,
  grantId: grant.id,
  actionId: plan.actionId,
  planSha256,
  requestSha256: "3".repeat(64),
  idempotencyKeySha256: "4".repeat(64),
  status: "succeeded",
  result: { approvalIds: ["approval-1"] },
  agreementEventIds: ["agreement-event-1"],
  provenance: { schemaVersion: "1.0", planId: plan.id },
  startedAt: "2026-08-02T00:00:02.000Z",
  completedAt: "2026-08-02T00:00:03.000Z",
};

const executionEvent: typeof agreementEvents.$inferSelect = {
  id: "agreement-event-1",
  workspaceId,
  agreementId: 41,
  type: "approval.requested",
  actorUserId: null,
  actorEmail: null,
  actor: "Contract agent",
  detail: "Policy-derived approvals were requested.",
  previousHash: null,
  eventHash: "7".repeat(64),
  sequence: 1,
  sourceAgentPlanId: plan.id,
  createdAt: "2026-08-02T00:00:03.000Z",
};

test("offboarding evidence sanitizers omit storage, diagnostic, and retry secrets", () => {
  const purge: typeof purgeJobs.$inferSelect = {
    id: "purge-1",
    workspaceId,
    resourceType: "agreement",
    resourceId: "40",
    objectKeys: ["workspaces/workspace-export/documents/private/file.pdf"],
    status: "completed",
    guardChanges: 1,
    attempts: 1,
    lastError: "provider error containing credential metadata",
    lastAttemptAt: "2026-08-03T00:00:00.000Z",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:01.000Z",
    completedAt: "2026-08-03T00:00:01.000Z",
  };
  const diagnostic: typeof integrationDiagnostics.$inferSelect = {
    workspaceId,
    integrationId: "docuseal",
    configurationFingerprint: "secret-backed-fingerprint",
    status: "passed",
    testedAt: "2026-08-04T00:00:00.000Z",
    detail: "live provider detail",
    testedByUserId: "user-admin",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
  const ingestionBatch: typeof ingestionBatches.$inferSelect = {
    id: "ingestion-batch-1",
    workspaceId,
    createdByUserId: "user-admin",
    idempotencyKeySha256: "5".repeat(64),
    requestSha256: "6".repeat(64),
    status: "review",
    itemCount: 2,
    acceptedCount: 1,
    rejectedCount: 0,
    blockerCode: "human_review_required",
    blockerMessage: "One item still needs review.",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:01.000Z",
    completedAt: null,
  };

  const safePurge = sanitizePurgeJob(purge);
  const safeDiagnostic = sanitizeIntegrationDiagnostic(diagnostic);
  const safeIngestionBatch = sanitizeIngestionBatch(ingestionBatch);
  const safePlan = sanitizeAgentActionPlan(plan);
  const safeExecution = sanitizeAgentActionExecution(execution);
  const serialized = JSON.stringify({ safePurge, safeDiagnostic, safeIngestionBatch, safePlan, safeExecution });

  assert.equal(safePurge.objectCount, 1);
  assert.equal("objectKeys" in safePurge, false);
  assert.equal("lastError" in safePurge, false);
  assert.equal("configurationFingerprint" in safeDiagnostic, false);
  assert.equal("detail" in safeDiagnostic, false);
  assert.equal("idempotencyKeySha256" in safeIngestionBatch, false);
  assert.equal("requestSha256" in safeIngestionBatch, false);
  assert.equal("idempotencyKeySha256" in safeExecution, false);
  assert.equal((safePlan.provenance.idempotency as Record<string, unknown>).keySha256, undefined);
  assert.equal((safePlan.provenance.idempotency as Record<string, unknown>).requestSha256, "2".repeat(64));
  assert.equal((plan.provenance.idempotency as Record<string, unknown>).keySha256, "1".repeat(64), "sanitization must not mutate durable evidence");
  for (const secret of [
    purge.objectKeys[0],
    purge.lastError,
    diagnostic.configurationFingerprint,
    diagnostic.detail,
    execution.idempotencyKeySha256,
    ingestionBatch.idempotencyKeySha256,
    ingestionBatch.requestSha256,
    "1".repeat(64),
    "never-export-this-token",
  ]) assert.equal(serialized.includes(secret ?? ""), false);
});

test("workspace agent evidence is tenant-pure and referentially closed", () => {
  const valid = verifyAgentEvidenceClosure({
    workspaceId,
    servicePrincipals: [principal],
    grants: [grant],
    runs: [run],
    plans: [plan],
    decisions: [decision],
    executions: [execution],
    agreementEvents: [executionEvent],
    sourcePlanReferences: [{ agreementId: 41, planId: plan.id }],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.sourceAgentPlanReferences, 1);
  assert.equal(valid.violations.length, 0);

  const invalid = verifyAgentEvidenceClosure({
    workspaceId,
    servicePrincipals: [principal],
    grants: [grant],
    runs: [run],
    plans: [plan],
    decisions: [{ ...decision, planSha256: "9".repeat(64) }],
    executions: [{ ...execution, agreementEventIds: ["missing-event"] }],
    agreementEvents: [executionEvent],
    sourcePlanReferences: [{ agreementId: 99, planId: "missing-plan" }],
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.violations.some((message) => message.includes("digest-matching")));
  assert.ok(invalid.violations.some((message) => message.includes("unavailable agreement event")));
  assert.ok(invalid.violations.some((message) => message.includes("unavailable or mismatched agent plan")));
});

test("agreement evidence exports exactly the plans attributed by sourceAgentPlanId", () => {
  const valid = verifyAgentEvidenceClosure({
    workspaceId,
    servicePrincipals: [],
    grants: [],
    runs: [],
    plans: [plan],
    decisions: [decision],
    executions: [execution],
    agreementEvents: [executionEvent],
    sourcePlanReferences: [
      { agreementId: 41, planId: plan.id },
      { agreementId: 41, planId: plan.id },
    ],
    scopedAgreementId: 41,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.sourceAgentPlanReferences, 2);

  const incomplete = verifyAgentEvidenceClosure({
    workspaceId,
    servicePrincipals: [],
    grants: [],
    runs: [],
    plans: [plan],
    decisions: [],
    executions: [],
    agreementEvents: [executionEvent],
    sourcePlanReferences: [{ agreementId: 41, planId: plan.id }],
    scopedAgreementId: 41,
  });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.violations.some((message) => message.includes("no exported human decision")));
  assert.ok(incomplete.violations.some((message) => message.includes("no exported execution receipt")));

  const extraPlan = { ...plan, id: "00000000-0000-4000-8000-000000000042" };
  const invalid = verifyAgentEvidenceClosure({
    workspaceId,
    servicePrincipals: [],
    grants: [],
    runs: [],
    plans: [plan, extraPlan],
    decisions: [decision],
    executions: [execution],
    agreementEvents: [executionEvent],
    sourcePlanReferences: [{ agreementId: 41, planId: plan.id }],
    scopedAgreementId: 41,
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.violations.some((message) => message.includes("outside the agreement export scope")));
});

test("execution receipts bind each unique agreement event to the same plan and agreement", () => {
  for (const agreementEventsInput of [
    [{ ...executionEvent, sourceAgentPlanId: "00000000-0000-4000-8000-000000000099" }],
    [{ ...executionEvent, agreementId: 99 }],
  ]) {
    const invalid = verifyAgentEvidenceClosure({
      workspaceId,
      servicePrincipals: [principal],
      grants: [grant],
      runs: [run],
      plans: [plan],
      decisions: [decision],
      executions: [execution],
      agreementEvents: agreementEventsInput,
      sourcePlanReferences: [{ agreementId: 41, planId: plan.id }],
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.violations.some((message) => message.includes("not bound to its plan and agreement")));
  }

  const duplicate = verifyAgentEvidenceClosure({
    workspaceId,
    servicePrincipals: [principal],
    grants: [grant],
    runs: [run],
    plans: [plan],
    decisions: [decision],
    executions: [{ ...execution, agreementEventIds: [executionEvent.id, executionEvent.id] }],
    agreementEvents: [executionEvent],
    sourcePlanReferences: [{ agreementId: 41, planId: plan.id }],
  });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.violations.some((message) => message.includes("repeats an agreement event reference")));

  const omitted = verifyAgentEvidenceClosure({
    workspaceId,
    servicePrincipals: [principal],
    grants: [grant],
    runs: [run],
    plans: [plan],
    decisions: [decision],
    executions: [{ ...execution, agreementEventIds: [] }],
    agreementEvents: [executionEvent],
    sourcePlanReferences: [{ agreementId: 41, planId: plan.id }],
  });
  assert.equal(omitted.valid, false);
  assert.ok(omitted.violations.some((message) => message.includes("not claimed by its agent execution receipt")));
});

test("signed export routes wire sanitized ledgers, counts, deterministic order, and closure fences", () => {
  const workspaceExport = source("../app/api/admin/export/route.ts");
  const agreementAudit = source("../app/api/agreements/[id]/audit/route.ts");

  for (const table of [
    "purgeJobs", "integrationDiagnostics", "servicePrincipals", "agentGrants",
    "agentRuns", "agentActionPlans", "agentPlanDecisions", "agentActionExecutions",
  ]) {
    assert.match(workspaceExport, new RegExp(`${table}:`));
  }
  assert.match(workspaceExport, /purgeJobs\.createdAt\), asc\(purgeJobs\.id\)/);
  assert.match(workspaceExport, /agentActionPlans\.createdAt\), asc\(agentActionPlans\.id\)/);
  assert.match(workspaceExport, /agentActionExecutions\.startedAt\), asc\(agentActionExecutions\.id\)/);
  assert.match(workspaceExport, /purgeJobRows\.map\(sanitizePurgeJob\)/);
  assert.match(workspaceExport, /integrationDiagnosticRows\.map\(sanitizeIntegrationDiagnostic\)/);
  assert.match(workspaceExport, /ingestionBatchRows\.map\(sanitizeIngestionBatch\)/);
  assert.match(workspaceExport, /agentPlanRows\.map\(sanitizeAgentActionPlan\)/);
  assert.match(workspaceExport, /agentActionExecutionRows\.map\(sanitizeAgentActionExecution\)/);
  assert.match(workspaceExport, /verifyAgentEvidenceClosure\([\s\S]*sourcePlanReferences: sourceAgentPlanReferences/);
  assert.match(workspaceExport, /const evidenceJson = JSON\.stringify\(evidence\);[\s\S]*payloadSha256/);

  assert.match(agreementAudit, /approval\.sourceAgentPlanId/);
  assert.match(agreementAudit, /event\.sourceAgentPlanId/);
  assert.match(agreementAudit, /referencedAgentPlanIds\.has\(plan\.id\)/);
  assert.match(agreementAudit, /scopedAgreementId: agreementId/);
  assert.match(agreementAudit, /agentActionPlans: agentPlanRows\.map\(sanitizeAgentActionPlan\)/);
  assert.match(agreementAudit, /agentActionExecutions: agentActionExecutionRows\.map\(sanitizeAgentActionExecution\)/);
  assert.match(agreementAudit, /const evidenceJson = JSON\.stringify\(evidence\);[\s\S]*payloadSha256/);
});

test("signed export routes read every signed row in one transactional D1 snapshot", () => {
  const workspaceExport = source("../app/api/admin/export/route.ts");
  const agreementAudit = source("../app/api/agreements/[id]/audit/route.ts");

  for (const [label, route] of [
    ["workspace export", workspaceExport],
    ["agreement audit", agreementAudit],
  ] as const) {
    assertAllRouteDbCallsUseOneBatch(label, route);
    const syntheticLateRead = route.replace(
      "const evidence = {",
      "const lateMutableRows = await db.select().from(agreements);\n  const evidence = { lateMutableRows,",
    );
    assert.throws(
      () => assertAllRouteDbCallsUseOneBatch(`${label} synthetic torn read`, syntheticLateRead),
      /outside the one signed-evidence snapshot/,
      `${label} test must reject a mutable D1 read added after the batch`,
    );
    assert.equal((route.match(/await db\.batch\(\[/g) ?? []).length, 1, `${label} must use one read snapshot`);
    assert.doesNotMatch(route, /await Promise\.all\(/, `${label} must not add independently timed read waves`);
    assert.ok(route.indexOf("await db.batch([") < route.indexOf("const evidence = {"), `${label} snapshot must precede envelope assembly`);
    assert.ok(route.indexOf("await db.batch([") < route.indexOf("const evidenceJson = JSON.stringify(evidence)"), `${label} snapshot must precede signing`);
  }

  const agreementBatchEnd = agreementAudit.indexOf("]);", agreementAudit.indexOf("await db.batch(["));
  assert.ok(agreementAudit.indexOf("db.select().from(agreements)") < agreementBatchEnd);
  assert.ok(agreementAudit.indexOf("db.select().from(agentActionPlans)") < agreementBatchEnd);
  assert.ok(agreementAudit.indexOf("db.select({ execution: agentActionExecutions })") < agreementBatchEnd);

  const workspaceBatchEnd = workspaceExport.indexOf("]);", workspaceExport.indexOf("await db.batch(["));
  assert.ok(workspaceExport.indexOf("db.select().from(workspaces)") < workspaceBatchEnd);
  assert.ok(workspaceExport.indexOf("db.select().from(purgeJobs)") < workspaceBatchEnd);
  assert.ok(workspaceExport.indexOf("db.select().from(agentActionExecutions)") < workspaceBatchEnd);
});

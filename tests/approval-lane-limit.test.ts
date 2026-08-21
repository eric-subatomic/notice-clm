import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APPROVAL_LANE_LIMIT_BLOCKER_CODE,
  APPROVAL_LANE_LIMIT_ERROR_CODE,
  approvalLaneLimitWouldBeExceeded,
  MAX_CURRENT_APPROVAL_LANES,
} from "../app/lib/approval-policy";
import { operationMutationSchema } from "../app/lib/validation";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("current approval lanes have a fail-closed fixed capacity", () => {
  assert.equal(MAX_CURRENT_APPROVAL_LANES, 20);
  assert.equal(approvalLaneLimitWouldBeExceeded(0, MAX_CURRENT_APPROVAL_LANES), false);
  assert.equal(approvalLaneLimitWouldBeExceeded(MAX_CURRENT_APPROVAL_LANES - 1), false);
  assert.equal(approvalLaneLimitWouldBeExceeded(MAX_CURRENT_APPROVAL_LANES), true);
  assert.equal(approvalLaneLimitWouldBeExceeded(MAX_CURRENT_APPROVAL_LANES - 1, 2), true);
  assert.equal(approvalLaneLimitWouldBeExceeded(-1), true);
  assert.equal(approvalLaneLimitWouldBeExceeded(Number.NaN), true);
});

test("bounded custom named lanes remain valid without replacing Legal and Finance with an enum", () => {
  const customLane = "Information Security & Privacy";
  const parsed = operationMutationSchema.parse({
    entity: "approval",
    action: "create",
    record: { agreementId: 42, role: customLane, due: "2026-09-20" },
  });
  assert.equal(parsed.entity, "approval");
  assert.equal(parsed.action, "create");
  assert.equal((parsed.record as { role?: string }).role, customLane);
  assert.equal(operationMutationSchema.safeParse({
    entity: "approval",
    action: "create",
    record: { agreementId: 42, role: "x".repeat(101), due: "2026-09-20" },
  }).success, false);
});

test("approval creation and required-lane routing recheck the post-mutation cap", async () => {
  const route = await source("../app/api/operations/route.ts");
  const routingService = await source("../app/lib/approval-routing-service.ts");
  const ensureStart = route.indexOf('if (input.entity === "approval" && input.action === "ensure_required")');
  const createStart = route.indexOf('if (input.entity === "approval" && input.action === "create")');
  const claimStart = route.indexOf('if (input.entity === "approval" && input.action === "claim")');
  assert.ok(ensureStart >= 0 && createStart > ensureStart && claimStart > createStart);
  const ensure = route.slice(ensureStart, createStart);
  const create = route.slice(createStart, claimStart);

  assert.match(routingService, /function currentApprovalBasisPredicate[\s\S]*ne\(approvalRequests\.status, "Superseded"\)[\s\S]*eq\(approvalRequests\.basisHash, basis\.hash\)[\s\S]*eq\(approvalRequests\.documentVersion, basis\.documentVersion\)[\s\S]*eq\(approvalRequests\.documentSha256, basis\.documentSha256\)/);
  assert.match(routingService, /limit\(MAX_CURRENT_APPROVAL_LANES \+ 1\)/);
  assert.match(routingService, /function currentApprovalLaneCapGuard[\s\S]*limit\(1\)\.offset\(MAX_CURRENT_APPROVAL_LANES\)/);
  assert.match(ensure, /inspectRequiredApprovalRouting/);
  assert.match(ensure, /buildRequiredApprovalRoutingStatements/);
  assert.match(ensure, /isMutationGuardConflict\(error\)/);
  const serviceStatementList = routingService.lastIndexOf("const statements = [");
  assert.ok(serviceStatementList > 0);
  assert.ok(routingService.indexOf("input.db.insert(approvalRequests).values(created)", serviceStatementList)
    < routingService.indexOf("guardedAgreementUpdate,", serviceStatementList));
  assert.match(create, /currentApprovalLaneCapGuard\(db, workspaceId, agreement\.id, approvalBasis\)/);
  assert.match(create, /isMutationGuardConflict\(error\)/);
  assert.match(create, /approvalLaneLimitError\(auth\.requestId\)/);
  assert.ok(create.indexOf("db.insert(approvalRequests).values(approval)") < create.indexOf("currentApprovalLaneCapGuard"));
  assert.equal(APPROVAL_LANE_LIMIT_ERROR_CODE, "approval_lane_limit_reached");
});

test("available actions read only a bounded exact-basis approval set and expose a stable blocker", async () => {
  const route = await source("../app/api/v1/agreements/[id]/available-actions/route.ts");
  assert.match(route, /ne\(approvalRequests\.status, "Superseded"\)/);
  assert.match(route, /eq\(approvalRequests\.basisHash, workflowBasisHash\)/);
  assert.match(route, /eq\(approvalRequests\.documentVersion, exactDocument\.version\)/);
  assert.match(route, /eq\(approvalRequests\.documentSha256, exactDocument\.sha256\)/);
  assert.match(route, /limit\(MAX_CURRENT_APPROVAL_LANES \+ 1\)/);
  assert.match(route, /actionId === "approval\.request" && approvalLaneLimitReached/);
  assert.match(route, /APPROVAL_LANE_LIMIT_BLOCKER_CODE/);
  assert.equal(APPROVAL_LANE_LIMIT_BLOCKER_CODE, "APPROVAL_LANE_LIMIT_REACHED");
});

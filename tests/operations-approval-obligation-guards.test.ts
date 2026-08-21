import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = () => readFile(new URL("../app/api/operations/route.ts", import.meta.url), "utf8");

function branch(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `could not isolate ${start}`);
  return source.slice(startIndex, endIndex);
}

test("agent-plan reviewer separation is checked before and during claim and decision commits", async () => {
  const source = await routeSource();
  const claim = branch(
    source,
    'if (input.entity === "approval" && input.action === "claim")',
    'if (input.entity === "approval" && input.action === "decide")',
  );
  const decide = branch(
    source,
    'if (input.entity === "approval" && input.action === "decide")',
    'if (input.entity === "obligation" && input.action === "create")',
  );
  for (const operation of [claim, decide]) {
    assert.match(operation, /current\.sourceAgentPlanReviewerUserId === auth\.context\.user\.id/);
    assert.match(operation, /agent_plan_reviewer_separation_required/);
    assert.match(operation, /isNull\(approvalRequests\.sourceAgentPlanReviewerUserId\)/);
    assert.match(operation, /ne\(approvalRequests\.sourceAgentPlanReviewerUserId, auth\.context\.user\.id\)/);
  }
});

test("obligation reads and completion hide deleted parents and enforce owner-scoped fulfillment", async () => {
  const source = await routeSource();
  const get = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));
  const complete = branch(
    source,
    'if (input.entity === "obligation" && input.action === "complete")',
    'if (input.entity === "event" && input.action === "comment")',
  );
  assert.match(get, /select\(\{ obligation: obligations \}\)\.from\(obligations\)\.innerJoin\(agreements/);
  assert.match(get, /isNull\(agreements\.deletedAt\)/);

  assert.match(complete, /permissions\.has\("obligation:write"\)/);
  assert.match(complete, /permissions\.has\("obligation:fulfill"\)/);
  assert.match(complete, /current\.ownerUserId === auth\.context\.user\.id/);
  assert.match(complete, /!completingOwnObligation && !canOverride/);
  assert.match(complete, /obligation_override_reason_required/);
  assert.match(complete, /overrideReason: input\.record\.overrideReason/);
  assert.match(complete, /eq\(obligations\.ownerUserId, auth\.context\.user\.id\)/);
  assert.match(complete, /exists\(db\.select\(\{ id: agreements\.id \}\)/);
  assert.ok((complete.match(/isNull\(agreements\.deletedAt\)/g) ?? []).length >= 2);
});

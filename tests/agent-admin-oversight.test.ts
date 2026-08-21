import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("human agent-plan inbox is bounded, cursor-scoped, and workspace-authorized", async () => {
  const route = await source("../app/api/admin/agent-plans/route.ts");
  assert.match(route, /authorizeApiRequest\(request, "agent:admin"\)/);
  assert.match(route, /eq\(agentActionPlans\.workspaceId, auth\.context\.workspace\.id\)/);
  assert.match(route, /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(50\)\.default\(25\)/);
  assert.match(route, /parsed\.data\.status \? eq\(agentActionPlans\.status, parsed\.data\.status\)/);
  assert.match(route, /parsed\.data\.principalId \? eq\(agentActionPlans\.principalId, parsed\.data\.principalId\)/);
  assert.match(route, /parsed\.data\.actionId \? eq\(agentActionPlans\.actionId, parsed\.data\.actionId\)/);
  assert.match(route, /limit\(parsed\.data\.limit \+ 1\)/);
  assert.match(route, /nextCursor: hasMore \? page\.at\(-1\)\?\.id \?\? null : null/);
  assert.doesNotMatch(route, /export async function (POST|PATCH|DELETE)/);
});

test("agent governance UI exposes exact scoped administration and complete human review material", async () => {
  const page = await source("../app/page.tsx");
  const css = await source("../app/globals.css");

  assert.match(page, /requestJson<\{ principals: AgentPrincipal\[\] \}>\("\/api\/admin\/agent-principals"\)/);
  assert.match(page, /requestJson<\{ grants: AgentGrant\[\] \}>\("\/api\/admin\/agent-grants"\)/);
  assert.match(page, /requestJson<\{ plans: AgentPlanSummary\[\]; nextCursor: string \| null \}>\("\/api\/admin\/agent-plans\?limit=25"\)/);
  assert.match(page, /actionIds = agentGrantAction === "agreement\.read"[\s\S]*\["agreement\.read", agentGrantAction\]/);
  assert.match(page, /resourceConstraints: \{ resources: \[\{ type: "agreement", ids: \[String\(agentGrantAgreementId\)\] \}\] \}/);
  assert.match(page, /requestJson<\{ plan: AgentPlanDetail \}>\(`\/api\/v1\/plans\/\$\{encodeURIComponent\(planId\)\}`\)/);
  assert.match(page, /expectedStatus: "pending_approval"/);
  assert.match(page, /planDigest: agentReviewPlan\.planSha256/);
  assert.match(page, /confirmed: true/);
  for (const label of ["Before state", "Proposed diff", "Canonical input", "Provenance", "Plan SHA-256"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /!agentReviewPlan\.review\.eligible/);
  assert.match(page, /agentReviewReason\.trim\(\)\.length < 8/);
  assert.match(page, /I reviewed the complete persisted plan material/);
  assert.match(css, /\.agent-governance-grid/);
  assert.match(css, /\.agent-plan-material/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.agent-plan-card/);
});

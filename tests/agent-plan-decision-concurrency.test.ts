import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import { z } from "zod";
import ts from "typescript";
import * as schema from "../db/schema";
import {
  computeAgentActionPlanDigest,
  evaluatePlanDecisionBinding,
  type AgentActionPlanMaterial,
} from "../app/lib/agent-governance";
import { apiError, apiJson } from "../app/lib/http";
import { isMutationGuardConflict } from "../app/lib/persistence";
import { EVALUATION_SERVICE_PRINCIPAL_HEADER } from "../app/lib/service-principal-auth";
import { parseJson } from "../app/lib/validation";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

const routeSource = await readFile(new URL("../app/api/v1/plans/[id]/decisions/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/v1/plans/[id]/decisions/route.ts",
}).outputText;

const WORKSPACE_ID = "workspace-a";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const SPONSOR_ID = "44444444-4444-4444-8444-444444444444";
const REVIEWER_ID = "55555555-5555-4555-8555-555555555555";
const AGREEMENT_ID = 4102;
const CREATED_AT = "2026-08-01T00:00:00.000Z";
const EXPIRES_AT = "2099-08-01T00:00:00.000Z";
const BASIS_HASH = "a".repeat(64);

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly bindings: readonly SQLInputValue[] = [],
  ) {}

  bind(...bindings: SQLInputValue[]) {
    return new SqliteD1Statement(this.database, this.query, bindings);
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first<T>() {
    return (this.database.prepare(this.query).get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.database.prepare(this.query).all(...this.bindings) as T[] };
  }

  async raw<T extends unknown[]>() {
    return sqliteD1RawRows<T>(this.database, this.query, this.bindings);
  }
}

class SqliteD1 {
  private beforeBatchOnce: (() => void) | null = null;

  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  beforeNextBatch(hook: () => void): void {
    this.beforeBatchOnce = hook;
  }

  async batch(statements: readonly SqliteD1Statement[]) {
    const hook = this.beforeBatchOnce;
    this.beforeBatchOnce = null;
    hook?.();
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE agent_action_plans (
      id text PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
      grant_id text NOT NULL, run_id text, action_id text NOT NULL,
      resource_type text NOT NULL, resource_id text NOT NULL, agreement_id integer,
      canonical_input text NOT NULL, input_sha256 text NOT NULL, plan_sha256 text NOT NULL,
      expected_version integer, basis_hash text, document_version integer,
      document_sha256 text, policy_version text NOT NULL, risk_tier text NOT NULL,
      status text NOT NULL, before_snapshot text, proposed_diff text NOT NULL,
      blockers text NOT NULL, provenance text NOT NULL, created_by_user_id text,
      expires_at text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL
    );
    CREATE TABLE service_principals (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL, status text NOT NULL
    );
    CREATE TABLE agent_grants (
      id text PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
      delegator_user_id text NOT NULL, version integer NOT NULL, policy_version text NOT NULL,
      status text NOT NULL, revoked_at text, starts_at text NOT NULL, expires_at text NOT NULL
    );
    CREATE TABLE users (
      id text PRIMARY KEY, status text NOT NULL, updated_at text NOT NULL
    );
    CREATE TABLE workspace_memberships (
      workspace_id text NOT NULL, user_id text NOT NULL, role text NOT NULL,
      status text NOT NULL, updated_at text NOT NULL, PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE agreements (
      id integer PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      party text NOT NULL, side text NOT NULL, type text NOT NULL, value integer NOT NULL,
      value_minor integer NOT NULL, currency_code text NOT NULL, department text NOT NULL,
      risk text NOT NULL, risk_disposition text, effective_date text NOT NULL,
      expiration_date text NOT NULL, workflow_definition_id text,
      workflow_policy_sha256 text, workflow_approval_lanes text, deleted_at text
    );
    CREATE TABLE agreement_document_versions (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      version integer NOT NULL, sha256 text NOT NULL
    );
    CREATE TABLE mutation_guards (
      id text PRIMARY KEY, workspace_id text NOT NULL, operation text NOT NULL,
      guard_changes integer NOT NULL, created_at text NOT NULL,
      CONSTRAINT ck_mutation_guards_changes CHECK (guard_changes = 1)
    );
    CREATE TABLE agent_plan_decisions (
      id text PRIMARY KEY, workspace_id text NOT NULL, plan_id text NOT NULL,
      plan_sha256 text NOT NULL, decision text NOT NULL, reason text NOT NULL,
      decided_by_user_id text NOT NULL, decided_at text NOT NULL,
      UNIQUE (workspace_id, plan_id)
    );
  `);
  return database;
}

function material(): AgentActionPlanMaterial {
  return {
    schemaVersion: "1.0",
    planId: PLAN_ID,
    workspaceId: WORKSPACE_ID,
    serviceAccountId: PRINCIPAL_ID,
    grantId: GRANT_ID,
    delegatorPrincipalId: SPONSOR_ID,
    actionId: "agreement.read",
    target: { resourceType: "agreement", resourceId: String(AGREEMENT_ID), version: 7, basisHash: BASIS_HASH },
    input: { include: ["summary", "workingDocumentEvidence"] },
    policyVersion: "policy-v1",
    actionDefinition: { catalogVersion: "test", id: "agreement.read", executionPolicy: "direct" },
    riskTier: "low",
    beforeSnapshot: { agreement: { id: AGREEMENT_ID, version: 7 } },
    proposedDiff: {},
    blockers: [],
    provenance: { modelId: "test", toolVersion: "1" },
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  };
}

async function seed(database: DatabaseSync): Promise<{ digest: string; review: Record<string, unknown> }> {
  const planMaterial = material();
  const digest = await computeAgentActionPlanDigest(planMaterial);
  database.prepare(`INSERT INTO agent_action_plans VALUES (
    ?, ?, ?, ?, NULL, 'agreement.read', 'agreement', ?, ?, ?, ?, ?, 7, ?, NULL,
    NULL, 'policy-v1', 'low', 'pending_approval', ?, '{}', '[]', ?, NULL, ?, ?, ?
  )`).run(
    PLAN_ID,
    WORKSPACE_ID,
    PRINCIPAL_ID,
    GRANT_ID,
    String(AGREEMENT_ID),
    AGREEMENT_ID,
    JSON.stringify(planMaterial.input),
    "b".repeat(64),
    digest,
    BASIS_HASH,
    JSON.stringify(planMaterial.beforeSnapshot),
    JSON.stringify({ actionDefinition: planMaterial.actionDefinition }),
    EXPIRES_AT,
    CREATED_AT,
    CREATED_AT,
  );
  database.prepare("INSERT INTO service_principals VALUES (?, ?, 3, 'active')")
    .run(PRINCIPAL_ID, WORKSPACE_ID);
  database.prepare("INSERT INTO agent_grants VALUES (?, ?, ?, ?, 4, 'policy-v1', 'active', NULL, ?, ?)")
    .run(GRANT_ID, WORKSPACE_ID, PRINCIPAL_ID, SPONSOR_ID, CREATED_AT, EXPIRES_AT);
  database.prepare("INSERT INTO users VALUES (?, 'active', ?)").run(SPONSOR_ID, CREATED_AT);
  database.prepare("INSERT INTO users VALUES (?, 'active', ?)").run(REVIEWER_ID, CREATED_AT);
  database.prepare("INSERT INTO workspace_memberships VALUES (?, ?, 'legal', 'active', ?)")
    .run(WORKSPACE_ID, SPONSOR_ID, CREATED_AT);
  database.prepare("INSERT INTO workspace_memberships VALUES (?, ?, 'admin', 'active', ?)")
    .run(WORKSPACE_ID, REVIEWER_ID, CREATED_AT);
  database.prepare(`INSERT INTO agreements VALUES (
    ?, ?, 7, 'Acme', 'Sell-side', 'Services Agreement', 100, 10000, 'USD',
    'Legal', 'Low', NULL, '2026-08-01', '2027-08-01', NULL, NULL, NULL, NULL
  )`).run(AGREEMENT_ID, WORKSPACE_ID);
  return {
    digest,
    review: {
      eligible: true,
      material: planMaterial,
      commitFence: {
        principal: { id: PRINCIPAL_ID, version: 3 },
        grant: {
          id: GRANT_ID,
          version: 4,
          sponsorUserId: SPONSOR_ID,
          policyVersion: "policy-v1",
          startsAt: CREATED_AT,
          expiresAt: EXPIRES_AT,
        },
        sponsor: { id: SPONSOR_ID, updatedAt: CREATED_AT },
        membership: { role: "legal", updatedAt: CREATED_AT },
        target: {
          agreementId: AGREEMENT_ID,
          version: 7,
          party: "Acme",
          side: "Sell-side",
          type: "Services Agreement",
          value: 100,
          valueMinor: 10000,
          currencyCode: "USD",
          department: "Legal",
          risk: "Low",
          riskDisposition: null,
          effectiveDate: "2026-08-01",
          expirationDate: "2027-08-01",
          workflowDefinitionId: null,
          workflowPolicySha256: null,
          workflowApprovalLanes: null,
          documentVersion: null,
          documentSha256: null,
        },
      },
      effectiveStatus: "pending_approval",
      blockers: [],
    },
  };
}

async function harness(reviewerId = REVIEWER_ID) {
  const database = createDatabase();
  const seeded = await seed(database);
  const d1 = new SqliteD1(database);
  const db = drizzle(d1 as unknown as D1Database, { schema });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "zod") return { z };
    if (specifier === "../../../../../../db") return { getDb: () => db };
    if (specifier === "../../../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../../../db/schema") return schema;
    if (specifier === "../../../../../lib/agent-governance") return { evaluatePlanDecisionBinding };
    if (specifier === "../../../../../lib/agent-plan-review") {
      return { evaluatePersistedAgentPlanReview: async () => seeded.review };
    }
    if (specifier === "../../../../../lib/api") {
      return {
        authorizeApiRequest: async () => ({
          ok: true,
          context: {
            workspace: { id: WORKSPACE_ID, slug: "workspace-a", name: "Workspace A" },
            user: { id: reviewerId, email: "reviewer@example.test", displayName: "Reviewer" },
            role: "admin",
          },
          requestId: "request-decision",
          headers: new Headers(),
        }),
        handleRouteError: (error: unknown) => apiError("internal_error", String(error), { status: 500 }),
      };
    }
    if (specifier === "../../../../../lib/http") return { apiError, apiJson };
    if (specifier === "../../../../../lib/persistence") return { isMutationGuardConflict };
    if (specifier === "../../../../../lib/service-principal-auth") return { EVALUATION_SERVICE_PRINCIPAL_HEADER };
    if (specifier === "../../../../../lib/validation") return { parseJson };
    throw new Error(`Unexpected decision-route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    require: requireModule,
    Request,
    Response,
    Headers,
    URL,
    Date,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto,
    console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/v1/plans/[id]/decisions/route.cjs" }).runInContext(context);
  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  const post = moduleObject.exports.POST as Handler;
  const call = async (decision: "approved" | "rejected" = "approved") => {
    const response = await post(new Request(`https://notice.test/api/v1/plans/${PLAN_ID}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://notice.test" },
      body: JSON.stringify({
        expectedStatus: "pending_approval",
        planDigest: seeded.digest,
        decision,
        reason: "Reviewed the exact persisted plan and authority.",
        confirmed: true,
      }),
    }), { params: Promise.resolve({ id: PLAN_ID }) });
    return { response, body: await response.json() as Record<string, unknown> };
  };
  return { database, d1, call };
}

test("a grant sponsor cannot approve or reject their own plan", async () => {
  for (const outcome of ["approved", "rejected"] as const) {
    const route = await harness(SPONSOR_ID);
    try {
      const result = await route.call(outcome);
      assert.equal(result.response.status, 409);
      assert.equal((result.body.error as { code: string }).code, "plan_decision_invalid");
      assert.equal(route.database.prepare("SELECT count(*) AS count FROM agent_plan_decisions").get()?.count, 0);
      assert.equal(route.database.prepare("SELECT status FROM agent_action_plans WHERE id = ?").get(PLAN_ID)?.status, "pending_approval");
    } finally {
      route.database.close();
    }
  }
});

test("a concurrent reviewer disable or demotion aborts the atomic plan decision", async () => {
  for (const mutate of [
    (database: DatabaseSync) => database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(REVIEWER_ID),
    (database: DatabaseSync) => database.prepare("UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?")
      .run(WORKSPACE_ID, REVIEWER_ID),
  ]) {
    const route = await harness();
    try {
      route.d1.beforeNextBatch(() => void mutate(route.database));
      const result = await route.call();
      assert.equal(result.response.status, 409);
      assert.equal((result.body.error as { code: string }).code, "plan_state_conflict");
      assert.equal(route.database.prepare("SELECT count(*) AS count FROM agent_plan_decisions").get()?.count, 0);
      assert.equal(route.database.prepare("SELECT status FROM agent_action_plans WHERE id = ?").get(PLAN_ID)?.status, "pending_approval");
    } finally {
      route.database.close();
    }
  }
});

test("a separate active administrator can commit the exact plan decision", async () => {
  const route = await harness();
  try {
    const result = await route.call();
    assert.equal(result.response.status, 201);
    assert.equal(route.database.prepare("SELECT status FROM agent_action_plans WHERE id = ?").get(PLAN_ID)?.status, "approved");
    const decision = route.database.prepare("SELECT decision, decided_by_user_id AS reviewer FROM agent_plan_decisions").get();
    assert.equal(decision?.decision, "approved");
    assert.equal(decision?.reviewer, REVIEWER_ID);
  } finally {
    route.database.close();
  }
});

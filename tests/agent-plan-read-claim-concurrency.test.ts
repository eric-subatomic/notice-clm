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
import { computeAgreementBasisHash } from "../app/lib/agreement-basis";
import * as agentActionContracts from "../app/lib/agent-action-contracts";
import * as actionRegistry from "../app/lib/action-registry";
import * as agentGovernance from "../app/lib/agent-governance";
import {
  currentActionDefinitionSnapshot,
  matchesCurrentActionDefinition,
} from "../app/lib/agent-plan-review";
import { apiError, apiJson } from "../app/lib/http";
import { isMutationGuardConflict } from "../app/lib/persistence";
import { parseJson } from "../app/lib/validation";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

const routeSource = await readFile(new URL("../app/api/v1/plans/[id]/execute/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/v1/plans/[id]/execute/route.ts",
}).outputText;

const WORKSPACE_ID = "workspace-a";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const SPONSOR_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const AGREEMENT_ID = 4102;
const CREATED_AT = "2026-08-01T00:00:00.000Z";
const EXPIRES_AT = "2099-08-01T00:00:00.000Z";

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
  private batchNumber = 0;
  private beforeBatchHook: ((batchNumber: number) => void) | null = null;

  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  beforeBatch(hook: (batchNumber: number) => void): void {
    this.beforeBatchHook = hook;
  }

  async batch(statements: readonly SqliteD1Statement[]) {
    this.batchNumber += 1;
    this.beforeBatchHook?.(this.batchNumber);
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
    CREATE TABLE agent_action_executions (
      id text PRIMARY KEY, workspace_id text NOT NULL, plan_id text NOT NULL,
      principal_id text NOT NULL, grant_id text NOT NULL, action_id text NOT NULL,
      plan_sha256 text NOT NULL, request_sha256 text NOT NULL,
      idempotency_key_sha256 text NOT NULL, status text NOT NULL, result text,
      agreement_event_ids text NOT NULL, provenance text NOT NULL,
      started_at text NOT NULL, completed_at text,
      UNIQUE (workspace_id, principal_id, idempotency_key_sha256)
    );
    CREATE TABLE service_principals (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL, status text NOT NULL
    );
    CREATE TABLE agent_grants (
      id text PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
      delegator_user_id text NOT NULL, version integer NOT NULL, policy_version text NOT NULL,
      action_ids text NOT NULL, resource_constraints text NOT NULL, status text NOT NULL,
      revoked_at text, starts_at text NOT NULL, expires_at text NOT NULL
    );
    CREATE TABLE users (id text PRIMARY KEY, status text NOT NULL);
    CREATE TABLE workspace_memberships (
      workspace_id text NOT NULL, user_id text NOT NULL, role text NOT NULL,
      status text NOT NULL, PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE agreements (
      id integer PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      party text NOT NULL, initials text NOT NULL, side text NOT NULL, type text NOT NULL,
      value integer NOT NULL, value_minor integer NOT NULL, currency_code text NOT NULL,
      stage text NOT NULL, owner text NOT NULL, owner_user_id text,
      primary_counterparty_id text, legal_entity_id text, governed_template_version_id text,
      workflow_definition_id text, workflow_policy_sha256 text, workflow_approval_lanes text,
      next_action text NOT NULL, due text NOT NULL, crm text NOT NULL, crm_record text NOT NULL,
      tags text NOT NULL, updated text NOT NULL, created_at text NOT NULL,
      updated_at text NOT NULL, created_by_user_id text, updated_by_user_id text,
      legal_hold integer NOT NULL, retention_until text, deleted_at text,
      department text NOT NULL, risk text NOT NULL, risk_disposition text,
      risk_basis_hash text, risk_document_version integer, risk_document_sha256 text,
      risk_decision_reason text, risk_decided_by_user_id text, risk_decided_at text,
      approval_status text NOT NULL, signature_status text NOT NULL,
      effective_date text NOT NULL, expiration_date text NOT NULL
    );
    CREATE TABLE agreement_document_versions (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      version integer NOT NULL, sha256 text NOT NULL
    );
    CREATE TABLE agent_runs (
      id text PRIMARY KEY, workspace_id text NOT NULL, principal_id text NOT NULL,
      status text NOT NULL, completed_at text
    );
    CREATE TABLE mutation_guards (
      id text PRIMARY KEY, workspace_id text NOT NULL, operation text NOT NULL,
      guard_changes integer NOT NULL, created_at text NOT NULL,
      CONSTRAINT ck_mutation_guards_changes CHECK (guard_changes = 1)
    );
    CREATE TABLE agent_plan_decisions (
      id text PRIMARY KEY, workspace_id text NOT NULL, plan_id text NOT NULL,
      plan_sha256 text NOT NULL, decision text NOT NULL, reason text NOT NULL,
      decided_by_user_id text NOT NULL, decided_at text NOT NULL
    );
  `);
  return database;
}

function agreementRow() {
  return {
    workspaceId: WORKSPACE_ID,
    id: AGREEMENT_ID,
    version: 7,
    party: "Acme Incorporated",
    initials: "AI",
    side: "Sell-side",
    type: "Services Agreement",
    value: 100,
    valueMinor: 10_000,
    currencyCode: "USD",
    stage: "Review",
    owner: "Sam Sponsor",
    ownerUserId: SPONSOR_ID,
    primaryCounterpartyId: null,
    legalEntityId: null,
    governedTemplateVersionId: null,
    workflowDefinitionId: null,
    workflowPolicySha256: null,
    workflowApprovalLanes: null,
    nextAction: "Complete review",
    due: "2026-09-01",
    crm: "None",
    crmRecord: "",
    tags: ["priority"],
    updated: "Today",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    createdByUserId: SPONSOR_ID,
    updatedByUserId: SPONSOR_ID,
    legalHold: false,
    retentionUntil: null,
    deletedAt: null,
    department: "Legal",
    risk: "Low",
    riskDisposition: null,
    riskBasisHash: null,
    riskDocumentVersion: null,
    riskDocumentSha256: null,
    riskDecisionReason: null,
    riskDecidedByUserId: null,
    riskDecidedAt: null,
    approvalStatus: "Required",
    signatureStatus: "Not sent",
    effectiveDate: "2026-08-01",
    expirationDate: "2027-08-01",
  } as const;
}

async function seed(database: DatabaseSync) {
  const agreement = agreementRow();
  database.prepare(`INSERT INTO agreements VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )`).run(
    agreement.id, agreement.workspaceId, agreement.version, agreement.party, agreement.initials,
    agreement.side, agreement.type, agreement.value, agreement.valueMinor, agreement.currencyCode,
    agreement.stage, agreement.owner, agreement.ownerUserId, agreement.primaryCounterpartyId,
    agreement.legalEntityId, agreement.governedTemplateVersionId, agreement.workflowDefinitionId,
    agreement.workflowPolicySha256, agreement.workflowApprovalLanes, agreement.nextAction,
    agreement.due, agreement.crm, agreement.crmRecord, JSON.stringify(agreement.tags), agreement.updated,
    agreement.createdAt, agreement.updatedAt, agreement.createdByUserId, agreement.updatedByUserId,
    Number(agreement.legalHold), agreement.retentionUntil, agreement.deletedAt, agreement.department,
    agreement.risk, agreement.riskDisposition, agreement.riskBasisHash, agreement.riskDocumentVersion,
    agreement.riskDocumentSha256, agreement.riskDecisionReason, agreement.riskDecidedByUserId,
    agreement.riskDecidedAt, agreement.approvalStatus, agreement.signatureStatus,
    agreement.effectiveDate, agreement.expirationDate,
  );
  const basisHash = await agentGovernance.canonicalJsonDigest({
    kind: "notice.agreement-without-working-document",
    workspaceId: WORKSPACE_ID,
    agreementId: AGREEMENT_ID,
    agreementVersion: agreement.version,
  });
  const definition = actionRegistry.getActionDefinition("agreement.read");
  const input = { include: ["summary", "workingDocumentEvidence"] };
  const provenance = {
    actionDefinition: currentActionDefinitionSnapshot(definition),
    run: { modelId: "customer-model-v1", toolVersion: "1" },
  };
  const planMaterial: agentGovernance.AgentActionPlanMaterial = {
    schemaVersion: "1.0",
    planId: PLAN_ID,
    workspaceId: WORKSPACE_ID,
    serviceAccountId: PRINCIPAL_ID,
    grantId: GRANT_ID,
    delegatorPrincipalId: SPONSOR_ID,
    actionId: "agreement.read",
    target: { resourceType: "agreement", resourceId: String(AGREEMENT_ID), version: 7, basisHash },
    input,
    policyVersion: "policy-v1",
    actionDefinition: provenance.actionDefinition,
    riskTier: "low",
    beforeSnapshot: { agreement: { id: AGREEMENT_ID, version: 7 } },
    proposedDiff: {},
    blockers: [],
    provenance,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  };
  const planDigest = await agentGovernance.computeAgentActionPlanDigest(planMaterial);
  database.prepare(`INSERT INTO agent_action_plans VALUES (
    ?, ?, ?, ?, ?, 'agreement.read', 'agreement', ?, ?, ?, ?, ?, 7, ?, NULL, NULL,
    'policy-v1', 'low', 'approved', ?, '{}', '[]', ?, ?, ?, ?, ?
  )`).run(
    PLAN_ID, WORKSPACE_ID, PRINCIPAL_ID, GRANT_ID, RUN_ID, String(AGREEMENT_ID), AGREEMENT_ID,
    JSON.stringify(input), "b".repeat(64), planDigest, basisHash,
    JSON.stringify(planMaterial.beforeSnapshot), JSON.stringify(provenance), SPONSOR_ID,
    EXPIRES_AT, CREATED_AT, CREATED_AT,
  );
  database.prepare("INSERT INTO service_principals VALUES (?, ?, 3, 'active')")
    .run(PRINCIPAL_ID, WORKSPACE_ID);
  database.prepare("INSERT INTO agent_grants VALUES (?, ?, ?, ?, 4, 'policy-v1', ?, ?, 'active', NULL, ?, ?)")
    .run(
      GRANT_ID,
      WORKSPACE_ID,
      PRINCIPAL_ID,
      SPONSOR_ID,
      JSON.stringify(["agreement.read"]),
      JSON.stringify({ resources: [{ type: "agreement", ids: [String(AGREEMENT_ID)] }] }),
      CREATED_AT,
      EXPIRES_AT,
    );
  database.prepare("INSERT INTO users VALUES (?, 'active')").run(SPONSOR_ID);
  database.prepare("INSERT INTO workspace_memberships VALUES (?, ?, 'admin', 'active')")
    .run(WORKSPACE_ID, SPONSOR_ID);
  database.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, 'running', NULL)")
    .run(RUN_ID, WORKSPACE_ID, PRINCIPAL_ID);
  return { planDigest };
}

async function harness() {
  const database = createDatabase();
  const seeded = await seed(database);
  const d1 = new SqliteD1(database);
  const db = drizzle(d1 as unknown as D1Database, { schema });
  const serviceContext = {
    kind: "service" as const,
    workspace: { id: WORKSPACE_ID, slug: "workspace-a", name: "Workspace A" },
    principal: {
      id: PRINCIPAL_ID,
      workspaceId: WORKSPACE_ID,
      issuer: "https://access.example.test",
      subject: "service-subject",
      status: "active",
      name: "Contract agent",
      version: 3,
    },
    grants: [],
    authenticatedAt: CREATED_AT,
    identitySource: "evaluation-service-principal" as const,
  };
  const authority = {
    ok: true as const,
    context: serviceContext,
    workspace: serviceContext.workspace,
    principal: serviceContext.principal,
    grant: {
      id: GRANT_ID,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      delegatorUserId: SPONSOR_ID,
      status: "active",
      actionIds: ["agreement.read"],
      resourceConstraints: { resources: [{ type: "agreement", ids: [String(AGREEMENT_ID)] }] },
      policyVersion: "policy-v1",
      startsAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      revokedAt: null,
    },
    sponsor: { id: SPONSOR_ID, status: "active" },
    membership: { workspaceId: WORKSPACE_ID, userId: SPONSOR_ID, role: "admin", status: "active" },
    effectivePermissions: ["agreement:read"],
    requestId: "request-execute",
    headers: new Headers(),
  };
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const governed = {
    ...agentGovernance,
    canonicalJson: (value: unknown) => agentGovernance.canonicalJson(clone(value)),
    canonicalJsonDigest: (value: unknown) => agentGovernance.canonicalJsonDigest(clone(value)),
    computeAgentActionPlanDigest: (value: agentGovernance.AgentActionPlanMaterial) => agentGovernance.computeAgentActionPlanDigest(clone(value)),
    computeIdempotencyRequestDigest: (scope: agentGovernance.IdempotencyScope, payload: unknown) => agentGovernance.computeIdempotencyRequestDigest(clone(scope), clone(payload)),
    computeIdempotencyScopeDigest: (scope: agentGovernance.IdempotencyScope) => agentGovernance.computeIdempotencyScopeDigest(clone(scope)),
    validateAgentExecutionProvenance: (provenance: agentGovernance.AgentExecutionProvenance, expected: Parameters<typeof agentGovernance.validateAgentExecutionProvenance>[1]) => agentGovernance.validateAgentExecutionProvenance(clone(provenance), clone(expected)),
  };
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "zod") return { z };
    if (specifier === "../../../../../../db") return { getDb: () => db };
    if (specifier === "../../../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../../../db/schema") return schema;
    if (specifier === "../../../../../lib/agreement-basis") return { computeAgreementBasisHash };
    if (specifier === "../../../../../lib/agent-action-contracts") return agentActionContracts;
    if (specifier === "../../../../../lib/action-registry") return actionRegistry;
    if (specifier === "../../../../../lib/agent-plan-review") {
      return {
        matchesCurrentActionDefinition: (saved: unknown, riskTier: string, definition: actionRegistry.ActionDefinition) => matchesCurrentActionDefinition(clone(saved), riskTier, definition),
      };
    }
    if (specifier === "../../../../../lib/agent-governance") return governed;
    if (specifier === "../../../../../lib/approval-routing-service") {
      return {
        inspectRequiredApprovalRouting: async () => { throw new Error("approval routing is outside this read test"); },
        buildRequiredApprovalRoutingStatements: async () => { throw new Error("approval routing is outside this read test"); },
      };
    }
    if (specifier === "../../../../../lib/api") {
      return { handleRouteError: (error: unknown) => apiError("internal_error", String(error), { status: 500 }) };
    }
    if (specifier === "../../../../../lib/http") return { apiError, apiJson };
    if (specifier === "../../../../../lib/persistence") return { isMutationGuardConflict };
    if (specifier === "../../../../../lib/service-principal-auth") {
      return {
        authorizeV1ReadRequest: async () => ({
          ok: true,
          actor: { kind: "service", context: serviceContext },
          requestId: "request-execute",
          headers: new Headers(),
        }),
        authorizeServicePrincipalRequest: async () => authority,
      };
    }
    if (specifier === "../../../../../lib/validation") return { parseJson };
    throw new Error(`Unexpected execute-route dependency: ${specifier}`);
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
  new vm.Script(compiledRoute, { filename: "app/api/v1/plans/[id]/execute/route.cjs" }).runInContext(context);
  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  const post = moduleObject.exports.POST as Handler;
  const call = async () => {
    const response = await post(new Request(`https://notice.test/api/v1/plans/${PLAN_ID}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "read-attempt-1" },
      body: JSON.stringify({ planDigest: seeded.planDigest }),
    }), { params: Promise.resolve({ id: PLAN_ID }) });
    return { response, body: await response.json() as Record<string, unknown> };
  };
  return { database, d1, call };
}

function assertUnclaimed(database: DatabaseSync): void {
  assert.equal(database.prepare("SELECT count(*) AS count FROM agent_action_executions").get()?.count, 0);
  assert.equal(database.prepare("SELECT status FROM agent_action_plans WHERE id = ?").get(PLAN_ID)?.status, "approved");
}

test("agreement.read atomically rejects concurrent authority, expiry, target, and document changes", async () => {
  const mutations: Array<(database: DatabaseSync) => void> = [
    (database) => void database.prepare("UPDATE service_principals SET status = 'disabled' WHERE id = ?").run(PRINCIPAL_ID),
    (database) => void database.prepare("UPDATE agent_grants SET status = 'revoked', revoked_at = ?, version = version + 1 WHERE id = ?")
      .run("2026-08-21T00:00:00.000Z", GRANT_ID),
    (database) => void database.prepare("UPDATE agent_grants SET action_ids = '[]' WHERE id = ?").run(GRANT_ID),
    (database) => void database.prepare("UPDATE agent_grants SET resource_constraints = ? WHERE id = ?")
      .run(JSON.stringify({ resources: [{ type: "agreement", ids: ["9999"] }] }), GRANT_ID),
    (database) => void database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(SPONSOR_ID),
    (database) => void database.prepare("UPDATE workspace_memberships SET status = 'disabled' WHERE workspace_id = ? AND user_id = ?")
      .run(WORKSPACE_ID, SPONSOR_ID),
    (database) => void database.prepare("UPDATE agent_action_plans SET expires_at = ? WHERE id = ?")
      .run("2026-08-01T00:00:01.000Z", PLAN_ID),
    (database) => void database.prepare("UPDATE agreements SET owner = 'Concurrent owner' WHERE id = ?").run(AGREEMENT_ID),
    (database) => void database.prepare("INSERT INTO agreement_document_versions VALUES ('doc-1', ?, ?, 1, ?)")
      .run(WORKSPACE_ID, AGREEMENT_ID, "d".repeat(64)),
  ];
  for (const mutate of mutations) {
    const route = await harness();
    try {
      route.d1.beforeBatch((batchNumber) => {
        if (batchNumber === 1) mutate(route.database);
      });
      const result = await route.call();
      assert.equal(result.response.status, 409, JSON.stringify(result.body));
      assert.equal((result.body.error as { code: string }).code, "plan_basis_stale");
      assertUnclaimed(route.database);
    } finally {
      route.database.close();
    }
  }
});

test("agreement.read result commit rechecks the exact claimed snapshot", async () => {
  const route = await harness();
  try {
    route.d1.beforeBatch((batchNumber) => {
      if (batchNumber === 2) {
        route.database.prepare("UPDATE agreements SET owner = 'Changed after claim' WHERE id = ?").run(AGREEMENT_ID);
      }
    });
    const result = await route.call();
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal((result.body.error as { code: string }).code, "execution_state_conflict");
    const execution = route.database.prepare("SELECT status, result FROM agent_action_executions WHERE id = ?").get(PLAN_ID);
    assert.equal(execution?.status, "executing");
    assert.equal(execution?.result, null);
    assert.equal(route.database.prepare("SELECT status FROM agent_action_plans WHERE id = ?").get(PLAN_ID)?.status, "executing");
  } finally {
    route.database.close();
  }
});

test("agreement.read succeeds with a result bound to the exact claimed agreement", async () => {
  const route = await harness();
  try {
    const result = await route.call();
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const execution = result.body.execution as { status: string; result: { agreement: { owner: string; version: number } } };
    assert.equal(execution.status, "succeeded");
    assert.equal(execution.result.agreement.owner, "Sam Sponsor");
    assert.equal(execution.result.agreement.version, 7);
    assert.equal(route.database.prepare("SELECT status FROM agent_action_plans WHERE id = ?").get(PLAN_ID)?.status, "succeeded");
  } finally {
    route.database.close();
  }
});

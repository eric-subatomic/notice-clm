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
import * as enterpriseDomain from "../app/lib/enterprise-domain";
import * as enterpriseReferences from "../app/lib/enterprise-references";
import * as enterpriseValidation from "../app/lib/enterprise-validation";
import { minorUnitsFromWholeUnits, wholeUnitProjection } from "../app/lib/money";
import { governedWorkflowSnapshot } from "../app/lib/workflow-policy";
import { parseJson, RequestValidationError } from "../app/lib/validation";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

const routeSource = await readFile(new URL("../app/api/intake/submissions/[id]/convert/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/intake/submissions/[id]/convert/route.ts",
}).outputText;

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly bindings: readonly SQLInputValue[] = [],
  ) {}
  bind(...bindings: SQLInputValue[]) { return new SqliteD1Statement(this.database, this.query, bindings); }
  async run() {
    const result = this.database.prepare(this.query).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async first<T>() { return (this.database.prepare(this.query).get(...this.bindings) as T | undefined) ?? null; }
  async all<T>() { return { results: this.database.prepare(this.query).all(...this.bindings) as T[] }; }
  async raw<T extends unknown[]>() {
    return sqliteD1RawRows<T>(this.database, this.query, this.bindings);
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(query: string) { return new SqliteD1Statement(this.database, query); }
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY, identity_provider text NOT NULL, identity_subject text NOT NULL,
      email text NOT NULL, display_name text NOT NULL, status text NOT NULL,
      created_at text NOT NULL, updated_at text NOT NULL, last_seen_at text NOT NULL
    );
    CREATE TABLE workspace_memberships (
      workspace_id text NOT NULL, user_id text NOT NULL, role text NOT NULL,
      status text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE legal_entities (
      id text PRIMARY KEY, workspace_id text NOT NULL, status text NOT NULL
    );
    CREATE TABLE counterparties (
      id text PRIMARY KEY, workspace_id text NOT NULL, display_name text NOT NULL, status text NOT NULL
    );
    CREATE TABLE governed_templates (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      name text NOT NULL, description text NOT NULL, agreement_type text NOT NULL,
      side text NOT NULL, status text NOT NULL, current_published_version integer,
      created_by_user_id text NOT NULL, created_at text NOT NULL,
      updated_by_user_id text NOT NULL, updated_at text NOT NULL
    );
    CREATE TABLE governed_template_versions (
      id text PRIMARY KEY, workspace_id text NOT NULL, template_id text NOT NULL,
      version integer NOT NULL, status text NOT NULL, body text NOT NULL,
      variable_schema text NOT NULL, language_block_ids text NOT NULL,
      content_sha256 text NOT NULL, change_summary text NOT NULL,
      created_by_user_id text NOT NULL, created_at text NOT NULL,
      reviewed_by_user_id text, reviewed_at text
    );
    CREATE TABLE workflow_definitions (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      name text NOT NULL, description text NOT NULL, status text NOT NULL,
      definition text NOT NULL, definition_sha256 text NOT NULL,
      created_by_user_id text NOT NULL, created_at text NOT NULL,
      updated_by_user_id text NOT NULL, updated_at text NOT NULL,
      published_by_user_id text, published_at text
    );
    CREATE TABLE intake_forms (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      name text NOT NULL, description text NOT NULL, status text NOT NULL,
      form_schema text NOT NULL, template_id text, template_version_id text,
      workflow_definition_id text, created_by_user_id text NOT NULL,
      created_at text NOT NULL, updated_by_user_id text NOT NULL, updated_at text NOT NULL
    );
    CREATE TABLE intake_submissions (
      id text PRIMARY KEY, workspace_id text NOT NULL, form_id text NOT NULL,
      form_version integer NOT NULL, version integer NOT NULL, status text NOT NULL,
      answers text NOT NULL, submitted_by_user_id text NOT NULL, agreement_id integer,
      created_at text NOT NULL, updated_at text NOT NULL, submitted_at text, converted_at text
    );
    CREATE TABLE agreements (
      id integer PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      party text NOT NULL, initials text NOT NULL, side text NOT NULL, type text NOT NULL,
      value integer NOT NULL, value_minor integer NOT NULL, currency_code text NOT NULL,
      stage text NOT NULL, owner text NOT NULL, owner_user_id text,
      primary_counterparty_id text, legal_entity_id text, governed_template_version_id text,
      workflow_definition_id text, workflow_policy_sha256 text, workflow_approval_lanes text,
      next_action text NOT NULL, due text NOT NULL, crm text NOT NULL, crm_record text NOT NULL,
      tags text NOT NULL, updated text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL,
      created_by_user_id text, updated_by_user_id text, legal_hold integer NOT NULL,
      retention_until text, deleted_at text, department text NOT NULL, risk text NOT NULL,
      risk_disposition text, risk_basis_hash text, risk_document_version integer,
      risk_document_sha256 text, risk_decision_reason text, risk_decided_by_user_id text,
      risk_decided_at text, approval_status text NOT NULL, signature_status text NOT NULL,
      effective_date text NOT NULL, expiration_date text NOT NULL
    );
    CREATE TABLE agreement_events (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      type text NOT NULL, actor_user_id text, actor_email text, actor text NOT NULL,
      detail text NOT NULL, previous_hash text, event_hash text, sequence integer NOT NULL,
      source_agent_plan_id text, created_at text NOT NULL
    );
    CREATE TABLE agreement_versions (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      version integer NOT NULL, snapshot text NOT NULL, source_event_id text,
      checksum_sha256 text NOT NULL, created_by_user_id text NOT NULL, created_at text NOT NULL
    );
    CREATE TABLE outbox_events (
      id text PRIMARY KEY, workspace_id text NOT NULL, topic text NOT NULL,
      aggregate_type text NOT NULL, aggregate_id text NOT NULL, payload text NOT NULL,
      status text NOT NULL, attempts integer NOT NULL, available_at text NOT NULL,
      locked_at text, processed_at text, last_error text, created_at text NOT NULL
    );
  `);
  return database;
}

const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const ENTITY_ID = "33333333-3333-4333-8333-333333333333";
const COUNTERPARTY_ID = "44444444-4444-4444-8444-444444444444";
const TEMPLATE_ID = "55555555-5555-4555-8555-555555555555";
const TEMPLATE_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const WORKFLOW_ID = "77777777-7777-4777-8777-777777777777";
const FORM_ID = "88888888-8888-4888-8888-888888888888";
const SUBMISSION_ID = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-08-20T12:00:00.000Z";

const workflowDefinition = {
  schemaVersion: "1.0" as const,
  approvalLanes: [
    { lane: "Legal" },
    { lane: "Finance", when: { currencyCodes: ["USD"], minimumValueMinor: 10_000 } },
  ],
};
const templateContent = {
  body: "Services agreement for {{party}}",
  variableSchema: {},
  languageBlockIds: [] as number[],
};

async function seedGovernedSubmission(database: DatabaseSync, workspaceId = WORKSPACE_A): Promise<void> {
  const templateDigest = await enterpriseDomain.enterpriseContentDigest(templateContent, 600_000);
  const workflowDigest = await enterpriseDomain.enterpriseContentDigest(workflowDefinition);
  const user = database.prepare(`INSERT INTO users (
    id, identity_provider, identity_subject, email, display_name, status,
    created_at, updated_at, last_seen_at
  ) VALUES (?, 'test', ?, ?, ?, 'active', ?, ?, ?)`);
  user.run(USER_ID, USER_ID, "converter@example.test", "Casey Converter", NOW, NOW, NOW);
  user.run(OWNER_ID, OWNER_ID, "owner@example.test", "Olivia Owner", NOW, NOW, NOW);
  const membership = database.prepare(`INSERT INTO workspace_memberships (
    workspace_id, user_id, role, status, created_at, updated_at
  ) VALUES (?, ?, ?, 'active', ?, ?)`);
  membership.run(workspaceId, USER_ID, "legal", NOW, NOW);
  membership.run(workspaceId, OWNER_ID, "legal", NOW, NOW);
  database.prepare("INSERT INTO legal_entities VALUES (?, ?, 'active')").run(ENTITY_ID, workspaceId);
  database.prepare("INSERT INTO counterparties VALUES (?, ?, 'Acme Incorporated', 'active')").run(COUNTERPARTY_ID, workspaceId);
  database.prepare(`INSERT INTO governed_templates (
    id, workspace_id, version, name, description, agreement_type, side, status,
    current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, 2, 'Services', '', 'Services Agreement', 'Sell-side', 'published', 1, 'author', ?, 'publisher', ?)`)
    .run(TEMPLATE_ID, workspaceId, NOW, NOW);
  database.prepare(`INSERT INTO governed_template_versions (
    id, workspace_id, template_id, version, status, body, variable_schema,
    language_block_ids, content_sha256, change_summary, created_by_user_id,
    created_at, reviewed_by_user_id, reviewed_at
  ) VALUES (?, ?, ?, 1, 'published', ?, ?, ?, ?, 'Approved', 'author', ?, 'publisher', ?)`)
    .run(TEMPLATE_VERSION_ID, workspaceId, TEMPLATE_ID, templateContent.body, JSON.stringify(templateContent.variableSchema), JSON.stringify(templateContent.languageBlockIds), templateDigest, NOW, NOW);
  database.prepare(`INSERT INTO workflow_definitions (
    id, workspace_id, version, name, description, status, definition,
    definition_sha256, created_by_user_id, created_at, updated_by_user_id,
    updated_at, published_by_user_id, published_at
  ) VALUES (?, ?, 1, 'Standard review', '', 'published', ?, ?, 'author', ?, 'publisher', ?, 'publisher', ?)`)
    .run(WORKFLOW_ID, workspaceId, JSON.stringify(workflowDefinition), workflowDigest, NOW, NOW, NOW);
  database.prepare(`INSERT INTO intake_forms (
    id, workspace_id, version, name, description, status, form_schema,
    template_id, template_version_id, workflow_definition_id,
    created_by_user_id, created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, 3, 'Services request', '', 'published', ?, ?, ?, ?, 'author', ?, 'publisher', ?)`)
    .run(FORM_ID, workspaceId, JSON.stringify({ fields: [{ key: "summary", label: "Summary", type: "text", required: true, options: [] }] }), TEMPLATE_ID, TEMPLATE_VERSION_ID, WORKFLOW_ID, NOW, NOW);
  database.prepare(`INSERT INTO intake_submissions (
    id, workspace_id, form_id, form_version, version, status, answers,
    submitted_by_user_id, agreement_id, created_at, updated_at, submitted_at, converted_at
  ) VALUES (?, ?, ?, 3, 2, 'submitted', ?, 'requester', NULL, ?, ?, ?, NULL)`)
    .run(SUBMISSION_ID, workspaceId, FORM_ID, JSON.stringify({ summary: "Please prepare a services agreement", confidential: "do not echo" }), NOW, NOW, NOW);
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit; requestId?: string } = {}): Response {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function insertCommittedAgreement(database: DatabaseSync, agreementId: number, workspaceId = WORKSPACE_A): void {
  database.prepare(`INSERT INTO agreements (
    id, workspace_id, version, party, initials, side, type, value, value_minor,
    currency_code, stage, owner, owner_user_id, primary_counterparty_id,
    legal_entity_id, governed_template_version_id, workflow_definition_id,
    workflow_policy_sha256, workflow_approval_lanes, next_action, due, crm,
    crm_record, tags, updated, created_at, updated_at, created_by_user_id,
    updated_by_user_id, legal_hold, retention_until, deleted_at, department,
    risk, risk_disposition, risk_basis_hash, risk_document_version,
    risk_document_sha256, risk_decision_reason, risk_decided_by_user_id,
    risk_decided_at, approval_status, signature_status, effective_date, expiration_date
  ) VALUES (?, ?, 1, 'Prior agreement', 'PA', 'Sell-side', 'Services Agreement', 0, 0,
    'USD', 'Intake', 'Olivia Owner', ?, NULL, NULL, NULL, NULL, NULL, NULL,
    'Add a source document or create a working paper', 'Unscheduled', 'None', '', '[]',
    ?, ?, ?, ?, ?, 0, NULL, NULL, 'Legal', 'Unassessed', NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, 'Required', 'Not sent', '', '')`)
    .run(agreementId, workspaceId, OWNER_ID, NOW, NOW, NOW, USER_ID, USER_ID);
}

type MutationInput = Readonly<{
  type: string;
  detail: Record<string, unknown>;
  steps: Array<{ statement: PromiseLike<unknown>; guardOperation?: string }>;
}>;

function routeHarness(database: DatabaseSync) {
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  let workspaceId = WORKSPACE_A;
  let userId = USER_ID;
  let role = "legal";
  let eventSequence = 0;
  let beforeMutationOnce: (() => void) | undefined;
  let failAfterStep: number | null = null;
  const permissions: string[] = [];
  const committedMutations: Array<{ type: string; detail: Record<string, unknown> }> = [];
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const routeError = (error: unknown, requestId: string, headers: Headers) => {
    if (error instanceof enterpriseDomain.EnterpriseError) {
      return responseJson({ error: { code: error.code, message: error.message }, requestId }, { status: error.status, headers });
    }
    if (error instanceof RequestValidationError) {
      return responseJson({ error: { code: error.code, message: error.message }, issues: error.issues, requestId }, { status: error.status, headers });
    }
    return responseJson({ error: { code: "internal_error", message: "The intake submission could not be converted." }, requestId }, { status: 500, headers });
  };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "zod") return { z };
    if (specifier === "../../../../../../db") return { getDb: () => db };
    if (specifier === "../../../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../../../db/schema") return schema;
    if (specifier === "../../../../../lib/api") return {
      authorizeApiRequest: async (_request: Request, permission: string) => {
        permissions.push(permission);
        return {
          ok: true,
          context: {
            workspace: { id: workspaceId, name: workspaceId },
            user: { id: userId, email: `${userId}@example.test`, displayName: "Casey Converter" },
            role,
          },
          requestId: "request-convert",
          headers: new Headers(),
        };
      },
    };
    if (specifier === "../../../../../lib/enterprise-api") return {
      executeEnterpriseMutation: async (_db: unknown, input: MutationInput) => {
        const hook = beforeMutationOnce;
        beforeMutationOnce = undefined;
        hook?.();
        database.exec("BEGIN");
        try {
          let stepNumber = 0;
          for (const step of input.steps) {
            stepNumber += 1;
            const result = await step.statement as { meta?: { changes?: number } };
            if (step.guardOperation && result.meta?.changes !== 1) {
              throw new Error("CHECK constraint failed: ck_mutation_guards_changes");
            }
            if (failAfterStep === stepNumber) throw new Error("simulated batch failure");
          }
          database.exec("COMMIT");
          committedMutations.push({ type: input.type, detail: input.detail });
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          failAfterStep = null;
        }
      },
      enterpriseRouteError: routeError,
    };
    if (specifier === "../../../../../lib/enterprise-domain") return {
      ...enterpriseDomain,
      enterpriseContentDigest: (value: unknown, maxBytes?: number) => enterpriseDomain.enterpriseContentDigest(
        JSON.parse(JSON.stringify(value)) as unknown,
        maxBytes,
      ),
    };
    if (specifier === "../../../../../lib/enterprise-references") return enterpriseReferences;
    if (specifier === "../../../../../lib/enterprise-validation") return enterpriseValidation;
    if (specifier === "../../../../../lib/http") return { apiJson: responseJson };
    if (specifier === "../../../../../lib/crm-selection") return {
      configuredCrmSelectionError: (selection: string) => selection === "None"
        ? null
        : responseJson({ error: { code: "crm_provider_unavailable", message: "CRM unavailable" }, requestId: "request-convert" }, { status: 409 }),
    };
    if (specifier === "../../../../../lib/integration-events") return {
      crmAgreementProjection: (agreement: Record<string, unknown>) => ({
        agreementId: agreement.id,
        version: agreement.version,
        party: agreement.party,
        valueMinor: agreement.valueMinor,
        currencyCode: agreement.currencyCode,
      }),
      prepareIntegrationOutboxEvent: (input: Record<string, unknown>) => input,
    };
    if (specifier === "../../../../../lib/money") return { minorUnitsFromWholeUnits, wholeUnitProjection };
    if (specifier === "../../../../../lib/persistence") return {
      isMutationGuardConflict: (error: unknown) => String(error).toLowerCase().includes("ck_mutation_guards_changes"),
      prepareAgreementEvent: async (_database: unknown, input: Record<string, unknown>) => ({
        id: `event-${++eventSequence}`,
        workspaceId: input.workspaceId,
        agreementId: input.agreementId,
        type: input.type,
        actorUserId: userId,
        actorEmail: `${userId}@example.test`,
        actor: "Casey Converter",
        detail: input.detail,
        previousHash: null,
        eventHash: "e".repeat(64),
        sequence: 1,
        sourceAgentPlanId: null,
        createdAt: input.createdAt,
      }),
      prepareAgreementSnapshot: async (agreement: Record<string, unknown>, actorUserId: string, sourceEventId: string) => ({
        id: crypto.randomUUID(),
        workspaceId: agreement.workspaceId,
        agreementId: agreement.id,
        version: agreement.version,
        snapshot: agreement,
        sourceEventId,
        checksumSha256: "s".repeat(64),
        createdByUserId: actorUserId,
        createdAt: agreement.createdAt,
      }),
      prepareOutboxEvent: (input: Record<string, unknown>) => ({
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        topic: input.topic,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: input.payload,
        status: "pending",
        attempts: 0,
        availableAt: NOW,
        lockedAt: null,
        processedAt: null,
        lastError: null,
        createdAt: NOW,
      }),
    };
    if (specifier === "../../../../../lib/validation") return { parseJson };
    if (specifier === "../../../../../lib/workflow-policy") return { governedWorkflowSnapshot };
    throw new Error(`Unexpected intake-conversion dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, Date, TextEncoder, TextDecoder, Uint8Array,
    Uint16Array, crypto, console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/intake/submissions/[id]/convert/route.cjs" }).runInContext(context);
  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  const post = moduleObject.exports.POST as Handler;
  const call = async (submissionId: string, body?: unknown) => {
    const response = await post(new Request(`https://notice.test/api/intake/submissions/${submissionId}/convert`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }), { params: Promise.resolve({ id: submissionId }) });
    return { response, body: await response.json() as Record<string, unknown> };
  };
  return {
    permissions,
    committedMutations,
    call,
    setIdentity(nextWorkspaceId: string, nextUserId = USER_ID) { workspaceId = nextWorkspaceId; userId = nextUserId; },
    setRole(nextRole: string) { role = nextRole; },
    beforeNextMutation(hook: () => void) { beforeMutationOnce = hook; },
    failNextMutationAfter(step: number) { failAfterStep = step; },
  };
}

function conversionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    formVersion: 3,
    templateVersionId: TEMPLATE_VERSION_ID,
    workflowDefinitionId: WORKFLOW_ID,
    confirmed: true,
    reason: "Reviewed and approved for intake conversion",
    agreement: {
      party: "Untrusted caller label",
      side: "Sell-side",
      type: "Services Agreement",
      value: 999,
      valueMinor: 12_345,
      currencyCode: "usd",
      ownerUserId: OWNER_ID,
      primaryCounterpartyId: COUNTERPARTY_ID,
      legalEntityId: ENTITY_ID,
      due: "Next week",
      crm: "None",
      crmRecord: "must be stripped",
      tags: ["Priority", "Priority"],
      department: "Legal",
      effectiveDate: "2026-09-01",
      expirationDate: "2027-09-01",
    },
    ...overrides,
  };
}

test("intake conversion has no working-paper or DocuSeal side effect", () => {
  assert.doesNotMatch(routeSource, /docuseal/i);
  assert.doesNotMatch(routeSource, /agreementDocumentVersions|DOCUMENTS\.(?:put|delete)/);
});

test("submitted intake conversion creates one normalized governed agreement and its durable evidence atomically", async () => {
  const database = createDatabase();
  try {
    await seedGovernedSubmission(database);
    const harness = routeHarness(database);
    const converted = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(converted.response.status, 201, JSON.stringify(converted.body));
    assert.equal(converted.body.replay, false);
    assert.deepEqual(harness.permissions, ["agreement:create"]);
    const projection = converted.body.conversion as { agreementId: number; submissionVersion: number; convertedAt: string };
    assert.equal(projection.submissionVersion, 3);
    assert.ok(Number.isSafeInteger(projection.agreementId));
    assert.match(projection.convertedAt, /^\d{4}-\d{2}-\d{2}T/);

    const agreement = database.prepare(`SELECT party, side, type, value, value_minor, currency_code,
      stage, owner, owner_user_id, primary_counterparty_id, legal_entity_id,
      governed_template_version_id, workflow_definition_id, workflow_policy_sha256,
      workflow_approval_lanes, risk, approval_status, signature_status, crm_record, tags
      FROM agreements WHERE id = ?`).get(projection.agreementId);
    assert.equal(agreement?.party, "Acme Incorporated");
    assert.equal(agreement?.side, "Sell-side");
    assert.equal(agreement?.type, "Services Agreement");
    assert.equal(agreement?.value, 123);
    assert.equal(agreement?.value_minor, 12_345);
    assert.equal(agreement?.currency_code, "USD");
    assert.equal(agreement?.stage, "Intake");
    assert.equal(agreement?.owner, "Olivia Owner");
    assert.equal(agreement?.owner_user_id, OWNER_ID);
    assert.equal(agreement?.primary_counterparty_id, COUNTERPARTY_ID);
    assert.equal(agreement?.legal_entity_id, ENTITY_ID);
    assert.equal(agreement?.governed_template_version_id, TEMPLATE_VERSION_ID);
    assert.equal(agreement?.workflow_definition_id, WORKFLOW_ID);
    assert.match(String(agreement?.workflow_policy_sha256), /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(String(agreement?.workflow_approval_lanes)), ["Legal", "Finance"]);
    assert.equal(agreement?.risk, "Unassessed");
    assert.equal(agreement?.approval_status, "Required");
    assert.equal(agreement?.signature_status, "Not sent");
    assert.equal(agreement?.crm_record, "");
    assert.deepEqual(JSON.parse(String(agreement?.tags)), ["Priority"]);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_events").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_versions").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM outbox_events WHERE topic = 'agreement.created'").get()?.count, 1);
    assert.equal(database.prepare("SELECT status FROM intake_submissions WHERE id = ?").get(SUBMISSION_ID)?.status, "converted");
    assert.equal(harness.committedMutations[0]?.type, "IntakeSubmissionConverted");
    assert.equal(harness.committedMutations[0]?.detail.submissionId, SUBMISSION_ID);
  } finally {
    database.close();
  }
});

test("converted submissions return a minimal exact replay without parsing answers or duplicating evidence", async () => {
  const database = createDatabase();
  try {
    await seedGovernedSubmission(database);
    const harness = routeHarness(database);
    const first = await harness.call(SUBMISSION_ID, conversionBody());
    const firstProjection = first.body.conversion;
    const replay = await harness.call(SUBMISSION_ID);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal(replay.body.replay, true);
    assert.deepEqual(replay.body.conversion, firstProjection);
    assert.equal(JSON.stringify(replay.body).includes("confidential"), false);
    assert.equal(JSON.stringify(replay.body).includes("do not echo"), false);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_events").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_versions").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM outbox_events").get()?.count, 1);
  } finally {
    database.close();
  }
});

test("conversion fails closed on tenant, optimistic version, configuration pins, and inactive references", async () => {
  const database = createDatabase();
  try {
    await seedGovernedSubmission(database);
    const harness = routeHarness(database);
    harness.setRole("requester");
    const forbidden = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(forbidden.response.status, 403);
    assert.equal((forbidden.body.error as { code: string }).code, "intake_conversion_forbidden");
    harness.setRole("legal");
    harness.setIdentity(WORKSPACE_B);
    const crossTenant = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(crossTenant.response.status, 404);
    harness.setIdentity(WORKSPACE_A);

    const stale = await harness.call(SUBMISSION_ID, conversionBody({ version: 1 }));
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as { code: string }).code, "version_conflict");
    const wrongTemplate = await harness.call(SUBMISSION_ID, conversionBody({ templateVersionId: null }));
    assert.equal(wrongTemplate.response.status, 409);
    assert.equal((wrongTemplate.body.error as { code: string }).code, "intake_configuration_changed");
    const wrongWorkflow = await harness.call(SUBMISSION_ID, conversionBody({ workflowDefinitionId: null }));
    assert.equal(wrongWorkflow.response.status, 409);
    assert.equal((wrongWorkflow.body.error as { code: string }).code, "intake_configuration_changed");

    const crmBody = conversionBody();
    const unavailableCrm = await harness.call(SUBMISSION_ID, {
      ...crmBody,
      agreement: {
        ...(crmBody.agreement as Record<string, unknown>),
        crm: "Salesforce",
        crmRecord: "001-unconfigured",
      },
    });
    assert.equal(unavailableCrm.response.status, 409);
    assert.equal((unavailableCrm.body.error as { code: string }).code, "crm_provider_unavailable");

    database.prepare("UPDATE counterparties SET status = 'inactive' WHERE id = ?").run(COUNTERPARTY_ID);
    const inactiveReference = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(inactiveReference.response.status, 422);
    assert.equal((inactiveReference.body.error as { code: string }).code, "active_counterparty_required");

    database.prepare("UPDATE counterparties SET status = 'active' WHERE id = ?").run(COUNTERPARTY_ID);
    database.prepare("UPDATE workspace_memberships SET status = 'disabled' WHERE workspace_id = ? AND user_id = ?").run(WORKSPACE_A, OWNER_ID);
    const inactiveOwner = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(inactiveOwner.response.status, 422);
    assert.equal((inactiveOwner.body.error as { code: string }).code, "active_member_required");

    database.prepare("UPDATE workspace_memberships SET status = 'active' WHERE workspace_id = ? AND user_id = ?").run(WORKSPACE_A, OWNER_ID);
    database.prepare("UPDATE legal_entities SET status = 'inactive' WHERE id = ?").run(ENTITY_ID);
    const inactiveEntity = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(inactiveEntity.response.status, 422);
    assert.equal((inactiveEntity.body.error as { code: string }).code, "active_legal_entity_required");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("the guarded batch rolls back every conversion artifact and a concurrent winner converges to replay", async () => {
  const database = createDatabase();
  try {
    await seedGovernedSubmission(database);
    const harness = routeHarness(database);
    harness.failNextMutationAfter(5);
    const failed = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(failed.response.status, 500);
    assert.equal(database.prepare("SELECT status FROM intake_submissions WHERE id = ?").get(SUBMISSION_ID)?.status, "submitted");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_events").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_versions").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM outbox_events").get()?.count, 0);

    const winningAgreementId = 42;
    harness.beforeNextMutation(() => {
      insertCommittedAgreement(database, winningAgreementId);
      database.prepare(`UPDATE intake_submissions SET
        status = 'converted', agreement_id = ?, version = 3,
        converted_at = ?, updated_at = ? WHERE id = ? AND status = 'submitted'`)
        .run(winningAgreementId, NOW, NOW, SUBMISSION_ID);
    });
    const converged = await harness.call(SUBMISSION_ID, conversionBody());
    assert.equal(converged.response.status, 200, JSON.stringify(converged.body));
    assert.equal(converged.body.replay, true);
    assert.equal((converged.body.conversion as { agreementId: number }).agreementId, winningAgreementId);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_events").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_versions").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM outbox_events").get()?.count, 0);
  } finally {
    database.close();
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import { z } from "zod";
import ts from "typescript";
import { sha256Hex } from "../app/lib/document-security";
import {
  governedTemplateContentDigest,
  GovernedTemplateRuntimeError,
  renderGovernedTemplate,
} from "../app/lib/governed-template-runtime";
import { minorUnitsFromWholeUnits, wholeUnitProjection } from "../app/lib/money";
import { assembleStarterDraft } from "../app/lib/starter-draft";
import { enterpriseContentDigest, EnterpriseError } from "../app/lib/enterprise-domain";
import { governedWorkflowSnapshot } from "../app/lib/workflow-policy";
import { agreementDetailsPatchSchema, agreementMutationSchema, parseJson } from "../app/lib/validation";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

const TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEMPLATE_VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDEMPOTENCY_KEY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WORKFLOW_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const routeSource = await readFile(new URL("../app/api/agreements/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: "app/api/agreements/route.ts",
}).outputText;

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly bindings: readonly SQLInputValue[] = [],
  ) {}

  bind(...bindings: SQLInputValue[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.query, bindings);
  }

  async run(): Promise<Record<string, unknown>> {
    const result = this.database.prepare(this.query).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.query).all(...this.bindings) as T[] };
  }

  async raw<T extends unknown[]>(): Promise<T[]> {
    return sqliteD1RawRows<T>(this.database, this.query, this.bindings);
  }

  executeBatch(): Record<string, unknown> {
    const result = this.database.prepare(this.query).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Record<string, unknown>[]> {
    return statements.map((statement) => statement.executeBatch());
  }
}

function createAgreementDatabase(): DatabaseSync {
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
    CREATE TABLE agreement_creation_receipts (
      workspace_id text NOT NULL, user_id text NOT NULL, idempotency_key text NOT NULL,
      request_sha256 text NOT NULL, creation_mode text NOT NULL, agreement_id integer NOT NULL,
      created_at text NOT NULL, PRIMARY KEY (workspace_id, user_id, idempotency_key)
    );
    CREATE TABLE agreement_document_versions (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      version integer NOT NULL, label text NOT NULL, object_key text NOT NULL,
      content_type text NOT NULL, size integer NOT NULL, sha256 text NOT NULL,
      source_document_id text, created_by_user_id text NOT NULL, created_at text NOT NULL
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
  database.prepare(`INSERT INTO users (
    id, identity_provider, identity_subject, email, display_name, status,
    created_at, updated_at, last_seen_at
  ) VALUES (?, 'test', 'subject', 'alice@example.com', 'Alice Legal', 'active', '2026-01-01', '2026-01-01', '2026-01-01')`).run(USER_ID);
  database.prepare(`INSERT INTO workspace_memberships (
    workspace_id, user_id, role, status, created_at, updated_at
  ) VALUES ('workspace-a', ?, 'legal', 'active', '2026-01-01', '2026-01-01')`).run(USER_ID);
  return database;
}

type TemplateArtifact = Readonly<{
  body: string;
  variableSchema: Record<string, unknown>;
  contentSha256: string;
}>;

function insertPublishedTemplate(database: DatabaseSync, artifact: TemplateArtifact, workspaceId = "workspace-a"): void {
  database.prepare(`INSERT INTO governed_templates (
    id, workspace_id, version, name, description, agreement_type, side, status,
    current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, 2, 'Services approved', '', 'Services Agreement', 'Sell-side', 'published', 2, 'author', '2026-01-01', 'publisher', '2026-01-02')`).run(
    TEMPLATE_ID,
    workspaceId,
  );
  database.prepare(`INSERT INTO governed_template_versions (
    id, workspace_id, template_id, version, status, body, variable_schema,
    language_block_ids, content_sha256, change_summary, created_by_user_id,
    created_at, reviewed_by_user_id, reviewed_at
  ) VALUES (?, ?, ?, 2, 'published', ?, ?, '[]', ?, 'Approved', 'author', '2026-01-01', 'publisher', '2026-01-02')`).run(
    TEMPLATE_VERSION_ID,
    workspaceId,
    TEMPLATE_ID,
    artifact.body,
    JSON.stringify(artifact.variableSchema),
    artifact.contentSha256,
  );
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit } = {}): Response {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

type StoredObject = Readonly<{
  text: string;
  options: Readonly<Record<string, unknown>>;
}>;

function routeHarness(database: DatabaseSync) {
  const objects = new Map<string, StoredObject>();
  let putCalls = 0;
  const documents = {
    async put(key: string, value: ArrayBuffer | Uint8Array, options: Readonly<Record<string, unknown>>) {
      putCalls += 1;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { text: new TextDecoder().decode(bytes), options });
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  let eventSequence = 0;
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const fallback = new Proxy<Record<string, unknown>>({}, {
    get: (_target, property) => {
      throw new Error(`Unexpected agreement route dependency member: ${String(property)}`);
    },
  });
  const requireModule = (specifier: string): unknown => {
    if (specifier === "cloudflare:workers") return { env: { DOCUMENTS: documents } };
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "zod") return { z };
    if (specifier === "../../../db") return { getDb: () => db };
    if (specifier === "../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../db/schema") return schema;
    if (specifier === "../../lib/api") {
      return {
        authorizeApiRequest: async (_request: Request, permission: string) => ({
          ok: true,
          context: {
            workspace: { id: "workspace-a", name: "Notice, Inc." },
            user: { id: USER_ID, email: "alice@example.com", displayName: "Alice Legal" },
            permissions: new Set([permission]),
          },
          requestId: "request-create",
          headers: new Headers(),
        }),
        handleRouteError: (error: unknown) => { throw error; },
      };
    }
    if (specifier === "../../lib/document-security") return { sha256Hex };
    if (specifier === "../../lib/document-upload-idempotency") return { documentUploadKeyDigest: async () => "0".repeat(64) };
    if (specifier === "../../lib/http") {
      return {
        apiJson: responseJson,
        apiError: (code: string, message: string, options: { status: number; headers?: HeadersInit }) => responseJson({
          error: { code, message },
          requestId: "request-create",
        }, options),
      };
    }
    if (specifier === "../../lib/crm-selection") return { configuredCrmSelectionError: () => null };
    if (specifier === "../../lib/integration-events") {
      return {
        crmAgreementProjection: () => ({}),
        crmProviderForAgreementSelection: () => null,
        prepareAgreementDeletedIntegrationEvent: () => ({}),
        prepareIntegrationOutboxEvent: (input: Record<string, unknown>) => input,
      };
    }
    if (specifier === "../../lib/persistence") {
      return {
        findActiveAgreement: async () => null,
        isMutationGuardConflict: () => false,
        prepareAgreementEvent: async (_database: unknown, input: Record<string, unknown>) => ({
          id: `event-${++eventSequence}`,
          workspaceId: input.workspaceId,
          agreementId: input.agreementId,
          type: input.type,
          actorUserId: USER_ID,
          actorEmail: "alice@example.com",
          actor: "Alice Legal",
          detail: input.detail,
          previousHash: null,
          eventHash: "e".repeat(64),
          sequence: 1,
          sourceAgentPlanId: null,
          createdAt: input.createdAt,
        }),
        prepareAgreementSnapshot: async (record: Record<string, unknown>, userId: string, sourceEventId: string) => ({
          id: crypto.randomUUID(),
          workspaceId: record.workspaceId,
          agreementId: record.id,
          version: record.version,
          snapshot: record,
          sourceEventId,
          checksumSha256: "s".repeat(64),
          createdByUserId: userId,
          createdAt: record.createdAt,
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
          availableAt: "2026-01-01T00:00:00.000Z",
          lockedAt: null,
          processedAt: null,
          lastError: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      };
    }
    if (specifier === "../../lib/staged-object-cleanup") return { cleanupStagedWorkingVersionObject: async () => undefined };
    if (specifier === "../../lib/iso-date") return { validateAgreementDatePair: () => null };
    if (specifier === "../../lib/money") return { minorUnitsFromWholeUnits, wholeUnitProjection };
    if (specifier === "../../lib/governed-template-runtime") {
      return { GovernedTemplateRuntimeError, renderGovernedTemplate };
    }
    if (specifier === "../../lib/enterprise-domain") return { EnterpriseError };
    if (specifier === "../../lib/workflow-policy") return { governedWorkflowSnapshot };
    if (specifier === "../../lib/starter-draft") return { assembleStarterDraft };
    if (specifier === "../../lib/validation") {
      return { agreementDetailsPatchSchema, agreementMutationSchema, parseJson };
    }
    return fallback;
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
    btoa,
    atob,
    console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/agreements/route.cjs" }).runInContext(context);
  const post = moduleObject.exports.POST as (request: Request) => Promise<Response>;
  return {
    objects,
    get putCalls() { return putCalls; },
    async request(body: Record<string, unknown>, idempotencyKey = IDEMPOTENCY_KEY) {
      const response = await post(new Request("https://notice.test/api/agreements", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      }));
      return { response, body: await response.json() as Record<string, unknown> };
    },
  };
}

test("agreement creation snapshots the exact published governed workflow", async () => {
  const database = createAgreementDatabase();
  try {
    const definition = {
      schemaVersion: "1.0",
      approvalLanes: [
        { lane: "Legal" },
        { lane: "Finance", when: { currencyCodes: ["EUR"] } },
      ],
    } as const;
    const digest = await enterpriseContentDigest(definition);
    database.prepare(`INSERT INTO workflow_definitions (
      id, workspace_id, version, name, description, status, definition, definition_sha256,
      created_by_user_id, created_at, updated_by_user_id, updated_at, published_by_user_id, published_at
    ) VALUES (?, 'workspace-a', 1, 'EU commercial', '', 'published', ?, ?, 'author', '2026-01-01', 'publisher', '2026-01-02', 'publisher', '2026-01-02')`)
      .run(WORKFLOW_ID, JSON.stringify(definition), digest);
    const harness = routeHarness(database);
    const created = await harness.request({
      creationMode: "manual",
      party: "Euro Supplier",
      side: "Buy-side",
      type: "Supplier Agreement",
      valueMinor: 500_00,
      currencyCode: "EUR",
      owner: "ignored",
      workflowDefinitionId: WORKFLOW_ID,
      due: "2026-09-01",
      crm: "None",
      department: "Procurement",
    });
    assert.equal(created.response.status, 201);
    const agreement = created.body.agreement as Record<string, unknown>;
    assert.equal(agreement.workflowDefinitionId, WORKFLOW_ID);
    assert.equal(agreement.workflowPolicySha256, digest);
    assert.deepEqual(agreement.workflowApprovalLanes, ["Legal", "Finance"]);
    const stored = database.prepare("SELECT workflow_policy_sha256, workflow_approval_lanes FROM agreements").get() as Record<string, unknown>;
    assert.equal(stored.workflow_policy_sha256, digest);
    assert.deepEqual(JSON.parse(stored.workflow_approval_lanes as string), ["Legal", "Finance"]);
  } finally {
    database.close();
  }
});

function generatedInput(templateVariables: Record<string, string>): Record<string, unknown> {
  return {
    creationMode: "generated",
    party: "Acme Corp",
    side: "Sell-side",
    type: "Services Agreement",
    owner: "Caller-controlled name",
    governedTemplateVersionId: TEMPLATE_VERSION_ID,
    templateVariables,
    due: "2026-09-01",
    crm: "None",
    department: "Legal",
    effectiveDate: "2026-09-15",
    governingLaw: "Michigan",
  };
}

test("generated agreement renders the exact active version and replays canonically without rerendering", async () => {
  const database = createAgreementDatabase();
  try {
    const variableSchema = {
      version: 1,
      variables: {
        organization: { type: "string", source: "system", required: true, maxLength: 200 },
        party: { type: "string", source: "agreement", required: true, maxLength: 200 },
        effectiveDate: { type: "string", source: "agreement", required: true, maxLength: 10 },
        projectCode: { type: "string", source: "input", required: true, maxLength: 40 },
        region: { type: "string", source: "input", required: true, maxLength: 40 },
      },
    };
    const templateBody = "Agreement between {{organization}} and {{party}} effective {{effectiveDate}}. {{projectCode}} / {{region}}.";
    const contentSha256 = await governedTemplateContentDigest({ body: templateBody, variableSchema, languageBlockIds: [] });
    insertPublishedTemplate(database, { body: templateBody, variableSchema, contentSha256 });
    const harness = routeHarness(database);

    const first = await harness.request(generatedInput({ region: "US", projectCode: "PROJECT-7" }));
    assert.equal(first.response.status, 201);
    assert.equal(first.response.headers.get("idempotency-replayed"), "false");
    const agreement = first.body.agreement as Record<string, unknown>;
    const documentVersion = first.body.documentVersion as Record<string, unknown>;
    assert.equal(agreement.governedTemplateVersionId, TEMPLATE_VERSION_ID);
    assert.equal(agreement.owner, "Alice Legal", "the selected member, not caller text, owns the agreement");
    assert.equal(agreement.workflowPolicySha256, null);
    assert.equal(agreement.workflowApprovalLanes, null);
    assert.equal(documentVersion.label, "Generated governed template v2");
    assert.equal(harness.objects.size, 1);
    const stored = [...harness.objects.values()][0];
    assert.equal(stored.text, "Agreement between Notice, Inc. and Acme Corp effective 2026-09-15. PROJECT-7 / US.");
    assert.deepEqual({ ...(stored.options.customMetadata as Record<string, unknown>) }, {
      agreementId: String(agreement.id),
      version: "1",
      sha256: documentVersion.sha256,
      source: "governed-template",
      governedTemplateVersionId: TEMPLATE_VERSION_ID,
    });

    database.prepare("UPDATE governed_templates SET status = 'retired'").run();
    database.prepare("UPDATE governed_template_versions SET body = 'tampered after commit'").run();
    const replay = await harness.request(generatedInput({ projectCode: "PROJECT-7", region: "US" }));
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.body.replay, true);
    assert.equal(harness.putCalls, 1, "an identical retry returns the committed artifact without rendering or writing again");

    const conflict = await harness.request(generatedInput({ projectCode: "CHANGED", region: "US" }));
    assert.equal(conflict.response.status, 409);
    assert.equal((conflict.body.error as Record<string, unknown>).code, "idempotency_key_conflict");
    assert.equal(harness.putCalls, 1);
  } finally {
    database.close();
  }
});

test("generated agreement rejects inactive, mismatched, cross-tenant, and corrupt governed artifacts", async () => {
  const cases: Array<Readonly<{
    name: string;
    prepare: (database: DatabaseSync, artifact: TemplateArtifact) => void;
    mutateInput?: (input: Record<string, unknown>) => void;
    expectedCode: string;
  }>> = [
    {
      name: "inactive parent",
      prepare: (database, artifact) => {
        insertPublishedTemplate(database, artifact);
        database.prepare("UPDATE governed_templates SET status = 'retired'").run();
      },
      expectedCode: "template_version_not_published",
    },
    {
      name: "non-current version",
      prepare: (database, artifact) => {
        insertPublishedTemplate(database, artifact);
        database.prepare("UPDATE governed_templates SET current_published_version = 3").run();
      },
      expectedCode: "template_version_not_published",
    },
    {
      name: "cross-tenant artifact",
      prepare: (database, artifact) => insertPublishedTemplate(database, artifact, "workspace-b"),
      expectedCode: "template_version_not_published",
    },
    {
      name: "side mismatch",
      prepare: (database, artifact) => insertPublishedTemplate(database, artifact),
      mutateInput: (input) => { input.side = "Buy-side"; },
      expectedCode: "template_agreement_mismatch",
    },
    {
      name: "digest mismatch",
      prepare: (database, artifact) => {
        insertPublishedTemplate(database, artifact);
        database.prepare("UPDATE governed_template_versions SET body = 'tampered'").run();
      },
      expectedCode: "template_digest_mismatch",
    },
  ];

  const variableSchema = {
    version: 1,
    variables: {
      organization: { type: "string", source: "system", required: true, maxLength: 200 },
      projectCode: { type: "string", source: "input", required: true, maxLength: 40 },
    },
  };
  const body = "{{organization}} / {{projectCode}}";
  const contentSha256 = await governedTemplateContentDigest({ body, variableSchema, languageBlockIds: [] });
  const artifact = { body, variableSchema, contentSha256 };

  for (const [index, scenario] of cases.entries()) {
    const database = createAgreementDatabase();
    try {
      scenario.prepare(database, artifact);
      const harness = routeHarness(database);
      const input = generatedInput({ projectCode: "PROJECT-7" });
      scenario.mutateInput?.(input);
      const result = await harness.request(input, `eeeeeeee-eeee-4eee-8eee-${String(index + 1).padStart(12, "0")}`);
      assert.equal(result.response.status, scenario.expectedCode === "template_digest_mismatch" ? 409 : 400, scenario.name);
      assert.equal((result.body.error as Record<string, unknown>).code, scenario.expectedCode, scenario.name);
      assert.equal(harness.putCalls, 0, scenario.name);
    } finally {
      database.close();
    }
  }
});

test("template variables are bounded, generated-only, and canonicalized for receipt hashing", () => {
  const first = agreementMutationSchema.parse(generatedInput({ region: "US", projectCode: "PROJECT-7" }));
  const second = agreementMutationSchema.parse(generatedInput({ projectCode: "PROJECT-7", region: "US" }));
  assert.deepEqual(first.templateVariables, { projectCode: "PROJECT-7", region: "US" });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(agreementMutationSchema.safeParse({
    ...generatedInput({ projectCode: "PROJECT-7" }),
    creationMode: "manual",
  }).success, false);
  assert.equal(agreementMutationSchema.safeParse({
    ...generatedInput({ projectCode: "PROJECT-7" }),
    governedTemplateVersionId: undefined,
  }).success, false);
  assert.equal(agreementMutationSchema.safeParse(generatedInput({
    projectCode: "x".repeat(4_001),
  })).success, false);
});

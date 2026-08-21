import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import ts from "typescript";
import * as configurationCreationIdempotency from "../app/lib/configuration-creation-idempotency";
import * as enterpriseDomain from "../app/lib/enterprise-domain";
import * as enterpriseValidation from "../app/lib/enterprise-validation";
import * as governedTemplateRuntime from "../app/lib/governed-template-runtime";
import * as repositoryIntelligence from "../app/lib/repository-intelligence";
import * as requestValidation from "../app/lib/validation";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "workspace-atomic";
const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const PUBLISHER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-20T12:00:00.000Z";
const migrationNames = readdirSync(new URL("../drizzle/", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

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
  async raw<T extends unknown[]>() { return sqliteD1RawRows<T>(this.database, this.query, this.bindings); }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(query: string) { return new SqliteD1Statement(this.database, query); }
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames) {
    const sql = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
  database.prepare(`INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
    VALUES (?, 'atomic', 'Atomic Workspace', 'active', ?, ?)`).run(WORKSPACE_ID, NOW, NOW);
  const user = database.prepare(`INSERT INTO users (
    id, identity_provider, identity_subject, email, display_name, status,
    created_at, updated_at, last_seen_at
  ) VALUES (?, 'test', ?, ?, ?, 'active', ?, ?, ?)`);
  user.run(CREATOR_ID, CREATOR_ID, "creator@example.test", "Creator Admin", NOW, NOW, NOW);
  user.run(PUBLISHER_ID, PUBLISHER_ID, "publisher@example.test", "Publisher Admin", NOW, NOW, NOW);
  return database;
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit } = {}): Response {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function errorJson(code: string, message: string, status: number, requestId: string, headers?: HeadersInit): Response {
  return responseJson({ error: { code, message }, requestId }, { status, headers });
}

type MutationInput = Readonly<{
  workspaceId: string;
  actor: { id: string; email: string; displayName: string };
  type: string;
  detail: Readonly<Record<string, unknown>>;
  steps: Array<{ statement: PromiseLike<unknown>; guardOperation?: string }>;
  createdAt?: string;
}>;

type AtomicRouteKind = "template" | "playbook";

function routeHarness(database: DatabaseSync, kind: AtomicRouteKind) {
  const databaseClient = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  let userId = CREATOR_ID;
  let failAfterStep: number | null = null;
  let commitAsConcurrentWinner = false;

  const appendAuditEvent = (input: MutationInput) => {
    const previous = database.prepare(`SELECT sequence, event_hash FROM workspace_events
      WHERE workspace_id = ? ORDER BY sequence DESC LIMIT 1`).get(input.workspaceId) as { sequence: number; event_hash: string } | undefined;
    const sequence = (previous?.sequence ?? 0) + 1;
    database.prepare(`INSERT INTO workspace_events (
      id, workspace_id, sequence, type, actor_user_id, actor_email, actor,
      subject_user_id, subject_email, detail, previous_hash, event_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`).run(
      crypto.randomUUID(), input.workspaceId, sequence, input.type,
      input.actor.id, input.actor.email, input.actor.displayName,
      JSON.stringify(input.detail), previous?.event_hash ?? null,
      sequence.toString(16).padStart(64, "0"), input.createdAt ?? NOW,
    );
  };

  const commitMutation = async (input: MutationInput) => {
    database.exec("BEGIN");
    try {
      let stepNumber = 0;
      for (const step of input.steps) {
        stepNumber += 1;
        const result = await step.statement as { meta?: { changes?: number } };
        if (step.guardOperation && result.meta?.changes !== 1) {
          throw new Error("CHECK constraint failed: ck_mutation_guards_changes");
        }
        if (failAfterStep === stepNumber) throw new Error("simulated atomic batch failure");
      }
      appendAuditEvent(input);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      failAfterStep = null;
    }
  };

  const sourceUrl = kind === "template"
    ? new URL("../app/api/admin/configuration/templates/route.ts", import.meta.url)
    : new URL("../app/api/admin/configuration/playbooks/route.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourceUrl.pathname,
  }).outputText;
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "../../../../../db") return { getDb: () => databaseClient };
    if (specifier === "../../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../../db/schema") return schema;
    if (specifier === "../../../../lib/api") return {
      authorizeApiRequest: async () => ({
        ok: true,
        context: {
          workspace: { id: WORKSPACE_ID, name: "Atomic Workspace" },
          user: { id: userId, email: `${userId}@example.test`, displayName: userId === CREATOR_ID ? "Creator Admin" : "Publisher Admin" },
          role: "admin",
        },
        requestId: `request-${kind}`,
        headers: new Headers(),
      }),
      handleRouteError: (error: unknown, requestId: string, publicMessage: string) => error instanceof requestValidation.RequestValidationError
        ? errorJson(error.code, error.message, error.status, requestId)
        : errorJson(
            "internal_error",
            publicMessage || (error instanceof Error ? error.message : "Internal error"),
            500,
            requestId,
          ),
    };
    if (specifier === "../../../../lib/configuration-creation-idempotency") return configurationCreationIdempotency;
    if (specifier === "../../../../lib/enterprise-api") return {
      executeEnterpriseMutation: async (_db: unknown, input: MutationInput) => {
        if (commitAsConcurrentWinner) {
          commitAsConcurrentWinner = false;
          await commitMutation(input);
          throw new Error("UNIQUE constraint failed: concurrent idempotency receipt");
        }
        await commitMutation(input);
      },
      parseEnterpriseListQuery: () => ({ limit: 100 }),
      enterpriseRouteError: (error: unknown, requestId: string, headers: Headers) => {
        if (error instanceof enterpriseDomain.EnterpriseError) {
          return errorJson(error.code, error.message, error.status, requestId, headers);
        }
        if (error instanceof requestValidation.RequestValidationError) {
          return errorJson(error.code, error.message, error.status, requestId, headers);
        }
        return errorJson("internal_error", "The governed template mutation could not be completed.", 500, requestId, headers);
      },
    };
    if (specifier === "../../../../lib/enterprise-domain") return enterpriseDomain;
    if (specifier === "../../../../lib/enterprise-validation") return enterpriseValidation;
    if (specifier === "../../../../lib/governed-template-runtime") return governedTemplateRuntime;
    if (specifier === "../../../../lib/repository-intelligence") return repositoryIntelligence;
    if (specifier === "../../../../lib/http") return {
      apiJson: responseJson,
      apiError: (code: string, message: string, options: { status: number; requestId: string; headers?: HeadersInit }) => errorJson(code, message, options.status, options.requestId, options.headers),
    };
    if (specifier === "../../../../lib/persistence") return {
      isMutationGuardConflict: (error: unknown) => String(error).includes("ck_mutation_guards_changes"),
    };
    if (specifier === "../../../../lib/validation") return requestValidation;
    throw new Error(`Unexpected ${kind} route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto, console,
  });
  new vm.Script(compiled, { filename: `${kind}-route.cjs` }).runInContext(context);
  const post = moduleObject.exports.POST as (request: Request) => Promise<Response>;
  const patch = moduleObject.exports.PATCH as (request: Request) => Promise<Response>;

  const call = async (handler: (request: Request) => Promise<Response>, method: "POST" | "PATCH", body: unknown, key?: string) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (key) headers.set("idempotency-key", key);
    const response = await handler(new Request(`https://notice.test/api/admin/configuration/${kind}s`, {
      method,
      headers,
      body: JSON.stringify(body),
    }));
    return { response, body: await response.json() as Record<string, unknown> };
  };

  return {
    post: (body: unknown, key?: string) => call(post, "POST", body, key),
    patch: (body: unknown) => call(patch, "PATCH", body),
    setUser(next: string) { userId = next; },
    failAfter(next: number) { failAfterStep = next; },
    simulateConcurrentWinner() { commitAsConcurrentWinner = true; },
  };
}

const TEMPLATE_VARIABLES = {
  version: 1,
  variables: {
    party: { type: "string", source: "agreement", required: true, maxLength: 500 },
  },
};

function templateRequest(name = "Atomic services paper") {
  return {
    action: "create_with_version",
    name,
    description: "One governed identity and immutable first draft",
    agreementType: "Services Agreement",
    side: "Sell-side",
    body: "Services agreement for {{party}}",
    variableSchema: TEMPLATE_VARIABLES,
    languageBlockIds: [],
    changeSummary: "Initial governed version",
  };
}

function playbookRequest(name = "Atomic liability position") {
  return {
    action: "create_with_version",
    name,
    description: "One governed scope and immutable first position",
    scope: { agreementTypes: ["Services Agreement"], sides: ["Sell-side"], jurisdictions: ["New York"] },
    rules: { clauses: [{
      key: "liability.cap",
      title: "Liability cap",
      category: "Risk",
      position: "preferred",
      preferredText: "Liability is capped at fees paid in the preceding twelve months.",
      alternatives: [],
      reviewGuidance: "Escalate uncapped exposure.",
      risk: "high",
    }] },
    changeSummary: "Initial governed position",
  };
}

test("parent-only configuration creation is retired while version repair and revision remain supported", () => {
  assert.equal(enterpriseValidation.templatePostSchema.safeParse({
    action: "create_template",
    name: "Unsafe empty template",
    description: "",
    agreementType: "Services Agreement",
    side: "Sell-side",
  }).success, false);
  assert.equal(repositoryIntelligence.playbookPostSchema.safeParse({
    action: "create_playbook",
    name: "Unsafe empty playbook",
    description: "",
    scope: { agreementTypes: [], sides: [], jurisdictions: [] },
  }).success, false);

  assert.equal(enterpriseValidation.templatePostSchema.safeParse({
    action: "create_version",
    templateId: "33333333-3333-4333-8333-333333333333",
    templateVersion: 1,
    body: "Services agreement for {{party}}",
    variableSchema: TEMPLATE_VARIABLES,
    languageBlockIds: [],
    changeSummary: "Repair or revise governed paper",
  }).success, true);
  assert.equal(repositoryIntelligence.playbookPostSchema.safeParse({
    action: "create_version",
    playbookId: "44444444-4444-4444-8444-444444444444",
    playbookVersion: 1,
    rules: playbookRequest().rules,
    changeSummary: "Repair or revise governed positions",
  }).success, true);
});

test("configuration routes reject parent-only creation and retain version-one repair plus later revision", async () => {
  const database = createDatabase();
  try {
    const templateHarness = routeHarness(database, "template");
    const playbookHarness = routeHarness(database, "playbook");
    const rejectedTemplate = await templateHarness.post({
      action: "create_template",
      name: "Unsafe empty template",
      description: "",
      agreementType: "Services Agreement",
      side: "Sell-side",
    });
    assert.equal(rejectedTemplate.response.status, 400);
    assert.equal((rejectedTemplate.body.error as { code: string }).code, "validation_failed");
    const rejectedPlaybook = await playbookHarness.post({
      action: "create_playbook",
      name: "Unsafe empty playbook",
      description: "",
      scope: { agreementTypes: [], sides: [], jurisdictions: [] },
    });
    assert.equal(rejectedPlaybook.response.status, 400);
    assert.equal((rejectedPlaybook.body.error as { code: string }).code, "validation_failed");
    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_templates").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbooks").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count, 0);

    const templateId = "55555555-5555-4555-8555-555555555555";
    const playbookId = "66666666-6666-4666-8666-666666666666";
    database.prepare(`INSERT INTO governed_templates (
      id, workspace_id, version, name, description, agreement_type, side, status,
      current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at
    ) VALUES (?, ?, 1, 'Earlier draft template', '', 'Services Agreement', 'Sell-side', 'draft', NULL, ?, ?, ?, ?)`)
      .run(templateId, WORKSPACE_ID, CREATOR_ID, NOW, CREATOR_ID, NOW);
    database.prepare(`INSERT INTO clause_playbooks (
      id, workspace_id, version, name, description, scope, status,
      current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at
    ) VALUES (?, ?, 1, 'Earlier draft playbook', '', ?, 'draft', NULL, ?, ?, ?, ?)`)
      .run(
        playbookId,
        WORKSPACE_ID,
        JSON.stringify({ agreementTypes: ["Services Agreement"], sides: ["Sell-side"], jurisdictions: [] }),
        CREATOR_ID,
        NOW,
        CREATOR_ID,
        NOW,
      );

    const repairedTemplate = await templateHarness.post({
      action: "create_version",
      templateId,
      templateVersion: 1,
      body: "Services agreement for {{party}}",
      variableSchema: TEMPLATE_VARIABLES,
      languageBlockIds: [],
      changeSummary: "Create the missing governed version",
    });
    assert.equal(repairedTemplate.response.status, 201, JSON.stringify(repairedTemplate.body));
    assert.equal((repairedTemplate.body.templateVersion as { version: number }).version, 1);
    assert.equal(repairedTemplate.body.templateVersionToken, 2);
    const revisedTemplate = await templateHarness.post({
      action: "create_version",
      templateId,
      templateVersion: 2,
      body: "Updated services agreement for {{party}}",
      variableSchema: TEMPLATE_VARIABLES,
      languageBlockIds: [],
      changeSummary: "Add a later governed revision",
    });
    assert.equal(revisedTemplate.response.status, 201, JSON.stringify(revisedTemplate.body));
    assert.equal((revisedTemplate.body.templateVersion as { version: number }).version, 2);
    assert.equal(revisedTemplate.body.templateVersionToken, 3);

    const repairedPlaybook = await playbookHarness.post({
      action: "create_version",
      playbookId,
      playbookVersion: 1,
      rules: playbookRequest().rules,
      changeSummary: "Create the missing governed version",
    });
    assert.equal(repairedPlaybook.response.status, 201, JSON.stringify(repairedPlaybook.body));
    assert.equal((repairedPlaybook.body.playbookVersion as { version: number }).version, 1);
    assert.equal(repairedPlaybook.body.playbookVersionToken, 2);
    const revisedPlaybook = await playbookHarness.post({
      action: "create_version",
      playbookId,
      playbookVersion: 2,
      rules: playbookRequest().rules,
      changeSummary: "Add a later governed revision",
    });
    assert.equal(revisedPlaybook.response.status, 201, JSON.stringify(revisedPlaybook.body));
    assert.equal((revisedPlaybook.body.playbookVersion as { version: number }).version, 2);
    assert.equal(revisedPlaybook.body.playbookVersionToken, 3);

    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_template_versions WHERE template_id = ?").get(templateId)?.count, 2);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbook_versions WHERE playbook_id = ?").get(playbookId)?.count, 2);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count, 4);
  } finally {
    database.close();
  }
});

test("initial governed-template creation is atomic, replayable, conflict-safe, and independently publishable", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database, "template");
    const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const missingKey = await harness.post(templateRequest());
    assert.equal(missingKey.response.status, 400);
    assert.equal((missingKey.body.error as { code: string }).code, "idempotency_key_required");
    const nonCanonicalKey = await harness.post(templateRequest(), "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
    assert.equal(nonCanonicalKey.response.status, 400);
    assert.equal((nonCanonicalKey.body.error as { code: string }).code, "invalid_idempotency_key");

    const created = await harness.post(templateRequest(), key);
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.response.headers.get("Idempotency-Replayed"), "false");
    const template = created.body.template as { id: string; version: number; createdByUserId: string };
    const version = created.body.templateVersion as { id: string; templateId: string; version: number; createdByUserId: string };
    assert.equal(template.version, 1);
    assert.equal(version.version, 1);
    assert.equal(version.templateId, template.id);
    assert.equal(template.createdByUserId, CREATOR_ID);
    assert.equal(version.createdByUserId, CREATOR_ID);
    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_templates").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_template_versions").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_template_creation_receipts").get()?.count, 1);
    const receipt = database.prepare("SELECT idempotency_key_sha256, request_sha256 FROM governed_template_creation_receipts").get() as Record<string, string>;
    assert.equal(receipt.idempotency_key_sha256.length, 64);
    assert.notEqual(receipt.idempotency_key_sha256, key);
    assert.equal(receipt.request_sha256.length, 64);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workspace_events WHERE type = 'GovernedTemplateInitialized'").get()?.count, 1);

    const replay = await harness.post(templateRequest(), key);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal((replay.body.template as { id: string }).id, template.id);
    assert.equal((replay.body.templateVersion as { id: string }).id, version.id);
    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_templates").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count, 1);

    const mismatch = await harness.post({ ...templateRequest(), description: "Different paper" }, key);
    assert.equal(mismatch.response.status, 409);
    assert.equal((mismatch.body.error as { code: string }).code, "idempotency_key_conflict");

    const creatorPublish = await harness.patch({
      action: "publish_version", templateId: template.id, templateVersion: 1, versionId: version.id,
      confirmed: true, reason: "Reviewed the exact immutable template digest",
    });
    assert.equal(creatorPublish.response.status, 409);
    assert.equal((creatorPublish.body.error as { code: string }).code, "independent_review_required");
    harness.setUser(PUBLISHER_ID);
    const published = await harness.patch({
      action: "publish_version", templateId: template.id, templateVersion: 1, versionId: version.id,
      confirmed: true, reason: "Reviewed the exact immutable template digest",
    });
    assert.equal(published.response.status, 200, JSON.stringify(published.body));

    const beforeConcurrentEvents = Number(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count);
    harness.setUser(CREATOR_ID);
    harness.simulateConcurrentWinner();
    const concurrent = await harness.post(templateRequest("Concurrent template"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
    assert.equal(concurrent.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_templates WHERE name = 'Concurrent template'").get()?.count, 1);
    assert.equal(Number(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count), beforeConcurrentEvents + 1);

    const beforeRollbackEvents = Number(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count);
    harness.failAfter(1);
    const failed = await harness.post(templateRequest("Rolled back template"), "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert.equal(failed.response.status, 500);
    assert.equal(database.prepare("SELECT count(*) AS count FROM governed_templates WHERE name = 'Rolled back template'").get()?.count, 0);
    assert.equal(Number(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count), beforeRollbackEvents);
  } finally {
    database.close();
  }
});

test("initial clause-playbook creation is atomic, replayable, conflict-safe, and independently publishable", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database, "playbook");
    const key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const created = await harness.post(playbookRequest(), key);
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.response.headers.get("Idempotency-Replayed"), "false");
    const playbook = created.body.playbook as { id: string; version: number; createdByUserId: string };
    const version = created.body.playbookVersion as { id: string; playbookId: string; version: number; createdByUserId: string };
    assert.equal(playbook.version, 1);
    assert.equal(version.version, 1);
    assert.equal(version.playbookId, playbook.id);
    assert.equal(playbook.createdByUserId, CREATOR_ID);
    assert.equal(version.createdByUserId, CREATOR_ID);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbooks").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbook_versions").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbook_creation_receipts").get()?.count, 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workspace_events WHERE type = 'ClausePlaybookInitialized'").get()?.count, 1);

    const replay = await harness.post(playbookRequest(), key);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal((replay.body.playbook as { id: string }).id, playbook.id);
    assert.equal((replay.body.playbookVersion as { id: string }).id, version.id);
    const mismatch = await harness.post({ ...playbookRequest(), changeSummary: "Different governed material" }, key);
    assert.equal(mismatch.response.status, 409);
    assert.equal((mismatch.body.error as { code: string }).code, "idempotency_key_conflict");

    const creatorPublish = await harness.patch({
      action: "publish_version", playbookId: playbook.id, playbookVersion: 1, versionId: version.id,
      reason: "Reviewed exact clause position",
    });
    assert.equal(creatorPublish.response.status, 409);
    assert.equal((creatorPublish.body.error as { code: string }).code, "independent_publisher_required");
    harness.setUser(PUBLISHER_ID);
    const published = await harness.patch({
      action: "publish_version", playbookId: playbook.id, playbookVersion: 1, versionId: version.id,
      reason: "Reviewed exact clause position",
    });
    assert.equal(published.response.status, 200, JSON.stringify(published.body));

    harness.setUser(CREATOR_ID);
    harness.simulateConcurrentWinner();
    const concurrent = await harness.post(playbookRequest("Concurrent playbook"), "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
    assert.equal(concurrent.response.headers.get("Idempotency-Replayed"), "true");
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbooks WHERE name = 'Concurrent playbook'").get()?.count, 1);

    const beforeRollbackEvents = Number(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count);
    harness.failAfter(2);
    const failed = await harness.post(playbookRequest("Rolled back playbook"), "ffffffff-ffff-4fff-8fff-ffffffffffff");
    assert.equal(failed.response.status, 500);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbooks WHERE name = 'Rolled back playbook'").get()?.count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM clause_playbook_versions WHERE playbook_id NOT IN (SELECT id FROM clause_playbooks)").get()?.count, 0);
    assert.equal(Number(database.prepare("SELECT count(*) AS count FROM workspace_events").get()?.count), beforeRollbackEvents);
  } finally {
    database.close();
  }
});

test("schema 20 binds immutable creation receipts to the exact creator-owned first version", () => {
  const database = createDatabase();
  try {
    database.prepare(`INSERT INTO governed_templates (
      id, workspace_id, version, name, description, agreement_type, side, status,
      current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at
    ) VALUES ('template-direct', ?, 1, 'Direct', '', 'NDA', 'Sell-side', 'draft', NULL, ?, ?, ?, ?)`)
      .run(WORKSPACE_ID, CREATOR_ID, NOW, CREATOR_ID, NOW);
    database.prepare(`INSERT INTO governed_template_versions (
      id, workspace_id, template_id, version, status, body, variable_schema,
      language_block_ids, content_sha256, change_summary, created_by_user_id, created_at,
      reviewed_by_user_id, reviewed_at
    ) VALUES ('template-direct-v1', ?, 'template-direct', 1, 'draft', 'Body', ?, '[]', ?, 'Initial', ?, ?, NULL, NULL)`)
      .run(WORKSPACE_ID, JSON.stringify({ version: 1, variables: {} }), "a".repeat(64), CREATOR_ID, NOW);
    assert.throws(() => database.prepare(`INSERT INTO governed_template_creation_receipts (
      workspace_id, user_id, idempotency_key_sha256, request_sha256, template_id, template_version_id, created_at
    ) VALUES (?, ?, ?, ?, 'template-direct', 'template-direct-v1', ?)`)
      .run(WORKSPACE_ID, PUBLISHER_ID, "b".repeat(64), "c".repeat(64), NOW), /invalid_governed_template_creation_receipt/);
    database.prepare(`INSERT INTO governed_template_creation_receipts (
      workspace_id, user_id, idempotency_key_sha256, request_sha256, template_id, template_version_id, created_at
    ) VALUES (?, ?, ?, ?, 'template-direct', 'template-direct-v1', ?)`)
      .run(WORKSPACE_ID, CREATOR_ID, "d".repeat(64), "e".repeat(64), NOW);
    assert.throws(
      () => database.prepare("UPDATE governed_template_creation_receipts SET request_sha256 = ?").run("f".repeat(64)),
      /immutable_governed_template_creation_receipt/,
    );
  } finally {
    database.close();
  }
});

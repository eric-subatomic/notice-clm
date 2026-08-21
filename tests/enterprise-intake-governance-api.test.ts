import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import ts from "typescript";
import * as schema from "../db/schema";
import * as enterpriseDomain from "../app/lib/enterprise-domain";
import * as enterpriseReferences from "../app/lib/enterprise-references";
import * as enterpriseValidation from "../app/lib/enterprise-validation";

const routeSource = await readFile(new URL("../app/api/admin/configuration/intake-forms/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/admin/configuration/intake-forms/route.ts",
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
    return this.database.prepare(this.query).all(...this.bindings).map((row) => Object.values(row) as T);
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(query: string) { return new SqliteD1Statement(this.database, query); }
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
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
      form_version integer NOT NULL, status text NOT NULL, agreement_id integer
    );
  `);
  return database;
}

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const FORM_ID = "33333333-3333-4333-8333-333333333333";
const formSchema = {
  fields: [{ key: "request_name", label: "Request name", type: "text", required: true, options: [] }],
};

function seedTemplate(database: DatabaseSync, workspaceId = "workspace-a") {
  database.prepare(`INSERT INTO governed_templates (
    id, workspace_id, version, name, description, agreement_type, side, status,
    current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, 4, 'NDA', '', 'NDA', 'Corporate', 'published', 7,
    'template-author', '2026-08-20T00:00:00.000Z', 'template-reviewer', '2026-08-20T00:00:00.000Z')`)
    .run(TEMPLATE_ID, workspaceId);
  database.prepare(`INSERT INTO governed_template_versions (
    id, workspace_id, template_id, version, status, body, variable_schema,
    language_block_ids, content_sha256, change_summary, created_by_user_id,
    created_at, reviewed_by_user_id, reviewed_at
  ) VALUES (?, ?, ?, 7, 'published', 'NDA body', '{}', '[]', ?, 'Published',
    'template-author', '2026-08-20T00:00:00.000Z', 'template-reviewer', '2026-08-20T00:00:00.000Z')`)
    .run(TEMPLATE_VERSION_ID, workspaceId, TEMPLATE_ID, "a".repeat(64));
}

function seedDraftForm(database: DatabaseSync, input: { id?: string; workspaceId?: string; templateId?: string; createdBy?: string } = {}) {
  database.prepare(`INSERT INTO intake_forms (
    id, workspace_id, version, name, description, status, form_schema,
    template_id, template_version_id, workflow_definition_id,
    created_by_user_id, created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, 2, 'NDA request', '', 'draft', ?, ?, NULL, NULL, ?,
    '2026-08-20T00:00:00.000Z', ?, '2026-08-20T00:00:00.000Z')`)
    .run(
      input.id ?? FORM_ID,
      input.workspaceId ?? "workspace-a",
      JSON.stringify(formSchema),
      input.templateId ?? TEMPLATE_ID,
      input.createdBy ?? "form-author",
      input.createdBy ?? "form-author",
    );
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit; requestId?: string } = {}) {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function routeHarness(database: DatabaseSync) {
  let userId = "form-reviewer";
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "../../../../../db") return { getDb: () => db };
    if (specifier === "../../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../../db/schema") return schema;
    if (specifier === "../../../../lib/enterprise-domain") return {
      ...enterpriseDomain,
      enterpriseContentDigest: (value: unknown, maxBytes?: number) => enterpriseDomain.enterpriseContentDigest(
        JSON.parse(JSON.stringify(value)) as unknown,
        maxBytes,
      ),
    };
    if (specifier === "../../../../lib/enterprise-references") return enterpriseReferences;
    if (specifier === "../../../../lib/enterprise-validation") return enterpriseValidation;
    if (specifier === "../../../../lib/api") return {
      authorizeApiRequest: async () => ({
        ok: true,
        context: {
          workspace: { id: "workspace-a", name: "workspace-a" },
          user: { id: userId, email: `${userId}@example.test`, displayName: userId },
          role: "admin",
        },
        requestId: "request-form-publish",
        headers: new Headers(),
      }),
    };
    if (specifier === "../../../../lib/enterprise-api") return {
      parseEnterpriseListQuery: () => ({ limit: 100 }),
      executeEnterpriseMutation: async (_db: unknown, input: { steps: Array<{ statement: PromiseLike<unknown> }> }) => {
        database.exec("BEGIN");
        try {
          for (const step of input.steps) await step.statement;
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
      enterpriseRouteError: (error: unknown, requestId: string, headers: Headers) => {
        if (error instanceof enterpriseDomain.EnterpriseError) {
          return responseJson({ error: { code: error.code, message: error.message }, requestId }, { status: error.status, headers });
        }
        throw error;
      },
    };
    if (specifier === "../../../../lib/http") return { apiJson: responseJson };
    if (specifier === "../../../../lib/validation") return {
      parseJson: async (request: Request, validationSchema: { parse(value: unknown): unknown }) => validationSchema.parse(await request.json()),
    };
    throw new Error(`Unexpected intake-form route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto, console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/admin/configuration/intake-forms/route.cjs" }).runInContext(context);
  const patch = moduleObject.exports.PATCH as (request: Request) => Promise<Response>;
  return {
    setUser(nextUserId: string) { userId = nextUserId; },
    async publish(id = FORM_ID) {
      const response = await patch(new Request("https://notice.test/api/admin/configuration/intake-forms", {
        method: "PATCH",
        body: JSON.stringify({ action: "publish", id, version: 2, confirmed: true, reason: "Reviewed for controlled release" }),
        headers: { "content-type": "application/json" },
      }));
      return { response, body: await response.json() as Record<string, unknown> };
    },
    async retire(version = 3, id = FORM_ID) {
      const response = await patch(new Request("https://notice.test/api/admin/configuration/intake-forms", {
        method: "PATCH",
        body: JSON.stringify({ action: "retire", id, version, confirmed: true, reason: "Retire after the request queue is clear" }),
        headers: { "content-type": "application/json" },
      }));
      return { response, body: await response.json() as Record<string, unknown> };
    },
  };
}

test("intake publication atomically pins the exact current published template version", async () => {
  const database = createDatabase();
  try {
    seedTemplate(database);
    seedDraftForm(database);
    const harness = routeHarness(database);
    const published = await harness.publish();
    assert.equal(published.response.status, 200, JSON.stringify(published.body));
    const responseForm = published.body.intakeForm as { status: string; templateVersionId: string; contentSha256: string };
    assert.equal(responseForm.status, "published");
    assert.equal(responseForm.templateVersionId, TEMPLATE_VERSION_ID);
    assert.match(responseForm.contentSha256, /^[a-f0-9]{64}$/);
    const row = database.prepare("SELECT status, template_version_id FROM intake_forms WHERE id = ?").get(FORM_ID);
    assert.equal(row?.status, "published");
    assert.equal(row?.template_version_id, TEMPLATE_VERSION_ID);

    database.prepare("UPDATE governed_templates SET current_published_version = 8 WHERE id = ?").run(TEMPLATE_ID);
    assert.equal(database.prepare("SELECT template_version_id FROM intake_forms WHERE id = ?").get(FORM_ID)?.template_version_id, TEMPLATE_VERSION_ID);
  } finally {
    database.close();
  }
});

test("intake publication rejects creator self-review and cross-tenant template references", async () => {
  const database = createDatabase();
  try {
    seedTemplate(database, "workspace-b");
    seedDraftForm(database);
    const harness = routeHarness(database);
    const invalidReference = await harness.publish();
    assert.equal(invalidReference.response.status, 422);
    assert.equal((invalidReference.body.error as { code: string }).code, "published_template_required");

    database.prepare("DELETE FROM governed_template_versions").run();
    database.prepare("DELETE FROM governed_templates").run();
    seedTemplate(database, "workspace-a");
    harness.setUser("form-author");
    const selfReview = await harness.publish();
    assert.equal(selfReview.response.status, 409);
    assert.equal((selfReview.body.error as { code: string }).code, "independent_review_required");
  } finally {
    database.close();
  }
});

test("intake retirement preserves every submitted request until it is converted or resolved", async () => {
  const database = createDatabase();
  try {
    seedTemplate(database);
    seedDraftForm(database);
    const harness = routeHarness(database);
    const published = await harness.publish();
    assert.equal(published.response.status, 200, JSON.stringify(published.body));
    database.prepare(`INSERT INTO intake_submissions (
      id, workspace_id, form_id, form_version, status, agreement_id
    ) VALUES ('44444444-4444-4444-8444-444444444444', 'workspace-a', ?, 3, 'submitted', NULL)`)
      .run(FORM_ID);

    const blocked = await harness.retire();
    assert.equal(blocked.response.status, 409);
    assert.equal((blocked.body.error as { code: string }).code, "intake_form_has_pending_submissions");
    assert.equal(database.prepare("SELECT status FROM intake_forms WHERE id = ?").get(FORM_ID)?.status, "published");

    database.prepare("DELETE FROM intake_submissions WHERE form_id = ?").run(FORM_ID);
    const retired = await harness.retire();
    assert.equal(retired.response.status, 200, JSON.stringify(retired.body));
    assert.equal((retired.body.intakeForm as { status: string }).status, "retired");
    assert.equal(database.prepare("SELECT status FROM intake_forms WHERE id = ?").get(FORM_ID)?.status, "retired");
  } finally {
    database.close();
  }
});

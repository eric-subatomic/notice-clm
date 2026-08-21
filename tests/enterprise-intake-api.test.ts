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
import * as enterpriseValidation from "../app/lib/enterprise-validation";

const routeSource = await readFile(new URL("../app/api/intake/submissions/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/intake/submissions/route.ts",
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
    CREATE TABLE intake_forms (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      name text NOT NULL, description text NOT NULL, status text NOT NULL,
      form_schema text NOT NULL, template_id text, template_version_id text, workflow_definition_id text,
      created_by_user_id text NOT NULL, created_at text NOT NULL,
      updated_by_user_id text NOT NULL, updated_at text NOT NULL
    );
    CREATE TABLE intake_submissions (
      id text PRIMARY KEY, workspace_id text NOT NULL, form_id text NOT NULL,
      form_version integer NOT NULL, version integer NOT NULL, status text NOT NULL,
      answers text NOT NULL, submitted_by_user_id text NOT NULL, agreement_id integer,
      created_at text NOT NULL, updated_at text NOT NULL, submitted_at text, converted_at text
    );
  `);
  return database;
}

const FORM_A = "11111111-1111-4111-8111-111111111111";
const FORM_B = "22222222-2222-4222-8222-222222222222";
const SUBMISSION_A = "33333333-3333-4333-8333-333333333333";
const SUBMISSION_B = "44444444-4444-4444-8444-444444444444";
const formSchema = {
  fields: [
    { key: "request_name", label: "Request name", type: "text", required: true, options: [] },
    { key: "urgent", label: "Urgent", type: "boolean", required: false, options: [] },
  ],
};

function seedForm(database: DatabaseSync, input: { id: string; workspaceId: string; version?: number; status?: string }) {
  database.prepare(`INSERT INTO intake_forms (
    id, workspace_id, version, name, description, status, form_schema,
    created_by_user_id, created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, ?, 'Request form', '', ?, ?, 'admin', '2026-08-20T00:00:00.000Z', 'reviewer', '2026-08-20T00:00:00.000Z')`)
    .run(input.id, input.workspaceId, input.version ?? 3, input.status ?? "published", JSON.stringify(formSchema));
}

function seedSubmission(database: DatabaseSync, input: { id: string; workspaceId: string; userId: string; formId?: string; version?: number; status?: string }) {
  database.prepare(`INSERT INTO intake_submissions (
    id, workspace_id, form_id, form_version, version, status, answers,
    submitted_by_user_id, created_at, updated_at
  ) VALUES (?, ?, ?, 3, ?, ?, ?, ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`)
    .run(input.id, input.workspaceId, input.formId ?? FORM_A, input.version ?? 1, input.status ?? "draft", JSON.stringify({ urgent: true }), input.userId);
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit; requestId?: string } = {}) {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function routeHarness(database: DatabaseSync) {
  let workspaceId = "workspace-a";
  let userId = "requester-a";
  let role = "requester";
  const permissions: string[] = [];
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const parseListQuery = (request: Request) => {
    const url = new URL(request.url);
    return {
      limit: Number(url.searchParams.get("limit") ?? 100),
      id: url.searchParams.get("id") || undefined,
      status: url.searchParams.get("status") || undefined,
    };
  };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "../../../../db") return { getDb: () => db };
    if (specifier === "../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../db/schema") return schema;
    if (specifier === "../../../lib/enterprise-domain") return enterpriseDomain;
    if (specifier === "../../../lib/enterprise-references") return {
      requirePinnedTemplateVersion: async (_db: unknown, _workspaceId: string, templateId: string | null, templateVersionId: string | null) => {
        if (templateId !== null || templateVersionId !== null) throw new Error("This harness only seeds template-free forms");
      },
    };
    if (specifier === "../../../lib/enterprise-validation") return enterpriseValidation;
    if (specifier === "../../../lib/api") return {
      authorizeApiRequest: async (_request: Request, permission: string) => {
        permissions.push(permission);
        return {
          ok: true,
          context: {
            workspace: { id: workspaceId, name: workspaceId },
            user: { id: userId, email: `${userId}@example.test`, displayName: userId },
            role,
          },
          requestId: "request-intake",
          headers: new Headers(),
        };
      },
    };
    if (specifier === "../../../lib/enterprise-api") return {
      parseEnterpriseListQuery: parseListQuery,
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
    if (specifier === "../../../lib/http") return { apiJson: responseJson };
    if (specifier === "../../../lib/validation") return {
      parseJson: async (request: Request, validationSchema: { parse(value: unknown): unknown }) => validationSchema.parse(await request.json()),
    };
    throw new Error(`Unexpected intake route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto, console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/intake/submissions/route.cjs" }).runInContext(context);
  const get = moduleObject.exports.GET as (request: Request) => Promise<Response>;
  const post = moduleObject.exports.POST as (request: Request) => Promise<Response>;
  const patch = moduleObject.exports.PATCH as (request: Request) => Promise<Response>;
  const remove = moduleObject.exports.DELETE as (request: Request) => Promise<Response>;
  const request = (method: string, body?: unknown, parameters = "") => new Request(`https://notice.test/api/intake/submissions${parameters}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return {
    permissions,
    setIdentity(nextWorkspaceId: string, nextUserId: string, nextRole = role) { workspaceId = nextWorkspaceId; userId = nextUserId; role = nextRole; },
    async get(parameters = "") { const response = await get(request("GET", undefined, parameters)); return { response, body: await response.json() as Record<string, unknown> }; },
    async post(body: unknown) { const response = await post(request("POST", body)); return { response, body: await response.json() as Record<string, unknown> }; },
    async patch(body: unknown) { const response = await patch(request("PATCH", body)); return { response, body: await response.json() as Record<string, unknown> }; },
    async delete(body: unknown) { const response = await remove(request("DELETE", body)); return { response, body: await response.json() as Record<string, unknown> }; },
  };
}

test("submission reads are tenant-scoped and owner-scoped", async () => {
  const database = createDatabase();
  try {
    seedForm(database, { id: FORM_A, workspaceId: "workspace-a" });
    seedForm(database, { id: FORM_B, workspaceId: "workspace-b" });
    seedSubmission(database, { id: SUBMISSION_A, workspaceId: "workspace-a", userId: "requester-a" });
    seedSubmission(database, { id: SUBMISSION_B, workspaceId: "workspace-a", userId: "requester-b" });
    seedSubmission(database, { id: "55555555-5555-4555-8555-555555555555", workspaceId: "workspace-b", userId: "requester-a", formId: FORM_B });
    const harness = routeHarness(database);
    const result = await harness.get();
    assert.equal(result.response.status, 200);
    const rows = result.body.intakeSubmissions as Array<{ id: string; templateVersionId: string | null }>;
    assert.deepEqual(rows.map((row) => row.id), [SUBMISSION_A]);
    assert.equal(rows[0]?.templateVersionId, null);
    assert.equal(harness.permissions.at(-1), "agreement:read");
  } finally {
    database.close();
  }
});

test("Legal and Admin get a workspace-scoped submitted review queue while requesters cannot enumerate it", async () => {
  const database = createDatabase();
  try {
    seedForm(database, { id: FORM_A, workspaceId: "workspace-a" });
    seedForm(database, { id: FORM_B, workspaceId: "workspace-b" });
    seedSubmission(database, { id: SUBMISSION_A, workspaceId: "workspace-a", userId: "requester-a", status: "submitted" });
    seedSubmission(database, { id: SUBMISSION_B, workspaceId: "workspace-a", userId: "requester-b", status: "submitted" });
    seedSubmission(database, { id: "55555555-5555-4555-8555-555555555555", workspaceId: "workspace-a", userId: "requester-c", status: "draft" });
    seedSubmission(database, { id: "66666666-6666-4666-8666-666666666666", workspaceId: "workspace-b", userId: "requester-a", formId: FORM_B, status: "submitted" });
    const harness = routeHarness(database);

    const denied = await harness.get("?scope=review&status=submitted");
    assert.equal(denied.response.status, 403);
    assert.equal((denied.body.error as { code: string }).code, "intake_review_forbidden");

    harness.setIdentity("workspace-a", "legal-reviewer", "legal");
    const review = await harness.get("?scope=review&status=submitted");
    assert.equal(review.response.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.scope, "review");
    assert.deepEqual((review.body.intakeSubmissions as Array<{ id: string }>).map((row) => row.id).sort(), [SUBMISSION_A, SUBMISSION_B]);
  } finally {
    database.close();
  }
});

test("only Legal or Admin can reject a version-matched submitted request", async () => {
  const database = createDatabase();
  try {
    seedForm(database, { id: FORM_A, workspaceId: "workspace-a" });
    seedForm(database, { id: FORM_B, workspaceId: "workspace-b" });
    seedSubmission(database, { id: SUBMISSION_A, workspaceId: "workspace-a", userId: "requester-a", version: 2, status: "submitted" });
    seedSubmission(database, { id: SUBMISSION_B, workspaceId: "workspace-b", userId: "requester-b", formId: FORM_B, version: 2, status: "submitted" });
    const harness = routeHarness(database);

    const requester = await harness.patch({ action: "reject", id: SUBMISSION_A, version: 2, reason: "Not in scope", confirmed: true });
    assert.equal(requester.response.status, 403);
    assert.equal((requester.body.error as { code: string }).code, "intake_review_forbidden");

    harness.setIdentity("workspace-a", "legal-reviewer", "legal");
    const crossTenant = await harness.patch({ action: "reject", id: SUBMISSION_B, version: 2, reason: "Not in scope", confirmed: true });
    assert.equal(crossTenant.response.status, 404);
    const stale = await harness.patch({ action: "reject", id: SUBMISSION_A, version: 1, reason: "Not in scope", confirmed: true });
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as { code: string }).code, "version_conflict");

    const rejected = await harness.patch({ action: "reject", id: SUBMISSION_A, version: 2, reason: "Outside contracting policy", confirmed: true });
    assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
    assert.equal((rejected.body.intakeSubmission as { status: string }).status, "rejected");
    assert.equal(database.prepare("SELECT status FROM intake_submissions WHERE id = ?").get(SUBMISSION_A)?.status, "rejected");

    const repeated = await harness.patch({ action: "reject", id: SUBMISSION_A, version: 3, reason: "Reject again", confirmed: true });
    assert.equal(repeated.response.status, 409);
    assert.equal((repeated.body.error as { code: string }).code, "intake_submission_not_reviewable");
  } finally {
    database.close();
  }
});

test("a non-admin requester can create a partial draft only from a published same-tenant form", async () => {
  const database = createDatabase();
  try {
    seedForm(database, { id: FORM_A, workspaceId: "workspace-a" });
    seedForm(database, { id: FORM_B, workspaceId: "workspace-b" });
    const harness = routeHarness(database);
    const created = await harness.post({ formId: FORM_A, answers: { urgent: true } });
    assert.equal(created.response.status, 201);
    assert.equal((created.body.intakeSubmission as { submittedByUserId: string }).submittedByUserId, "requester-a");
    assert.equal((created.body.intakeSubmission as { workspaceId: string }).workspaceId, "workspace-a");
    assert.equal((created.body.intakeSubmission as { templateVersionId: string | null }).templateVersionId, null);
    assert.equal(harness.permissions.at(-1), "agreement:create");

    const crossTenant = await harness.post({ formId: FORM_B, answers: {} });
    assert.equal(crossTenant.response.status, 422);
    assert.equal((crossTenant.body.error as { code: string }).code, "published_intake_form_required");
  } finally {
    database.close();
  }
});

test("draft updates enforce owner, version, complete submit validation, and terminal immutability", async () => {
  const database = createDatabase();
  try {
    seedForm(database, { id: FORM_A, workspaceId: "workspace-a" });
    seedSubmission(database, { id: SUBMISSION_A, workspaceId: "workspace-a", userId: "requester-a" });
    const harness = routeHarness(database);

    const stale = await harness.patch({ action: "update_draft", id: SUBMISSION_A, version: 2, answers: { urgent: false } });
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as { code: string }).code, "version_conflict");

    harness.setIdentity("workspace-a", "requester-b");
    const otherOwner = await harness.patch({ action: "update_draft", id: SUBMISSION_A, version: 1, answers: { urgent: false } });
    assert.equal(otherOwner.response.status, 404);
    harness.setIdentity("workspace-a", "requester-a");

    const incomplete = await harness.patch({ action: "submit", id: SUBMISSION_A, version: 1, confirmed: true });
    assert.equal(incomplete.response.status, 422);
    assert.equal((incomplete.body.error as { code: string }).code, "invalid_intake_answer");

    const submitted = await harness.patch({
      action: "submit", id: SUBMISSION_A, version: 1, confirmed: true,
      answers: { request_name: "New NDA", urgent: true },
    });
    assert.equal(submitted.response.status, 200);
    assert.equal((submitted.body.intakeSubmission as { status: string }).status, "submitted");
    assert.equal((submitted.body.intakeSubmission as { templateVersionId: string | null }).templateVersionId, null);

    const immutable = await harness.patch({ action: "update_draft", id: SUBMISSION_A, version: 2, answers: { request_name: "Changed" } });
    assert.equal(immutable.response.status, 409);
    assert.equal((immutable.body.error as { code: string }).code, "intake_submission_immutable");
  } finally {
    database.close();
  }
});

test("only the owner can delete a version-matched draft submission", async () => {
  const database = createDatabase();
  try {
    seedForm(database, { id: FORM_A, workspaceId: "workspace-a" });
    seedSubmission(database, { id: SUBMISSION_A, workspaceId: "workspace-a", userId: "requester-a", version: 2 });
    const harness = routeHarness(database);
    harness.setIdentity("workspace-a", "requester-b");
    const otherOwner = await harness.delete({ id: SUBMISSION_A, version: 2, reason: "No longer needed" });
    assert.equal(otherOwner.response.status, 404);

    harness.setIdentity("workspace-a", "requester-a");
    const stale = await harness.delete({ id: SUBMISSION_A, version: 1, reason: "No longer needed" });
    assert.equal(stale.response.status, 409);
    const removed = await harness.delete({ id: SUBMISSION_A, version: 2, reason: "No longer needed" });
    assert.equal(removed.response.status, 200);
    assert.equal(database.prepare("SELECT count(*) AS count FROM intake_submissions WHERE id = ?").get(SUBMISSION_A)?.count, 0);
  } finally {
    database.close();
  }
});

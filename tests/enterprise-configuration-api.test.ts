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

const routeSource = await readFile(new URL("../app/api/admin/configuration/counterparties/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/admin/configuration/counterparties/route.ts",
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
    CREATE TABLE counterparties (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      legal_name text NOT NULL, display_name text NOT NULL, domain text NOT NULL,
      jurisdiction text NOT NULL, registration_number text NOT NULL, external_id text NOT NULL,
      dedupe_key text NOT NULL, status text NOT NULL, created_by_user_id text NOT NULL,
      created_at text NOT NULL, updated_by_user_id text NOT NULL, updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX uq_counterparties_workspace_dedupe ON counterparties (workspace_id, dedupe_key);
  `);
  return database;
}

const EXISTING_ID = "11111111-1111-4111-8111-111111111111";

function seedCounterparty(database: DatabaseSync, workspaceId = "workspace-a") {
  const dedupeKey = enterpriseDomain.counterpartyDedupeKey({ legalName: "Acme, Inc.", domain: "acme.example" });
  database.prepare(`INSERT INTO counterparties (
    id, workspace_id, version, legal_name, display_name, domain, jurisdiction,
    registration_number, external_id, dedupe_key, status, created_by_user_id,
    created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, 4, 'Acme, Inc.', 'Acme', 'acme.example', '', '', '', ?, 'active',
    'admin-a', '2026-08-20T00:00:00.000Z', 'admin-a', '2026-08-20T00:00:00.000Z')`)
    .run(EXISTING_ID, workspaceId, dedupeKey);
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit; requestId?: string } = {}) {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function routeHarness(database: DatabaseSync) {
  let workspaceId = "workspace-a";
  const permissions: string[] = [];
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "../../../../../db") return { getDb: () => db };
    if (specifier === "../../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../../db/schema") return schema;
    if (specifier === "../../../../lib/enterprise-domain") return enterpriseDomain;
    if (specifier === "../../../../lib/enterprise-validation") return enterpriseValidation;
    if (specifier === "../../../../lib/api") return {
      authorizeApiRequest: async (_request: Request, permission: string) => {
        permissions.push(permission);
        return {
          ok: true,
          context: {
            workspace: { id: workspaceId, name: workspaceId },
            user: { id: "admin-a", email: "admin@example.test", displayName: "Admin" },
            role: "admin",
          },
          requestId: "request-counterparty",
          headers: new Headers(),
        };
      },
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
          return responseJson({
            error: { code: error.code, message: error.message },
            ...(error.details ? { details: error.details } : {}),
            requestId,
          }, { status: error.status, headers });
        }
        throw error;
      },
    };
    if (specifier === "../../../../lib/http") return { apiJson: responseJson };
    if (specifier === "../../../../lib/validation") return {
      parseJson: async (request: Request, validationSchema: { parse(value: unknown): unknown }) => validationSchema.parse(await request.json()),
    };
    throw new Error(`Unexpected counterparty route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto, console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/admin/configuration/counterparties/route.cjs" }).runInContext(context);
  const post = moduleObject.exports.POST as (request: Request) => Promise<Response>;
  const patch = moduleObject.exports.PATCH as (request: Request) => Promise<Response>;
  const call = async (handler: (request: Request) => Promise<Response>, method: string, body: unknown) => {
    const response = await handler(new Request("https://notice.test/api/admin/configuration/counterparties", {
      method, body: JSON.stringify(body), headers: { "content-type": "application/json" },
    }));
    return { response, body: await response.json() as Record<string, unknown> };
  };
  return {
    permissions,
    setWorkspace(next: string) { workspaceId = next; },
    post: (body: unknown) => call(post, "POST", body),
    patch: (body: unknown) => call(patch, "PATCH", body),
  };
}

test("counterparty API returns a scoped collision and permits the same normalized party in another tenant", async () => {
  const database = createDatabase();
  try {
    seedCounterparty(database);
    const harness = routeHarness(database);
    const duplicate = await harness.post({
      legalName: "Different spelling", displayName: "Acme duplicate", domain: "HTTPS://WWW.ACME.EXAMPLE/contracts",
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal((duplicate.body.error as { code: string }).code, "counterparty_duplicate");
    assert.equal((duplicate.body.details as { counterpartyId: string }).counterpartyId, EXISTING_ID);
    assert.equal(harness.permissions.at(-1), "workspace:admin");

    harness.setWorkspace("workspace-b");
    const separateTenant = await harness.post({
      legalName: "Acme, Inc.", displayName: "Acme", domain: "acme.example",
    });
    assert.equal(separateTenant.response.status, 201);
    assert.equal((separateTenant.body.counterparty as { workspaceId: string }).workspaceId, "workspace-b");
    assert.equal(database.prepare("SELECT count(*) AS count FROM counterparties").get()?.count, 2);
  } finally {
    database.close();
  }
});

test("counterparty update rejects stale optimistic versions", async () => {
  const database = createDatabase();
  try {
    seedCounterparty(database);
    const harness = routeHarness(database);
    const stale = await harness.patch({ id: EXISTING_ID, version: 3, displayName: "Acme stale edit" });
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as { code: string }).code, "version_conflict");
    assert.equal(database.prepare("SELECT display_name FROM counterparties WHERE id = ?").get(EXISTING_ID)?.display_name, "Acme");
  } finally {
    database.close();
  }
});

test("every configuration mutation is admin-gated and uses the audited mutation path", async () => {
  const routeNames = [
    "legal-entities", "counterparties", "groups", "custom-fields", "custom-field-values",
    "templates", "workflows", "approval-authorities", "saved-views", "intake-forms",
  ];
  for (const name of routeNames) {
    const source = await readFile(new URL(`../app/api/admin/configuration/${name}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /authorizeApiRequest\(request, "workspace:admin"/, `${name} must require workspace admin`);
    assert.match(source, /executeEnterpriseMutation\(/, `${name} must append audited mutations`);
    assert.match(source, /workspace\.id/, `${name} must derive tenant scope from authorization context`);
  }
});

test("approval authority uniqueness permits separate currencies and re-grant after revocation", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE approval_lane_authorities (
        id text PRIMARY KEY, workspace_id text NOT NULL, lane text NOT NULL,
        subject_type text NOT NULL, subject_id text NOT NULL, currency_code text NOT NULL,
        status text NOT NULL
      );
      CREATE UNIQUE INDEX uq_approval_lane_authorities_active_identity
      ON approval_lane_authorities (workspace_id, lane, subject_type, subject_id, currency_code)
      WHERE status = 'active';
    `);
    const insert = database.prepare("INSERT INTO approval_lane_authorities VALUES (?, 'workspace-a', 'Finance', 'user', 'user-a', ?, ?)");
    insert.run("authority-usd", "USD", "active");
    insert.run("authority-eur", "EUR", "active");
    assert.throws(() => insert.run("authority-usd-duplicate", "USD", "active"), /UNIQUE constraint failed/);
    database.exec("UPDATE approval_lane_authorities SET status = 'revoked' WHERE id = 'authority-usd'");
    insert.run("authority-usd-regrant", "USD", "active");
    assert.equal(database.prepare("SELECT count(*) AS count FROM approval_lane_authorities").get()?.count, 3);

    const source = await readFile(new URL("../app/api/admin/configuration/approval-authorities/route.ts", import.meta.url), "utf8");
    assert.match(source, /approval_lane_authorities\.currency_code/);
    assert.match(source, /approval lane and currency/);
    assert.equal(source.match(/isAuthorityIdentityConflict\(error\)/g)?.length, 2,
      "create and currency-update collisions must both map to the stable conflict");
  } finally {
    database.close();
  }
});

test("group disable repeats the active-authority invariant inside its commit", async () => {
  const source = await readFile(new URL("../app/api/admin/configuration/groups/route.ts", import.meta.url), "utf8");
  const update = source.slice(source.indexOf('if (input.action === "update_group")'), source.indexOf("const [membership]"));
  assert.match(update, /notExists\(db\.select\(\{ id: approvalLaneAuthorities\.id \}\)/);
  assert.match(update, /eq\(approvalLaneAuthorities\.status, "active"\)/);

  const migration = await readFile(new URL("../drizzle/0019_romantic_kabuki.sql", import.meta.url), "utf8");
  assert.match(migration, /prevent_disable_group_with_active_authority_v19[\s\S]*NEW\.`status` = 'disabled'[\s\S]*group_has_active_authority/);
});

test("workflow administration canonicalizes the governed policy before create and publish", async () => {
  const source = await readFile(new URL("../app/api/admin/configuration/workflows/route.ts", import.meta.url), "utf8");
  assert.match(source, /parseGovernedWorkflowDefinition\(input\.definition\)/);
  assert.match(source, /parseGovernedWorkflowDefinition\(workflow\.definition\)/);
  assert.match(source, /definitionSha256 = await enterpriseContentDigest\(definition\)/);
});

test("governed template versions reject mutable language-block references", () => {
  const parsed = enterpriseValidation.templatePostSchema.safeParse({
    action: "create_version",
    templateId: "11111111-1111-4111-8111-111111111111",
    templateVersion: 1,
    body: "Hello {{party}}",
    variableSchema: { version: 1, variables: {} },
    languageBlockIds: [7],
    changeSummary: "Initial terms",
  });
  assert.equal(parsed.success, false);
});

test("template and workflow retirement atomically fence concurrent intake publication", async () => {
  const templateSource = await readFile(new URL("../app/api/admin/configuration/templates/route.ts", import.meta.url), "utf8");
  const workflowSource = await readFile(new URL("../app/api/admin/configuration/workflows/route.ts", import.meta.url), "utf8");
  for (const [name, source, reference] of [
    ["template", templateSource, "intakeForms.templateId"],
    ["workflow", workflowSource, "intakeForms.workflowDefinitionId"],
  ] as const) {
    const retirement = name === "template"
      ? source.slice(source.indexOf('if (input.action === "retire_template")'), source.indexOf('if (template.status === "retired")', source.indexOf('if (input.action === "retire_template")')))
      : source.slice(source.indexOf("const [publishedForm]"));
    assert.match(retirement, /notExists\(db\.select/,
      `${name} retirement must recheck intake use in the guarded update`);
    assert.ok(retirement.lastIndexOf(reference) > retirement.indexOf("executeEnterpriseMutation(db"),
      `${name} retirement commit predicate must bind the published intake reference`);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import ts from "typescript";
import {
  governedTemplateContentDigest,
  GovernedTemplateRuntimeError,
  renderGovernedTemplate,
  validateGovernedTemplateArtifact,
} from "../app/lib/governed-template-runtime";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

const VARIABLE_SCHEMA = {
  version: 1,
  variables: {
    organization: { type: "string", source: "system", required: true, maxLength: 200 },
    party: { type: "string", source: "agreement", required: true, maxLength: 200 },
    type: { type: "string", source: "agreement", required: true, maxLength: 120 },
    projectCode: { type: "string", source: "input", required: true, maxLength: 40 },
  },
} as const;

const TEMPLATE_BODY = "{{type}}\n\n{{organization}} and {{party}}\nProject: {{projectCode}}\n";

test("governed template v1 renders deterministically from separated trusted sources", async () => {
  const digest = await governedTemplateContentDigest({
    body: TEMPLATE_BODY,
    variableSchema: VARIABLE_SCHEMA,
    languageBlockIds: [8, 13],
  });
  const input = {
    body: TEMPLATE_BODY,
    variableSchema: VARIABLE_SCHEMA,
    languageBlockIds: [8, 13],
    contentSha256: digest,
    organization: "Notice, Inc.",
    agreementVariables: { party: "Acme Corp", type: "Services Agreement" },
    templateVariables: { projectCode: "PROJECT-7" },
  } as const;

  const first = await renderGovernedTemplate(input);
  const second = await renderGovernedTemplate(input);
  assert.equal(first, "Services Agreement\n\nNotice, Inc. and Acme Corp\nProject: PROJECT-7\n");
  assert.equal(second, first);

  const reorderedDigest = await governedTemplateContentDigest({
    languageBlockIds: [8, 13],
    variableSchema: {
      variables: {
        projectCode: { maxLength: 40, required: true, source: "input", type: "string" },
        type: { maxLength: 120, required: true, source: "agreement", type: "string" },
        party: { maxLength: 200, required: true, source: "agreement", type: "string" },
        organization: { maxLength: 200, required: true, source: "system", type: "string" },
      },
      version: 1,
    },
    body: TEMPLATE_BODY,
  });
  assert.equal(reorderedDigest, digest, "the published artifact digest is canonical across object key order");
});

test("governed template runtime fails closed on digest, schema, placeholder, and variable violations", async () => {
  const digest = await governedTemplateContentDigest({
    body: TEMPLATE_BODY,
    variableSchema: VARIABLE_SCHEMA,
    languageBlockIds: [],
  });
  const base = {
    body: TEMPLATE_BODY,
    variableSchema: VARIABLE_SCHEMA,
    languageBlockIds: [] as number[],
    contentSha256: digest,
    organization: "Notice, Inc.",
    agreementVariables: { party: "Acme Corp", type: "Services Agreement" },
    templateVariables: { projectCode: "PROJECT-7" },
  };

  await assert.rejects(
    renderGovernedTemplate({ ...base, body: `${TEMPLATE_BODY}tampered` }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "template_digest_mismatch" && error.status === 409,
  );
  const invalidSourceSchema = {
    ...VARIABLE_SCHEMA,
    variables: {
      ...VARIABLE_SCHEMA.variables,
      organization: { type: "string", source: "input", required: true, maxLength: 200 },
    },
  };
  const invalidSourceDigest = await governedTemplateContentDigest({
    body: TEMPLATE_BODY,
    variableSchema: invalidSourceSchema,
    languageBlockIds: [],
  });
  await assert.rejects(
    renderGovernedTemplate({ ...base, variableSchema: invalidSourceSchema, contentSha256: invalidSourceDigest }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "invalid_template_variable_schema",
  );
  await assert.rejects(
    renderGovernedTemplate({ ...base, templateVariables: {} }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "missing_template_variable",
  );
  await assert.rejects(
    renderGovernedTemplate({ ...base, templateVariables: { projectCode: "PROJECT-7", extra: "unknown" } }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "unknown_template_variable",
  );
  await assert.rejects(
    renderGovernedTemplate({ ...base, templateVariables: { projectCode: "PROJECT-7", organization: "Caller Corp" } }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "protected_template_variable",
  );
  await assert.rejects(
    renderGovernedTemplate({ ...base, templateVariables: { projectCode: "unsafe\nvalue" } }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "unsafe_template_variable",
  );

  const unresolvedBody = `${TEMPLATE_BODY}{{optionalNote}}`;
  const unresolvedSchema = {
    ...VARIABLE_SCHEMA,
    variables: {
      ...VARIABLE_SCHEMA.variables,
      optionalNote: { type: "string", source: "input", required: false, maxLength: 100 },
    },
  };
  const unresolvedDigest = await governedTemplateContentDigest({
    body: unresolvedBody,
    variableSchema: unresolvedSchema,
    languageBlockIds: [],
  });
  await assert.rejects(
    renderGovernedTemplate({
      ...base,
      body: unresolvedBody,
      variableSchema: unresolvedSchema,
      contentSha256: unresolvedDigest,
    }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "unresolved_template_placeholder",
  );
});

test("governed template publication rejects invalid schemas and placeholder artifacts", () => {
  assert.throws(
    () => validateGovernedTemplateArtifact({ body: TEMPLATE_BODY, variableSchema: { version: 2, variables: {} } }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "invalid_template_variable_schema",
  );
  assert.throws(
    () => validateGovernedTemplateArtifact({ body: "Hello {{undeclared}}", variableSchema: VARIABLE_SCHEMA }),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "unknown_template_placeholder",
  );
  assert.throws(
    () => validateGovernedTemplateArtifact({ body: "Hello {{party", variableSchema: VARIABLE_SCHEMA }, 409),
    (error: unknown) => error instanceof GovernedTemplateRuntimeError && error.code === "invalid_template_placeholder" && error.status === 409,
  );
});

type TemplateListBody = Readonly<{
  templates?: Array<Record<string, unknown> & { publishedVersion: Record<string, unknown> }>;
  requestId?: string;
  error?: Readonly<{ code: string; message: string }>;
}>;

const routeSource = await readFile(new URL("../app/api/templates/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: "app/api/templates/route.ts",
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
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, query);
  }
}

function createTemplateDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE governed_templates (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      version integer NOT NULL,
      name text NOT NULL,
      description text NOT NULL,
      agreement_type text NOT NULL,
      side text NOT NULL,
      status text NOT NULL,
      current_published_version integer,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE TABLE governed_template_versions (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      template_id text NOT NULL,
      version integer NOT NULL,
      status text NOT NULL,
      body text NOT NULL,
      variable_schema text NOT NULL,
      language_block_ids text NOT NULL,
      content_sha256 text NOT NULL,
      change_summary text NOT NULL,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      reviewed_by_user_id text,
      reviewed_at text
    );
  `);
  return database;
}

function insertTemplate(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  name: string;
  status: string;
  currentPublishedVersion: number | null;
}>): void {
  database.prepare(`INSERT INTO governed_templates (
    id, workspace_id, version, name, description, agreement_type, side, status,
    current_published_version, created_by_user_id, created_at, updated_by_user_id, updated_at
  ) VALUES (?, ?, 3, ?, 'Published terms', 'Services Agreement', 'Sell-side', ?, ?, 'author', '2026-01-01', 'publisher', '2026-02-01')`).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.name,
    input.status,
    input.currentPublishedVersion,
  );
}

function insertVersion(database: DatabaseSync, input: Readonly<{
  id: string;
  templateId: string;
  version: number;
  status: string;
  body: string;
  variableSchema: Record<string, unknown>;
  contentSha256: string;
  workspaceId?: string;
}>): void {
  database.prepare(`INSERT INTO governed_template_versions (
    id, workspace_id, template_id, version, status, body, variable_schema,
    language_block_ids, content_sha256, change_summary, created_by_user_id,
    created_at, reviewed_by_user_id, reviewed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, '[8,13]', ?, 'Approved revision', 'author', '2026-01-02', 'publisher', '2026-02-01')`).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.templateId,
    input.version,
    input.status,
    input.body,
    JSON.stringify(input.variableSchema),
    input.contentSha256,
  );
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit } = {}): Response {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function templateRouteHarness(database: DatabaseSync) {
  let workspaceId = "workspace-a";
  let authorized = true;
  let ensureCalls = 0;
  const permissions: string[] = [];
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "../../../db") return { getDb: () => db };
    if (specifier === "../../../db/ensure") return { ensureStorageSchema: async () => { ensureCalls += 1; } };
    if (specifier === "../../../db/schema") return schema;
    if (specifier === "../../lib/api") {
      return {
        authorizeApiRequest: async (_request: Request, permission: string) => {
          permissions.push(permission);
          if (!authorized) {
            return { ok: false, response: responseJson({ error: { code: "forbidden", message: "Denied" } }, { status: 403 }) };
          }
          return {
            ok: true,
            context: { workspace: { id: workspaceId }, user: { id: "user-a" } },
            requestId: "request-templates",
            headers: new Headers(),
          };
        },
        handleRouteError: (error: unknown) => { throw error; },
      };
    }
    if (specifier === "../../lib/http") {
      return {
        apiJson: responseJson,
        apiError: (code: string, message: string, options: { status: number; headers?: HeadersInit }) => responseJson({
          error: { code, message },
          requestId: "request-templates",
        }, options),
      };
    }
    throw new Error(`Unexpected template route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    require: requireModule,
    Request,
    Response,
    Headers,
    URL,
    console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/templates/route.cjs" }).runInContext(context);
  const get = moduleObject.exports.GET as (request: Request) => Promise<Response>;
  return {
    permissions,
    get ensureCalls() { return ensureCalls; },
    setWorkspace(nextWorkspaceId: string) { workspaceId = nextWorkspaceId; },
    deny() { authorized = false; },
    async request(parameters = ""): Promise<{ response: Response; body: TemplateListBody }> {
      const response = await get(new Request(`https://notice.test/api/templates${parameters ? `?${parameters}` : ""}`));
      return { response, body: await response.json() as TemplateListBody };
    },
  };
}

test("published template endpoint returns only the tenant's exact current published artifact", async () => {
  const database = createTemplateDatabase();
  try {
    const currentDigest = await governedTemplateContentDigest({
      body: TEMPLATE_BODY,
      variableSchema: VARIABLE_SCHEMA,
      languageBlockIds: [8, 13],
    });
    const oldBody = "Old published body";
    const oldDigest = await governedTemplateContentDigest({ body: oldBody, variableSchema: VARIABLE_SCHEMA, languageBlockIds: [8, 13] });
    insertTemplate(database, { id: "template-live", name: "Live services", status: "published", currentPublishedVersion: 2 });
    insertVersion(database, { id: "version-old", templateId: "template-live", version: 1, status: "published", body: oldBody, variableSchema: VARIABLE_SCHEMA, contentSha256: oldDigest });
    insertVersion(database, { id: "version-current", templateId: "template-live", version: 2, status: "published", body: TEMPLATE_BODY, variableSchema: VARIABLE_SCHEMA, contentSha256: currentDigest });

    insertTemplate(database, { id: "template-draft", name: "Draft parent", status: "draft", currentPublishedVersion: 1 });
    insertVersion(database, { id: "version-draft-parent", templateId: "template-draft", version: 1, status: "published", body: TEMPLATE_BODY, variableSchema: VARIABLE_SCHEMA, contentSha256: currentDigest });
    insertTemplate(database, { id: "template-retired", name: "Retired parent", status: "retired", currentPublishedVersion: 1 });
    insertVersion(database, { id: "version-retired-parent", templateId: "template-retired", version: 1, status: "published", body: TEMPLATE_BODY, variableSchema: VARIABLE_SCHEMA, contentSha256: currentDigest });
    insertTemplate(database, { id: "template-draft-version", name: "Draft version", status: "published", currentPublishedVersion: 1 });
    insertVersion(database, { id: "version-draft", templateId: "template-draft-version", version: 1, status: "draft", body: TEMPLATE_BODY, variableSchema: VARIABLE_SCHEMA, contentSha256: currentDigest });
    insertTemplate(database, { id: "template-other", workspaceId: "workspace-b", name: "Other tenant", status: "published", currentPublishedVersion: 1 });
    insertVersion(database, { id: "version-other", templateId: "template-other", workspaceId: "workspace-b", version: 1, status: "published", body: TEMPLATE_BODY, variableSchema: VARIABLE_SCHEMA, contentSha256: currentDigest });

    const harness = templateRouteHarness(database);
    const result = await harness.request();
    assert.equal(result.response.status, 200);
    assert.equal(result.body.requestId, "request-templates");
    assert.equal(result.body.templates?.length, 1);
    const template = result.body.templates?.[0];
    assert.equal(template?.id, "template-live");
    assert.equal(template?.status, "published");
    assert.equal(template?.currentPublishedVersion, 2);
    assert.deepEqual(template?.publishedVersion, {
      id: "version-current",
      templateId: "template-live",
      version: 2,
      status: "published",
      body: TEMPLATE_BODY,
      variableSchema: VARIABLE_SCHEMA,
      languageBlockIds: [8, 13],
      contentSha256: currentDigest,
      changeSummary: "Approved revision",
      createdByUserId: "author",
      createdAt: "2026-01-02",
      reviewedByUserId: "publisher",
      reviewedAt: "2026-02-01",
    });
    assert.deepEqual(harness.permissions, ["agreement:read"]);
    assert.equal(harness.ensureCalls, 1);

    harness.setWorkspace("workspace-b");
    const otherTenant = await harness.request();
    assert.deepEqual(otherTenant.body.templates?.map((entry) => entry.id), ["template-other"]);
  } finally {
    database.close();
  }
});

test("published template endpoint rejects query parameters and permission denial before storage", async () => {
  const database = createTemplateDatabase();
  try {
    const harness = templateRouteHarness(database);
    const invalid = await harness.request("status=draft");
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error?.code, "invalid_query");
    assert.equal(harness.ensureCalls, 0);

    harness.deny();
    const denied = await harness.request();
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.error?.code, "forbidden");
    assert.equal(harness.ensureCalls, 0);
  } finally {
    database.close();
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import ts from "typescript";
import { z } from "zod";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";
import * as enterpriseDomain from "../app/lib/enterprise-domain";

const routeSource = await readFile(new URL("../app/api/saved-views/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/saved-views/route.ts",
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
    CREATE TABLE saved_views (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      owner_user_id text NOT NULL,
      resource_type text NOT NULL,
      name text NOT NULL,
      filter text NOT NULL CHECK (json_valid(filter) = 1 AND json_type(filter) = 'object'),
      sort text NOT NULL CHECK (json_valid(sort) = 1 AND json_type(sort) = 'object'),
      shared integer NOT NULL DEFAULT 0,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX uq_saved_views_workspace_owner_resource_name
      ON saved_views (workspace_id, owner_user_id, resource_type, name);
  `);
  return database;
}

const VIEW_A_PRIVATE = "11111111-1111-4111-8111-111111111111";
const VIEW_B_SHARED = "22222222-2222-4222-8222-222222222222";
const VIEW_B_PRIVATE = "33333333-3333-4333-8333-333333333333";
const VIEW_OTHER_TENANT = "44444444-4444-4444-8444-444444444444";
const VIEW_OTHER_RESOURCE = "55555555-5555-4555-8555-555555555555";

function seedView(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  ownerUserId?: string;
  resourceType?: string;
  name?: string;
  shared?: boolean;
  version?: number;
  updatedAt?: string;
}>): void {
  database.prepare(`INSERT INTO saved_views (
    id, workspace_id, version, owner_user_id, resource_type, name, filter, sort,
    shared, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-20T00:00:00.000Z', ?)`)
    .run(
      input.id,
      input.workspaceId ?? "workspace-a",
      input.version ?? 1,
      input.ownerUserId ?? "user-a",
      input.resourceType ?? "agreements",
      input.name ?? input.id,
      JSON.stringify({ stage: "Review" }),
      JSON.stringify({ updatedAt: "desc" }),
      input.shared ? 1 : 0,
      input.updatedAt ?? "2026-08-20T00:00:00.000Z",
    );
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit; requestId?: string } = {}) {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function errorResponse(error: unknown, requestId: string, headers: Headers): Response {
  if (error instanceof enterpriseDomain.EnterpriseError) {
    return responseJson({ error: { code: error.code, message: error.message }, requestId }, { status: error.status, headers });
  }
  if (String(error).toLowerCase().includes("ck_mutation_guards_changes")) {
    return responseJson({ error: { code: "version_conflict", message: "This record changed while it was being saved." }, requestId }, { status: 409, headers });
  }
  return responseJson({ error: { code: "internal_error", message: String(error) }, requestId }, { status: 500, headers });
}

function routeHarness(database: DatabaseSync) {
  let workspaceId = "workspace-a";
  let userId = "user-a";
  let role = "legal";
  let authorized = true;
  let beforeMutationOnce: (() => void) | undefined;
  const permissions: string[] = [];
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "zod") return { z };
    if (specifier === "../../../db") return { getDb: () => db };
    if (specifier === "../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../db/schema") return schema;
    if (specifier === "../../lib/api") return {
      authorizeApiRequest: async (_request: Request, permission: string) => {
        permissions.push(permission);
        if (!authorized) {
          return {
            ok: false,
            response: responseJson({ error: { code: "insufficient_permissions", message: "Permission denied." } }, { status: 403 }),
          };
        }
        return {
          ok: true,
          context: {
            workspace: { id: workspaceId, name: workspaceId },
            user: { id: userId, email: `${userId}@example.test`, displayName: userId },
            role,
          },
          requestId: "request-saved-view",
          headers: new Headers(),
        };
      },
    };
    if (specifier === "../../lib/enterprise-domain") return enterpriseDomain;
    if (specifier === "../../lib/enterprise-api") return {
      executeEnterpriseMutation: async (_db: unknown, input: { steps: Array<{ statement: PromiseLike<unknown>; guardOperation?: string }> }) => {
        const hook = beforeMutationOnce;
        beforeMutationOnce = undefined;
        hook?.();
        database.exec("BEGIN");
        try {
          for (const step of input.steps) {
            const result = await step.statement as { meta?: { changes?: number } };
            if (step.guardOperation && result.meta?.changes !== 1) {
              throw new Error("CHECK constraint failed: ck_mutation_guards_changes");
            }
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
      enterpriseRouteError: errorResponse,
    };
    if (specifier === "../../lib/http") return { apiJson: responseJson };
    if (specifier === "../../lib/validation") return {
      parseJson: async (request: Request, validationSchema: { safeParse(value: unknown): { success: boolean; data?: unknown } }) => {
        const parsed = validationSchema.safeParse(await request.json());
        if (!parsed.success) throw new enterpriseDomain.EnterpriseError(400, "validation_failed", "Request validation failed.");
        return parsed.data;
      },
    };
    throw new Error(`Unexpected saved-view route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto, console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/saved-views/route.cjs" }).runInContext(context);
  const handlers = moduleObject.exports as Record<"GET" | "POST" | "PATCH" | "DELETE", (request: Request) => Promise<Response>>;
  const call = async (method: keyof typeof handlers, body?: unknown, query = "") => {
    const response = await handlers[method](new Request(`https://notice.test/api/saved-views${query}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }));
    return { response, body: await response.json() as Record<string, unknown> };
  };
  return {
    permissions,
    setIdentity(nextWorkspaceId: string, nextUserId: string, nextRole = "legal") {
      workspaceId = nextWorkspaceId;
      userId = nextUserId;
      role = nextRole;
    },
    setAuthorized(next: boolean) { authorized = next; },
    beforeNextMutation(hook: () => void) { beforeMutationOnce = hook; },
    get: (query = "") => call("GET", undefined, query),
    post: (body: unknown) => call("POST", body),
    patch: (body: unknown) => call("PATCH", body),
    delete: (body: unknown) => call("DELETE", body),
  };
}

function seedVisibilityFixture(database: DatabaseSync): void {
  seedView(database, { id: VIEW_A_PRIVATE, ownerUserId: "user-a", name: "My private agreements" });
  seedView(database, { id: VIEW_B_SHARED, ownerUserId: "user-b", name: "Team agreements", shared: true });
  seedView(database, { id: VIEW_B_PRIVATE, ownerUserId: "user-b", name: "B private" });
  seedView(database, { id: VIEW_OTHER_TENANT, workspaceId: "workspace-b", ownerUserId: "user-a", name: "Other tenant", shared: true });
  seedView(database, { id: VIEW_OTHER_RESOURCE, ownerUserId: "user-a", resourceType: "approvals", name: "My approvals" });
}

test("saved-view authorization is enforced before storage and uses agreement read permission", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database);
    harness.setAuthorized(false);
    const deniedRead = await harness.get();
    const deniedWrite = await harness.post({ resourceType: "agreements", name: "Denied", filter: {}, sort: {} });
    assert.equal(deniedRead.response.status, 403);
    assert.equal(deniedWrite.response.status, 403);
    assert.deepEqual(harness.permissions, ["agreement:read", "agreement:read"]);
    assert.equal(database.prepare("SELECT count(*) AS count FROM saved_views").get()?.count, 0);
  } finally {
    database.close();
  }
});

test("saved-view reads expose only the caller's own or shared views in the active tenant", async () => {
  const database = createDatabase();
  try {
    seedVisibilityFixture(database);
    const harness = routeHarness(database);
    const userA = await harness.get("?resourceType=agreements");
    assert.equal(userA.response.status, 200);
    assert.deepEqual(
      (userA.body.savedViews as Array<{ id: string }>).map((row) => row.id).sort(),
      [VIEW_A_PRIVATE, VIEW_B_SHARED].sort(),
    );

    harness.setIdentity("workspace-a", "user-b");
    const userB = await harness.get("?resourceType=agreements");
    assert.deepEqual(
      (userB.body.savedViews as Array<{ id: string }>).map((row) => row.id).sort(),
      [VIEW_B_PRIVATE, VIEW_B_SHARED].sort(),
    );
  } finally {
    database.close();
  }
});

test("saved-view creation derives owner and tenant and keeps name uniqueness owner-scoped", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database);
    const first = await harness.post({ resourceType: "agreements", name: "Quarter close", filter: { stage: "Review" }, sort: {}, shared: true });
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    const created = first.body.savedView as { workspaceId: string; ownerUserId: string; version: number; shared: boolean };
    assert.deepEqual(created, {
      ...(created as object),
      workspaceId: "workspace-a",
      ownerUserId: "user-a",
      version: 1,
      shared: true,
    });

    const duplicate = await harness.post({ resourceType: "agreements", name: "Quarter close", filter: {}, sort: {}, shared: false });
    assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.body));
    assert.equal((duplicate.body.error as { code: string }).code, "saved_view_exists");

    harness.setIdentity("workspace-a", "user-b");
    const otherOwner = await harness.post({ resourceType: "agreements", name: "Quarter close", filter: {}, sort: {}, shared: false });
    assert.equal(otherOwner.response.status, 201);
  } finally {
    database.close();
  }
});

test("saved-view updates require the owner or admin and enforce both preflight and commit-time versions", async () => {
  const database = createDatabase();
  try {
    seedView(database, { id: VIEW_B_SHARED, ownerUserId: "user-b", name: "Team agreements", shared: true });
    const harness = routeHarness(database);
    const nonOwner = await harness.patch({ id: VIEW_B_SHARED, version: 1, name: "Taken over" });
    assert.equal(nonOwner.response.status, 403);
    assert.equal((nonOwner.body.error as { code: string }).code, "saved_view_owner_required");

    harness.setIdentity("workspace-a", "admin-a", "admin");
    const stale = await harness.patch({ id: VIEW_B_SHARED, version: 2, name: "Stale" });
    assert.equal(stale.response.status, 409);
    assert.equal((stale.body.error as { code: string }).code, "version_conflict");

    harness.beforeNextMutation(() => {
      database.prepare("UPDATE saved_views SET version = 2, name = 'Concurrent edit' WHERE id = ?").run(VIEW_B_SHARED);
    });
    const raced = await harness.patch({ id: VIEW_B_SHARED, version: 1, name: "Lost update" });
    assert.equal(raced.response.status, 409);
    assert.equal((raced.body.error as { code: string }).code, "version_conflict");
    assert.equal(database.prepare("SELECT name FROM saved_views WHERE id = ?").get(VIEW_B_SHARED)?.name, "Concurrent edit");

    const saved = await harness.patch({ id: VIEW_B_SHARED, version: 2, name: "Admin curated" });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal((saved.body.savedView as { version: number }).version, 3);
  } finally {
    database.close();
  }
});

test("saved-view deletion is owner/admin guarded, tenant-scoped, and rejects stale or lost deletes", async () => {
  const database = createDatabase();
  try {
    seedView(database, { id: VIEW_A_PRIVATE, ownerUserId: "user-a", name: "Delete me" });
    seedView(database, { id: VIEW_B_SHARED, ownerUserId: "user-b", name: "Shared", shared: true });
    seedView(database, { id: VIEW_OTHER_TENANT, workspaceId: "workspace-b", ownerUserId: "user-a", name: "Other tenant" });
    const harness = routeHarness(database);

    const nonOwner = await harness.delete({ id: VIEW_B_SHARED, version: 1, reason: "No longer needed" });
    assert.equal(nonOwner.response.status, 403);
    const crossTenant = await harness.delete({ id: VIEW_OTHER_TENANT, version: 1, reason: "No longer needed" });
    assert.equal(crossTenant.response.status, 404);
    const stale = await harness.delete({ id: VIEW_A_PRIVATE, version: 2, reason: "No longer needed" });
    assert.equal(stale.response.status, 409);

    harness.beforeNextMutation(() => {
      database.prepare("UPDATE saved_views SET version = 2 WHERE id = ?").run(VIEW_A_PRIVATE);
    });
    const raced = await harness.delete({ id: VIEW_A_PRIVATE, version: 1, reason: "No longer needed" });
    assert.equal(raced.response.status, 409);
    assert.equal(database.prepare("SELECT count(*) AS count FROM saved_views WHERE id = ?").get(VIEW_A_PRIVATE)?.count, 1);

    const removed = await harness.delete({ id: VIEW_A_PRIVATE, version: 2, reason: "No longer needed" });
    assert.equal(removed.response.status, 200);
    assert.equal(database.prepare("SELECT count(*) AS count FROM saved_views WHERE id = ?").get(VIEW_A_PRIVATE)?.count, 0);
  } finally {
    database.close();
  }
});

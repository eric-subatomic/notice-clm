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

const routeSource = await readFile(new URL("../app/api/agreements/[id]/relationships/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/agreements/[id]/relationships/route.ts",
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
    CREATE TABLE agreements (
      id integer PRIMARY KEY,
      workspace_id text NOT NULL,
      party text NOT NULL,
      stage text NOT NULL,
      deleted_at text
    );
    CREATE TABLE legal_entities (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      display_name text NOT NULL,
      legal_name text NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE counterparties (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      display_name text NOT NULL,
      legal_name text NOT NULL,
      status text NOT NULL
    );
    CREATE TABLE agreement_parties (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      role text NOT NULL CHECK (role IN ('our_entity', 'counterparty', 'guarantor', 'affiliate', 'other')),
      legal_entity_id text,
      counterparty_id text,
      \`primary\` integer NOT NULL DEFAULT 0,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      CHECK ((legal_entity_id IS NULL) <> (counterparty_id IS NULL))
    );
    CREATE UNIQUE INDEX uq_agreement_parties_workspace_agreement_role_target
      ON agreement_parties (workspace_id, agreement_id, role, legal_entity_id, counterparty_id);
    CREATE UNIQUE INDEX uq_agreement_parties_workspace_agreement_role_primary
      ON agreement_parties (workspace_id, agreement_id, role) WHERE \`primary\` = 1;
    CREATE TABLE agreement_relationships (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      source_agreement_id integer NOT NULL,
      target_agreement_id integer NOT NULL,
      relationship_type text NOT NULL CHECK (relationship_type IN ('master', 'amends', 'order_under', 'dpa_for', 'renews', 'supersedes', 'related')),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      CHECK (source_agreement_id <> target_agreement_id)
    );
    CREATE UNIQUE INDEX uq_agreement_relationships_workspace_source_target_type
      ON agreement_relationships (workspace_id, source_agreement_id, target_agreement_id, relationship_type);
  `);
  return database;
}

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_A_SECOND = "22222222-2222-4222-8222-222222222222";
const ENTITY_A_INACTIVE = "33333333-3333-4333-8333-333333333333";
const ENTITY_B = "44444444-4444-4444-8444-444444444444";
const COUNTERPARTY_A = "55555555-5555-4555-8555-555555555555";
const COUNTERPARTY_A_SECOND = "66666666-6666-4666-8666-666666666666";
const COUNTERPARTY_A_INACTIVE = "77777777-7777-4777-8777-777777777777";
const COUNTERPARTY_B = "88888888-8888-4888-8888-888888888888";
const PARTY_A = "99999999-9999-4999-8999-999999999999";
const PARTY_OTHER_TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RELATIONSHIP_OUTBOUND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RELATIONSHIP_INBOUND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RELATIONSHIP_DELETED_TARGET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RELATIONSHIP_OTHER_TENANT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function seedAgreement(database: DatabaseSync, id: number, workspaceId = "workspace-a", deletedAt: string | null = null): void {
  database.prepare("INSERT INTO agreements (id, workspace_id, party, stage, deleted_at) VALUES (?, ?, ?, 'Review', ?)")
    .run(id, workspaceId, `Party ${id}`, deletedAt);
}

function seedDirectory(database: DatabaseSync): void {
  const entity = database.prepare("INSERT INTO legal_entities VALUES (?, ?, ?, ?, ?)");
  entity.run(ENTITY_A, "workspace-a", "Notice LLC", "Notice LLC", "active");
  entity.run(ENTITY_A_SECOND, "workspace-a", "Notice Europe", "Notice Europe GmbH", "active");
  entity.run(ENTITY_A_INACTIVE, "workspace-a", "Old Notice", "Old Notice LLC", "inactive");
  entity.run(ENTITY_B, "workspace-b", "Other tenant", "Other Tenant LLC", "active");
  const counterparty = database.prepare("INSERT INTO counterparties VALUES (?, ?, ?, ?, ?)");
  counterparty.run(COUNTERPARTY_A, "workspace-a", "Acme", "Acme, Inc.", "active");
  counterparty.run(COUNTERPARTY_A_SECOND, "workspace-a", "Bravo", "Bravo, Inc.", "active");
  counterparty.run(COUNTERPARTY_A_INACTIVE, "workspace-a", "Former", "Former, Inc.", "inactive");
  counterparty.run(COUNTERPARTY_B, "workspace-b", "Other tenant", "Other Tenant Corp.", "active");
}

function seedParty(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  agreementId?: number;
  role?: string;
  legalEntityId?: string | null;
  counterpartyId?: string | null;
  primary?: boolean;
}>): void {
  database.prepare(`INSERT INTO agreement_parties (
    id, workspace_id, agreement_id, role, legal_entity_id, counterparty_id,
    \`primary\`, created_by_user_id, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user-a', '2026-08-20T00:00:00.000Z')`).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.agreementId ?? 1,
    input.role ?? "our_entity",
    input.legalEntityId === undefined ? ENTITY_A : input.legalEntityId,
    input.counterpartyId ?? null,
    input.primary ? 1 : 0,
  );
}

function seedRelationship(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  sourceAgreementId: number;
  targetAgreementId: number;
  relationshipType?: string;
}>): void {
  database.prepare(`INSERT INTO agreement_relationships (
    id, workspace_id, source_agreement_id, target_agreement_id, relationship_type,
    created_by_user_id, created_at
  ) VALUES (?, ?, ?, ?, ?, 'user-a', '2026-08-20T00:00:00.000Z')`).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.sourceAgreementId,
    input.targetAgreementId,
    input.relationshipType ?? "related",
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
    return responseJson({ error: { code: "version_conflict", message: "The linked record changed." }, requestId }, { status: 409, headers });
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
    if (specifier === "../../../../../db") return { getDb: () => db };
    if (specifier === "../../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../../db/schema") return schema;
    if (specifier === "../../../../lib/api") return {
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
          requestId: "request-relationships",
          headers: new Headers(),
        };
      },
    };
    if (specifier === "../../../../lib/enterprise-domain") return enterpriseDomain;
    if (specifier === "../../../../lib/enterprise-api") return {
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
    if (specifier === "../../../../lib/http") return { apiJson: responseJson };
    if (specifier === "../../../../lib/validation") return {
      parseJson: async (request: Request, validationSchema: { safeParse(value: unknown): { success: boolean; data?: unknown } }) => {
        const parsed = validationSchema.safeParse(await request.json());
        if (!parsed.success) throw new enterpriseDomain.EnterpriseError(400, "validation_failed", "Request validation failed.");
        return parsed.data;
      },
    };
    throw new Error(`Unexpected relationship route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, crypto, console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/agreements/[id]/relationships/route.cjs" }).runInContext(context);
  type Context = { params: Promise<{ id: string }> };
  type Handler = (request: Request, context: Context) => Promise<Response>;
  const handlers = moduleObject.exports as Record<"GET" | "POST" | "DELETE", Handler>;
  const call = async (method: keyof typeof handlers, agreementId: number | string, body?: unknown) => {
    const response = await handlers[method](new Request(`https://notice.test/api/agreements/${agreementId}/relationships`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }), { params: Promise.resolve({ id: String(agreementId) }) });
    return { response, body: await response.json() as Record<string, unknown> };
  };
  return {
    permissions,
    setIdentity(nextWorkspaceId: string, nextUserId: string, nextRole = "legal") { workspaceId = nextWorkspaceId; userId = nextUserId; role = nextRole; },
    setAuthorized(next: boolean) { authorized = next; },
    beforeNextMutation(hook: () => void) { beforeMutationOnce = hook; },
    get: (agreementId: number | string) => call("GET", agreementId),
    post: (agreementId: number | string, body: unknown) => call("POST", agreementId, body),
    delete: (agreementId: number | string, body: unknown) => call("DELETE", agreementId, body),
  };
}

function seedAgreementsAndDirectory(database: DatabaseSync): void {
  seedAgreement(database, 1);
  seedAgreement(database, 2);
  seedAgreement(database, 3, "workspace-a", "2026-08-19T00:00:00.000Z");
  seedAgreement(database, 4, "workspace-b");
  seedDirectory(database);
}

test("relationship authorization is enforced with separate read and update permissions", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database);
    harness.setAuthorized(false);
    assert.equal((await harness.get(1)).response.status, 403);
    assert.equal((await harness.post(1, { action: "add_relationship", targetAgreementId: 2, relationshipType: "related" })).response.status, 403);
    assert.equal((await harness.delete(1, { kind: "relationship", id: RELATIONSHIP_OUTBOUND, reason: "No longer applies" })).response.status, 403);
    assert.deepEqual(harness.permissions, ["agreement:read", "agreement:update", "agreement:update"]);
  } finally {
    database.close();
  }
});

test("relationship reads are tenant-scoped and omit links whose other agreement is soft-deleted", async () => {
  const database = createDatabase();
  try {
    seedAgreementsAndDirectory(database);
    seedParty(database, { id: PARTY_A, agreementId: 1, legalEntityId: ENTITY_A, primary: true });
    seedParty(database, { id: PARTY_OTHER_TENANT, workspaceId: "workspace-b", agreementId: 1, legalEntityId: ENTITY_B });
    seedRelationship(database, { id: RELATIONSHIP_OUTBOUND, sourceAgreementId: 1, targetAgreementId: 2, relationshipType: "master" });
    seedRelationship(database, { id: RELATIONSHIP_INBOUND, sourceAgreementId: 2, targetAgreementId: 1, relationshipType: "amends" });
    seedRelationship(database, { id: RELATIONSHIP_DELETED_TARGET, sourceAgreementId: 1, targetAgreementId: 3, relationshipType: "related" });
    seedRelationship(database, { id: RELATIONSHIP_OTHER_TENANT, workspaceId: "workspace-b", sourceAgreementId: 1, targetAgreementId: 4, relationshipType: "related" });
    const harness = routeHarness(database);
    const loaded = await harness.get(1);
    assert.equal(loaded.response.status, 200, JSON.stringify(loaded.body));
    const parties = loaded.body.parties as Array<{ id: string; targetType: string; target: { id: string } }>;
    assert.deepEqual(parties.map((row) => row.id), [PARTY_A]);
    assert.equal(parties[0]?.targetType, "legal_entity");
    assert.equal(parties[0]?.target.id, ENTITY_A);
    const relationships = loaded.body.relationships as Array<{ id: string; direction: string }>;
    assert.deepEqual(relationships.map((row) => row.id).sort(), [RELATIONSHIP_INBOUND, RELATIONSHIP_OUTBOUND].sort());
    assert.equal(relationships.find((row) => row.id === RELATIONSHIP_OUTBOUND)?.direction, "outbound");
    assert.equal(relationships.find((row) => row.id === RELATIONSHIP_INBOUND)?.direction, "inbound");
    assert.deepEqual(loaded.body.page, {
      parties: { limit: 200, hasMore: false },
      relationships: { limit: 200, hasMore: false },
    });

    assert.equal((await harness.get(3)).response.status, 404);
    assert.equal((await harness.get(4)).response.status, 404);
  } finally {
    database.close();
  }
});

test("relationship reads are deterministically bounded and disclose truncation", async () => {
  const database = createDatabase();
  try {
    seedAgreement(database, 1);
    for (let id = 10; id <= 210; id += 1) {
      seedAgreement(database, id);
      seedRelationship(database, {
        id: `${id.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        sourceAgreementId: 1,
        targetAgreementId: id,
      });
    }
    const loaded = await routeHarness(database).get(1);
    assert.equal(loaded.response.status, 200);
    const relationships = loaded.body.relationships as Array<{ id: string }>;
    assert.equal(relationships.length, 200);
    assert.equal((loaded.body.page as { relationships: { hasMore: boolean } }).relationships.hasMore, true);
    assert.deepEqual(relationships.map((row) => row.id), [...relationships.map((row) => row.id)].sort(),
      "the bounded projection has an explicit deterministic order");
  } finally {
    database.close();
  }
});

test("party creation enforces role-target semantics, active tenant scope, duplicates, and one primary per role", async () => {
  const database = createDatabase();
  try {
    seedAgreementsAndDirectory(database);
    const harness = routeHarness(database);
    const wrongSemanticTarget = await harness.post(1, {
      action: "add_party", role: "our_entity", targetType: "counterparty", targetId: COUNTERPARTY_A, primary: true,
    });
    assert.equal(wrongSemanticTarget.response.status, 422);
    assert.equal((wrongSemanticTarget.body.error as { code: string }).code, "party_target_type_mismatch");

    for (const targetId of [ENTITY_A_INACTIVE, ENTITY_B, COUNTERPARTY_A]) {
      const invalid = await harness.post(1, {
        action: "add_party", role: "guarantor", targetType: "legal_entity", targetId, primary: false,
      });
      assert.equal(invalid.response.status, 404);
      assert.equal((invalid.body.error as { code: string }).code, "party_target_not_found");
    }

    const created = await harness.post(1, {
      action: "add_party", role: "guarantor", targetType: "legal_entity", targetId: ENTITY_A, primary: true,
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const party = created.body.party as { legalEntityId: string | null; counterpartyId: string | null; primary: boolean };
    assert.equal(party.legalEntityId, ENTITY_A);
    assert.equal(party.counterpartyId, null);
    assert.equal(party.primary, true);

    const duplicate = await harness.post(1, {
      action: "add_party", role: "guarantor", targetType: "legal_entity", targetId: ENTITY_A, primary: false,
    });
    assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.body));
    assert.equal((duplicate.body.error as { code: string }).code, "agreement_party_exists");

    const primaryConflict = await harness.post(1, {
      action: "add_party", role: "guarantor", targetType: "legal_entity", targetId: ENTITY_A_SECOND, primary: true,
    });
    assert.equal(primaryConflict.response.status, 409, JSON.stringify(primaryConflict.body));
    assert.equal((primaryConflict.body.error as { code: string }).code, "agreement_party_exists");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_parties WHERE workspace_id = 'workspace-a'").get()?.count, 1);
  } finally {
    database.close();
  }
});

test("relationship creation rejects self, cross-tenant, deleted, invalid, and duplicate targets", async () => {
  const database = createDatabase();
  try {
    seedAgreementsAndDirectory(database);
    const harness = routeHarness(database);
    const self = await harness.post(1, { action: "add_relationship", targetAgreementId: 1, relationshipType: "related" });
    assert.equal(self.response.status, 400);
    assert.equal((self.body.error as { code: string }).code, "self_relationship");
    assert.equal((await harness.post(1, { action: "add_relationship", targetAgreementId: 3, relationshipType: "related" })).response.status, 404);
    assert.equal((await harness.post(1, { action: "add_relationship", targetAgreementId: 4, relationshipType: "related" })).response.status, 404);
    assert.equal((await harness.post(1, { action: "add_relationship", targetAgreementId: 2, relationshipType: "unsupported" })).response.status, 400);

    const created = await harness.post(1, { action: "add_relationship", targetAgreementId: 2, relationshipType: "master" });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const duplicate = await harness.post(1, { action: "add_relationship", targetAgreementId: 2, relationshipType: "master" });
    assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.body));
    assert.equal((duplicate.body.error as { code: string }).code, "agreement_relationship_exists");
  } finally {
    database.close();
  }
});

test("party and relationship deletes require an exact scoped row and support inbound relationship removal", async () => {
  const database = createDatabase();
  try {
    seedAgreementsAndDirectory(database);
    seedParty(database, { id: PARTY_A, agreementId: 1, legalEntityId: ENTITY_A });
    seedParty(database, { id: PARTY_OTHER_TENANT, workspaceId: "workspace-b", agreementId: 4, legalEntityId: ENTITY_B });
    seedRelationship(database, { id: RELATIONSHIP_INBOUND, sourceAgreementId: 2, targetAgreementId: 1, relationshipType: "amends" });
    const harness = routeHarness(database);

    const wrongParty = await harness.delete(1, { kind: "party", id: PARTY_OTHER_TENANT, reason: "Not linked here" });
    assert.equal(wrongParty.response.status, 409);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_parties WHERE id = ?").get(PARTY_OTHER_TENANT)?.count, 1);
    const wrongRelationship = await harness.delete(2, { kind: "relationship", id: RELATIONSHIP_OUTBOUND, reason: "Not linked here" });
    assert.equal(wrongRelationship.response.status, 409);

    const removedParty = await harness.delete(1, { kind: "party", id: PARTY_A, reason: "No longer applies" });
    assert.equal(removedParty.response.status, 200);
    const removedInbound = await harness.delete(1, { kind: "relationship", id: RELATIONSHIP_INBOUND, reason: "No longer applies" });
    assert.equal(removedInbound.response.status, 200);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_relationships WHERE id = ?").get(RELATIONSHIP_INBOUND)?.count, 0);

    const softDeletedBase = await harness.delete(3, { kind: "party", id: PARTY_A, reason: "No longer applies" });
    assert.equal(softDeletedBase.response.status, 404);
    harness.setIdentity("workspace-b", "user-b");
    const crossTenant = await harness.delete(1, { kind: "party", id: PARTY_A, reason: "No longer applies" });
    assert.equal(crossTenant.response.status, 404);
  } finally {
    database.close();
  }
});

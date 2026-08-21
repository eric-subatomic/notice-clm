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

type AgreementListBody = Readonly<{
  agreements: Array<{
    id: number;
    party: string;
    side: string;
    stage: string;
    risk: string;
    value: number;
    valueMinor: number;
    currencyCode: string;
    updatedAt: string;
  }>;
  totalMatched: number;
  nextCursor: string | null;
  hasMore: boolean;
  error?: { code: string; message: string };
}>;

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
    const statement = this.database.prepare(this.query);
    return statement.all(...this.bindings).map((row) => Object.values(row) as T);
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, query);
  }
}

function createAgreementDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE agreements (
      id integer PRIMARY KEY,
      workspace_id text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      party text NOT NULL DEFAULT '',
      initials text NOT NULL DEFAULT '',
      side text NOT NULL DEFAULT 'Sell-side',
      type text NOT NULL DEFAULT '',
      value integer NOT NULL DEFAULT 0,
      value_minor integer NOT NULL DEFAULT 0,
      currency_code text NOT NULL DEFAULT 'USD',
      stage text NOT NULL DEFAULT 'Intake',
      owner text NOT NULL DEFAULT '',
      owner_user_id text,
      primary_counterparty_id text,
      legal_entity_id text,
      governed_template_version_id text,
      workflow_definition_id text,
      workflow_policy_sha256 text,
      workflow_approval_lanes text,
      next_action text NOT NULL DEFAULT '',
      due text NOT NULL DEFAULT '',
      crm text NOT NULL DEFAULT 'None',
      crm_record text NOT NULL DEFAULT '',
      tags text NOT NULL DEFAULT '[]',
      updated text NOT NULL DEFAULT '',
      created_at text NOT NULL DEFAULT '',
      updated_at text NOT NULL DEFAULT '',
      created_by_user_id text,
      updated_by_user_id text,
      legal_hold integer NOT NULL DEFAULT 0,
      retention_until text,
      deleted_at text,
      department text NOT NULL DEFAULT 'Legal',
      risk text NOT NULL DEFAULT 'Unassessed',
      risk_disposition text,
      risk_basis_hash text,
      risk_document_version integer,
      risk_document_sha256 text,
      risk_decision_reason text,
      risk_decided_by_user_id text,
      risk_decided_at text,
      approval_status text NOT NULL DEFAULT 'Required',
      signature_status text NOT NULL DEFAULT 'Not sent',
      effective_date text NOT NULL DEFAULT '',
      expiration_date text NOT NULL DEFAULT ''
    );
  `);
  return database;
}

type AgreementSeed = Readonly<{
  id: number;
  workspaceId?: string;
  party?: string;
  type?: string;
  owner?: string;
  tags?: readonly string[];
  side?: string;
  stage?: string;
  risk?: string;
  value?: number;
  valueMinor?: number;
  currencyCode?: string;
  updatedAt?: string;
  createdAt?: string;
  deletedAt?: string | null;
}>;

function insertAgreement(database: DatabaseSync, input: AgreementSeed): void {
  database.prepare(`INSERT INTO agreements (
    id, workspace_id, party, initials, side, type, value, value_minor, currency_code, stage, owner,
    tags, updated, created_at, updated_at, deleted_at, risk
  ) VALUES (?, ?, ?, 'NA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.party ?? `Party ${input.id}`,
    input.side ?? "Sell-side",
    input.type ?? "Services Agreement",
    input.value ?? input.id,
    input.valueMinor ?? (input.value ?? input.id) * 100,
    input.currencyCode ?? "USD",
    input.stage ?? "Review",
    input.owner ?? "Legal Owner",
    JSON.stringify(input.tags ?? []),
    input.updatedAt ?? "2026-08-19T12:00:00.000Z",
    input.createdAt ?? "2026-01-01T00:00:00.000Z",
    input.updatedAt ?? "2026-08-19T12:00:00.000Z",
    input.deletedAt ?? null,
    input.risk ?? "Unassessed",
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit } = {}): Response {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function routeHarness(database: DatabaseSync, initialWorkspaceId = "workspace-a") {
  let workspaceId = initialWorkspaceId;
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const fallbackModule = new Proxy<Record<string, unknown>>({}, {
    get: () => () => {
      throw new Error("An unrelated route dependency was invoked by agreement GET");
    },
  });
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "cloudflare:workers") return { env: {} };
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "zod") return { z };
    if (specifier === "../../../db") return { getDb: () => db };
    if (specifier === "../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../db/schema") return schema;
    if (specifier === "../../lib/api") {
      return {
        authorizeApiRequest: async () => ({
          ok: true,
          context: { workspace: { id: workspaceId }, user: { id: "user-a" } },
          requestId: "request-agreement-page",
          headers: new Headers(),
        }),
        handleRouteError: (error: unknown) => {
          throw error;
        },
      };
    }
    if (specifier === "../../lib/document-security") return { sha256Hex };
    if (specifier === "../../lib/http") {
      return {
        apiJson: responseJson,
        apiError: (code: string, message: string, options: { status: number; headers?: HeadersInit }) => responseJson({
          error: { code, message },
          requestId: "request-agreement-page",
        }, options),
      };
    }
    return fallbackModule;
  };
  const context = vm.createContext({
    module: moduleObject,
    exports: moduleObject.exports,
    require: requireModule,
    Request,
    Response,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto,
    btoa,
    atob,
    console,
  });
  new vm.Script(compiledRoute, { filename: "app/api/agreements/route.cjs" }).runInContext(context);
  const get = moduleObject.exports.GET as (request: Request) => Promise<Response>;
  return {
    setWorkspaceId(next: string) {
      workspaceId = next;
    },
    async request(parameters = ""): Promise<{ response: Response; body: AgreementListBody }> {
      const response = await get(new Request(`https://notice.test/api/agreements${parameters ? `?${parameters}` : ""}`));
      return { response, body: await response.json() as AgreementListBody };
    },
  };
}

test("agreement list source keeps every page and count tenant-scoped, live-only, and keyset ordered", () => {
  const get = routeSource.slice(routeSource.indexOf("export async function GET"), routeSource.indexOf("export async function POST"));
  assert.ok((get.match(/eq\(agreements\.workspaceId, auth\.context\.workspace\.id\)/g) ?? []).length >= 1);
  assert.ok((get.match(/isNull\(agreements\.deletedAt\)/g) ?? []).length >= 1);
  assert.match(get, /max\(\$\{agreements\.id\}\)/);
  assert.match(get, /lte\(agreements\.id, anchorId\)/);
  assert.match(get, /lte\(agreements\.createdAt, snapshotAt\)/);
  assert.match(get, /agreementListCursorCondition\(query\.sort, cursor\)/);
  assert.match(get, /totalMatched,[\s\S]*nextCursor,[\s\S]*hasMore/);
  assert.match(routeSource, /record\.b !== expectedBinding[\s\S]*record\.c !== expectedChecksum/);
  assert.match(routeSource, /workspaceId,[\s\S]*q: query\.q,[\s\S]*sort: query\.sort,[\s\S]*limit: query\.limit/);
  assert.match(routeSource, /json_each\(case when json_valid\(\$\{agreements\.tags\}\)/);
});

test("default paging returns every pre-anchor agreement once across an estate larger than 200", async () => {
  const database = createAgreementDatabase();
  try {
    const originalIds = Array.from({ length: 256 }, (_, index) => index + 1).filter((id) => id !== 150);
    for (const id of originalIds) {
      insertAgreement(database, {
        id,
        updatedAt: `2026-08-${String(1 + Math.floor((id - 1) / 50)).padStart(2, "0")}T12:00:00.000Z`,
      });
    }
    insertAgreement(database, { id: 300, party: "Deleted tenant A", deletedAt: "2026-08-19T00:00:00.000Z" });
    insertAgreement(database, { id: 1_000, workspaceId: "workspace-b", party: "Tenant B" });
    const harness = routeHarness(database);

    const first = await harness.request();
    assert.equal(first.response.status, 200);
    assert.equal(first.body.agreements.length, 200, "the no-query client contract retains its 200-row first page");
    assert.equal(first.body.totalMatched, 255);
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.nextCursor);

    insertAgreement(database, {
      id: 5_000,
      party: "Inserted after page one",
      updatedAt: "2027-01-01T00:00:00.000Z",
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });
    insertAgreement(database, {
      id: 150,
      party: "Inserted after page one with a lower ID",
      updatedAt: "2025-01-01T00:00:00.000Z",
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const second = await harness.request(`cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.totalMatched, 255, "the page-one insertion fence excludes later higher-ID inserts from this live traversal");
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.nextCursor, null);
    const repeatedSecond = await harness.request(`cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    assert.deepEqual(
      repeatedSecond.body.agreements.map((agreement) => agreement.id),
      second.body.agreements.map((agreement) => agreement.id),
      "reusing an unchanged cursor is deterministic",
    );
    assert.equal(repeatedSecond.body.totalMatched, second.body.totalMatched);

    const ids = [...first.body.agreements, ...second.body.agreements].map((agreement) => agreement.id);
    assert.equal(ids.length, 255);
    assert.equal(new Set(ids).size, 255, "equal sort values use the ID tie-break without duplication");
    assert.deepEqual([...ids].sort((left, right) => left - right), originalIds);
    assert.equal(ids.includes(300), false, "soft-deleted agreements never enter a page");
    assert.equal(ids.includes(1_000), false, "another workspace never enters a page");
    assert.equal(ids.includes(5_000), false, "post-anchor inserts never enter a later page");
    assert.equal(ids.includes(150), false, "the creation cutoff also excludes a later insert whose ID is below the anchor");
  } finally {
    database.close();
  }
});

test("search, filters, and all three sorts execute on the server with canonical money and deterministic ID ties", async () => {
  const database = createAgreementDatabase();
  try {
    insertAgreement(database, { id: 1, party: "Needle Counterparty", risk: "Low", value: 100 });
    insertAgreement(database, { id: 2, type: "Needle License", risk: "Medium", value: 100 });
    insertAgreement(database, { id: 3, owner: "Needle Owner", risk: "High", value: 50 });
    insertAgreement(database, { id: 4, tags: ["priority", "needle-tag"], risk: "High", value: 100 });
    insertAgreement(database, { id: 5, party: "Literal % counterparty", risk: "Unassessed", value: 1 });
    insertAgreement(database, { id: 8, party: "Fractional USD 1.49", value: 1, valueMinor: 149 });
    insertAgreement(database, { id: 9, party: "Fractional USD 1.40", value: 1, valueMinor: 140 });
    insertAgreement(database, { id: 10, party: "JPY group", value: 900, valueMinor: 900, currencyCode: "JPY" });
    insertAgreement(database, { id: 11, party: "EUR group", value: 2, valueMinor: 200, currencyCode: "EUR" });
    insertAgreement(database, {
      id: 6,
      side: "Buy-side",
      stage: "Review",
      risk: "High",
      value: 100,
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    insertAgreement(database, {
      id: 7,
      side: "Buy-side",
      stage: "Active",
      risk: "High",
      value: 100,
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    insertAgreement(database, { id: 20, workspaceId: "workspace-b", party: "Needle other tenant" });
    insertAgreement(database, { id: 21, party: "Needle deleted", deletedAt: "2026-08-21T00:00:00.000Z" });
    const harness = routeHarness(database);

    const searched = await harness.request("q=needle");
    assert.equal(searched.body.totalMatched, 4);
    assert.deepEqual(new Set(searched.body.agreements.map((agreement) => agreement.id)), new Set([1, 2, 3, 4]));
    const literalWildcard = await harness.request(`q=${encodeURIComponent("%")}`);
    assert.deepEqual(literalWildcard.body.agreements.map((agreement) => agreement.id), [5], "LIKE metacharacters are literal search input");

    const filtered = await harness.request("side=Buy-side&stage=Review&risk=High");
    assert.deepEqual(filtered.body.agreements.map((agreement) => agreement.id), [6]);

    const byValue = await harness.request("sort=Value");
    const expectedValueOrder = [11, 10, 7, 6, 4, 2, 1, 3, 8, 9, 5];
    assert.deepEqual(
      byValue.body.agreements.map((agreement) => agreement.id),
      expectedValueOrder,
      "currencies are grouped by code and exact minor units sort within each group",
    );
    const oneAtATime: number[] = [];
    let valueCursor: string | null = null;
    do {
      const page = await harness.request(`sort=Value&limit=1${valueCursor ? `&cursor=${encodeURIComponent(valueCursor)}` : ""}`);
      assert.equal(page.response.status, 200);
      oneAtATime.push(...page.body.agreements.map((agreement) => agreement.id));
      valueCursor = page.body.nextCursor;
    } while (valueCursor);
    assert.deepEqual(oneAtATime, expectedValueOrder, "the keyset preserves fractional amounts and currency boundaries");
    const byRisk = await harness.request("sort=Risk");
    assert.deepEqual(byRisk.body.agreements.map((agreement) => agreement.id), [7, 6, 4, 3, 2, 1, 11, 10, 9, 8, 5]);
    const byUpdated = await harness.request("sort=Updated");
    assert.deepEqual(byUpdated.body.agreements.slice(0, 2).map((agreement) => agreement.id), [7, 6]);
  } finally {
    database.close();
  }
});

test("agreement cursors reject malformed, tampered, query-mismatched, and cross-tenant reuse with one stable error", async () => {
  const database = createAgreementDatabase();
  try {
    for (let id = 1; id <= 6; id += 1) insertAgreement(database, { id, value: 10 });
    for (let id = 101; id <= 103; id += 1) insertAgreement(database, { id, workspaceId: "workspace-b", value: 10 });
    const harness = routeHarness(database);
    const first = await harness.request("sort=Value&limit=2");
    assert.ok(first.body.nextCursor);
    const cursor = first.body.nextCursor!;

    const invalidRequests = [
      "cursor=not*base64",
      `sort=Value&limit=2&cursor=${encodeURIComponent(`${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`)}`,
      `sort=Risk&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `sort=Value&limit=3&cursor=${encodeURIComponent(cursor)}`,
      `sort=Value&limit=2&q=party&cursor=${encodeURIComponent(cursor)}`,
      `sort=Value&limit=2&cursor=${encodeURIComponent(cursor)}&cursor=${encodeURIComponent(cursor)}`,
    ];
    for (const parameters of invalidRequests) {
      const invalid = await harness.request(parameters);
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.body.error?.code, "invalid_cursor");
    }

    harness.setWorkspaceId("workspace-b");
    const crossTenant = await harness.request(`sort=Value&limit=2&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(crossTenant.response.status, 400);
    assert.equal(crossTenant.body.error?.code, "invalid_cursor");
    const tenantPage = await harness.request("sort=Value&limit=10");
    assert.deepEqual(tenantPage.body.agreements.map((agreement) => agreement.id), [103, 102, 101]);

    for (const parameters of ["limit=201", "limit=02", "sort=Newest", "side=External", "unknown=true"]) {
      const invalid = await harness.request(parameters);
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.body.error?.code, "invalid_query");
    }
  } finally {
    database.close();
  }
});

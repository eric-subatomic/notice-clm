import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import ts from "typescript";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";
import { boundedWorkItemCount, WORK_ITEM_MAX_LIMIT, WORK_ITEM_SUMMARY_COUNT_CAP } from "../app/lib/work-item-pagination";

type WorkItemBody = Readonly<{
  resource?: string;
  items?: Array<Record<string, unknown>>;
  page?: Readonly<{
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
    snapshotAt: string;
  }>;
  summary?: Readonly<{
    totalMatched: number;
    totalMatchedCapped: boolean;
    statusCounts: Array<Readonly<{ status: string; count: number; capped: boolean }>>;
  }>;
  error?: Readonly<{ code: string; message: string }>;
}>;

const helperSource = await readFile(new URL("../app/lib/work-item-pagination.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/work-items/route.ts", import.meta.url), "utf8");

function compile(source: string, fileName: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName,
  }).outputText;
}

const compiledHelper = compile(helperSource, "app/lib/work-item-pagination.ts");
const compiledRoute = compile(routeSource, "app/api/work-items/route.ts");

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

function createWorkItemDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE agreements (
      id integer PRIMARY KEY,
      workspace_id text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      party text NOT NULL,
      side text NOT NULL DEFAULT 'Sell-side',
      type text NOT NULL DEFAULT 'Services Agreement',
      value integer NOT NULL DEFAULT 0,
      stage text NOT NULL DEFAULT 'Review',
      owner text NOT NULL DEFAULT '',
      owner_user_id text,
      risk text NOT NULL DEFAULT 'Unassessed',
      deleted_at text
    );

    CREATE TABLE approval_requests (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      agreement_id integer NOT NULL,
      basis_hash text NOT NULL DEFAULT '',
      document_version integer NOT NULL DEFAULT 0,
      document_sha256 text NOT NULL DEFAULT '',
      role text NOT NULL,
      requested_by_user_id text NOT NULL DEFAULT '',
      approver text NOT NULL,
      approver_user_id text,
      status text NOT NULL,
      decided_by_user_id text,
      decided_at text,
      basis_confirmed_at text,
      comment text,
      due text NOT NULL,
      created_at text NOT NULL
    );

    CREATE TABLE signature_packets (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      basis_hash text NOT NULL DEFAULT '',
      document_version integer NOT NULL DEFAULT 0,
      document_sha256 text NOT NULL DEFAULT '',
      provider text NOT NULL,
      status text NOT NULL,
      signers text NOT NULL,
      evidence_document_id text,
      version integer NOT NULL DEFAULT 1,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      completed_at text
    );

    CREATE TABLE obligations (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      agreement_id integer NOT NULL,
      schedule_id text NOT NULL,
      occurrence_number integer NOT NULL,
      title text NOT NULL,
      due_date text NOT NULL,
      owner text NOT NULL,
      owner_user_id text,
      status text NOT NULL,
      completed_by_user_id text,
      completed_at text,
      completion_evidence text,
      cadence text NOT NULL,
      source text NOT NULL,
      timezone text NOT NULL,
      reminder_lead_days text NOT NULL,
      next_reminder_date text,
      created_by_user_id text,
      created_at text NOT NULL
    );

    CREATE TABLE obligation_schedules (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      version integer NOT NULL DEFAULT 1,
      title text NOT NULL,
      source text NOT NULL,
      owner_user_id text,
      owner text NOT NULL,
      timezone text NOT NULL,
      recurrence_unit text NOT NULL,
      recurrence_interval integer NOT NULL,
      anchor_date text NOT NULL,
      end_date text,
      reminder_lead_days text NOT NULL,
      status text NOT NULL,
      next_occurrence_number integer,
      next_occurrence_date text,
      next_materialization_date text,
      supersedes_schedule_id text,
      created_by_user_id text,
      created_at text NOT NULL,
      updated_by_user_id text,
      updated_at text NOT NULL
    );

    CREATE TABLE agreement_events (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      type text NOT NULL,
      actor_user_id text,
      actor_email text,
      actor text NOT NULL,
      detail text NOT NULL,
      sequence integer NOT NULL,
      source_agent_plan_id text,
      created_at text NOT NULL
    );
  `);
  return database;
}

function insertAgreement(
  database: DatabaseSync,
  id: number,
  workspaceId = "workspace-a",
  options: Readonly<{ party?: string; owner?: string; ownerUserId?: string | null; deletedAt?: string | null }> = {},
): void {
  database.prepare(`INSERT INTO agreements (
    id, workspace_id, party, owner, owner_user_id, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      workspaceId,
      options.party ?? `Party ${id}`,
      options.owner ?? "Alice Legal",
      options.ownerUserId === undefined ? (workspaceId === "workspace-a" ? "user-a" : "user-b") : options.ownerUserId,
      options.deletedAt ?? null,
    );
}

type ApprovalSeed = Readonly<{
  id: string;
  workspaceId?: string;
  agreementId?: number;
  status?: string;
  approver?: string;
  approverUserId?: string | null;
  role?: string;
  due?: string;
  createdAt?: string;
}>;

function insertApproval(database: DatabaseSync, input: ApprovalSeed): void {
  database.prepare(`INSERT INTO approval_requests (
    id, workspace_id, agreement_id, role, requested_by_user_id, approver,
    approver_user_id, status, due, created_at
  ) VALUES (?, ?, ?, ?, 'requester', ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.workspaceId ?? "workspace-a",
      input.agreementId ?? 1,
      input.role ?? "Security review",
      input.approver ?? "Alice Legal",
      input.approverUserId === undefined ? "user-a" : input.approverUserId,
      input.status ?? "Pending",
      input.due ?? "2026-09-01",
      input.createdAt ?? "2026-08-20T12:00:00.000Z",
    );
}

function insertSignature(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  agreementId?: number;
  provider?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}>): void {
  database.prepare(`INSERT INTO signature_packets (
    id, workspace_id, agreement_id, provider, status, signers, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.workspaceId ?? "workspace-a",
      input.agreementId ?? 1,
      input.provider ?? "DocuSeal",
      input.status ?? "pending",
      JSON.stringify([{ role: "Signer", email: "signer@example.com", status: "pending", signingUrl: "secret" }]),
      input.createdAt ?? "2026-08-18T00:00:00.000Z",
      input.updatedAt ?? "2026-08-20T00:00:00.000Z",
    );
}

function insertObligation(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  agreementId?: number;
  owner?: string;
  ownerUserId?: string | null;
  status?: string;
  title?: string;
  dueDate?: string;
  createdAt?: string;
}>): void {
  database.prepare(`INSERT INTO obligations (
    id, workspace_id, agreement_id, schedule_id, occurrence_number, title,
    due_date, owner, owner_user_id, status, cadence, source, timezone,
    reminder_lead_days, created_at
  ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'Monthly', 'Contract terms', 'UTC', '[7]', ?)`)
    .run(
      input.id,
      input.workspaceId ?? "workspace-a",
      input.agreementId ?? 1,
      `schedule-${input.id}`,
      input.title ?? "Renewal notice",
      input.dueDate ?? "2026-09-01",
      input.owner ?? "Alice Legal",
      input.ownerUserId === undefined ? "user-a" : input.ownerUserId,
      input.status ?? "Open",
      input.createdAt ?? "2026-08-15T00:00:00.000Z",
    );
}

function insertSchedule(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  agreementId?: number;
  owner?: string;
  ownerUserId?: string | null;
  status?: string;
  title?: string;
  nextOccurrenceDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
}>): void {
  const nextDate = input.nextOccurrenceDate === undefined ? "2026-09-01" : input.nextOccurrenceDate;
  database.prepare(`INSERT INTO obligation_schedules (
    id, workspace_id, agreement_id, title, source, owner_user_id, owner,
    timezone, recurrence_unit, recurrence_interval, anchor_date,
    reminder_lead_days, status, next_occurrence_number,
    next_occurrence_date, next_materialization_date, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'Contract terms', ?, ?, 'UTC', 'month', 1,
    '2026-01-01', '[7]', ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.workspaceId ?? "workspace-a",
      input.agreementId ?? 1,
      input.title ?? "Renewal schedule",
      input.ownerUserId === undefined ? "user-a" : input.ownerUserId,
      input.owner ?? "Alice Legal",
      input.status ?? "active",
      nextDate === null ? null : 1,
      nextDate,
      nextDate,
      input.createdAt ?? "2026-08-01T00:00:00.000Z",
      input.updatedAt ?? "2026-08-20T00:00:00.000Z",
    );
}

function insertEvent(database: DatabaseSync, input: Readonly<{
  id: string;
  workspaceId?: string;
  agreementId?: number;
  type?: string;
  actor?: string;
  actorUserId?: string | null;
  detail?: string;
  sequence?: number;
  createdAt?: string;
}>): void {
  database.prepare(`INSERT INTO agreement_events (
    id, workspace_id, agreement_id, type, actor_user_id, actor_email,
    actor, detail, sequence, created_at
  ) VALUES (?, ?, ?, ?, ?, 'alice@example.com', ?, ?, ?, ?)`)
    .run(
      input.id,
      input.workspaceId ?? "workspace-a",
      input.agreementId ?? 1,
      input.type ?? "agreement.updated",
      input.actorUserId === undefined ? "user-a" : input.actorUserId,
      input.actor ?? "Alice Legal",
      input.detail ?? "Security terms updated",
      input.sequence ?? 1,
      input.createdAt ?? "2026-08-20T00:00:00.000Z",
    );
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit } = {}): Response {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function sanitizeSignaturePacket(packet: Record<string, unknown>): Record<string, unknown> {
  const signers = Array.isArray(packet.signers) ? packet.signers.map((candidate) => {
    const signer = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    return Object.fromEntries(["role", "email", "name", "submitterId", "status"]
      .filter((key) => key in signer).map((key) => [key, signer[key]]));
  }) : [];
  return { ...packet, signers };
}

function routeHarness(database: DatabaseSync) {
  let workspaceId = "workspace-a";
  let userId = "user-a";
  let displayName = "Alice Legal";
  const permissions: string[] = [];
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const context = vm.createContext({
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

  const helperModule: { exports: Record<string, unknown> } = { exports: {} };
  const helperWrapper = new vm.Script(
    `(function (require, module, exports) { ${compiledHelper}\n})`,
    { filename: "app/lib/work-item-pagination.cjs" },
  ).runInContext(context) as (require: (specifier: string) => unknown, module: typeof helperModule, exports: Record<string, unknown>) => void;
  helperWrapper(() => ({}), helperModule, helperModule.exports);

  const routeModule: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "../../../db") return { getDb: () => db };
    if (specifier === "../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../db/schema") return schema;
    if (specifier === "../../lib/work-item-pagination") return helperModule.exports;
    if (specifier === "../../lib/signature-evidence") return { sanitizeSignaturePacket };
    if (specifier === "../../lib/api") {
      return {
        authorizeApiRequest: async (_request: Request, permission: string) => {
          permissions.push(permission);
          return {
            ok: true,
            context: {
              workspace: { id: workspaceId, name: workspaceId },
              user: { id: userId, displayName },
              permissions: new Set([permission]),
            },
            requestId: "request-work-items",
            headers: new Headers(),
          };
        },
        handleRouteError: (error: unknown) => {
          throw error;
        },
      };
    }
    if (specifier === "../../lib/http") {
      return {
        apiJson: responseJson,
        apiError: (code: string, message: string, options: { status: number; headers?: HeadersInit }) => responseJson({
          error: { code, message },
          requestId: "request-work-items",
        }, options),
      };
    }
    throw new Error(`Unexpected work-item route dependency: ${specifier}`);
  };
  const routeWrapper = new vm.Script(
    `(function (require, module, exports) { ${compiledRoute}\n})`,
    { filename: "app/api/work-items/route.cjs" },
  ).runInContext(context) as (require: (specifier: string) => unknown, module: typeof routeModule, exports: Record<string, unknown>) => void;
  routeWrapper(requireModule, routeModule, routeModule.exports);
  const get = routeModule.exports.GET as (request: Request) => Promise<Response>;

  return {
    permissions,
    setIdentity(nextWorkspaceId: string, nextUserId = "user-a", nextDisplayName = "Alice Legal") {
      workspaceId = nextWorkspaceId;
      userId = nextUserId;
      displayName = nextDisplayName;
    },
    async request(parameters: string): Promise<{ response: Response; body: WorkItemBody }> {
      const response = await get(new Request(`https://notice.test/api/work-items?${parameters}`));
      return { response, body: await response.json() as WorkItemBody };
    },
  };
}

test("work-item limits and summary counts stay explicitly bounded", () => {
  assert.equal(WORK_ITEM_MAX_LIMIT, 200);
  assert.equal(WORK_ITEM_SUMMARY_COUNT_CAP, 100_000);
  assert.deepEqual(boundedWorkItemCount(99_999), { count: 99_999, capped: false });
  assert.deepEqual(boundedWorkItemCount(100_001), { count: 100_000, capped: true });
});

test("work-item pagination fences later inserts across more than 200 live rows", async () => {
  const database = createWorkItemDatabase();
  try {
    insertAgreement(database, 1);
    insertAgreement(database, 2, "workspace-a", { party: "Deleted party", deletedAt: "2026-08-19T00:00:00.000Z" });
    insertAgreement(database, 3, "workspace-b", { party: "Tenant B" });
    const originalIds = Array.from({ length: 231 }, (_, index) => `approval-${String(index + 1).padStart(4, "0")}`);
    for (const [index, id] of originalIds.entries()) {
      insertApproval(database, { id, status: index % 2 === 0 ? "Pending" : "Approved" });
    }
    insertApproval(database, { id: "approval-deleted", agreementId: 2 });
    insertApproval(database, { id: "approval-tenant-b", workspaceId: "workspace-b", agreementId: 3 });
    insertApproval(database, { id: "approval-cross-tenant", workspaceId: "workspace-a", agreementId: 3 });
    insertApproval(database, { id: "approval-future-dated", createdAt: "2099-01-01T00:00:00.000Z" });

    const harness = routeHarness(database);
    let cursor: string | null = null;
    let snapshotAt: string | null = null;
    const ids: string[] = [];
    let pageNumber = 0;
    do {
      const parameters = `resource=approvals&sort=newest&limit=47${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const result = await harness.request(parameters);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.resource, "approvals");
      assert.equal(result.body.summary?.totalMatched, 231);
      assert.equal(result.body.summary?.totalMatchedCapped, false);
      assert.equal(result.body.summary?.statusCounts.find((entry) => entry.status === "Pending")?.count, 116);
      assert.equal(result.body.summary?.statusCounts.find((entry) => entry.status === "Approved")?.count, 115);
      assert.ok(result.body.page);
      snapshotAt ??= result.body.page.snapshotAt;
      assert.equal(result.body.page.snapshotAt, snapshotAt, "the insertion-fence marker stays bound to the cursor anchor");
      ids.push(...(result.body.items ?? []).map((item) => String(item.id)));
      cursor = result.body.page.nextCursor;
      pageNumber += 1;
      if (pageNumber === 1) {
        insertApproval(database, {
          id: "approval-post-snapshot",
          createdAt: "2020-01-01T00:00:00.000Z",
        });
      }
    } while (cursor);

    assert.equal(pageNumber, 5);
    assert.equal(ids.length, 231);
    assert.equal(new Set(ids).size, 231, "insertion-only traversal pages contain no duplicates");
    assert.deepEqual([...ids].sort(), originalIds, "every unchanged item present at the first-page anchor appears exactly once");
    assert.equal(ids.includes("approval-post-snapshot"), false, "a matching later insert is excluded by the page-one fence");
    assert.equal(ids.includes("approval-deleted"), false, "work for a deleted agreement is excluded");
    assert.equal(ids.includes("approval-tenant-b"), false, "another tenant is excluded");
    assert.equal(ids.includes("approval-cross-tenant"), false, "a mismatched source/agreement tenant cannot join");
    assert.equal(ids.includes("approval-future-dated"), false, "the signed insertion timestamp bounds future-dated rows");

    harness.setIdentity("workspace-b", "user-b", "Bob Legal");
    const tenantB = await harness.request("resource=approvals&limit=200");
    assert.deepEqual(tenantB.body.items?.map((item) => item.id), ["approval-tenant-b"]);
    assert.equal(harness.permissions.every((permission) => permission === "approval:read"), true);
  } finally {
    database.close();
  }
});

test("work-item cursors reject tampering and reuse across resource, filters, sort, limit, user, or tenant", async () => {
  const database = createWorkItemDatabase();
  try {
    insertAgreement(database, 1, "workspace-a", { party: "Needle Corp" });
    insertAgreement(database, 2, "workspace-a");
    insertAgreement(database, 3, "workspace-b");
    for (let index = 1; index <= 5; index += 1) {
      insertApproval(database, {
        id: `approval-${index}`,
        role: "Needle security",
        status: "Pending",
        approverUserId: "user-a",
      });
    }
    const harness = routeHarness(database);
    const base = "resource=approvals&status=Pending&owner=me&agreement=1&q=needle&sort=oldest&limit=2";
    const first = await harness.request(base);
    assert.equal(first.response.status, 200);
    assert.ok(first.body.page?.nextCursor);
    const cursor = first.body.page!.nextCursor!;
    const middle = Math.floor(cursor.length / 2);
    const tampered = `${cursor.slice(0, middle)}${cursor[middle] === "A" ? "B" : "A"}${cursor.slice(middle + 1)}`;
    const invalidRequests = [
      `resource=approvals&cursor=not*base64`,
      `${base}&cursor=${encodeURIComponent(tampered)}`,
      `resource=signatures&status=pending&owner=me&agreement=1&q=needle&sort=oldest&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `resource=approvals&status=Approved&owner=me&agreement=1&q=needle&sort=oldest&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `resource=approvals&status=Pending&owner=other&agreement=1&q=needle&sort=oldest&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `resource=approvals&status=Pending&owner=me&agreement=2&q=needle&sort=oldest&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `resource=approvals&status=Pending&owner=me&agreement=1&q=changed&sort=oldest&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `resource=approvals&status=Pending&owner=me&agreement=1&q=needle&sort=newest&limit=2&cursor=${encodeURIComponent(cursor)}`,
      `resource=approvals&status=Pending&owner=me&agreement=1&q=needle&sort=oldest&limit=3&cursor=${encodeURIComponent(cursor)}`,
      `${base}&cursor=${encodeURIComponent(cursor)}&cursor=${encodeURIComponent(cursor)}`,
    ];
    for (const parameters of invalidRequests) {
      const invalid = await harness.request(parameters);
      assert.equal(invalid.response.status, 400, parameters);
      assert.equal(invalid.body.error?.code, "invalid_cursor", parameters);
    }

    harness.setIdentity("workspace-a", "different-user", "Alice Legal");
    const crossUser = await harness.request(`${base}&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(crossUser.response.status, 400);
    assert.equal(crossUser.body.error?.code, "invalid_cursor");
    harness.setIdentity("workspace-b", "user-a", "Alice Legal");
    const crossTenant = await harness.request(`${base}&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(crossTenant.response.status, 400);
    assert.equal(crossTenant.body.error?.code, "invalid_cursor");

    const invalidQueries = [
      "limit=10",
      "resource=unknown",
      "resource=approvals&status=Unknown",
      "resource=events&status=Pending",
      "resource=approvals&agreement=0",
      "resource=approvals&agreement=01",
      "resource=approvals&agreement=9999999999999999",
      "resource=approvals&sort=updated_desc",
      "resource=approvals&limit=0",
      "resource=approvals&limit=201",
      "resource=approvals&limit=02",
      "resource=approvals&unknown=true",
      `resource=approvals&q=${"a".repeat(201)}`,
      "resource=approvals&owner=Alice%0ALegal",
    ];
    for (const parameters of invalidQueries) {
      const invalid = await harness.request(parameters);
      assert.equal(invalid.response.status, 400, parameters);
      assert.equal(invalid.body.error?.code, "invalid_query", parameters);
    }
  } finally {
    database.close();
  }
});

test("every work-item resource enforces its permission and server-side filters, sorts, live join, and safe projection", async () => {
  const database = createWorkItemDatabase();
  try {
    insertAgreement(database, 1, "workspace-a", { party: "Alpha Security", owner: "Alice Legal" });
    insertAgreement(database, 2, "workspace-a", { party: "Beta Commercial", owner: "Bob Legal" });
    insertAgreement(database, 4, "workspace-a", { party: "Deleted Security", deletedAt: "2026-08-19T00:00:00.000Z" });

    insertApproval(database, { id: "approval-a", due: "2026-09-02", role: "Security review" });
    insertApproval(database, { id: "approval-b", agreementId: 1, status: "Approved", approver: "Unassigned", approverUserId: null, due: "2026-08-30" });
    insertApproval(database, { id: "approval-c", agreementId: 2, due: "2026-09-01" });
    insertApproval(database, { id: "approval-same-name-other-user", agreementId: 1, approver: "Alice Legal", approverUserId: "user-other" });
    insertApproval(database, { id: "approval-legacy-name", agreementId: 1, approver: "Alice Legal", approverUserId: null });
    insertApproval(database, { id: "approval-deleted", agreementId: 4 });
    insertApproval(database, { id: "approval-percent", agreementId: 2, role: "Literal % review" });

    insertSignature(database, { id: "signature-a", agreementId: 1, status: "pending", updatedAt: "2026-08-22T00:00:00.000Z" });
    insertSignature(database, { id: "signature-b", agreementId: 2, status: "completed", updatedAt: "2026-08-21T00:00:00.000Z" });
    insertSignature(database, { id: "signature-deleted", agreementId: 4, status: "pending" });

    insertObligation(database, { id: "obligation-a", agreementId: 1, title: "Security renewal", dueDate: "2026-09-02" });
    insertObligation(database, { id: "obligation-b", agreementId: 1, status: "Complete", owner: "Unassigned", ownerUserId: null, dueDate: "2026-08-30" });
    insertObligation(database, { id: "obligation-c", agreementId: 2, dueDate: "2026-09-01" });
    insertObligation(database, { id: "obligation-deleted", agreementId: 4 });

    insertSchedule(database, { id: "schedule-a", agreementId: 1, title: "Security renewal schedule", nextOccurrenceDate: "2026-09-02" });
    insertSchedule(database, { id: "schedule-b", agreementId: 1, status: "paused", owner: "Unassigned", ownerUserId: null, nextOccurrenceDate: null });
    insertSchedule(database, { id: "schedule-c", agreementId: 2, nextOccurrenceDate: "2026-09-01" });
    insertSchedule(database, { id: "schedule-deleted", agreementId: 4 });

    insertEvent(database, { id: "event-a", agreementId: 1, detail: "Security terms updated", sequence: 1, createdAt: "2026-08-19T00:00:00.000Z" });
    insertEvent(database, { id: "event-b", agreementId: 2, actor: "Bob Legal", actorUserId: null, detail: "Commercial terms updated", sequence: 1 });
    insertEvent(database, { id: "event-deleted", agreementId: 4, sequence: 1 });

    const harness = routeHarness(database);

    const approvals = await harness.request("resource=approvals&status=Pending&owner=me&agreement=1&q=security&sort=due_asc&limit=10");
    assert.deepEqual(approvals.body.items?.map((item) => item.id), ["approval-legacy-name", "approval-a"]);
    assert.equal(approvals.body.summary?.totalMatched, 2);
    assert.equal(approvals.body.items?.some((item) => item.id === "approval-same-name-other-user"), false,
      "owner=me may use the display-name fallback only for legacy rows without an owner user ID");
    assert.equal(harness.permissions.at(-1), "approval:read");
    const unassignedApproval = await harness.request("resource=approvals&owner=unassigned&sort=due_asc");
    assert.deepEqual(unassignedApproval.body.items?.map((item) => item.id), ["approval-b", "approval-legacy-name"]);
    const literalWildcard = await harness.request("resource=approvals&q=%25");
    assert.deepEqual(literalWildcard.body.items?.map((item) => item.id), ["approval-percent"], "LIKE metacharacters remain literal query input");

    const signatures = await harness.request("resource=signatures&status=pending&owner=me&agreement=1&q=docuseal&sort=updated_desc");
    assert.deepEqual(signatures.body.items?.map((item) => item.id), ["signature-a"]);
    const signer = (signatures.body.items?.[0]?.signers as Array<Record<string, unknown>> | undefined)?.[0];
    assert.equal(signer?.email, "signer@example.com");
    assert.equal("signingUrl" in (signer ?? {}), false, "signer bearer capabilities and unknown fields are not projected");
    assert.equal(harness.permissions.at(-1), "agreement:read");

    const obligations = await harness.request("resource=obligations&status=Open&owner=me&agreement=1&q=renewal&sort=due_desc");
    assert.deepEqual(obligations.body.items?.map((item) => item.id), ["obligation-a"]);
    assert.equal(harness.permissions.at(-1), "obligation:read");
    const obligationOrder = await harness.request("resource=obligations&sort=due_asc");
    assert.deepEqual(obligationOrder.body.items?.map((item) => item.id), ["obligation-b", "obligation-c", "obligation-a"]);

    const schedules = await harness.request("resource=obligation_schedules&status=active&owner=me&agreement=1&q=security&sort=next_due_desc");
    assert.deepEqual(schedules.body.items?.map((item) => item.id), ["schedule-a"]);
    assert.equal(harness.permissions.at(-1), "obligation:read");
    const scheduleAscending = await harness.request("resource=obligation_schedules&sort=next_due_asc");
    assert.deepEqual(scheduleAscending.body.items?.map((item) => item.id), ["schedule-c", "schedule-a", "schedule-b"]);
    const scheduleDescending = await harness.request("resource=obligation_schedules&sort=next_due_desc");
    assert.deepEqual(scheduleDescending.body.items?.map((item) => item.id), ["schedule-a", "schedule-c", "schedule-b"]);

    const events = await harness.request("resource=events&owner=me&agreement=1&q=security&sort=oldest");
    assert.deepEqual(events.body.items?.map((item) => item.id), ["event-a"]);
    assert.deepEqual(events.body.summary?.statusCounts, []);
    assert.equal(harness.permissions.at(-1), "audit:read");

    for (const resource of ["approvals", "signatures", "obligations", "obligation_schedules", "events"]) {
      const result = await harness.request(`resource=${resource}&limit=200`);
      assert.equal(result.body.items?.some((item) => String(item.id).includes("deleted")), false, resource);
    }
  } finally {
    database.close();
  }
});

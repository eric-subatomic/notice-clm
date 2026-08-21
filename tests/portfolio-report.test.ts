import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import ts from "typescript";
import { z } from "zod";
import { boundedReportCount, exactMinorTotal, parsePortfolioReportQuery } from "../app/lib/portfolio-report";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

type CountGroup = Readonly<{ key: string; count: number }>;

type PortfolioReportBody = Readonly<{
  generatedAt?: string;
  asOfDate?: string;
  filters?: Readonly<Record<string, unknown>>;
  portfolio?: Readonly<{
    agreements: number;
    stages: CountGroup[];
    risks: CountGroup[];
    currencies: Array<Readonly<{ currencyCode: string; agreements: number; valueMinor: string }>>;
    renewals: Readonly<{ through: string; count: number }>;
  }>;
  work?: Readonly<{
    approvals: Readonly<{ pending: number; overdue: number; changesRequested: number }>;
    signatures: CountGroup[];
    obligations: Readonly<{ open: number; overdue: number; complete: number }>;
    obligationSchedules: CountGroup[];
  }>;
  requestId?: string;
  error?: Readonly<{ code: string; message: string }>;
}>;

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const ENTITY_A = "33333333-3333-4333-8333-333333333333";
const ENTITY_B = "44444444-4444-4444-8444-444444444444";
const COUNTERPARTY_A = "55555555-5555-4555-8555-555555555555";
const COUNTERPARTY_B = "66666666-6666-4666-8666-666666666666";

const helperSource = await readFile(new URL("../app/lib/portfolio-report.ts", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/reports/portfolio/route.ts", import.meta.url), "utf8");

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

const compiledHelper = compile(helperSource, "app/lib/portfolio-report.ts");
const compiledRoute = compile(routeSource, "app/api/reports/portfolio/route.ts");

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

function createPortfolioDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE agreements (
      id integer PRIMARY KEY,
      workspace_id text NOT NULL,
      deleted_at text,
      stage text NOT NULL,
      risk text NOT NULL,
      owner_user_id text,
      legal_entity_id text,
      primary_counterparty_id text,
      currency_code text NOT NULL,
      value_minor integer NOT NULL,
      expiration_date text NOT NULL
    );

    CREATE TABLE approval_requests (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      status text NOT NULL,
      due text NOT NULL
    );

    CREATE TABLE signature_packets (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      status text NOT NULL
    );

    CREATE TABLE obligations (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      status text NOT NULL,
      due_date text NOT NULL
    );

    CREATE TABLE obligation_schedules (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      status text NOT NULL
    );
  `);
  return database;
}

type AgreementSeed = Readonly<{
  id: number;
  workspaceId?: string;
  deletedAt?: string | null;
  stage?: string;
  risk?: string;
  ownerUserId?: string | null;
  legalEntityId?: string | null;
  counterpartyId?: string | null;
  currencyCode?: string;
  valueMinor?: number;
  expirationDate?: string;
}>;

function insertAgreement(database: DatabaseSync, input: AgreementSeed): void {
  database.prepare(`INSERT INTO agreements (
    id, workspace_id, deleted_at, stage, risk, owner_user_id, legal_entity_id,
    primary_counterparty_id, currency_code, value_minor, expiration_date
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.deletedAt ?? null,
    input.stage ?? "Active",
    input.risk ?? "Low",
    input.ownerUserId === undefined ? OWNER_A : input.ownerUserId,
    input.legalEntityId === undefined ? ENTITY_A : input.legalEntityId,
    input.counterpartyId === undefined ? COUNTERPARTY_A : input.counterpartyId,
    input.currencyCode ?? "USD",
    input.valueMinor ?? 0,
    input.expirationDate ?? "",
  );
}

function insertApproval(database: DatabaseSync, input: Readonly<{
  id: string;
  agreementId: number;
  workspaceId?: string;
  status: string;
  due: string;
}>): void {
  database.prepare(`INSERT INTO approval_requests (id, workspace_id, agreement_id, status, due)
    VALUES (?, ?, ?, ?, ?)`).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.agreementId,
    input.status,
    input.due,
  );
}

function insertSignature(database: DatabaseSync, input: Readonly<{
  id: string;
  agreementId: number;
  workspaceId?: string;
  status: string;
}>): void {
  database.prepare(`INSERT INTO signature_packets (id, workspace_id, agreement_id, status)
    VALUES (?, ?, ?, ?)`).run(input.id, input.workspaceId ?? "workspace-a", input.agreementId, input.status);
}

function insertObligation(database: DatabaseSync, input: Readonly<{
  id: string;
  agreementId: number;
  workspaceId?: string;
  status: string;
  dueDate: string;
}>): void {
  database.prepare(`INSERT INTO obligations (id, workspace_id, agreement_id, status, due_date)
    VALUES (?, ?, ?, ?, ?)`).run(
    input.id,
    input.workspaceId ?? "workspace-a",
    input.agreementId,
    input.status,
    input.dueDate,
  );
}

function insertSchedule(database: DatabaseSync, input: Readonly<{
  id: string;
  agreementId: number;
  workspaceId?: string;
  status: string;
}>): void {
  database.prepare(`INSERT INTO obligation_schedules (id, workspace_id, agreement_id, status)
    VALUES (?, ?, ?, ?)`).run(input.id, input.workspaceId ?? "workspace-a", input.agreementId, input.status);
}

function addDays(calendarDate: string, days: number): string {
  const date = new Date(`${calendarDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function responseJson(payload: unknown, options: { status?: number; headers?: HeadersInit } = {}): Response {
  return Response.json(payload, { status: options.status ?? 200, headers: options.headers });
}

function routeHarness(database: DatabaseSync) {
  let workspaceId = "workspace-a";
  let authorized = true;
  let ensureCalls = 0;
  const permissions: Array<Readonly<{ permission: string; limit: number | undefined }>> = [];
  const db = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
  const context = vm.createContext({
    Request,
    Response,
    Headers,
    URL,
    Date,
    console,
  });

  const helperModule: { exports: Record<string, unknown> } = { exports: {} };
  const helperWrapper = new vm.Script(
    `(function (require, module, exports) { ${compiledHelper}\n})`,
    { filename: "app/lib/portfolio-report.cjs" },
  ).runInContext(context) as (require: (specifier: string) => unknown, module: typeof helperModule, exports: Record<string, unknown>) => void;
  helperWrapper((specifier) => {
    if (specifier === "zod") return { z };
    throw new Error(`Unexpected portfolio helper dependency: ${specifier}`);
  }, helperModule, helperModule.exports);

  const routeModule: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "../../../../db") return { getDb: () => db };
    if (specifier === "../../../../db/ensure") {
      return { ensureStorageSchema: async () => { ensureCalls += 1; } };
    }
    if (specifier === "../../../../db/schema") return schema;
    if (specifier === "../../../lib/portfolio-report") return helperModule.exports;
    if (specifier === "../../../lib/api") {
      return {
        authorizeApiRequest: async (_request: Request, permission: string, options?: { limit?: number }) => {
          permissions.push({ permission, limit: options?.limit });
          if (!authorized) {
            return {
              ok: false,
              response: responseJson({ error: { code: "forbidden", message: "Permission denied." } }, { status: 403 }),
            };
          }
          return {
            ok: true,
            context: {
              workspace: { id: workspaceId, name: workspaceId },
              user: { id: OWNER_A, displayName: "Alice Legal" },
              permissions: new Set([permission]),
            },
            requestId: "request-portfolio",
            headers: new Headers({ "x-request-id": "request-portfolio" }),
          };
        },
        handleRouteError: (error: unknown) => {
          throw error;
        },
      };
    }
    if (specifier === "../../../lib/http") {
      return {
        apiJson: responseJson,
        apiError: (code: string, message: string, options: { status: number; headers?: HeadersInit }) => responseJson({
          error: { code, message },
          requestId: "request-portfolio",
        }, options),
      };
    }
    throw new Error(`Unexpected portfolio route dependency: ${specifier}`);
  };
  const routeWrapper = new vm.Script(
    `(function (require, module, exports) { ${compiledRoute}\n})`,
    { filename: "app/api/reports/portfolio/route.cjs" },
  ).runInContext(context) as (require: (specifier: string) => unknown, module: typeof routeModule, exports: Record<string, unknown>) => void;
  routeWrapper(requireModule, routeModule, routeModule.exports);
  const get = routeModule.exports.GET as (request: Request) => Promise<Response>;

  return {
    permissions,
    get ensureCalls() {
      return ensureCalls;
    },
    setWorkspace(nextWorkspaceId: string) {
      workspaceId = nextWorkspaceId;
    },
    deny() {
      authorized = false;
    },
    async request(parameters = ""): Promise<{ response: Response; body: PortfolioReportBody }> {
      const suffix = parameters ? `?${parameters}` : "";
      const response = await get(new Request(`https://notice.test/api/reports/portfolio${suffix}`));
      return { response, body: await response.json() as PortfolioReportBody };
    },
  };
}

function sortedGroups(groups: readonly CountGroup[] | undefined): CountGroup[] {
  return [...(groups ?? [])].sort((left, right) => left.key.localeCompare(right.key));
}

function seedPortfolio(database: DatabaseSync, today: string): void {
  insertAgreement(database, {
    id: 1,
    valueMinor: 10_025,
    expirationDate: addDays(today, 10),
  });
  insertAgreement(database, {
    id: 2,
    stage: "Review",
    risk: "High",
    ownerUserId: OWNER_B,
    legalEntityId: ENTITY_B,
    valueMinor: 20_075,
    expirationDate: addDays(today, 40),
  });
  insertAgreement(database, {
    id: 3,
    risk: "Medium",
    counterpartyId: COUNTERPARTY_B,
    currencyCode: "EUR",
    valueMinor: 30_050,
  });
  insertAgreement(database, {
    id: 4,
    deletedAt: `${today}T01:00:00.000Z`,
    valueMinor: 9_000_000,
    expirationDate: addDays(today, 5),
  });
  insertAgreement(database, {
    id: 5,
    workspaceId: "workspace-b",
    valueMinor: 8_000_000,
    expirationDate: addDays(today, 5),
  });

  insertApproval(database, { id: "approval-overdue", agreementId: 1, status: "Pending", due: addDays(today, -1) });
  insertApproval(database, { id: "approval-due-today", agreementId: 1, status: "Pending", due: today });
  insertApproval(database, { id: "approval-changes", agreementId: 2, status: "Changes requested", due: addDays(today, 2) });
  insertApproval(database, { id: "approval-approved", agreementId: 3, status: "Approved", due: addDays(today, -2) });
  insertApproval(database, { id: "approval-deleted", agreementId: 4, status: "Pending", due: addDays(today, -2) });
  insertApproval(database, { id: "approval-tenant-b", agreementId: 5, workspaceId: "workspace-b", status: "Pending", due: addDays(today, -2) });
  insertApproval(database, { id: "approval-cross-tenant", agreementId: 5, status: "Pending", due: addDays(today, -2) });

  insertSignature(database, { id: "signature-pending", agreementId: 1, status: "pending" });
  insertSignature(database, { id: "signature-completed", agreementId: 2, status: "completed" });
  insertSignature(database, { id: "signature-review", agreementId: 3, status: "completed_review_required" });
  insertSignature(database, { id: "signature-deleted", agreementId: 4, status: "pending" });
  insertSignature(database, { id: "signature-tenant-b", agreementId: 5, workspaceId: "workspace-b", status: "completed" });
  insertSignature(database, { id: "signature-cross-tenant", agreementId: 5, status: "pending" });

  insertObligation(database, { id: "obligation-overdue", agreementId: 1, status: "Open", dueDate: addDays(today, -1) });
  insertObligation(database, { id: "obligation-due-today", agreementId: 1, status: "Open", dueDate: today });
  insertObligation(database, { id: "obligation-complete", agreementId: 2, status: "Complete", dueDate: addDays(today, -2) });
  insertObligation(database, { id: "obligation-future", agreementId: 3, status: "Open", dueDate: addDays(today, 3) });
  insertObligation(database, { id: "obligation-deleted", agreementId: 4, status: "Open", dueDate: addDays(today, -2) });
  insertObligation(database, { id: "obligation-tenant-b", agreementId: 5, workspaceId: "workspace-b", status: "Open", dueDate: addDays(today, -2) });
  insertObligation(database, { id: "obligation-cross-tenant", agreementId: 5, status: "Open", dueDate: addDays(today, -2) });

  insertSchedule(database, { id: "schedule-active", agreementId: 1, status: "active" });
  insertSchedule(database, { id: "schedule-paused", agreementId: 2, status: "paused" });
  insertSchedule(database, { id: "schedule-ended", agreementId: 3, status: "ended" });
  insertSchedule(database, { id: "schedule-deleted", agreementId: 4, status: "active" });
  insertSchedule(database, { id: "schedule-tenant-b", agreementId: 5, workspaceId: "workspace-b", status: "active" });
  insertSchedule(database, { id: "schedule-cross-tenant", agreementId: 5, status: "active" });
}

test("portfolio report helpers reject ambiguous queries and unsafe aggregate values", () => {
  assert.deepEqual(
    parsePortfolioReportQuery(new Request("https://notice.test/report?currencyCode=USD&renewalWindowDays=30")),
    { currencyCode: "USD", renewalWindowDays: 30 },
  );
  assert.throws(
    () => parsePortfolioReportQuery(new Request("https://notice.test/report?stage=Active&stage=Review")),
    /may be supplied only once/,
  );
  assert.equal(boundedReportCount("42"), 42);
  assert.equal(exactMinorTotal("12", "345"), "12000345");
  assert.throws(() => boundedReportCount(-1), /outside the supported range/);
  assert.throws(() => exactMinorTotal("not-a-number", "0"), /outside the supported range/);
});

test("portfolio report groups exact minor-unit totals and isolates tenant, deleted, and cross-tenant work", async () => {
  const database = createPortfolioDatabase();
  try {
    const today = new Date().toISOString().slice(0, 10);
    seedPortfolio(database, today);
    const harness = routeHarness(database);
    const result = await harness.request();

    assert.equal(result.response.status, 200);
    assert.equal(result.body.asOfDate, today);
    assert.equal(result.body.requestId, "request-portfolio");
    assert.deepEqual(result.body.filters, { renewalWindowDays: 90 });
    assert.equal(result.body.portfolio?.agreements, 3);
    assert.deepEqual(sortedGroups(result.body.portfolio?.stages), [
      { key: "Active", count: 2 },
      { key: "Review", count: 1 },
    ]);
    assert.deepEqual(sortedGroups(result.body.portfolio?.risks), [
      { key: "High", count: 1 },
      { key: "Low", count: 1 },
      { key: "Medium", count: 1 },
    ]);
    assert.deepEqual(
      [...(result.body.portfolio?.currencies ?? [])].sort((left, right) => left.currencyCode.localeCompare(right.currencyCode)),
      [
        { currencyCode: "EUR", agreements: 1, valueMinor: "30050" },
        { currencyCode: "USD", agreements: 2, valueMinor: "30100" },
      ],
    );
    assert.deepEqual(result.body.portfolio?.renewals, { through: addDays(today, 90), count: 2 });
    assert.deepEqual(result.body.work?.approvals, { pending: 2, overdue: 1, changesRequested: 1 });
    assert.deepEqual(sortedGroups(result.body.work?.signatures), [
      { key: "completed", count: 1 },
      { key: "completed_review_required", count: 1 },
      { key: "pending", count: 1 },
    ]);
    assert.deepEqual(result.body.work?.obligations, { open: 3, overdue: 1, complete: 1 });
    assert.deepEqual(sortedGroups(result.body.work?.obligationSchedules), [
      { key: "active", count: 1 },
      { key: "ended", count: 1 },
      { key: "paused", count: 1 },
    ]);
    assert.deepEqual(harness.permissions, [{ permission: "agreement:read", limit: 30 }]);
    assert.equal(harness.ensureCalls, 1);

    harness.setWorkspace("workspace-b");
    const tenantB = await harness.request("renewalWindowDays=30");
    assert.equal(tenantB.body.portfolio?.agreements, 1);
    assert.deepEqual(tenantB.body.portfolio?.currencies, [
      { currencyCode: "USD", agreements: 1, valueMinor: "8000000" },
    ]);
    assert.deepEqual(tenantB.body.work?.approvals, { pending: 1, overdue: 1, changesRequested: 0 });
    assert.deepEqual(sortedGroups(tenantB.body.work?.signatures), [{ key: "completed", count: 1 }]);
    assert.deepEqual(tenantB.body.work?.obligations, { open: 1, overdue: 1, complete: 0 });
    assert.deepEqual(sortedGroups(tenantB.body.work?.obligationSchedules), [{ key: "active", count: 1 }]);
  } finally {
    database.close();
  }
});

test("portfolio report preserves an exact currency total above JavaScript's safe integer", async () => {
  const database = createPortfolioDatabase();
  try {
    insertAgreement(database, { id: 91, valueMinor: 9_000_000_000_000_000, currencyCode: "USD" });
    insertAgreement(database, { id: 92, valueMinor: 9_000_000_000_000_000, currencyCode: "USD" });
    const result = await routeHarness(database).request();
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.portfolio?.currencies, [{
      currencyCode: "USD",
      agreements: 2,
      valueMinor: "18000000000000000",
    }]);
  } finally {
    database.close();
  }
});

test("portfolio report applies agreement filters to portfolio and every work aggregate", async () => {
  const database = createPortfolioDatabase();
  try {
    const today = new Date().toISOString().slice(0, 10);
    seedPortfolio(database, today);
    const harness = routeHarness(database);
    const parameters = new URLSearchParams({
      stage: "Active",
      risk: "Low",
      ownerUserId: OWNER_A,
      legalEntityId: ENTITY_A,
      counterpartyId: COUNTERPARTY_A,
      currencyCode: "USD",
      renewalWindowDays: "30",
    }).toString();
    const result = await harness.request(parameters);

    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.filters, {
      stage: "Active",
      risk: "Low",
      ownerUserId: OWNER_A,
      legalEntityId: ENTITY_A,
      counterpartyId: COUNTERPARTY_A,
      currencyCode: "USD",
      renewalWindowDays: 30,
    });
    assert.equal(result.body.portfolio?.agreements, 1);
    assert.deepEqual(result.body.portfolio?.stages, [{ key: "Active", count: 1 }]);
    assert.deepEqual(result.body.portfolio?.risks, [{ key: "Low", count: 1 }]);
    assert.deepEqual(result.body.portfolio?.currencies, [
      { currencyCode: "USD", agreements: 1, valueMinor: "10025" },
    ]);
    assert.deepEqual(result.body.portfolio?.renewals, { through: addDays(today, 30), count: 1 });
    assert.deepEqual(result.body.work?.approvals, { pending: 2, overdue: 1, changesRequested: 0 });
    assert.deepEqual(result.body.work?.signatures, [{ key: "pending", count: 1 }]);
    assert.deepEqual(result.body.work?.obligations, { open: 2, overdue: 1, complete: 0 });
    assert.deepEqual(result.body.work?.obligationSchedules, [{ key: "active", count: 1 }]);
  } finally {
    database.close();
  }
});

test("portfolio report rejects unknown, malformed, and duplicate query parameters", async () => {
  const database = createPortfolioDatabase();
  try {
    const harness = routeHarness(database);
    const invalidQueries = [
      "stage=Expired",
      "risk=Critical",
      "currencyCode=usd",
      "currencyCode=US",
      "ownerUserId=not-a-uuid",
      "legalEntityId=not-a-uuid",
      "counterpartyId=not-a-uuid",
      "renewalWindowDays=0",
      "renewalWindowDays=366",
      "renewalWindowDays=1.5",
      "unknown=true",
      "stage=Active&stage=Review",
      "renewalWindowDays=30&renewalWindowDays=60",
    ];
    for (const parameters of invalidQueries) {
      const result = await harness.request(parameters);
      assert.equal(result.response.status, 400, parameters);
      assert.equal(result.body.error?.code, "invalid_report_query", parameters);
    }
  } finally {
    database.close();
  }
});

test("portfolio report returns permission denial before storage or query work", async () => {
  const database = createPortfolioDatabase();
  try {
    const harness = routeHarness(database);
    harness.deny();
    const result = await harness.request("stage=Active&stage=Review");

    assert.equal(result.response.status, 403);
    assert.equal(result.body.error?.code, "forbidden");
    assert.equal(harness.ensureCalls, 0);
    assert.deepEqual(harness.permissions, [{ permission: "agreement:read", limit: 30 }]);
  } finally {
    database.close();
  }
});

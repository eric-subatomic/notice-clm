import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { drizzle } from "drizzle-orm/d1";
import * as drizzleOrm from "drizzle-orm";
import { z } from "zod";
import ts from "typescript";
import * as schema from "../db/schema";
import { parseJson } from "../app/lib/validation";
import { isDocumentReadable } from "../app/lib/document-access";
import {
  CustomerHostedOcrError,
  supportsCustomerHostedOcr,
} from "../app/lib/document-security";
import {
  assessRejectedObjectCleanupPolicy,
  claimRejectedObjectCleanup,
} from "../app/lib/rejected-object-cleanup";
import {
  cleanupStagedDocumentObject,
  cleanupStagedWorkingVersionObject,
} from "../app/lib/staged-object-cleanup";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

const routeSource = await readFile(new URL("../app/api/documents/import/route.ts", import.meta.url), "utf8");
const compiledRoute = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: "app/api/documents/import/route.ts",
}).outputText;

const WORKSPACE_ID = "workspace-a";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const AGREEMENT_ID = 4102;
const SOURCE_KEY = `workspaces/${WORKSPACE_ID}/documents/${DOCUMENT_ID}/source.pdf`;
const SOURCE_BYTES = new TextEncoder().encode("%PDF-1.4\n% bounded route test\n");
const SOURCE_SHA256 = await digest(SOURCE_BYTES);
const OCR_PROFILE = { modelId: "customer-vision-v1", profileId: "contracts-en-v1" } as const;

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
  private batchNumber = 0;
  constructor(
    private readonly database: DatabaseSync,
    private readonly beforeBatch?: (batchNumber: number) => void,
    private readonly afterBatchCommit?: (batchNumber: number) => void,
  ) {}
  prepare(query: string) { return new SqliteD1Statement(this.database, query); }
  async batch(statements: readonly SqliteD1Statement[]) {
    this.batchNumber += 1;
    this.beforeBatch?.(this.batchNumber);
    this.database.exec("BEGIN");
    let results: Array<{ success: boolean; meta: { changes: number } }>;
    try {
      results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    // This hook deliberately models a lost D1 acknowledgement after the
    // transaction is durable, so it must run outside the rollback scope.
    this.afterBatchCommit?.(this.batchNumber);
    return results;
  }
}

function createDatabase(targetLegalHold = false): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE documents (
      id text PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      agreement_id integer, role text NOT NULL, direction text NOT NULL,
      negotiation_round_id text, provider_message_id text, parent_sha256 text,
      original_sender_email text, file_name text NOT NULL, object_key text NOT NULL,
      content_type text NOT NULL, size integer NOT NULL, tags text NOT NULL,
      extracted text NOT NULL, extraction_mode text NOT NULL, sha256 text NOT NULL,
      scan_status text NOT NULL, scan_provider text, scanned_at text,
      created_by_user_id text, legal_hold integer NOT NULL, retention_until text,
      deleted_at text, created_at text NOT NULL
    );
    CREATE TABLE document_upload_receipts (
      workspace_id text NOT NULL, user_id text NOT NULL, key_digest text NOT NULL,
      request_digest text NOT NULL, document_id text NOT NULL, response_json text NOT NULL,
      response_status integer NOT NULL, created_at text NOT NULL, expires_at text NOT NULL,
      linked_at text, PRIMARY KEY (workspace_id, user_id, key_digest)
    );
    CREATE TABLE agreements (
      id integer PRIMARY KEY, workspace_id text NOT NULL, version integer NOT NULL,
      party text NOT NULL, initials text NOT NULL, side text NOT NULL, type text NOT NULL,
      value integer NOT NULL, value_minor integer NOT NULL, currency_code text NOT NULL,
      stage text NOT NULL, owner text NOT NULL, owner_user_id text,
      primary_counterparty_id text, legal_entity_id text, governed_template_version_id text,
      workflow_definition_id text, workflow_policy_sha256 text, workflow_approval_lanes text,
      next_action text NOT NULL, due text NOT NULL, crm text NOT NULL, crm_record text NOT NULL,
      tags text NOT NULL, updated text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL,
      created_by_user_id text, updated_by_user_id text, legal_hold integer NOT NULL,
      retention_until text, deleted_at text, department text NOT NULL, risk text NOT NULL,
      risk_disposition text, risk_basis_hash text, risk_document_version integer,
      risk_document_sha256 text, risk_decision_reason text, risk_decided_by_user_id text,
      risk_decided_at text, approval_status text NOT NULL, signature_status text NOT NULL,
      effective_date text NOT NULL, expiration_date text NOT NULL
    );
    CREATE TABLE signature_packets (id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL, active_key text);
    CREATE TABLE negotiation_rounds (id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL, active_key text, round_number integer, status text, updated_at text);
    CREATE TABLE agreement_document_versions (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      version integer NOT NULL, label text NOT NULL, object_key text NOT NULL,
      content_type text NOT NULL, size integer NOT NULL, sha256 text NOT NULL,
      source_document_id text, created_by_user_id text NOT NULL, created_at text NOT NULL
    );
    CREATE TABLE approval_requests (id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL, status text NOT NULL, version integer NOT NULL);
    CREATE TABLE mutation_guards (
      id text PRIMARY KEY, workspace_id text NOT NULL, operation text NOT NULL,
      guard_changes integer NOT NULL CHECK (guard_changes = 1), created_at text NOT NULL
    );
    CREATE TABLE purge_jobs (
      id text PRIMARY KEY, workspace_id text NOT NULL, resource_type text NOT NULL,
      resource_id text NOT NULL, object_keys text NOT NULL, status text NOT NULL,
      guard_changes integer NOT NULL, attempts integer NOT NULL, last_error text,
      last_attempt_at text, created_at text NOT NULL, updated_at text NOT NULL,
      completed_at text
    );
    CREATE TABLE workspace_events (
      id text PRIMARY KEY, workspace_id text NOT NULL, sequence integer NOT NULL,
      type text NOT NULL, actor_user_id text NOT NULL, actor_email text NOT NULL,
      actor text NOT NULL, subject_user_id text, subject_email text, detail text NOT NULL,
      previous_hash text, event_hash text NOT NULL, created_at text NOT NULL
    );
    CREATE TABLE agreement_events (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      type text NOT NULL, actor_user_id text, actor_email text, actor text NOT NULL,
      detail text NOT NULL, previous_hash text, event_hash text, sequence integer NOT NULL,
      source_agent_plan_id text, created_at text NOT NULL
    );
    CREATE TABLE agreement_versions (
      id text PRIMARY KEY, workspace_id text NOT NULL, agreement_id integer NOT NULL,
      version integer NOT NULL, snapshot text NOT NULL, source_event_id text,
      checksum_sha256 text NOT NULL, created_by_user_id text NOT NULL, created_at text NOT NULL
    );
  `);
  database.prepare(`INSERT INTO documents VALUES (
    ?, ?, 1, NULL, 'initial_source', 'inbound', NULL, NULL, NULL, NULL,
    'source.pdf', ?, 'application/pdf', ?, '[]', '{}', 'PDF stored after scanning',
    ?, 'clean', 'approved-scanner', '2026-08-20T12:00:00.000Z', ?, 0,
    '2026-08-21T12:00:00.000Z', NULL, '2026-08-20T12:00:00.000Z'
  )`).run(DOCUMENT_ID, WORKSPACE_ID, SOURCE_KEY, SOURCE_BYTES.byteLength, SOURCE_SHA256, USER_ID);
  database.prepare(`INSERT INTO agreements VALUES (
    ?, ?, 1, 'Acme', 'AC', 'Sell-side', 'Services Agreement', 0, 0, 'USD',
    'Review', 'Alice Legal', ?, NULL, NULL, NULL, NULL, NULL, NULL,
    'Review source', 'Unscheduled', 'None', '', '[]', '2026-08-20T12:00:00.000Z',
    '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z', ?, ?, ?, NULL,
    NULL, 'Legal', 'Unassessed', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'Required', 'Not sent', '', ''
  )`).run(AGREEMENT_ID, WORKSPACE_ID, USER_ID, USER_ID, USER_ID, targetLegalHold ? 1 : 0);
  return database;
}

type OcrResult = Readonly<{
  text: string;
  requestId: string;
  provider: string;
  detail: string;
  modelId: string;
  profileId: string;
  sourceSha256: string;
}>;

function maliciousError(): CustomerHostedOcrError {
  return new CustomerHostedOcrError("malicious_source", "The customer-hosted gateway rejected the OCR source as malicious.", 422, {
    requestId: "33333333-3333-4333-8333-333333333333",
    provider: "customer-isolated-ocr",
    detail: "Fresh malware verdict",
    scannedAt: "2026-08-20T12:05:00.000Z",
  });
}

function cleanResult(text = "Clean OCR result"): OcrResult {
  return {
    text,
    requestId: "44444444-4444-4444-8444-444444444444",
    provider: "customer-isolated-ocr",
    detail: "Complete",
    modelId: OCR_PROFILE.modelId,
    profileId: OCR_PROFILE.profileId,
    sourceSha256: SOURCE_SHA256,
  };
}

type StoredObject = { bytes: Uint8Array; customMetadata?: Record<string, string> };

type RouteHarnessOptions = Readonly<{
  beforeBatch?: (batchNumber: number) => void;
  afterBatchCommit?: (batchNumber: number) => void;
  beforeWorkspaceEvent?: (input: Record<string, unknown>) => Promise<void>;
  failWorkingVersionPutOnce?: boolean;
  failFinalAgreementEventOnce?: boolean;
  canRescanDocument?: (status: string) => boolean;
  scan?: () => Promise<Readonly<{
    status: "clean" | "malicious" | "unavailable";
    provider: string;
    detail: string;
    scannedAt: string | null;
  }>>;
}>;

function routeHarness(database: DatabaseSync, extract: () => Promise<OcrResult>, harnessOptions: RouteHarnessOptions = {}) {
  const objects = new Map<string, StoredObject>([[SOURCE_KEY, { bytes: SOURCE_BYTES }]]);
  const puts: Array<{ key: string; bytes: Uint8Array; options: Record<string, unknown> }> = [];
  let workingVersionPutFailed = false;
  let finalAgreementEventFailed = false;
  const documentsBucket = {
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        size: stored.bytes.byteLength,
        httpMetadata: { contentType: key === SOURCE_KEY ? "application/pdf" : "text/plain" },
        customMetadata: stored.customMetadata,
        async arrayBuffer() { return Uint8Array.from(stored.bytes).buffer; },
      };
    },
    async put(key: string, value: ArrayBuffer | Uint8Array, options: Record<string, unknown>) {
      if (harnessOptions.failWorkingVersionPutOnce && !workingVersionPutFailed && key !== SOURCE_KEY) {
        workingVersionPutFailed = true;
        throw new Error("Synthetic R2 working-version write failure");
      }
      const bytes = value instanceof Uint8Array ? Uint8Array.from(value) : new Uint8Array(value);
      puts.push({ key, bytes, options });
      objects.set(key, { bytes, customMetadata: options.customMetadata as Record<string, string> | undefined });
    },
    async delete(key: string) { objects.delete(key); },
  };
  const db = drizzle(new SqliteD1(database, harnessOptions.beforeBatch, harnessOptions.afterBatchCommit) as unknown as D1Database, { schema });
  let workspaceSequence = 0;
  let agreementSequence = 0;
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "cloudflare:workers") return { env: { DOCUMENTS: documentsBucket } };
    if (specifier === "node:buffer") return { Buffer };
    if (specifier === "drizzle-orm") return drizzleOrm;
    if (specifier === "zod") return { z };
    if (specifier === "../../../../db") return { getDb: () => db };
    if (specifier === "../../../../db/ensure") return { ensureStorageSchema: async () => undefined };
    if (specifier === "../../../../db/schema") return schema;
    if (specifier === "../../../lib/api") return {
      authorizeApiRequest: async () => ({
        ok: true,
        context: {
          workspace: { id: WORKSPACE_ID, name: "Workspace A" },
          user: { id: USER_ID, email: "alice@example.test", displayName: "Alice Legal" },
          permissions: new Set(["document:upload", "agreement:update", "document:manage"]),
        },
        requestId: "request-ocr-link",
        headers: new Headers(),
      }),
      handleRouteError: (error: unknown) => { throw error; },
    };
    if (specifier === "../../../lib/config") return { getNoticeConfig: () => ({ mode: "production" }) };
    if (specifier === "../../../lib/document-access") return {
      canRescanDocument: harnessOptions.canRescanDocument ?? (() => false),
      isDocumentReadable: (status: string) => status === "clean",
    };
    if (specifier === "../../../lib/document-security") return {
      CustomerHostedOcrError,
      extractDocumentTextWithCustomerHostedOcr: extract,
      inspectDocument: () => ({ extension: "pdf", contentType: "application/pdf" }),
      MAX_DOCUMENT_BYTES: 20 * 1024 * 1024,
      normalizedDocumentName: (name: string) => name,
      scanDocument: harnessOptions.scan ?? (async () => ({ status: "clean", provider: "scanner", detail: "clean", scannedAt: new Date().toISOString() })),
      sha256Hex: digest,
      supportsCustomerHostedOcr,
    };
    if (specifier === "../../../lib/http") return {
      apiJson: (payload: unknown, options: { status?: number; headers?: HeadersInit } = {}) => Response.json(payload, { status: options.status ?? 200, headers: options.headers }),
      apiError: (code: string, message: string, options: { status: number; headers?: HeadersInit }) => Response.json({ error: { code, message }, requestId: "request-ocr-link" }, { status: options.status, headers: options.headers }),
    };
    if (specifier === "../../../lib/persistence") return {
      findActiveAgreement: async () => (await db.select().from(schema.agreements).where(drizzleOrm.and(
        drizzleOrm.eq(schema.agreements.workspaceId, WORKSPACE_ID),
        drizzleOrm.eq(schema.agreements.id, AGREEMENT_ID),
        drizzleOrm.isNull(schema.agreements.deletedAt),
      )).limit(1))[0] ?? null,
      isMutationGuardConflict: (error: unknown) => /ck_mutation_guards_changes|guard_changes = 1/.test(String(error)),
      isOptimisticConcurrencyConflict: () => false,
      prepareWorkspaceEvent: async (_database: unknown, input: Record<string, unknown>) => {
        await harnessOptions.beforeWorkspaceEvent?.(input);
        return {
          id: crypto.randomUUID(), workspaceId: input.workspaceId, sequence: ++workspaceSequence,
          type: input.type, actorUserId: USER_ID, actorEmail: "alice@example.test", actor: "Alice Legal",
          subjectUserId: null, subjectEmail: null, detail: input.detail, previousHash: null,
          eventHash: "e".repeat(64), createdAt: input.createdAt,
        };
      },
      prepareAgreementEvent: async (_database: unknown, input: Record<string, unknown>) => {
        if (harnessOptions.failFinalAgreementEventOnce && !finalAgreementEventFailed && input.type === "Version") {
          finalAgreementEventFailed = true;
          throw new Error("Synthetic agreement-event preparation failure");
        }
        return {
          id: crypto.randomUUID(), workspaceId: input.workspaceId, agreementId: input.agreementId,
          type: input.type, actorUserId: USER_ID, actorEmail: "alice@example.test", actor: "Alice Legal",
          detail: input.detail, previousHash: null, eventHash: "a".repeat(64), sequence: ++agreementSequence,
          sourceAgentPlanId: null, createdAt: input.createdAt,
        };
      },
      prepareAgreementSnapshot: async (agreement: Record<string, unknown>, actorId: string, eventId: string) => ({
        id: crypto.randomUUID(), workspaceId: agreement.workspaceId, agreementId: agreement.id,
        version: agreement.version, snapshot: agreement, sourceEventId: eventId,
        checksumSha256: "s".repeat(64), createdByUserId: actorId, createdAt: agreement.updatedAt,
      }),
    };
    if (specifier === "../../../lib/providers") return { getScannerConfiguration: () => ({
      endpoint: "https://scanner.example.test/v1/scan", secret: "s".repeat(32), ocr: OCR_PROFILE,
    }) };
    if (specifier === "../../../lib/negotiation-round-state") return { deriveNegotiationRoundAction: () => ({ roundStatus: "review", nextAction: "Review" }) };
    if (specifier === "../../../lib/staged-object-cleanup") return {
      cleanupStagedDocumentObject,
      cleanupStagedWorkingVersionObject,
    };
    if (specifier === "../../../lib/stored-document-integrity") return {
      verifyStoredDocumentSource: async () => ({ ok: true, bytes: SOURCE_BYTES, inspected: { extension: "pdf", contentType: "application/pdf" } }),
    };
    if (specifier === "../../../lib/validation") return {
      documentLinkSchema: z.object({ documentId: z.string().uuid(), agreementId: z.number().int().positive() }).strict(),
      parseJson,
      readBoundedBody: async () => new Uint8Array(),
    };
    if (specifier === "../../../lib/document-extraction") return { extractDocumentMetadata: () => ({ tags: [], riskFlags: [], extracted: {} }) };
    if (specifier === "../../../lib/document-upload-idempotency") return {
      canonicalDocumentUploadIdempotencyKey: (value: string) => value,
      documentUploadExpiresAt: () => "2026-08-21T12:00:00.000Z",
      documentUploadKeyDigest: async () => "k".repeat(64),
      documentUploadLinkReceiptState: () => "missing",
      documentUploadRequestDigest: async () => "r".repeat(64),
    };
    throw new Error(`Unexpected import-route dependency: ${specifier}`);
  };
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports, require: requireModule,
    Request, Response, Headers, URL, FormData, Blob, File, Buffer, Date,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, crypto, console, setTimeout, clearTimeout,
  });
  new vm.Script(compiledRoute, { filename: "app/api/documents/import/route.cjs" }).runInContext(context);
  const patch = moduleObject.exports.PATCH as (request: Request) => Promise<Response>;
  const put = moduleObject.exports.PUT as (request: Request) => Promise<Response>;
  const call = async () => {
    const response = await patch(new Request("https://notice.example.test/api/documents/import", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: DOCUMENT_ID, agreementId: AGREEMENT_ID }),
    }));
    return { response, body: await response.json() as Record<string, unknown> };
  };
  const callRescan = async () => {
    const response = await put(new Request("https://notice.example.test/api/documents/import", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: DOCUMENT_ID }),
    }));
    return { response, body: await response.json() as Record<string, unknown> };
  };
  return { call, callRescan, puts, objects };
}

function rejectedPurgeJob(database: DatabaseSync) {
  const row = database.prepare(`SELECT id, workspace_id, resource_type, resource_id, object_keys, attempts
    FROM purge_jobs WHERE resource_type = 'document' ORDER BY created_at DESC LIMIT 1`).get();
  assert.ok(row);
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    resourceType: "document" as const,
    resourceId: String(row.resource_id),
    objectKeys: JSON.parse(String(row.object_keys)) as unknown,
    attempts: Number(row.attempts),
  };
}

test("deferred OCR eligibility excludes TXT and RTF while retaining PDF and DOCX", () => {
  assert.equal(supportsCustomerHostedOcr({ extension: "pdf", contentType: "application/pdf" }), true);
  assert.equal(supportsCustomerHostedOcr({ extension: "docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), true);
  assert.equal(supportsCustomerHostedOcr({ extension: "txt", contentType: "text/plain" }), false);
  assert.equal(supportsCustomerHostedOcr({ extension: "rtf", contentType: "application/rtf" }), false);
  assert.match(routeSource, /const deferredOcrProfile = ocrEligible \? scannerConfiguration\?\.ocr \?\? null : null/);
  assert.match(routeSource, /ocrEligible \? \{ ocrStatus: "disabled" \} : \{\}/);
});

test("protocol-v1 rescan claim serializes concurrent scanner calls", async () => {
  const database = createDatabase();
  let scannerCalls = 0;
  let scannerStarted!: () => void;
  let releaseScanner!: () => void;
  const started = new Promise<void>((resolve) => { scannerStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseScanner = resolve; });
  try {
    database.prepare("UPDATE documents SET scan_status = 'quarantined', scan_provider = 'scan-gateway', scanned_at = '2026-08-20T11:00:00.000Z' WHERE id = ?").run(DOCUMENT_ID);
    const harness = routeHarness(database, async () => cleanResult(), {
      canRescanDocument: (status) => status === "quarantined",
      scan: async () => {
        scannerCalls += 1;
        scannerStarted();
        await released;
        return { status: "clean", provider: "scanner-a", detail: "clean", scannedAt: new Date().toISOString() };
      },
    });
    const first = harness.callRescan();
    await started;
    const concurrent = await harness.callRescan();
    assert.equal(concurrent.response.status, 409, JSON.stringify(concurrent.body));
    assert.equal((concurrent.body.error as { code: string }).code, "rescan_in_progress");
    assert.equal(scannerCalls, 1, "only the durable claim owner may call the scanner");
    releaseScanner();
    const completed = await first;
    assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
    const document = database.prepare("SELECT version, scan_status, scan_provider, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.version, 3);
    assert.equal(document?.scan_status, "clean");
    assert.equal(document?.scan_provider, "scanner-a");
    assert.equal(document?.deleted_at, null);
  } finally {
    releaseScanner?.();
    database.close();
  }
});

test("a correlated malicious stale claimant monotonically rejects a concurrently clean rescan", async () => {
  const database = createDatabase();
  let scannerCalls = 0;
  let firstScannerStarted!: () => void;
  let releaseFirstScanner!: () => void;
  let maliciousEvidenceStarted!: () => void;
  let releaseMaliciousEvidence!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstScannerStarted = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirstScanner = resolve; });
  const evidenceStarted = new Promise<void>((resolve) => { maliciousEvidenceStarted = resolve; });
  const evidenceReleased = new Promise<void>((resolve) => { releaseMaliciousEvidence = resolve; });
  try {
    database.prepare("UPDATE documents SET scan_status = 'quarantined', scan_provider = 'scan-gateway', scanned_at = '2026-08-20T11:00:00.000Z' WHERE id = ?").run(DOCUMENT_ID);
    const harness = routeHarness(database, async () => cleanResult(), {
      canRescanDocument: (status) => status === "quarantined",
      scan: async () => {
        scannerCalls += 1;
        if (scannerCalls === 1) {
          firstScannerStarted();
          await firstReleased;
          return { status: "malicious", provider: "scanner-malicious", detail: "correlated malware", scannedAt: new Date().toISOString() };
        }
        return { status: "clean", provider: "scanner-clean", detail: "clean", scannedAt: new Date().toISOString() };
      },
      beforeWorkspaceEvent: async (input) => {
        if (typeof input.detail !== "string" || !input.detail.includes('"provider":"scanner-malicious"')) return;
        maliciousEvidenceStarted();
        await evidenceReleased;
      },
    });

    const staleMalicious = harness.callRescan();
    await firstStarted;
    // Model passage beyond the lease without mutating the claimed version or
    // byte identity. A new worker may now recover the abandoned claim.
    database.prepare("UPDATE documents SET scanned_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(DOCUMENT_ID);
    const recoveredClean = await harness.callRescan();
    assert.equal(recoveredClean.response.status, 200, JSON.stringify(recoveredClean.body));
    assert.equal(database.prepare("SELECT scan_status FROM documents WHERE id = ?").get(DOCUMENT_ID)?.scan_status, "clean");

    releaseFirstScanner();
    await evidenceStarted;
    const fenced = database.prepare("SELECT scan_status, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(fenced?.scan_status, "rejected", "malicious verdict must close D1 readability before audit preparation can wait");
    assert.notEqual(fenced?.deleted_at, null);
    releaseMaliciousEvidence();
    const malicious = await staleMalicious;
    assert.equal(malicious.response.status, 422, JSON.stringify(malicious.body));
    assert.equal((malicious.body.error as { code: string }).code, "malware_detected");
    assert.equal(scannerCalls, 2);
    const document = database.prepare("SELECT version, scan_status, scan_provider, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.version, 5);
    assert.equal(document?.scan_status, "rejected");
    assert.equal(document?.scan_provider, "scanner-malicious");
    assert.notEqual(document?.deleted_at, null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM purge_jobs WHERE resource_type = 'document'").get()?.count, 1);
  } finally {
    releaseFirstScanner?.();
    releaseMaliciousEvidence?.();
    database.close();
  }
});

test("a newer malicious rescan cannot be undone or resurrected in R2 by a stale clean claimant", async () => {
  const database = createDatabase();
  let scannerCalls = 0;
  let staleCleanStarted!: () => void;
  let releaseStaleClean!: () => void;
  const started = new Promise<void>((resolve) => { staleCleanStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseStaleClean = resolve; });
  try {
    database.prepare("UPDATE documents SET scan_status = 'quarantined', scan_provider = 'scan-gateway', scanned_at = '2026-08-20T11:00:00.000Z' WHERE id = ?").run(DOCUMENT_ID);
    const harness = routeHarness(database, async () => cleanResult(), {
      canRescanDocument: (status) => status === "quarantined",
      scan: async () => {
        scannerCalls += 1;
        if (scannerCalls === 1) {
          staleCleanStarted();
          await released;
          return { status: "clean", provider: "scanner-stale-clean", detail: "clean", scannedAt: new Date().toISOString() };
        }
        return { status: "malicious", provider: "scanner-malicious", detail: "correlated malware", scannedAt: new Date().toISOString() };
      },
    });

    const staleClean = harness.callRescan();
    await started;
    database.prepare("UPDATE documents SET scanned_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(DOCUMENT_ID);
    const malicious = await harness.callRescan();
    assert.equal(malicious.response.status, 422, JSON.stringify(malicious.body));
    assert.equal(database.prepare("SELECT scan_status FROM documents WHERE id = ?").get(DOCUMENT_ID)?.scan_status, "rejected");
    assert.equal(database.prepare("SELECT count(*) AS count FROM purge_jobs WHERE resource_type = 'document'").get()?.count, 1);

    // Model the durable cleanup worker completing before the stale clean
    // request resumes. A post-verdict R2 put would recreate an untracked copy.
    harness.objects.delete(SOURCE_KEY);
    releaseStaleClean();
    const staleResult = await staleClean;
    assert.equal(staleResult.response.status, 422, JSON.stringify(staleResult.body));
    assert.equal((staleResult.body.error as { code: string }).code, "malware_detected");
    assert.equal(database.prepare("SELECT scan_status FROM documents WHERE id = ?").get(DOCUMENT_ID)?.scan_status, "rejected");
    assert.equal(harness.objects.has(SOURCE_KEY), false, "stale clean worker must not recreate deleted malicious bytes");
    assert.equal(harness.puts.filter((put) => put.key === SOURCE_KEY).length, 0);
  } finally {
    releaseStaleClean?.();
    database.close();
  }
});

test("malicious v2 OCR atomically revokes source readability, never promotes paper, and creates no working version", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database, async () => { throw maliciousError(); });
    const result = await harness.call();
    assert.equal(result.response.status, 422, JSON.stringify(result.body));
    assert.equal((result.body.error as { code: string }).code, "ocr_source_rejected");
    const document = database.prepare("SELECT version, agreement_id, scan_status, scan_provider, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.version, 3);
    assert.equal(document?.agreement_id, AGREEMENT_ID, "rejected source must retain its target-policy association");
    assert.equal(document?.scan_status, "rejected");
    assert.equal(document?.scan_provider, "customer-isolated-ocr");
    assert.ok(document?.deleted_at);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 0);
    assert.equal(harness.puts.length, 0);
    const purge = database.prepare("SELECT object_keys FROM purge_jobs").get();
    assert.deepEqual(JSON.parse(String(purge?.object_keys)), [SOURCE_KEY]);
    const evidence = database.prepare("SELECT detail FROM workspace_events WHERE detail LIKE '%notice.document_security.rescan.v1%' ORDER BY sequence DESC LIMIT 1").get();
    assert.match(String(evidence?.detail), /"scannerProtocol":"2\.0"/);
    assert.match(String(evidence?.detail), /"scannerRequestId":"33333333-3333-4333-8333-333333333333"/);
    assert.match(String(evidence?.detail), /"ocrModelId":"customer-vision-v1"/);
    assert.match(String(evidence?.detail), /"ocrProfileId":"contracts-en-v1"/);
  } finally {
    database.close();
  }
});

test("exact-request malicious verdicts remain rejecting when ancillary response fields are malformed", async (t) => {
  const variants = ["extra", "extraction", "provider-long", "provider-surrogate", "detail-surrogate"] as const;
  for (const variant of variants) {
    await t.test(variant, async () => {
      const database = createDatabase();
      try {
        // Gateway-conformance tests prove each malformed wire shape is
        // classified as malicious_source. This route regression proves every
        // such sanitized classification takes the same irreversible path.
        const harness = routeHarness(database, async () => {
          throw new CustomerHostedOcrError(
            "malicious_source",
            `Correlated malicious verdict with malformed ${variant} evidence.`,
            422,
            {
              requestId: "33333333-3333-4333-8333-333333333333",
              provider: "scan-gateway",
              detail: `Sanitized ${variant} evidence`,
              scannedAt: "2026-08-20T12:05:00.000Z",
            },
          );
        });
        const result = await harness.call();
        assert.equal(result.response.status, 422, JSON.stringify(result.body));
        assert.equal((result.body.error as { code: string }).code, "ocr_source_rejected");
        const document = database.prepare("SELECT agreement_id, scan_status, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
        assert.equal(document?.agreement_id, AGREEMENT_ID);
        assert.equal(document?.scan_status, "rejected");
        assert.equal(isDocumentReadable(String(document?.scan_status), "production"), false);
        assert.ok(document?.deleted_at, "download queries must not find the rejected row as active");
        assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 0);
        assert.equal(harness.puts.length, 0);
        assert.ok(harness.objects.has(SOURCE_KEY), "retention owns deletion after durable rejection");
      } finally {
        database.close();
      }
    });
  }
});

test("target agreement legal hold is fenced into the claim and retains rejected source bytes", async () => {
  const database = createDatabase(true);
  try {
    const harness = routeHarness(database, async () => { throw maliciousError(); });
    assert.equal((await harness.call()).response.status, 422);
    const document = database.prepare("SELECT legal_hold, scan_status, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.legal_hold, 1);
    assert.equal(document?.scan_status, "rejected");
    assert.ok(document?.deleted_at);
    assert.equal(database.prepare("SELECT count(*) AS count FROM purge_jobs").get()?.count, 0);
    assert.ok(harness.objects.has(SOURCE_KEY));
  } finally {
    database.close();
  }
});

test("a hold activated after the verdict policy read but before rejection commit still fences cleanup", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database, async () => { throw maliciousError(); }, {
      beforeBatch: (batchNumber) => {
        if (batchNumber === 2) {
          database.prepare("UPDATE agreements SET legal_hold = 1, version = version + 1, updated_at = '2026-08-20T12:08:00.000Z' WHERE id = ?").run(AGREEMENT_ID);
        }
      },
    });
    assert.equal((await harness.call()).response.status, 422);
    const document = database.prepare("SELECT agreement_id, legal_hold, scan_status FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.agreement_id, AGREEMENT_ID);
    assert.equal(document?.legal_hold, 0, "the interleaving intentionally occurs after the pre-read");
    assert.equal(document?.scan_status, "rejected");
    const job = rejectedPurgeJob(database);
    const policyDb = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
    assert.deepEqual(await assessRejectedObjectCleanupPolicy(policyDb, job), {
      action: "defer",
      resourceId: DOCUMENT_ID,
      reason: "agreement legal hold is active",
    });
    assert.equal(await claimRejectedObjectCleanup(policyDb, job), false);
    assert.ok(harness.objects.has(SOURCE_KEY));
  } finally {
    database.close();
  }
});

test("a target hold enabled after the 422 response makes the retention worker retain rejected bytes", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database, async () => { throw maliciousError(); });
    assert.equal((await harness.call()).response.status, 422);
    database.prepare("UPDATE agreements SET legal_hold = 1, version = version + 1, updated_at = '2026-08-20T12:09:00.000Z' WHERE id = ?").run(AGREEMENT_ID);
    const job = rejectedPurgeJob(database);
    const policyDb = drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
    const policy = await assessRejectedObjectCleanupPolicy(policyDb, job);
    let deletionAttempted = false;
    if (policy?.action === "allow" && await claimRejectedObjectCleanup(policyDb, job)) {
      deletionAttempted = true;
      harness.objects.delete(SOURCE_KEY);
    }
    assert.equal(policy?.action, "defer");
    assert.equal(deletionAttempted, false);
    assert.ok(harness.objects.has(SOURCE_KEY));
  } finally {
    database.close();
  }
});

test("an unavailable OCR call releases the claim without linking or creating a working version", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database, async () => {
      throw new CustomerHostedOcrError("gateway_timeout", "The customer-hosted OCR gateway timed out.", 503);
    });
    const result = await harness.call();
    assert.equal(result.response.status, 503, JSON.stringify(result.body));
    const document = database.prepare("SELECT version, agreement_id, scan_status, scan_provider, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.version, 3);
    assert.equal(document?.agreement_id, null);
    assert.equal(document?.scan_status, "clean");
    assert.equal(document?.scan_provider, "approved-scanner");
    assert.equal(document?.deleted_at, null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 0);
    assert.equal(harness.puts.length, 0);
    assert.match(routeSource, /hasActiveDocumentClaim\(document, "customer-hosted-ocr-pending", ACTIVE_OCR_CLAIM_MAX_AGE_MS\)/);
  } finally {
    database.close();
  }
});

test("a wrong-request malicious OCR response remains quarantined and cannot be retried as clean", async () => {
  const database = createDatabase();
  let calls = 0;
  try {
    const harness = routeHarness(database, async () => {
      calls += 1;
      // The production boundary classifies a wrong requestId as this untrusted
      // response. The route must preserve the unreadable claim rather than
      // restoring the prior clean/downloadable state.
      throw new CustomerHostedOcrError("invalid_response", "The OCR response did not match the signed request.", 503);
    });
    const result = await harness.call();
    assert.equal(result.response.status, 503, JSON.stringify(result.body));
    assert.equal((result.body.error as { code: string }).code, "customer_hosted_ocr_response_untrusted");
    const document = database.prepare("SELECT version, agreement_id, scan_status, scan_provider, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.version, 2);
    assert.equal(document?.agreement_id, null);
    assert.equal(document?.scan_status, "quarantined");
    assert.equal(document?.scan_provider, "customer-hosted-ocr-pending");
    assert.equal(document?.deleted_at, null);
    assert.equal(isDocumentReadable(String(document?.scan_status), "production"), false);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 0);
    const retry = await harness.call();
    assert.equal(retry.response.status, 409);
    assert.equal(calls, 1, "quarantined source must not be sent again through the link path");
    assert.equal(harness.puts.length, 0);
  } finally {
    database.close();
  }
});

test("a clean OCR result followed by an agreement edit releases the claim for immediate retry", async () => {
  const database = createDatabase();
  let calls = 0;
  try {
    const harness = routeHarness(database, async () => {
      calls += 1;
      if (calls === 1) {
        database.prepare("UPDATE agreements SET version = version + 1, updated_at = '2026-08-20T12:10:00.000Z' WHERE id = ?").run(AGREEMENT_ID);
      }
      return cleanResult();
    });
    const failed = await harness.call();
    assert.equal(failed.response.status, 409, JSON.stringify(failed.body));
    assert.equal((failed.body.error as { code: string }).code, "customer_hosted_ocr_commit_failed");
    assert.match(String((failed.body.error as { message: string }).message), /restored.*prior clean scan state.*retry/i);
    const released = database.prepare("SELECT agreement_id, scan_status, scan_provider FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(released?.agreement_id, null);
    assert.equal(released?.scan_status, "clean");
    assert.equal(released?.scan_provider, "approved-scanner");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 0);
    assert.deepEqual([...harness.objects.keys()], [SOURCE_KEY]);
    const retried = await harness.call();
    assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 1);
  } finally {
    database.close();
  }
});

for (const failure of ["r2", "event"] as const) {
  test(`a clean OCR ${failure} persistence failure removes staging and releases the claim`, async () => {
    const database = createDatabase();
    try {
      const harness = routeHarness(database, async () => cleanResult(), {
        failWorkingVersionPutOnce: failure === "r2",
        failFinalAgreementEventOnce: failure === "event",
      });
      const failed = await harness.call();
      assert.equal(failed.response.status, 503, JSON.stringify(failed.body));
      assert.equal((failed.body.error as { code: string }).code, "customer_hosted_ocr_commit_failed");
      const released = database.prepare("SELECT agreement_id, scan_status, scan_provider FROM documents WHERE id = ?").get(DOCUMENT_ID);
      assert.equal(released?.agreement_id, null);
      assert.equal(released?.scan_status, "clean");
      assert.equal(released?.scan_provider, "approved-scanner");
      assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 0);
      assert.deepEqual([...harness.objects.keys()], [SOURCE_KEY], "no uncommitted working object may remain");
      assert.equal((await harness.call()).response.status, 200);
      assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 1);
    } finally {
      database.close();
    }
  });
}

test("a lost final-batch acknowledgement reads back the exact committed OCR version instead of releasing it", async () => {
  const database = createDatabase();
  try {
    const harness = routeHarness(database, async () => cleanResult(), {
      afterBatchCommit: (batchNumber) => {
        if (batchNumber === 2) throw new Error("Synthetic lost D1 acknowledgement");
      },
    });
    const result = await harness.call();
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.alreadyLinked, true);
    assert.equal(result.body.workingVersionCreated, true);
    const document = database.prepare("SELECT agreement_id, scan_status, scan_provider FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.agreement_id, AGREEMENT_ID);
    assert.equal(document?.scan_status, "clean");
    assert.equal(document?.scan_provider, "customer-isolated-ocr");
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 1);
    assert.equal(harness.objects.size, 2, "the now-authoritative working object must not be cleaned up");
  } finally {
    database.close();
  }
});

test("the pre-inference claim serializes concurrent clean and malicious link attempts", async () => {
  const database = createDatabase();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  try {
    const harness = routeHarness(database, async () => {
      calls += 1;
      if (calls > 1) {
        return {
          text: "A clean result that must never win the concurrent claim.",
          requestId: "55555555-5555-4555-8555-555555555555",
          provider: "customer-isolated-ocr",
          detail: "Complete",
          modelId: OCR_PROFILE.modelId,
          profileId: OCR_PROFILE.profileId,
          sourceSha256: SOURCE_SHA256,
        };
      }
      started();
      await gate;
      throw maliciousError();
    });
    const malicious = harness.call();
    await began;
    const wouldBeClean = await harness.call();
    assert.equal(wouldBeClean.response.status, 409);
    assert.equal(calls, 1, "the losing clean attempt must not send source bytes");
    release();
    assert.equal((await malicious).response.status, 422);
    const final = database.prepare("SELECT agreement_id, scan_status, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(final?.agreement_id, AGREEMENT_ID);
    assert.equal(final?.scan_status, "rejected");
    assert.ok(final?.deleted_at);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreement_document_versions").get()?.count, 0);
  } finally {
    release?.();
    database.close();
  }
});

test("a target hold activated during OCR retains bytes without blocking malicious rejection", async () => {
  const database = createDatabase();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  try {
    const harness = routeHarness(database, async () => {
      started();
      await gate;
      throw maliciousError();
    });
    const pending = harness.call();
    await began;
    database.prepare("UPDATE agreements SET legal_hold = 1, version = version + 1, updated_at = '2026-08-20T12:07:00.000Z' WHERE id = ?").run(AGREEMENT_ID);
    release();
    assert.equal((await pending).response.status, 422);
    const document = database.prepare("SELECT scan_status, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.scan_status, "rejected");
    assert.ok(document?.deleted_at);
    assert.equal(database.prepare("SELECT count(*) AS count FROM purge_jobs").get()?.count, 0);
    assert.ok(harness.objects.has(SOURCE_KEY));
  } finally {
    release?.();
    database.close();
  }
});

test("a target agreement edit after the OCR claim cannot preserve a freshly malicious source", async () => {
  const database = createDatabase();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  try {
    const harness = routeHarness(database, async () => {
      started();
      await gate;
      throw maliciousError();
    });
    const pending = harness.call();
    await began;
    database.prepare("UPDATE agreements SET version = version + 1, updated_at = '2026-08-20T12:06:00.000Z' WHERE id = ?").run(AGREEMENT_ID);
    release();
    assert.equal((await pending).response.status, 422);
    const document = database.prepare("SELECT scan_status, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.scan_status, "rejected");
    assert.ok(document?.deleted_at);
  } finally {
    release?.();
    database.close();
  }
});

test("clean OCR output preserves exact accepted bytes and immutable gateway correlation metadata", async () => {
  const database = createDatabase();
  const exactText = "  Clause 😀 remains exact.  \n";
  try {
    const harness = routeHarness(database, async () => ({
      text: exactText,
      requestId: "44444444-4444-4444-8444-444444444444",
      provider: "customer-isolated-ocr",
      detail: "Complete",
      modelId: OCR_PROFILE.modelId,
      profileId: OCR_PROFILE.profileId,
      sourceSha256: SOURCE_SHA256,
    }));
    const result = await harness.call();
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(harness.puts.length, 1);
    assert.deepEqual(harness.puts[0].bytes, new TextEncoder().encode(exactText));
    const metadata = harness.puts[0].options.customMetadata as Record<string, string>;
    assert.equal(metadata.ocrProtocol, "2.0");
    assert.equal(metadata.ocrRequestId, "44444444-4444-4444-8444-444444444444");
    assert.equal(metadata.ocrProvider, "customer-isolated-ocr");
    assert.equal(metadata.ocrModelId, OCR_PROFILE.modelId);
    assert.equal(metadata.ocrProfileId, OCR_PROFILE.profileId);
    assert.equal(metadata.ocrSourceSha256, SOURCE_SHA256);
    const version = database.prepare("SELECT size, sha256, source_document_id FROM agreement_document_versions").get();
    assert.equal(version?.size, new TextEncoder().encode(exactText).byteLength);
    assert.equal(version?.sha256, await digest(new TextEncoder().encode(exactText)));
    assert.equal(version?.source_document_id, DOCUMENT_ID);
    const document = database.prepare("SELECT agreement_id, scan_status, deleted_at FROM documents WHERE id = ?").get(DOCUMENT_ID);
    assert.equal(document?.agreement_id, AGREEMENT_ID);
    assert.equal(document?.scan_status, "clean");
    assert.equal(document?.deleted_at, null);
    const event = database.prepare("SELECT detail FROM agreement_events WHERE detail LIKE '%signed OCR protocol 2.0 request%'").get();
    assert.match(String(event?.detail), /44444444-4444-4444-8444-444444444444.*customer-isolated-ocr/);
  } finally {
    database.close();
  }
});

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

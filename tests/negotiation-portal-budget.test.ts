import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";
import {
  NEGOTIATION_PORTAL_MAX_ACCEPTED_UPLOADS,
  NEGOTIATION_PORTAL_MAX_DOWNLOAD_ATTEMPTS,
  NEGOTIATION_PORTAL_MAX_REJECTED_UPLOADS,
  NEGOTIATION_PORTAL_TRANSFER_POLICY,
  NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES,
  claimNegotiationPortalDownload,
  claimNegotiationPortalUpload,
  completeNegotiationPortalUpload,
  rejectNegotiationPortalUpload,
} from "../app/lib/negotiation-portal-budget";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly bindings: readonly SQLInputValue[] = [],
  ) {}

  bind(...bindings: SQLInputValue[]) {
    return new SqliteD1Statement(this.database, this.query, bindings);
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first<T>() {
    return (this.database.prepare(this.query).get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.database.prepare(this.query).all(...this.bindings) as T[] };
  }

  async raw<T extends unknown[]>() {
    return sqliteD1RawRows<T>(this.database, this.query, this.bindings);
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(query: string) { return new SqliteD1Statement(this.database, query); }
}

const migrationNames = readdirSync(new URL("../drizzle", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

function applyMigrations(database: DatabaseSync): void {
  for (const name of migrationNames) {
    const source = readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
}

function portalDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  const db = drizzle(new SqliteD1(sqlite) as unknown as D1Database, { schema });
  return { sqlite, db };
}

const NOW = "2026-08-20T00:00:00.000Z";
const AFTER_LEASE = "2026-08-20T00:05:00.000Z";
const TOKEN_HASH = "a".repeat(64);
const OUTBOUND_SHA256 = "b".repeat(64);

test("portal policy makes its durable round and token-rotation semantics explicit", () => {
  assert.equal(NEGOTIATION_PORTAL_TRANSFER_POLICY.budgetScope, "exchange_round");
  assert.equal(NEGOTIATION_PORTAL_TRANSFER_POLICY.tokenRotationResetsBudget, false);
  assert.equal(NEGOTIATION_PORTAL_TRANSFER_POLICY.maximumAcceptedUploads, 4);
  assert.equal(NEGOTIATION_PORTAL_TRANSFER_POLICY.busyRetryAfterSeconds, 5);
});

function seedRound(database: DatabaseSync, id: string, tokenHash = TOKEN_HASH, agreementId = 701): void {
  database.prepare(`INSERT INTO negotiation_rounds (
    id, workspace_id, agreement_id, round_number, status, active_key, alias_code,
    base_document_version, base_sha256, outbound_document_id, outbound_sha256,
    portal_token_hash, portal_expires_at, created_by_user_id, created_at, updated_at
  ) VALUES (?, 'workspace-a', ?, 1, 'outbound', ?, ?, 1, ?, ?, ?, ?,
    '2026-09-20T00:00:00.000Z', 'user-a', ?, ?)`)
    .run(id, agreementId, `agreement:${agreementId}:${id}`, `alias-${id}`, "c".repeat(64), `document-${id}`, OUTBOUND_SHA256, tokenHash, NOW, NOW);
}

function uploadClaim(db: ReturnType<typeof portalDatabase>["db"], reservationId: string, now = NOW) {
  return claimNegotiationPortalUpload(db, {
    workspaceId: "workspace-a",
    tokenHash: TOKEN_HASH,
    reservationId,
    now,
  });
}

test("concurrent portal upload claims admit one scanner workload and durably charge a rejected release", async () => {
  const { sqlite, db } = portalDatabase();
  try {
    seedRound(sqlite, "round-concurrent");
    const claims = await Promise.all([uploadClaim(db, "reservation-a"), uploadClaim(db, "reservation-b")]);
    assert.equal(claims.filter((claim) => claim.ok).length, 1);
    assert.deepEqual(claims.filter((claim) => !claim.ok).map((claim) => claim.reason), ["busy"]);
    const owned = claims.find((claim) => claim.ok);
    assert.ok(owned?.ok);
    assert.equal(await rejectNegotiationPortalUpload(db, owned.reservation, 1_024), true);

    const row = sqlite.prepare(`SELECT portal_upload_attempts AS attempts,
      portal_upload_accepted AS accepted, portal_upload_rejected AS rejected,
      portal_upload_bytes AS bytes, portal_upload_reservation_id AS reservationId
      FROM negotiation_rounds WHERE id = 'round-concurrent'`).get();
    assert.deepEqual({ ...row }, { attempts: 1, accepted: 0, rejected: 1, bytes: 1_024, reservationId: null });
  } finally {
    sqlite.close();
  }
});

test("accepted and rejected upload retry classes are independently bounded for one reusable token", async () => {
  const acceptedDatabase = portalDatabase();
  try {
    seedRound(acceptedDatabase.sqlite, "round-accepted");
    for (let index = 0; index < NEGOTIATION_PORTAL_MAX_ACCEPTED_UPLOADS; index += 1) {
      const claim = await uploadClaim(acceptedDatabase.db, `accepted-${index}`);
      assert.ok(claim.ok);
      assert.equal(await completeNegotiationPortalUpload(acceptedDatabase.db, claim.reservation, {
        accepted: true,
        consumedBytes: 2_048,
      }), true);
    }
    assert.deepEqual(await uploadClaim(acceptedDatabase.db, "accepted-exhausted"), { ok: false, reason: "exhausted" });
    const accepted = acceptedDatabase.sqlite.prepare(`SELECT portal_upload_attempts AS attempts,
      portal_upload_accepted AS accepted, portal_upload_rejected AS rejected
      FROM negotiation_rounds WHERE id = 'round-accepted'`).get();
    assert.deepEqual({ ...accepted }, { attempts: 4, accepted: 4, rejected: 0 });
  } finally {
    acceptedDatabase.sqlite.close();
  }

  const rejectedDatabase = portalDatabase();
  try {
    seedRound(rejectedDatabase.sqlite, "round-rejected");
    for (let index = 0; index < NEGOTIATION_PORTAL_MAX_REJECTED_UPLOADS; index += 1) {
      const claim = await uploadClaim(rejectedDatabase.db, `rejected-${index}`);
      assert.ok(claim.ok);
      assert.equal(await rejectNegotiationPortalUpload(rejectedDatabase.db, claim.reservation, 0), true);
    }
    assert.deepEqual(await uploadClaim(rejectedDatabase.db, "rejected-exhausted"), { ok: false, reason: "exhausted" });
  } finally {
    rejectedDatabase.sqlite.close();
  }
});

test("aborted full-size upload reservations exhaust the byte budget instead of becoming free retries", async () => {
  const { sqlite, db } = portalDatabase();
  try {
    seedRound(sqlite, "round-byte-budget");
    for (let index = 0; index < 4; index += 1) {
      const claim = await uploadClaim(db, `aborted-${index}`);
      assert.ok(claim.ok);
      assert.equal(await rejectNegotiationPortalUpload(db, claim.reservation, claim.reservation.reservedBytes), true);
    }
    assert.deepEqual(await uploadClaim(db, "aborted-over-budget"), { ok: false, reason: "exhausted" });
    assert.equal(
      sqlite.prepare("SELECT portal_upload_bytes AS bytes FROM negotiation_rounds WHERE id = 'round-byte-budget'").get()?.bytes,
      4 * NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES,
    );
  } finally {
    sqlite.close();
  }
});

test("a stale upload lease is charged as rejected and its former owner cannot commit after replacement", async () => {
  const { sqlite, db } = portalDatabase();
  try {
    seedRound(sqlite, "round-stale");
    const stale = await uploadClaim(db, "stale-owner");
    assert.ok(stale.ok);
    const replacement = await uploadClaim(db, "replacement-owner", AFTER_LEASE);
    assert.ok(replacement.ok);
    assert.equal(await completeNegotiationPortalUpload(db, stale.reservation, { accepted: true, consumedBytes: 1 }), false);
    assert.equal(await completeNegotiationPortalUpload(db, replacement.reservation, { accepted: true, consumedBytes: 2 }), true);
    const row = sqlite.prepare(`SELECT portal_upload_attempts AS attempts,
      portal_upload_accepted AS accepted, portal_upload_rejected AS rejected,
      portal_upload_bytes AS bytes FROM negotiation_rounds WHERE id = 'round-stale'`).get();
    assert.deepEqual({ ...row }, { attempts: 2, accepted: 1, rejected: 1, bytes: NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES + 2 });
  } finally {
    sqlite.close();
  }
});

test("download replay, concurrency, and cumulative bytes are all atomically bounded before object reads", async () => {
  const { sqlite, db } = portalDatabase();
  try {
    seedRound(sqlite, "round-downloads");
    const download = (bytes: number) => claimNegotiationPortalDownload(db, {
      workspaceId: "workspace-a",
      agreementId: 701,
      roundId: "round-downloads",
      tokenHash: TOKEN_HASH,
      outboundDocumentId: "document-round-downloads",
      outboundSha256: OUTBOUND_SHA256,
      bytes,
      now: NOW,
    });
    const concurrent = await Promise.all(Array.from(
      { length: NEGOTIATION_PORTAL_MAX_DOWNLOAD_ATTEMPTS + 1 },
      () => download(1_024 * 1_024),
    ));
    assert.equal(concurrent.filter((claim) => claim.ok).length, NEGOTIATION_PORTAL_MAX_DOWNLOAD_ATTEMPTS);
    assert.deepEqual(concurrent.filter((claim) => !claim.ok).map((claim) => claim.reason), ["exhausted"]);

    seedRound(sqlite, "round-download-bytes", "d".repeat(64), 702);
    const byteDownload = () => claimNegotiationPortalDownload(db, {
      workspaceId: "workspace-a",
      agreementId: 702,
      roundId: "round-download-bytes",
      tokenHash: "d".repeat(64),
      outboundDocumentId: "document-round-download-bytes",
      outboundSha256: OUTBOUND_SHA256,
      bytes: 20 * 1_024 * 1_024,
      now: NOW,
    });
    for (let index = 0; index < 12; index += 1) assert.deepEqual(await byteDownload(), { ok: true });
    assert.deepEqual(await byteDownload(), { ok: false, reason: "exhausted" });
  } finally {
    sqlite.close();
  }
});

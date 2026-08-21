import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { sqliteD1RawRows } from "./helpers/sqlite-d1";
import {
  approvalLaneAuthorityCommitPredicate,
  evaluateApprovalLaneAuthority,
  type ApprovalAuthorityBasis,
} from "../app/lib/approval-authority";

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

function authorityDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE approval_lane_authorities (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      lane text NOT NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      currency_code text NOT NULL DEFAULT 'USD',
      amount_limit_minor integer,
      status text NOT NULL DEFAULT 'active',
      reason text NOT NULL DEFAULT '',
      created_by_user_id text NOT NULL DEFAULT 'admin',
      created_at text NOT NULL DEFAULT '2026-08-20T00:00:00.000Z',
      updated_by_user_id text NOT NULL DEFAULT 'admin',
      updated_at text NOT NULL DEFAULT '2026-08-20T00:00:00.000Z'
    );

    CREATE TABLE workspace_groups (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      status text NOT NULL
    );

    CREATE TABLE workspace_group_members (
      workspace_id text NOT NULL,
      group_id text NOT NULL,
      user_id text NOT NULL,
      PRIMARY KEY (workspace_id, group_id, user_id)
    );

    CREATE TABLE users (
      id text PRIMARY KEY,
      status text NOT NULL
    );

    CREATE TABLE workspace_memberships (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL,
      status text NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );

    INSERT INTO users (id, status) VALUES
      ('user-a', 'active'),
      ('user-direct', 'active'),
      ('admin-without-authority', 'active'),
      ('group-member', 'active'),
      ('bounded-user', 'active'),
      ('finance-approver', 'active'),
      ('admin-user', 'active');

    INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
    SELECT 'workspace-a', id,
      CASE id
        WHEN 'user-a' THEN 'legal'
        WHEN 'user-direct' THEN 'requester'
        WHEN 'admin-without-authority' THEN 'admin'
        WHEN 'group-member' THEN 'requester'
        WHEN 'bounded-user' THEN 'admin'
        WHEN 'finance-approver' THEN 'approver'
        ELSE 'admin'
      END,
      'active' FROM users;
  `);
  return database;
}

function authorityDb(database: DatabaseSync) {
  return drizzle(new SqliteD1(database) as unknown as D1Database, { schema });
}

function authority(
  database: DatabaseSync,
  input: Readonly<{
    id: string;
    workspaceId?: string;
    lane?: string;
    subjectType?: "user" | "group";
    subjectId?: string;
    currencyCode?: string;
    amountLimitMinor?: number | null;
    status?: "active" | "revoked";
  }>,
): void {
  database.prepare(`INSERT INTO approval_lane_authorities (
    id, workspace_id, lane, subject_type, subject_id, currency_code,
    amount_limit_minor, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.workspaceId ?? "workspace-a",
      input.lane ?? "Legal",
      input.subjectType ?? "user",
      input.subjectId ?? "user-a",
      input.currencyCode ?? "USD",
      input.amountLimitMinor ?? null,
      input.status ?? "active",
    );
}

function basis(input: Partial<ApprovalAuthorityBasis> = {}): ApprovalAuthorityBasis {
  return {
    workspaceId: "workspace-a",
    lane: "Legal",
    userId: "user-a",
    role: "legal",
    currencyCode: "USD",
    amountMinor: 10_000,
    ...input,
  };
}

function commitAllows(database: DatabaseSync, authorityBasis: ApprovalAuthorityBasis): boolean {
  const db = authorityDb(database);
  const query = db.select({ allowed: sql<number>`1` })
    .from(sql`(select 1) as singleton`)
    .where(approvalLaneAuthorityCommitPredicate(db, authorityBasis))
    .limit(1)
    .toSQL();
  return database.prepare(query.sql).get(...query.params as SQLInputValue[]) !== undefined;
}

function guardedCommitChanges(
  database: DatabaseSync,
  authorityBasis: ApprovalAuthorityBasis,
  authorityId: string,
): number {
  const db = authorityDb(database);
  const query = db.update(schema.approvalLaneAuthorities)
    .set({ reason: "commit authorized" })
    .where(and(
      eq(schema.approvalLaneAuthorities.id, authorityId),
      approvalLaneAuthorityCommitPredicate(db, authorityBasis),
    ))
    .toSQL();
  return Number(database.prepare(query.sql).run(...query.params as SQLInputValue[]).changes);
}

test("legacy lane roles remain available only before a lane is configured", async () => {
  const database = authorityDatabase();
  try {
    const db = authorityDb(database);
    assert.deepEqual(await evaluateApprovalLaneAuthority(db, basis()), {
      configured: false,
      authorized: true,
      source: "legacy_default",
      authorityId: null,
      blocker: null,
    });
    assert.equal((await evaluateApprovalLaneAuthority(db, basis({ role: "approver" }))).authorized, false);
    assert.equal((await evaluateApprovalLaneAuthority(db, basis({ userId: "finance-approver", lane: "Finance", role: "approver" }))).authorized, true);
    assert.equal((await evaluateApprovalLaneAuthority(db, basis({ userId: "admin-user", lane: "Security", role: "admin" }))).authorized, true);
    assert.equal(commitAllows(database, basis()), true);
    assert.equal(commitAllows(database, basis({ role: "approver" })), false);
  } finally {
    database.close();
  }
});

test("an explicit direct authority replaces role fallback for the configured lane", async () => {
  const database = authorityDatabase();
  try {
    authority(database, { id: "authority-direct", subjectId: "user-direct" });
    const db = authorityDb(database);
    const directBasis = basis({ userId: "user-direct", role: "requester" });
    const result = await evaluateApprovalLaneAuthority(db, directBasis);
    assert.equal(result.configured, true);
    assert.equal(result.authorized, true);
    assert.equal(result.source, "direct");
    assert.equal(result.authorityId, "authority-direct");
    assert.equal(commitAllows(database, directBasis), true);

    const adminWithoutAuthority = basis({ userId: "admin-without-authority", role: "admin" });
    assert.equal((await evaluateApprovalLaneAuthority(db, adminWithoutAuthority)).authorized, false);
    assert.equal(commitAllows(database, adminWithoutAuthority), false);
  } finally {
    database.close();
  }
});

test("active group membership grants authority while disabled and cross-tenant groups do not", async () => {
  const database = authorityDatabase();
  try {
    authority(database, {
      id: "authority-group",
      subjectType: "group",
      subjectId: "legal-group",
    });
    database.exec(`
      INSERT INTO workspace_groups (id, workspace_id, status)
      VALUES ('legal-group', 'workspace-a', 'active');
      INSERT INTO workspace_group_members (workspace_id, group_id, user_id)
      VALUES ('workspace-a', 'legal-group', 'group-member');
    `);
    const db = authorityDb(database);
    const groupBasis = basis({ userId: "group-member", role: "requester" });
    const granted = await evaluateApprovalLaneAuthority(db, groupBasis);
    assert.equal(granted.authorized, true);
    assert.equal(granted.source, "group");
    assert.equal(granted.authorityId, "authority-group");
    assert.equal(commitAllows(database, groupBasis), true);

    database.exec("UPDATE workspace_groups SET status = 'disabled' WHERE id = 'legal-group'");
    assert.equal((await evaluateApprovalLaneAuthority(db, groupBasis)).authorized, false);
    assert.equal(commitAllows(database, groupBasis), false);

    database.exec(`
      UPDATE workspace_groups SET status = 'active' WHERE id = 'legal-group';
      DELETE FROM workspace_group_members;
      INSERT INTO workspace_group_members (workspace_id, group_id, user_id)
      VALUES ('workspace-b', 'legal-group', 'group-member');
    `);
    assert.equal((await evaluateApprovalLaneAuthority(db, groupBasis)).authorized, false);
    assert.equal(commitAllows(database, groupBasis), false);
  } finally {
    database.close();
  }
});

test("authority currency and amount limits fail closed and include the exact upper bound", async () => {
  const database = authorityDatabase();
  try {
    authority(database, {
      id: "authority-bounded",
      subjectId: "bounded-user",
      currencyCode: "EUR",
      amountLimitMinor: 50_000,
    });
    const db = authorityDb(database);
    const exact = basis({ userId: "bounded-user", role: "admin", currencyCode: "EUR", amountMinor: 50_000 });
    assert.equal((await evaluateApprovalLaneAuthority(db, exact)).authorized, true);
    assert.equal(commitAllows(database, exact), true);

    for (const denied of [
      basis({ userId: "bounded-user", role: "admin", currencyCode: "EUR", amountMinor: 50_001 }),
      basis({ userId: "bounded-user", role: "admin", currencyCode: "USD", amountMinor: 1 }),
    ]) {
      assert.equal((await evaluateApprovalLaneAuthority(db, denied)).authorized, false);
      assert.equal(commitAllows(database, denied), false);
    }
  } finally {
    database.close();
  }
});

test("a revoked authority is still configuration evidence and therefore disables fallback", async () => {
  const database = authorityDatabase();
  try {
    authority(database, { id: "authority-revoked", subjectId: "admin-user", status: "revoked" });
    const db = authorityDb(database);
    const revokedBasis = basis({ userId: "admin-user", role: "admin" });
    const result = await evaluateApprovalLaneAuthority(db, revokedBasis);
    assert.equal(result.configured, true);
    assert.equal(result.authorized, false);
    assert.equal(result.source, "none");
    assert.equal(result.blocker?.code, "approval_lane_authority_required");
    assert.equal(commitAllows(database, revokedBasis), false);
  } finally {
    database.close();
  }
});

test("authority evaluation finds an exact direct grant beyond unrelated rows", async () => {
  const database = authorityDatabase();
  try {
    for (let index = 0; index < 125; index += 1) {
      authority(database, {
        id: `unrelated-${String(index).padStart(3, "0")}`,
        subjectId: `other-${index}`,
        currencyCode: index % 2 === 0 ? "EUR" : "USD",
      });
    }
    authority(database, { id: "zz-exact-authority", subjectId: "user-a", currencyCode: "USD", amountLimitMinor: 10_000 });
    const result = await evaluateApprovalLaneAuthority(authorityDb(database), basis());
    assert.equal(result.authorized, true);
    assert.equal(result.source, "direct");
    assert.equal(result.authorityId, "zz-exact-authority");
    assert.equal(commitAllows(database, basis()), true);
  } finally {
    database.close();
  }
});

test("group authority reports the exact matching currency and amount row", async () => {
  const database = authorityDatabase();
  try {
    authority(database, { id: "group-eur", subjectType: "group", subjectId: "finance-group", currencyCode: "EUR" });
    authority(database, { id: "group-usd-low", subjectType: "group", subjectId: "finance-group", currencyCode: "USD", amountLimitMinor: 5_000 });
    authority(database, { id: "group-usd-exact", subjectType: "group", subjectId: "finance-group", currencyCode: "USD", amountLimitMinor: 10_000 });
    database.exec(`
      INSERT INTO workspace_groups (id, workspace_id, status) VALUES ('finance-group', 'workspace-a', 'active');
      INSERT INTO workspace_group_members (workspace_id, group_id, user_id) VALUES ('workspace-a', 'finance-group', 'user-a');
    `);
    const result = await evaluateApprovalLaneAuthority(authorityDb(database), basis());
    assert.equal(result.authorized, true);
    assert.equal(result.source, "group");
    assert.equal(result.authorityId, "group-usd-exact");
  } finally {
    database.close();
  }
});

test("direct authority requires an active user and active workspace membership through commit", async () => {
  const database = authorityDatabase();
  try {
    authority(database, { id: "authority-direct-active", subjectId: "user-direct" });
    const db = authorityDb(database);
    const directBasis = basis({ userId: "user-direct", role: "requester" });

    assert.equal((await evaluateApprovalLaneAuthority(db, directBasis)).authorized, true);
    assert.equal(commitAllows(database, directBasis), true);

    database.exec("UPDATE workspace_memberships SET status = 'disabled' WHERE workspace_id = 'workspace-a' AND user_id = 'user-direct'");
    assert.equal((await evaluateApprovalLaneAuthority(db, directBasis)).authorized, false);
    assert.equal(commitAllows(database, directBasis), false);
    assert.equal(guardedCommitChanges(database, directBasis, "authority-direct-active"), 0);

    database.exec("UPDATE workspace_memberships SET status = 'active' WHERE workspace_id = 'workspace-a' AND user_id = 'user-direct'");
    database.exec("UPDATE users SET status = 'disabled' WHERE id = 'user-direct'");
    assert.equal((await evaluateApprovalLaneAuthority(db, directBasis)).authorized, false);
    assert.equal(commitAllows(database, directBasis), false);
    assert.equal(guardedCommitChanges(database, directBasis, "authority-direct-active"), 0);
  } finally {
    database.close();
  }
});

test("group authority requires an active user and active workspace membership through commit", async () => {
  const database = authorityDatabase();
  try {
    authority(database, {
      id: "authority-group-active",
      subjectType: "group",
      subjectId: "legal-group",
    });
    database.exec(`
      INSERT INTO workspace_groups (id, workspace_id, status)
      VALUES ('legal-group', 'workspace-a', 'active');
      INSERT INTO workspace_group_members (workspace_id, group_id, user_id)
      VALUES ('workspace-a', 'legal-group', 'group-member');
    `);
    const db = authorityDb(database);
    const groupBasis = basis({ userId: "group-member", role: "requester" });

    assert.equal((await evaluateApprovalLaneAuthority(db, groupBasis)).authorized, true);
    assert.equal(commitAllows(database, groupBasis), true);

    database.exec("UPDATE workspace_memberships SET status = 'disabled' WHERE workspace_id = 'workspace-a' AND user_id = 'group-member'");
    assert.equal((await evaluateApprovalLaneAuthority(db, groupBasis)).authorized, false);
    assert.equal(commitAllows(database, groupBasis), false);
    assert.equal(guardedCommitChanges(database, groupBasis, "authority-group-active"), 0);

    database.exec("UPDATE workspace_memberships SET status = 'active' WHERE workspace_id = 'workspace-a' AND user_id = 'group-member'");
    database.exec("UPDATE users SET status = 'disabled' WHERE id = 'group-member'");
    assert.equal((await evaluateApprovalLaneAuthority(db, groupBasis)).authorized, false);
    assert.equal(commitAllows(database, groupBasis), false);
    assert.equal(guardedCommitChanges(database, groupBasis, "authority-group-active"), 0);
  } finally {
    database.close();
  }
});

test("authority evaluation and commit reject a role changed after authentication", async () => {
  const database = authorityDatabase();
  try {
    const db = authorityDb(database);
    const legacyBasis = basis({ userId: "user-a", role: "legal" });
    assert.equal((await evaluateApprovalLaneAuthority(db, legacyBasis)).authorized, true);
    assert.equal(commitAllows(database, legacyBasis), true);
    database.exec("UPDATE workspace_memberships SET role = 'requester' WHERE workspace_id = 'workspace-a' AND user_id = 'user-a'");
    assert.equal((await evaluateApprovalLaneAuthority(db, legacyBasis)).authorized, false);
    assert.equal(commitAllows(database, legacyBasis), false);

    authority(database, { id: "authority-role-fence", subjectId: "user-direct" });
    const directBasis = basis({ userId: "user-direct", role: "requester" });
    assert.equal((await evaluateApprovalLaneAuthority(db, directBasis)).authorized, true);
    database.exec("UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = 'workspace-a' AND user_id = 'user-direct'");
    assert.equal(guardedCommitChanges(database, directBasis, "authority-role-fence"), 0);
  } finally {
    database.close();
  }
});

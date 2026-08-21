import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agreements } from "../db/schema";
import { exactSurvivingApprovalLaneCommitGuard } from "../app/lib/approval-routing-service";

const workspaceId = "workspace-routing-fence";
const agreementId = 41;
const basis = {
  hash: "a".repeat(64),
  documentVersion: 3,
  documentSha256: "b".repeat(64),
};
const inspectedLane = {
  id: "lane-legal",
  role: "Legal",
  status: "Pending",
  version: 1,
};

function databaseWithLane(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE agreements (
      id integer PRIMARY KEY,
      workspace_id text NOT NULL,
      next_action text NOT NULL
    );
    CREATE TABLE approval_requests (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      basis_hash text NOT NULL,
      document_version integer NOT NULL,
      document_sha256 text NOT NULL,
      role text NOT NULL,
      status text NOT NULL,
      version integer NOT NULL,
      approver_user_id text
    );
    INSERT INTO agreements (id, workspace_id, next_action)
    VALUES (41, 'workspace-routing-fence', 'Review approvals');
    INSERT INTO approval_requests (
      id, workspace_id, agreement_id, basis_hash, document_version,
      document_sha256, role, status, version, approver_user_id
    ) VALUES (
      'lane-legal', 'workspace-routing-fence', 41,
      '${"a".repeat(64)}', 3, '${"b".repeat(64)}',
      'Legal', 'Pending', 1, NULL
    );
  `);
  return database;
}

function guardedUpdate(
  database: DatabaseSync,
  expected = [inspectedLane],
): Readonly<{ changes: number; parameterCount: number }> {
  const db = drizzle({} as D1Database);
  const query = db.update(agreements).set({ nextAction: "Routing committed" }).where(and(
    eq(agreements.workspaceId, workspaceId),
    eq(agreements.id, agreementId),
    exactSurvivingApprovalLaneCommitGuard(workspaceId, agreementId, basis, expected),
  ));
  const compiled = query.toSQL();
  const result = database.prepare(compiled.sql).run(...compiled.params as SQLInputValue[]);
  return { changes: Number(result.changes), parameterCount: compiled.params.length };
}

test("the routing commit fence rejects a concurrent claim without relying on parent version drift", () => {
  const database = databaseWithLane();
  try {
    assert.equal(guardedUpdate(database).changes, 1, "the exact inspected lane must remain executable");
    database.exec(`
      UPDATE agreements SET next_action = 'Review approvals' WHERE id = 41;
      UPDATE approval_requests
      SET approver_user_id = 'claiming-user', version = version + 1
      WHERE id = 'lane-legal';
    `);
    assert.equal(
      guardedUpdate(database).changes,
      0,
      "a claim-only lane version change must invalidate the stale routing inspection",
    );
  } finally {
    database.close();
  }
});

test("the routing commit fence binds role and status and permits completed replacement semantics", () => {
  const database = databaseWithLane();
  try {
    database.exec("UPDATE approval_requests SET role = 'Finance' WHERE id = 'lane-legal'");
    assert.equal(guardedUpdate(database).changes, 0, "a role change must invalidate the inspection");

    database.exec(`
      UPDATE approval_requests SET role = 'Legal', status = 'Approved' WHERE id = 'lane-legal';
      UPDATE agreements SET next_action = 'Review approvals' WHERE id = 41;
    `);
    assert.equal(guardedUpdate(database).changes, 0, "a status change must invalidate the inspection");

    database.exec(`
      UPDATE approval_requests SET status = 'Superseded', version = version + 1 WHERE id = 'lane-legal';
      UPDATE agreements SET next_action = 'Review approvals' WHERE id = 41;
    `);
    assert.equal(
      guardedUpdate(database, []).changes,
      1,
      "once replacement supersedes every obsolete lane, an empty surviving set must remain valid",
    );
  } finally {
    database.close();
  }
});

test("the exact lane snapshot uses one bounded JSON parameter at the maximum lane count", () => {
  const database = databaseWithLane();
  try {
    const maximumSnapshot = Array.from({ length: 20 }, (_, index) => ({
      id: `lane-${index}`,
      role: `Role ${index}`,
      status: "Pending",
      version: index + 1,
    }));
    assert.ok(
      guardedUpdate(database, maximumSnapshot).parameterCount < 20,
      "the exact-lane fence must not consume one set of D1 parameters per lane",
    );
  } finally {
    database.close();
  }
});

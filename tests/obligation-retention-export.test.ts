import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function applyV17Migrations(database: DatabaseSync): void {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const names = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const last = names.findIndex((name) => name.startsWith("0017_"));
  assert.ok(last >= 0, "schema-v17 migration is required");
  for (const name of names.slice(0, last + 1)) {
    const migration = readFileSync(new URL(name, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
}

function seedObligationGraph(
  database: DatabaseSync,
  input: Readonly<{ agreementId: number; suffix: string; legalHold?: boolean; occurrenceNumber?: number }>,
): void {
  const occurrenceNumber = input.occurrenceNumber ?? 1;
  const scheduleId = `schedule-${input.suffix}`;
  const obligationId = `obligation-${input.suffix}`;
  const evidenceId = `evidence-${input.suffix}`;
  const keySuffix = String(input.agreementId * 10 + occurrenceNumber).padStart(12, "0").slice(-12);
  database.prepare(`INSERT INTO agreements (
    id, workspace_id, version, party, initials, side, type, stage, owner,
    next_action, due, crm, crm_record, tags, updated, legal_hold, deleted_at
  ) VALUES (?, 'workspace-retention', 1, ?, 'CP', 'Buy-side', 'MSA', 'Active',
    'Owner', 'Track obligations', '2026-09-01', 'None', '', '[]',
    '2026-08-01T00:00:00.000Z', ?, NULL)`).run(
      input.agreementId,
      `Counterparty ${input.suffix}`,
      input.legalHold ? 1 : 0,
    );
  database.prepare(`INSERT INTO obligation_schedules (
    id, workspace_id, agreement_id, version, title, source, owner, timezone,
    recurrence_unit, recurrence_interval, anchor_date, reminder_lead_days,
    status, next_occurrence_number, next_occurrence_date, next_materialization_date,
    created_at, updated_at
  ) VALUES (?, 'workspace-retention', ?, 1, 'Renewal notice', 'Section 8', 'Owner',
    'Etc/UTC', 'month', 1, '2026-09-01', '[30,7]', 'active', 2,
    '2026-10-01', '2026-09-01', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`)
    .run(scheduleId, input.agreementId);
  database.prepare(`INSERT INTO obligations (
    id, workspace_id, version, agreement_id, schedule_id, occurrence_number,
    title, due_date, owner, owner_user_id, status, completed_by_user_id,
    completed_at, completion_evidence, cadence, source, timezone,
    reminder_lead_days, next_reminder_date, created_at
  ) VALUES (?, 'workspace-retention', 1, ?, ?, ?, 'Renewal notice', '2026-09-01',
    'Owner', 'user-retention', 'Complete', 'user-retention', '2026-08-02T00:00:00.000Z',
    'Completed with counterparty confirmation', 'Monthly', 'Section 8', 'Etc/UTC', '[30,7]', NULL,
    '2026-08-01T00:00:00.000Z')`).run(
      obligationId,
      input.agreementId,
      scheduleId,
      occurrenceNumber,
    );
  database.prepare(`INSERT INTO obligation_evidence (
    id, workspace_id, agreement_id, obligation_id, evidence_text, evidence_sha256,
    submitted_by_user_id, provenance, created_at
  ) VALUES (?, 'workspace-retention', ?, ?, 'Completed with counterparty confirmation', ?,
    'user-retention', 'native', '2026-08-02T00:00:00.000Z')`).run(
      evidenceId,
      input.agreementId,
      obligationId,
      "a".repeat(64),
    );
  database.prepare(`INSERT INTO obligation_creation_receipts (
    workspace_id, user_id, idempotency_key, request_sha256, agreement_id,
    schedule_id, obligation_id, agreement_event_id, created_at
  ) VALUES ('workspace-retention', 'user-retention', ?, ?, ?, ?, ?, ?,
    '2026-08-01T00:00:00.000Z')`).run(
      `00000000-0000-4000-8000-${keySuffix}`,
      "b".repeat(64),
      input.agreementId,
      scheduleId,
      obligationId,
      `event-${input.suffix}`,
    );
}

type PurgeCounts = Readonly<{
  schedules: number;
  occurrences: number;
  evidence: number;
  receipts: number;
}>;

function guardedPurge(database: DatabaseSync, agreementId: number, expected: PurgeCounts): unknown {
  database.exec("BEGIN");
  try {
    database.prepare(`DELETE FROM agreements
      WHERE workspace_id = 'workspace-retention' AND id = ? AND legal_hold = 0
        AND (SELECT count(*) FROM obligation_schedules
          WHERE workspace_id = 'workspace-retention' AND agreement_id = agreements.id) = ?
        AND (SELECT count(*) FROM obligations
          WHERE workspace_id = 'workspace-retention' AND agreement_id = agreements.id) = ?
        AND (SELECT count(*) FROM obligation_evidence
          WHERE workspace_id = 'workspace-retention' AND agreement_id = agreements.id) = ?
        AND (SELECT count(*) FROM obligation_creation_receipts
          WHERE workspace_id = 'workspace-retention' AND agreement_id = agreements.id) = ?`)
      .run(agreementId, expected.schedules, expected.occurrences, expected.evidence, expected.receipts);
    database.prepare(`INSERT INTO purge_jobs (
      id, workspace_id, resource_type, resource_id, object_keys, status,
      guard_changes, attempts, created_at, updated_at
    ) VALUES (?, 'workspace-retention', 'agreement', ?, '[]', 'storage_pending',
      changes(), 0, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')`)
      .run(`purge-${agreementId}`, String(agreementId));
    database.prepare("DELETE FROM obligation_creation_receipts WHERE workspace_id = 'workspace-retention' AND agreement_id = ?").run(agreementId);
    database.prepare("DELETE FROM obligation_evidence WHERE workspace_id = 'workspace-retention' AND agreement_id = ?").run(agreementId);
    database.prepare("DELETE FROM obligations WHERE workspace_id = 'workspace-retention' AND agreement_id = ?").run(agreementId);
    database.prepare("DELETE FROM obligation_schedules WHERE workspace_id = 'workspace-retention' AND agreement_id = ?").run(agreementId);
    database.exec("COMMIT");
    return null;
  } catch (error) {
    database.exec("ROLLBACK");
    return error;
  }
}

function rowCount(database: DatabaseSync, table: string, agreementId: number): number {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE agreement_id = ?`).get(agreementId)?.count ?? 0);
}

test("schema-v17 obligation evidence survives soft delete and hard purge removes the complete graph atomically", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyV17Migrations(database);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
      VALUES ('workspace-retention', 'workspace-retention', 'Retention workspace', 'active', '2026-08-01', '2026-08-01');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at)
      VALUES ('user-retention', 'test', 'user-retention', 'retention@example.test', 'Retention user', 'active', '2026-08-01', '2026-08-01', '2026-08-01');
    `);
    seedObligationGraph(database, { agreementId: 41, suffix: "control" });
    database.exec("UPDATE agreements SET deleted_at = '2026-07-01T00:00:00.000Z' WHERE id = 41");

    for (const table of ["obligation_schedules", "obligations", "obligation_evidence", "obligation_creation_receipts"]) {
      assert.equal(rowCount(database, table, 41), 1, `${table} must survive the parent's soft-delete grace period`);
    }
    assert.equal(guardedPurge(database, 41, { schedules: 1, occurrences: 1, evidence: 1, receipts: 1 }), null);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements WHERE id = 41").get()?.count, 0);
    for (const table of ["obligation_schedules", "obligations", "obligation_evidence", "obligation_creation_receipts"]) {
      assert.equal(rowCount(database, table, 41), 0, `${table} must be hard-purged`);
    }
  } finally {
    database.close();
  }
});

test("a concurrent obligation row or parent legal hold aborts the guarded purge without partial deletion", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyV17Migrations(database);
    database.exec(`
      INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
      VALUES ('workspace-retention', 'workspace-retention', 'Retention workspace', 'active', '2026-08-01', '2026-08-01');
      INSERT INTO users (id, identity_provider, identity_subject, email, display_name, status, created_at, updated_at, last_seen_at)
      VALUES ('user-retention', 'test', 'user-retention', 'retention@example.test', 'Retention user', 'active', '2026-08-01', '2026-08-01', '2026-08-01');
    `);
    seedObligationGraph(database, { agreementId: 42, suffix: "race-one" });
    database.exec("UPDATE agreements SET deleted_at = '2026-07-01T00:00:00.000Z' WHERE id = 42");
    database.prepare(`INSERT INTO obligation_schedules (
      id, workspace_id, agreement_id, version, title, source, owner, timezone,
      recurrence_unit, recurrence_interval, anchor_date, reminder_lead_days,
      status, created_at, updated_at
    ) VALUES ('schedule-race-two', 'workspace-retention', 42, 1, 'Second notice',
      'Section 9', 'Owner', 'Etc/UTC', 'once', 1, '2026-10-01', '[0]', 'ended',
      '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`).run();
    database.prepare(`INSERT INTO obligations (
      id, workspace_id, version, agreement_id, schedule_id, occurrence_number,
      title, due_date, owner, owner_user_id, status, completed_by_user_id,
      completed_at, completion_evidence, cadence, source, timezone,
      reminder_lead_days, created_at
    ) VALUES ('obligation-race-two', 'workspace-retention', 1, 42, 'schedule-race-two', 1,
      'Second notice', '2026-10-01', 'Owner', 'user-retention', 'Complete', 'user-retention',
      '2026-08-02T00:00:00.000Z', 'Override evidence', 'Once', 'Section 9',
      'Etc/UTC', '[0]', '2026-08-02T00:00:00.000Z')`).run();
    database.prepare(`INSERT INTO obligation_evidence (
      id, workspace_id, agreement_id, obligation_id, evidence_text, evidence_sha256,
      submitted_by_user_id, provenance, created_at
    ) VALUES ('evidence-race-two', 'workspace-retention', 42, 'obligation-race-two',
      'Override evidence', ?, 'user-retention', 'native', '2026-08-02T00:00:00.000Z')`).run("c".repeat(64));
    database.prepare(`INSERT INTO obligation_creation_receipts (
      workspace_id, user_id, idempotency_key, request_sha256, agreement_id,
      schedule_id, obligation_id, agreement_event_id, created_at
    ) VALUES ('workspace-retention', 'user-retention',
      '00000000-0000-4000-8000-000000000042', ?, 42, 'schedule-race-two',
      'obligation-race-two', 'event-race-two', '2026-08-02T00:00:00.000Z')`).run("d".repeat(64));

    const staleCountError = guardedPurge(database, 42, { schedules: 1, occurrences: 1, evidence: 1, receipts: 1 });
    assert.match(String(staleCountError), /ck_purge_jobs_guard_changes/);
    assert.equal(database.prepare("SELECT count(*) AS count FROM agreements WHERE id = 42").get()?.count, 1);
    for (const table of ["obligation_schedules", "obligations", "obligation_evidence", "obligation_creation_receipts"]) {
      assert.equal(rowCount(database, table, 42), 2, `${table} must roll back after a stale count fence`);
    }

    database.exec("UPDATE agreements SET legal_hold = 1 WHERE id = 42");
    const legalHoldError = guardedPurge(database, 42, { schedules: 2, occurrences: 2, evidence: 2, receipts: 2 });
    assert.match(String(legalHoldError), /ck_purge_jobs_guard_changes/);
    assert.equal(database.prepare("SELECT legal_hold FROM agreements WHERE id = 42").get()?.legal_hold, 1);
    for (const table of ["obligation_schedules", "obligations", "obligation_evidence", "obligation_creation_receipts"]) {
      assert.equal(rowCount(database, table, 42), 2, `${table} must remain parent-governed under legal hold`);
    }
  } finally {
    database.close();
  }
});

test("retention and export routes preserve the v17 obligation evidence contract", () => {
  const retention = source("../app/api/jobs/retention/route.ts");
  const audit = source("../app/api/agreements/[id]/audit/route.ts");
  const workspaceExport = source("../app/api/admin/export/route.ts");

  for (const fence of [
    /from obligation_schedules as purge_counted_obligation_schedule[\s\S]*obligationScheduleRows\.length/,
    /from obligations as purge_counted_obligation_occurrence[\s\S]*obligationOccurrenceRows\.length/,
    /from obligation_evidence as purge_counted_obligation_evidence[\s\S]*obligationEvidenceRows\.length/,
    /from obligation_creation_receipts as purge_counted_obligation_receipt[\s\S]*obligationCreationReceiptRows\.length/,
  ]) assert.match(retention, fence);
  const hardPurge = retention.slice(retention.indexOf("const hardAgreementCandidates"));
  const parentDelete = hardPurge.indexOf("db.delete(agreements)");
  const receiptDelete = hardPurge.indexOf("db.delete(obligationCreationReceipts)", parentDelete);
  const evidenceDelete = hardPurge.indexOf("db.delete(obligationEvidence)", receiptDelete);
  const occurrenceDelete = hardPurge.indexOf("db.delete(obligations)", evidenceDelete);
  const scheduleDelete = hardPurge.indexOf("db.delete(obligationSchedules)", occurrenceDelete);
  assert.ok(parentDelete >= 0 && parentDelete < receiptDelete);
  assert.ok(receiptDelete < evidenceDelete && evidenceDelete < occurrenceDelete && occurrenceDelete < scheduleDelete);
  assert.match(hardPurge, /eq\(agreements\.legalHold, false\)/);
  const beforeHardPurge = retention.slice(0, retention.indexOf("const hardAgreementCandidates"));
  assert.doesNotMatch(beforeHardPurge, /db\.delete\(obligation(?:CreationReceipts|Evidence|Schedules|s)\)/);
  assert.match(retention, /const staleRejectedIntake = await db\.select/);
  assert.match(retention, /eq\(intakeSubmissions\.status, "rejected"\)/);
  assert.match(retention, /const staleIngestion = await db\.select/);
  assert.match(retention, /ingestionBatches\.status} in \('completed', 'cancelled'\)/);
  assert.match(retention, /held_ledger_document\.legal_hold = 1 or held_ledger_agreement\.legal_hold = 1/);
  assert.match(retention, /lifecyclePurged/);
  assert.match(retention, /remainingIngestion/);
  assert.match(retention, /retainedIngestionIds/);
  assert.match(retention, /remainingIngestion[\s\S]*lifecyclePurged\.ingestionBatchIds\.push\([\s\S]*filter\(\(id\) => !retainedIngestionIds\.has\(id\)\)/,
    "a non-dry-run response may report only ledger IDs confirmed absent after the guarded delete");
  assert.match(hardPurge, /db\.delete\(ingestionItems\)[\s\S]*purge_ledger_document\.agreement_id/);
  assert.doesNotMatch(hardPurge, /db\.delete\(ingestionBatches\)[\s\S]*purge_ledger_document\.agreement_id/,
    "purging one agreement must not cascade-delete sibling items from a mixed ingestion batch");

  assert.match(audit, /authorizeApiRequest\(request, "audit:read"/);
  assert.match(audit, /db\.select\(\)\.from\(agreements\)\.where\(and\([\s\S]*eq\(agreements\.workspaceId, workspaceId\)[\s\S]*eq\(agreements\.id, agreementId\)/);
  assert.doesNotMatch(audit, /findActiveAgreement/);
  assert.match(audit, /obligationSchedules: obligationScheduleRows/);
  assert.match(audit, /obligations: obligationRows/);
  assert.match(audit, /obligationEvidence: obligationEvidenceRows/);
  assert.match(audit, /obligationOccurrences: obligationRows\.length/);
  assert.match(audit, /evidenceSha256: obligationEvidence\.evidenceSha256/);
  assert.match(audit, /provenance: obligationEvidence\.provenance/);
  assert.doesNotMatch(audit, /obligationCreationReceipts/);

  assert.match(workspaceExport, /includesSoftDeletedRecords: true/);
  assert.match(workspaceExport, /obligationSchedules: obligationScheduleRows/);
  assert.match(workspaceExport, /obligations: obligationRows/);
  assert.match(workspaceExport, /obligationEvidence: obligationEvidenceRows/);
  assert.match(workspaceExport, /obligationOccurrences: obligationRows\.length/);
  assert.match(workspaceExport, /evidenceSha256: obligationEvidence\.evidenceSha256/);
  assert.match(workspaceExport, /provenance: obligationEvidence\.provenance/);
  assert.match(workspaceExport, /obligationCreationReceipts: Number\(obligationCreationReceiptCountRows\[0\]\?\.count \?\? 0\)/);
  for (const enterpriseRecord of [
    "intakeSubmissions", "customFieldValues", "ingestionBatches", "ingestionItems",
    "repositoryFragments", "extractionProposals", "extractionProposalCitations",
  ]) assert.match(workspaceExport, new RegExp(`${enterpriseRecord}:`));
  const exportedRecords = workspaceExport.slice(
    workspaceExport.indexOf("records: {"),
    workspaceExport.indexOf("artifacts: artifactManifest"),
  );
  assert.doesNotMatch(exportedRecords, /obligationCreationReceipts|idempotencyKey|requestSha256/);
});

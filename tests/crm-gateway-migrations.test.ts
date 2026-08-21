import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { handleCrmGatewayRequest, type CrmGatewayEnv } from "../integrations/crm-gateway/src/index";
import { D1ReceiptStore } from "../integrations/crm-gateway/src/receipt-store";

const hubspotV1 = Object.freeze({ provider: "hubspot", mappingVersion: "v1" });
const testOperationsSecret = "x".repeat(40);

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of ["0001_receipts.sql", "0002_operational_controls.sql"]) {
    database.exec(readFileSync(new URL(
      `../integrations/crm-gateway/migrations/${migration}`,
      import.meta.url,
    ), "utf8"));
  }
  return database;
}

test("the CRM gateway migration creates durable receipts, aggregate fencing, and due-work indexes", () => {
  const database = migratedDatabase();
  try {
    const objects = (database.prepare(
      "SELECT name, type FROM sqlite_master WHERE name LIKE 'crm_%' ORDER BY name",
    ).all() as Array<{ name: string; type: string }>).map(({ name, type }) => ({ name, type }));
    assert.deepEqual(objects, [
      { name: "crm_aggregate_state", type: "table" },
      { name: "crm_event_receipts", type: "table" },
      { name: "crm_gateway_schema_state", type: "table" },
    ]);

    const receiptIndexes = new Set((database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'crm_event_receipts'",
    ).all() as Array<{ name: string }>).map(({ name }) => name));
    assert.equal(receiptIndexes.has("idx_crm_receipts_due"), true);
    assert.equal(receiptIndexes.has("idx_crm_receipts_aggregate"), true);
    assert.equal(receiptIndexes.has("idx_crm_receipts_operations"), true);
    const primaryKey = (database.prepare("PRAGMA table_info(crm_aggregate_state)").all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter(({ pk }) => pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name);
    assert.deepEqual(primaryKey, ["workspace_id", "agreement_id", "provider", "mapping_version"]);
    const dueIndex = (database.prepare("PRAGMA index_info(idx_crm_receipts_due)").all() as Array<{
      name: string;
      seqno: number;
    }>).sort((left, right) => left.seqno - right.seqno).map(({ name }) => name);
    assert.deepEqual(dueIndex, ["provider", "mapping_version", "status", "available_at", "received_at"]);
    const operationsIndex = (database.prepare("PRAGMA index_info(idx_crm_receipts_operations)").all() as Array<{
      name: string;
      seqno: number;
    }>).sort((left, right) => left.seqno - right.seqno).map(({ name }) => name);
    assert.deepEqual(operationsIndex, ["provider", "mapping_version", "status", "completed_at", "updated_at"]);
    assert.equal(database.prepare(
      "SELECT schema_version FROM crm_gateway_schema_state WHERE singleton = 1",
    ).get()?.schema_version, 2);

    database.prepare(`INSERT INTO crm_event_receipts (
      workspace_id, event_id, body_digest, event_json, topic, agreement_id,
      aggregate_version, provider, mapping_version, status, attempts,
      available_at, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?, ?)`)
      .run(
        "workspace-a",
        "event-1",
        "a".repeat(64),
        "{}",
        "agreement.updated",
        "4102",
        7,
        "hubspot",
        "v1",
        "2026-08-02T12:00:00.000Z",
        "2026-08-02T12:00:00.000Z",
        "2026-08-02T12:00:00.000Z",
      );

    assert.throws(() => database.prepare(`INSERT INTO crm_event_receipts (
      workspace_id, event_id, body_digest, event_json, topic, agreement_id,
      aggregate_version, provider, mapping_version, available_at, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "workspace-a", "event-1", "b".repeat(64), "{}", "agreement.updated",
        "4102", 8, "hubspot", "v1", "2026-08-02", "2026-08-02", "2026-08-02",
      ), /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test("the CRM gateway migration rejects unsafe receipt and provider states", () => {
  const database = migratedDatabase();
  const insert = database.prepare(`INSERT INTO crm_event_receipts (
    workspace_id, event_id, body_digest, event_json, topic, agreement_id,
    aggregate_version, provider, mapping_version, status, attempts,
    available_at, received_at, updated_at
  ) VALUES (?, ?, 'digest', '{}', 'agreement.updated', '4102', ?, ?, 'v1', ?, ?, '2026-08-02', '2026-08-02', '2026-08-02')`);
  try {
    assert.throws(() => insert.run("workspace-a", "zero-version", 0, "hubspot", "received", 0), /CHECK constraint failed/);
    assert.throws(() => insert.run("workspace-a", "unknown-provider", 1, "unknown", "received", 0), /CHECK constraint failed/);
    assert.throws(() => insert.run("workspace-a", "unknown-status", 1, "custom", "lost", 0), /CHECK constraint failed/);
    assert.throws(() => insert.run("workspace-a", "negative-attempt", 1, "salesforce", "retry", -1), /CHECK constraint failed/);

    database.exec(`INSERT INTO crm_aggregate_state (
      workspace_id, agreement_id, latest_version, provider, mapping_version, updated_at
    ) VALUES ('workspace-a', '4102', 7, 'salesforce', 'v1', '2026-08-02')`);
    assert.throws(() => database.exec(`INSERT INTO crm_aggregate_state (
      workspace_id, agreement_id, latest_version, provider, mapping_version, updated_at
    ) VALUES ('workspace-a', '4103', -1, 'salesforce', 'v1', '2026-08-02')`), /CHECK constraint failed/);
    assert.throws(() => database.exec(`INSERT INTO crm_aggregate_state (
      workspace_id, agreement_id, latest_version, provider, mapping_version, updated_at
    ) VALUES ('workspace-b', '4102', 0, 'other', 'v1', '2026-08-02')`), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});

test("health readiness fails closed for missing migrations or unsafe runtime configuration", async () => {
  const healthyDatabase = migratedDatabase();
  const unmigratedDatabase = new DatabaseSync(":memory:");
  unmigratedDatabase.exec(readFileSync(new URL(
    "../integrations/crm-gateway/migrations/0001_receipts.sql",
    import.meta.url,
  ), "utf8"));
  const context = { waitUntil() {} } as unknown as ExecutionContext;
  const environment = (database: DatabaseSync, operationsSecret = testOperationsSecret) => ({
    CRM_DB: new SqliteD1(database) as unknown as D1Database,
    NOTICE_INGRESS_SECRET: "ingress-secret-at-least-32-characters",
    NOTICE_OPERATIONS_SECRET: operationsSecret,
    NOTICE_CRM_PROVIDER: "hubspot",
    NOTICE_CRM_MAPPING_VERSION: "v1",
    NOTICE_CRM_HUBSPOT_ACCESS_TOKEN: "synthetic-hubspot-credential-for-unit-tests-only",
    NOTICE_CRM_HUBSPOT_OBJECT_TYPE: "2-1234567",
    NOTICE_CRM_HUBSPOT_ID_PROPERTY: "notice_external_id",
  }) as unknown as CrmGatewayEnv;
  try {
    const healthy = await handleCrmGatewayRequest(
      new Request("https://gateway.invalid/healthz"),
      environment(healthyDatabase),
      context,
    );
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: "ok" });

    const missingMigration = await handleCrmGatewayRequest(
      new Request("https://gateway.invalid/healthz"),
      environment(unmigratedDatabase),
      context,
    );
    assert.equal(missingMigration.status, 503);
    assert.deepEqual(await missingMigration.json(), { status: "unhealthy" });

    const weakSecret = await handleCrmGatewayRequest(
      new Request("https://gateway.invalid/healthz"),
      environment(healthyDatabase, "weak"),
      context,
    );
    assert.equal(weakSecret.status, 503);
    const body = JSON.stringify(await weakSecret.json());
    assert.equal(body.includes("weak"), false);
    assert.equal(body.includes("operations-secret"), false);

    const reusedSecret = await handleCrmGatewayRequest(
      new Request("https://gateway.invalid/healthz"),
      environment(healthyDatabase, "ingress-secret-at-least-32-characters"),
      context,
    );
    assert.equal(reusedSecret.status, 503);
    assert.deepEqual(await reusedSecret.json(), { status: "unhealthy" });
  } finally {
    healthyDatabase.close();
    unmigratedDatabase.close();
  }
});

test("the D1 receipt store enforces digest idempotency and aggregate-version fencing on the migrated schema", async () => {
  const database = migratedDatabase();
  const store = new D1ReceiptStore(new SqliteD1(database) as unknown as D1Database);
  const now = "2026-08-02T12:00:00.000Z";
  try {
    const versionTwo = receiptInput("event-v2", "a".repeat(64), 2, now);
    const accepted = await store.accept(versionTwo);
    assert.equal(accepted.kind, "new");
    assert.equal((await store.accept(versionTwo)).kind, "duplicate");
    const claimed = await store.claim(accepted.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(claimed.kind, "claimed");
    assert.ok(claimed.receipt.leaseToken);
    await store.complete(claimed.receipt, claimed.receipt.leaseToken ?? "", "provider-4102", now);
    assert.equal((await store.get("workspace-a", "event-v2"))?.status, "succeeded");

    const profileConflict = await store.accept({
      ...versionTwo,
      mappingVersion: "v2",
      now: "2026-08-02T12:00:30.000Z",
    });
    assert.equal(profileConflict.kind, "profile_conflict");
    assert.equal(profileConflict.receipt.status, "succeeded");
    assert.equal(profileConflict.receipt.mappingVersion, "v1");
    assert.equal(profileConflict.receipt.lastErrorCode, null);

    const resync = await store.accept({
      ...versionTwo,
      eventId: "event-v3-new-profile",
      aggregateVersion: 3,
      provider: "custom",
      mappingVersion: "v2",
      now: "2026-08-02T12:00:31.000Z",
    });
    assert.equal(resync.kind, "new", "a changed CRM profile requires a fresh event ID/version");

    const versionOne = await store.accept(receiptInput("event-v1", "b".repeat(64), 1, now));
    assert.equal(versionOne.kind, "new");
    const superseded = await store.claim(versionOne.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(superseded.kind, "superseded");
    assert.equal((await store.get("workspace-a", "event-v1"))?.status, "superseded");

    const collision = await store.accept({
      ...versionTwo,
      bodyDigest: "c".repeat(64),
      aggregateVersion: 999,
      now: "2026-08-02T12:01:00.000Z",
    });
    assert.equal(collision.kind, "collision");
    assert.equal(collision.receipt.status, "quarantined");
    assert.equal(collision.receipt.lastErrorCode, "event_id_digest_collision");
    const collisionWatermark = database.prepare(`SELECT latest_version, latest_event_id
      FROM crm_aggregate_state WHERE workspace_id = ? AND agreement_id = ?
        AND provider = ? AND mapping_version = ?`).get("workspace-a", "4102", "hubspot", "v1");
    assert.deepEqual(
      { ...collisionWatermark },
      { latest_version: 2, latest_event_id: "event-v2" },
      "a collision must not advance the watermark from unpersisted caller metadata",
    );
  } finally {
    database.close();
  }
});

test("the D1 highest-seen watermark fences older work behind retry and dead receipts without blocking the exact retry", async () => {
  for (const terminal of [false, true]) {
    const database = migratedDatabase();
    const store = new D1ReceiptStore(new SqliteD1(database) as unknown as D1Database);
    const now = "2026-08-02T12:00:00.000Z";
    const suffix = terminal ? "dead" : "retry";
    try {
      const newer = await store.accept(receiptInput(`newer-${suffix}-v9`, `${terminal ? "d" : "e"}`.repeat(64), 9, now));
      const newerClaim = await store.claim(newer.receipt, now, "2026-08-02T11:55:00.000Z");
      assert.equal(newerClaim.kind, "claimed");
      await store.fail(newerClaim.receipt, newerClaim.receipt.leaseToken ?? "", {
        terminal,
        code: terminal ? "crm_provider_rejected" : "crm_provider_unavailable",
        availableAt: now,
        now,
      });
      assert.equal((await store.get("workspace-a", `newer-${suffix}-v9`))?.status, suffix);

      const older = await store.accept(receiptInput(`older-after-${suffix}-v8`, `${terminal ? "f" : "1"}`.repeat(64), 8, now));
      const olderClaim = await store.claim(older.receipt, now, "2026-08-02T11:55:00.000Z");
      assert.equal(olderClaim.kind, "superseded");
      assert.equal((await store.get("workspace-a", `older-after-${suffix}-v8`))?.status, "superseded");

      const equalVersionContender = await store.accept(receiptInput(
        `equal-contender-${suffix}-v9`,
        `${terminal ? "2" : "3"}`.repeat(64),
        9,
        now,
      ));
      assert.equal(
        (await store.claim(equalVersionContender.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
        "superseded",
        "the first durably accepted event wins an equal aggregate-version tie",
      );

      if (terminal) {
        assert.deepEqual(await store.requeueDead({
          workspaceId: "workspace-a",
          eventId: "newer-dead-v9",
          provider: "hubspot",
          mappingVersion: "v1",
          now,
        }), { kind: "requeued" });
      }
      const exact = await store.get("workspace-a", `newer-${suffix}-v9`);
      assert.ok(exact);
      const exactClaim = await store.claim(exact, now, "2026-08-02T11:55:00.000Z");
      assert.equal(
        exactClaim.kind,
        "claimed",
        "the exact watermark event must retain retry/requeue authority",
      );
      const watermark = database.prepare(`SELECT latest_version, latest_event_id
        FROM crm_aggregate_state WHERE workspace_id = ? AND agreement_id = ?
          AND provider = ? AND mapping_version = ?`).get("workspace-a", "4102", "hubspot", "v1");
      assert.deepEqual(
        { ...watermark },
        { latest_version: 9, latest_event_id: `newer-${suffix}-v9` },
      );
      if (terminal && exactClaim.kind === "claimed") {
        await store.fail(exactClaim.receipt, exactClaim.receipt.leaseToken ?? "", {
          terminal: true,
          code: "crm_provider_rejected",
          availableAt: now,
          now,
        });
        await store.redactTerminalPayloads("2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z", 50, hubspotV1);
        await store.pruneTerminalMetadata("2026-08-03T00:00:00.000Z", 50, hubspotV1);
        assert.equal(await store.get("workspace-a", "newer-dead-v9"), null);
        const lateOlder = await store.accept(receiptInput("late-after-prune-v7", "8".repeat(64), 7, now));
        assert.equal(
          (await store.claim(lateOlder.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
          "superseded",
          "terminal receipt pruning must not reopen an older provider mutation",
        );
      }
    } finally {
      database.close();
    }
  }
});

test("the D1 aggregate fence isolates equal agreement versions by exact provider and mapping profile", async () => {
  const database = migratedDatabase();
  const store = new D1ReceiptStore(new SqliteD1(database) as unknown as D1Database);
  const now = "2026-08-02T12:00:00.000Z";
  try {
    const newProfileProjection = await store.accept({
      ...receiptInput("new-profile-projection-v20", "b".repeat(64), 20, now),
      mappingVersion: "v2",
    });
    const newProfileClaim = await store.claim(newProfileProjection.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(newProfileClaim.kind, "claimed");

    const oldProfileTombstone = await store.accept(receiptInput("old-profile-tombstone-v20", "c".repeat(64), 20, now));
    const oldProfileClaim = await store.claim(oldProfileTombstone.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(
      oldProfileClaim.kind,
      "claimed",
      "a live new-profile lease must neither block nor supersede old-profile cleanup",
    );
    await store.complete(oldProfileClaim.receipt, oldProfileClaim.receipt.leaseToken ?? "", "provider-old", now);
    await store.complete(newProfileClaim.receipt, newProfileClaim.receipt.leaseToken ?? "", "provider-new", now);

    const otherProvider = await store.accept({
      ...receiptInput("custom-profile-v20", "d".repeat(64), 20, now),
      provider: "custom",
    });
    assert.equal(
      (await store.claim(otherProvider.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
      "claimed",
      "provider identity is part of aggregate ordering scope",
    );

    const staleOldProfile = await store.accept(receiptInput("old-profile-stale-v19", "e".repeat(64), 19, now));
    assert.equal(
      (await store.claim(staleOldProfile.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
      "superseded",
      "stale fencing remains strict within the old profile",
    );
    const staleNewProfile = await store.accept({
      ...receiptInput("new-profile-stale-v19", "f".repeat(64), 19, now),
      mappingVersion: "v2",
    });
    assert.equal(
      (await store.claim(staleNewProfile.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
      "superseded",
      "stale fencing remains strict within the new profile",
    );

    const aggregateProfiles = database.prepare(`SELECT provider, mapping_version, latest_version, latest_event_id
      FROM crm_aggregate_state
      WHERE workspace_id = ? AND agreement_id = ?
      ORDER BY provider, mapping_version`).all("workspace-a", "4102")
      .map((row) => ({ ...row }));
    assert.deepEqual(aggregateProfiles, [
      { provider: "custom", mapping_version: "v1", latest_version: 20, latest_event_id: "custom-profile-v20" },
      { provider: "hubspot", mapping_version: "v1", latest_version: 20, latest_event_id: "old-profile-tombstone-v20" },
      { provider: "hubspot", mapping_version: "v2", latest_version: 20, latest_event_id: "new-profile-projection-v20" },
    ]);
  } finally {
    database.close();
  }
});

test("D1 scheduling, recovery, operations, and retention stay inside the exact mapping profile", async () => {
  const database = migratedDatabase();
  const store = new D1ReceiptStore(new SqliteD1(database) as unknown as D1Database);
  const now = "2026-08-02T12:00:00.000Z";
  const hubspotV2 = Object.freeze({ provider: "hubspot", mappingVersion: "v2" });
  try {
    const oldProfile = await store.accept(receiptInput("maintenance-old-v30", "1".repeat(64), 30, now));
    const newProfile = await store.accept({
      ...receiptInput("maintenance-new-v30", "2".repeat(64), 30, now),
      mappingVersion: "v2",
    });
    assert.deepEqual(
      (await store.listDue(now, 50, hubspotV1)).map(({ eventId }) => eventId),
      ["maintenance-old-v30"],
    );
    assert.deepEqual(
      (await store.listDue(now, 50, hubspotV2)).map(({ eventId }) => eventId),
      ["maintenance-new-v30"],
    );

    const oldClaim = await store.claim(oldProfile.receipt, now, "2026-08-02T11:55:00.000Z");
    const newClaim = await store.claim(newProfile.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(oldClaim.kind, "claimed");
    assert.equal(newClaim.kind, "claimed");
    await store.recoverStale("2026-08-02T12:00:01.000Z", "2026-08-02T12:05:00.000Z", hubspotV1);
    assert.equal((await store.get("workspace-a", "maintenance-old-v30"))?.status, "retry");
    assert.equal(
      (await store.get("workspace-a", "maintenance-new-v30"))?.status,
      "processing",
      "old-profile recovery must not release or rewrite a new-profile lease",
    );
    await store.complete(newClaim.receipt, newClaim.receipt.leaseToken ?? "", "provider-new-v30", now);

    const recoveredOld = await store.get("workspace-a", "maintenance-old-v30");
    assert.ok(recoveredOld);
    const reclaimedOld = await store.claim(
      recoveredOld,
      "2026-08-02T12:05:00.000Z",
      "2026-08-02T12:00:00.000Z",
    );
    assert.equal(reclaimedOld.kind, "claimed");
    await store.fail(reclaimedOld.receipt, reclaimedOld.receipt.leaseToken ?? "", {
      terminal: true,
      code: "crm_provider_rejected",
      availableAt: "2026-08-02T12:05:00.000Z",
      now: "2026-08-02T12:05:00.000Z",
    });
    database.prepare(`UPDATE crm_event_receipts
      SET completed_at = '2026-01-01T00:00:00.000Z', updated_at = '2026-01-01T00:00:00.000Z'
      WHERE workspace_id = ? AND event_id IN (?, ?)`)
      .run("workspace-a", "maintenance-old-v30", "maintenance-new-v30");

    assert.deepEqual(
      (await store.listOperationalReceipts("dead", 50, hubspotV1)).map(({ eventId }) => eventId),
      ["maintenance-old-v30"],
    );
    assert.deepEqual(await store.listOperationalReceipts("dead", 50, hubspotV2), []);
    assert.deepEqual(
      (await store.listOperationalReceipts("succeeded", 50, hubspotV2)).map(({ eventId }) => eventId),
      ["maintenance-new-v30"],
    );

    await store.redactTerminalPayloads(
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      50,
      hubspotV1,
    );
    assert.equal((await store.get("workspace-a", "maintenance-old-v30"))?.eventJson, "");
    assert.notEqual((await store.get("workspace-a", "maintenance-new-v30"))?.eventJson, "");
    await store.pruneTerminalMetadata("2026-02-01T00:00:00.000Z", 50, hubspotV1);
    assert.equal(await store.get("workspace-a", "maintenance-old-v30"), null);
    assert.equal((await store.get("workspace-a", "maintenance-new-v30"))?.status, "succeeded");
  } finally {
    database.close();
  }
});

test("the D1 watermark reconciles pre-change rows and cannot regress when a newer receipt arrives under an older lease", async () => {
  const database = migratedDatabase();
  const store = new D1ReceiptStore(new SqliteD1(database) as unknown as D1Database);
  const now = "2026-08-02T12:00:00.000Z";
  try {
    const lower = await store.accept(receiptInput("leased-v7", "4".repeat(64), 7, now));
    const lowerClaim = await store.claim(lower.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(lowerClaim.kind, "claimed");
    const higher = await store.accept(receiptInput("accepted-during-v7-lease-v8", "5".repeat(64), 8, now));
    assert.equal(
      (await store.claim(higher.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
      "busy",
      "an accepted higher version must wait while the lower provider call owns the exact-profile lease",
    );
    await store.complete(lowerClaim.receipt, lowerClaim.receipt.leaseToken ?? "", "provider-v7", now);
    const concurrentWatermark = database.prepare(`SELECT latest_version, latest_event_id, provider_record_id
      FROM crm_aggregate_state WHERE workspace_id = ? AND agreement_id = ?
        AND provider = ? AND mapping_version = ?`).get("workspace-a", "4102", "hubspot", "v1");
    assert.deepEqual(
      { ...concurrentWatermark },
      { latest_version: 8, latest_event_id: "accepted-during-v7-lease-v8", provider_record_id: null },
      "a lower completion must release its lease without overwriting the newer durable watermark",
    );
    const higherClaim = await store.claim(higher.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(higherClaim.kind, "claimed");
    await store.complete(higherClaim.receipt, higherClaim.receipt.leaseToken ?? "", "provider-v8", now);

    const legacyDatabase = migratedDatabase();
    try {
      const legacyStore = new D1ReceiptStore(new SqliteD1(legacyDatabase) as unknown as D1Database);
      const legacyHigher = receiptInput("legacy-dead-v12", "6".repeat(64), 12, now);
      legacyDatabase.prepare(`INSERT INTO crm_event_receipts (
        workspace_id, event_id, body_digest, event_json, topic, agreement_id,
        aggregate_version, provider, mapping_version, status, attempts,
        available_at, received_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dead', 1, ?, ?, ?, ?)`).run(
        legacyHigher.workspaceId,
        legacyHigher.eventId,
        legacyHigher.bodyDigest,
        legacyHigher.eventJson,
        legacyHigher.topic,
        legacyHigher.agreementId,
        legacyHigher.aggregateVersion,
        legacyHigher.provider,
        legacyHigher.mappingVersion,
        now,
        now,
        now,
        now,
      );
      const legacyLower = await legacyStore.accept(receiptInput("legacy-lower-v11", "7".repeat(64), 11, now));
      assert.equal(
        (await legacyStore.claim(legacyLower.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
        "superseded",
      );
      const reconciledWatermark = legacyDatabase.prepare(`SELECT latest_version, latest_event_id
        FROM crm_aggregate_state WHERE workspace_id = ? AND agreement_id = ?
          AND provider = ? AND mapping_version = ?`).get("workspace-a", "4102", "hubspot", "v1");
      assert.deepEqual(
        { ...reconciledWatermark },
        { latest_version: 12, latest_event_id: "legacy-dead-v12" },
      );
    } finally {
      legacyDatabase.close();
    }

    const pruneDatabase = migratedDatabase();
    try {
      const pruneStore = new D1ReceiptStore(new SqliteD1(pruneDatabase) as unknown as D1Database);
      const prunableHigher = receiptInput("legacy-prunable-dead-v15", "9".repeat(64), 15, now);
      pruneDatabase.prepare(`INSERT INTO crm_event_receipts (
        workspace_id, event_id, body_digest, event_json, topic, agreement_id,
        aggregate_version, provider, mapping_version, status, attempts,
        available_at, received_at, updated_at, completed_at, payload_redacted_at
      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 'dead', 1, ?, ?, ?, ?, ?)`).run(
        prunableHigher.workspaceId,
        prunableHigher.eventId,
        prunableHigher.bodyDigest,
        prunableHigher.topic,
        prunableHigher.agreementId,
        prunableHigher.aggregateVersion,
        prunableHigher.provider,
        prunableHigher.mappingVersion,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      );
      await pruneStore.pruneTerminalMetadata("2026-02-01T00:00:00.000Z", 50, hubspotV1);
      assert.equal(await pruneStore.get("workspace-a", "legacy-prunable-dead-v15"), null);
      const prunedWatermark = pruneDatabase.prepare(`SELECT latest_version, latest_event_id
        FROM crm_aggregate_state WHERE workspace_id = ? AND agreement_id = ?
          AND provider = ? AND mapping_version = ?`).get("workspace-a", "4102", "hubspot", "v1");
      assert.deepEqual(
        { ...prunedWatermark },
        { latest_version: 15, latest_event_id: "legacy-prunable-dead-v15" },
      );
      const afterLegacyPrune = await pruneStore.accept(receiptInput("late-after-legacy-prune-v14", "a".repeat(64), 14, now));
      assert.equal(
        (await pruneStore.claim(afterLegacyPrune.receipt, now, "2026-08-02T11:55:00.000Z")).kind,
        "superseded",
      );
    } finally {
      pruneDatabase.close();
    }
  } finally {
    database.close();
  }
});

test("the D1 receipt store retries recovered leases and applies terminal payload and metadata retention", async () => {
  const database = migratedDatabase();
  const store = new D1ReceiptStore(new SqliteD1(database) as unknown as D1Database);
  const now = "2026-08-02T12:00:00.000Z";
  try {
    const accepted = await store.accept(receiptInput("event-recover", "d".repeat(64), 3, now));
    const claimed = await store.claim(accepted.receipt, now, "2026-08-02T11:55:00.000Z");
    assert.equal(claimed.kind, "claimed");
    await store.recoverStale("2026-08-02T12:00:01.000Z", "2026-08-02T12:05:00.000Z", hubspotV1);
    const recovered = await store.get("workspace-a", "event-recover");
    assert.equal(recovered?.status, "retry");
    assert.equal(recovered?.lastErrorCode, "stale_processing_recovered");
    assert.equal((await store.listDue("2026-08-02T12:04:59.999Z", 50, hubspotV1)).length, 0);
    assert.deepEqual(
      (await store.listDue("2026-08-02T12:05:00.000Z", 50, hubspotV1)).map(({ eventId }) => eventId),
      ["event-recover"],
    );

    const retried = await store.claim(
      recovered ?? accepted.receipt,
      "2026-08-02T12:05:00.000Z",
      "2026-08-02T12:00:00.000Z",
    );
    assert.equal(retried.kind, "claimed");
    await store.fail(retried.receipt, retried.receipt.leaseToken ?? "", {
      terminal: false,
      code: "crm_provider_unavailable",
      availableAt: "2026-08-02T12:10:00.000Z",
      now: "2026-08-02T12:05:00.000Z",
    });
    assert.equal((await store.listDue("2026-08-02T12:09:59.999Z", 50, hubspotV1)).length, 0);
    assert.equal((await store.listDue("2026-08-02T12:10:00.000Z", 50, hubspotV1)).length, 1);

    await store.redactTerminalPayloads("2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z", 50, hubspotV1);
    assert.ok(await store.get("workspace-a", "event-recover"), "retry receipts must not be redacted");

    const dead = await store.get("workspace-a", "event-recover");
    assert.ok(dead);
    const deadClaim = await store.claim(dead, "2026-08-02T12:10:00.000Z", "2026-08-02T12:05:00.000Z");
    assert.equal(deadClaim.kind, "claimed");
    await store.fail(deadClaim.receipt, deadClaim.receipt.leaseToken ?? "", {
      terminal: true,
      code: "crm_provider_rejected",
      availableAt: "2026-08-02T12:10:00.000Z",
      now: "2026-08-02T12:10:00.000Z",
    });
    const operational = await store.listOperationalReceipts("dead", 50, hubspotV1);
    assert.deepEqual(operational.map(({ eventId, status, payloadState }) => ({ eventId, status, payloadState })), [{
      eventId: "event-recover",
      status: "dead",
      payloadState: "retained",
    }]);
    assert.deepEqual(await store.requeueDead({
      workspaceId: "workspace-a",
      eventId: "event-recover",
      provider: "hubspot",
      mappingVersion: "v1",
      now: "2026-08-02T12:11:00.000Z",
    }), { kind: "requeued" });
    const requeued = await store.get("workspace-a", "event-recover");
    assert.equal(requeued?.status, "retry");
    assert.equal(requeued?.attempts, 0);
    const requeuedClaim = await store.claim(
      requeued ?? deadClaim.receipt,
      "2026-08-02T12:11:00.000Z",
      "2026-08-02T12:06:00.000Z",
    );
    assert.equal(requeuedClaim.kind, "claimed");
    await store.fail(requeuedClaim.receipt, requeuedClaim.receipt.leaseToken ?? "", {
      terminal: true,
      code: "crm_provider_rejected",
      availableAt: "2026-08-02T12:11:00.000Z",
      now: "2026-08-02T12:11:00.000Z",
    });
    await store.redactTerminalPayloads("2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z", 50, hubspotV1);
    const redacted = await store.get("workspace-a", "event-recover");
    assert.equal(redacted?.eventJson, "");
    assert.equal(redacted?.payloadRedactedAt, "2026-08-04T00:00:00.000Z");
    assert.deepEqual(await store.requeueDead({
      workspaceId: "workspace-a",
      eventId: "event-recover",
      provider: "hubspot",
      mappingVersion: "v1",
      now: "2026-08-04T00:01:00.000Z",
    }), { kind: "payload_redacted" });
    await store.pruneTerminalMetadata("2026-08-03T00:00:00.000Z", 50, hubspotV1);
    assert.equal(await store.get("workspace-a", "event-recover"), null);
    await store.checkReady();
  } finally {
    database.close();
  }
});

function receiptInput(eventId: string, bodyDigest: string, aggregateVersion: number, now: string) {
  return {
    workspaceId: "workspace-a",
    eventId,
    bodyDigest,
    eventJson: "{}",
    topic: "agreement.updated",
    agreementId: "4102",
    aggregateVersion,
    provider: "hubspot",
    mappingVersion: "v1",
    now,
  } as const;
}

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: readonly SQLInputValue[] = [],
  ) {}

  bind(...bindings: SQLInputValue[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async run(): Promise<Record<string, unknown>> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements: readonly SqliteD1Statement[]): Promise<Record<string, unknown>[]> {
    this.database.exec("BEGIN");
    try {
      const results: Record<string, unknown>[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

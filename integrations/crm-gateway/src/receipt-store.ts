export const receiptStatuses = ["received", "processing", "retry", "succeeded", "dead", "quarantined", "superseded"] as const;
export type ReceiptStatus = (typeof receiptStatuses)[number];

export type ReceiptRecord = Readonly<{
  workspaceId: string;
  eventId: string;
  bodyDigest: string;
  eventJson: string;
  topic: string;
  agreementId: string;
  aggregateVersion: number;
  provider: string;
  mappingVersion: string;
  status: ReceiptStatus;
  attempts: number;
  availableAt: string;
  leaseToken: string | null;
  lockedAt: string | null;
  lastErrorCode: string | null;
  providerRecordId: string | null;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  payloadRedactedAt: string | null;
}>;

export type NewReceipt = Readonly<{
  workspaceId: string;
  eventId: string;
  bodyDigest: string;
  eventJson: string;
  topic: string;
  agreementId: string;
  aggregateVersion: number;
  provider: string;
  mappingVersion: string;
  now: string;
}>;

export type ReceiptAcceptance = Readonly<{
  kind: "new" | "duplicate" | "collision" | "profile_conflict";
  receipt: ReceiptRecord;
}>;

export type ReceiptClaim = Readonly<{
  kind: "claimed" | "busy" | "superseded" | "terminal";
  receipt: ReceiptRecord;
}>;

export type OperationalReceipt = Readonly<{
  workspaceId: string;
  eventId: string;
  topic: string;
  agreementId: string;
  aggregateVersion: number;
  provider: string;
  mappingVersion: string;
  status: ReceiptStatus;
  attempts: number;
  lastErrorCode: string | null;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  payloadState: "retained" | "redacted";
}>;

export type DeadReceiptRequeue = Readonly<{
  kind: "requeued" | "not_found" | "not_dead" | "payload_redacted" | "profile_mismatch";
}>;

export type ReceiptProfile = Readonly<{
  provider: string;
  mappingVersion: string;
}>;

export interface ReceiptStore {
  accept(input: NewReceipt): Promise<ReceiptAcceptance>;
  get(workspaceId: string, eventId: string): Promise<ReceiptRecord | null>;
  claim(receipt: ReceiptRecord, now: string, staleBefore: string): Promise<ReceiptClaim>;
  complete(receipt: ReceiptRecord, leaseToken: string, providerRecordId: string | null, now: string): Promise<void>;
  fail(receipt: ReceiptRecord, leaseToken: string, input: { terminal: boolean; code: string; availableAt: string; now: string }): Promise<void>;
  listDue(now: string, limit: number, profile: ReceiptProfile): Promise<ReceiptRecord[]>;
  recoverStale(staleBefore: string, now: string, profile: ReceiptProfile): Promise<void>;
  listOperationalReceipts(status: ReceiptStatus, limit: number, profile: ReceiptProfile): Promise<OperationalReceipt[]>;
  requeueDead(input: {
    workspaceId: string;
    eventId: string;
    provider: string;
    mappingVersion: string;
    now: string;
  }): Promise<DeadReceiptRequeue>;
  redactTerminalPayloads(terminalBefore: string, now: string, limit: number, profile: ReceiptProfile): Promise<void>;
  pruneTerminalMetadata(terminalBefore: string, limit: number, profile: ReceiptProfile): Promise<void>;
  checkReady(): Promise<void>;
}

type ReceiptRow = {
  workspace_id: string;
  event_id: string;
  body_digest: string;
  event_json: string;
  topic: string;
  agreement_id: string;
  aggregate_version: number;
  provider: string;
  mapping_version: string;
  status: ReceiptStatus;
  attempts: number;
  available_at: string;
  lease_token: string | null;
  locked_at: string | null;
  last_error_code: string | null;
  provider_record_id: string | null;
  received_at: string;
  updated_at: string;
  completed_at: string | null;
  payload_redacted_at: string | null;
};

type OperationalReceiptRow = Omit<ReceiptRow, "body_digest" | "event_json" | "available_at" | "lease_token" | "locked_at" | "provider_record_id" | "payload_redacted_at"> & {
  payload_state: "retained" | "redacted";
};

const SELECT_RECEIPT = `SELECT
  workspace_id, event_id, body_digest, event_json, topic, agreement_id,
  aggregate_version, provider, mapping_version, status, attempts, available_at,
  lease_token, locked_at, last_error_code, provider_record_id, received_at,
  updated_at, completed_at, payload_redacted_at
FROM crm_event_receipts`;

export const CRM_GATEWAY_SCHEMA_VERSION = 2;

export class D1ReceiptStore implements ReceiptStore {
  constructor(private readonly database: D1Database) {}

  async accept(input: NewReceipt): Promise<ReceiptAcceptance> {
    const [inserted] = await this.database.batch([
      this.database.prepare(`INSERT INTO crm_event_receipts (
        workspace_id, event_id, body_digest, event_json, topic, agreement_id,
        aggregate_version, provider, mapping_version, status, attempts,
        available_at, received_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?, ?)
      ON CONFLICT(workspace_id, event_id) DO NOTHING`).bind(
        input.workspaceId,
        input.eventId,
        input.bodyDigest,
        input.eventJson,
        input.topic,
        input.agreementId,
        input.aggregateVersion,
        input.provider,
        input.mappingVersion,
        input.now,
        input.now,
        input.now,
      ),
      // Advance the durable ordering watermark only from the exact row that
      // is actually stored. A profile conflict, digest collision, or caller
      // metadata mismatch therefore cannot advance aggregate authority.
      this.database.prepare(`INSERT INTO crm_aggregate_state (
        workspace_id, agreement_id, latest_version, latest_event_id,
        provider, mapping_version, updated_at
      )
      SELECT workspace_id, agreement_id, aggregate_version, event_id,
        provider, mapping_version, ?
      FROM crm_event_receipts
      WHERE workspace_id = ? AND event_id = ? AND body_digest = ?
        AND topic = ? AND agreement_id = ? AND aggregate_version = ?
        AND provider = ? AND mapping_version = ?
      ON CONFLICT(workspace_id, agreement_id, provider, mapping_version) DO UPDATE SET
        latest_version = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            THEN excluded.latest_version
          ELSE crm_aggregate_state.latest_version
        END,
        latest_event_id = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            OR (excluded.latest_version = crm_aggregate_state.latest_version
              AND crm_aggregate_state.latest_event_id IS NULL)
            THEN excluded.latest_event_id
          ELSE crm_aggregate_state.latest_event_id
        END,
        updated_at = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            OR (excluded.latest_version = crm_aggregate_state.latest_version
              AND (crm_aggregate_state.latest_event_id IS NULL
                OR crm_aggregate_state.latest_event_id = excluded.latest_event_id))
            THEN excluded.updated_at
          ELSE crm_aggregate_state.updated_at
        END`).bind(
        input.now,
        input.workspaceId,
        input.eventId,
        input.bodyDigest,
        input.topic,
        input.agreementId,
        input.aggregateVersion,
        input.provider,
        input.mappingVersion,
      ),
    ]);

    let receipt = await this.get(input.workspaceId, input.eventId);
    if (!receipt) throw new Error("CRM receipt insert was not observable");
    if ((inserted.meta.changes ?? 0) > 0) return { kind: "new", receipt };
    if (receipt.provider !== input.provider || receipt.mappingVersion !== input.mappingVersion) {
      return { kind: "profile_conflict", receipt };
    }
    if (receipt.bodyDigest === input.bodyDigest) return { kind: "duplicate", receipt };

    await this.database.prepare(`UPDATE crm_event_receipts
      SET status = 'quarantined', last_error_code = 'event_id_digest_collision',
          lease_token = NULL, locked_at = NULL, completed_at = COALESCE(completed_at, ?),
          updated_at = ?
      WHERE workspace_id = ? AND event_id = ? AND body_digest <> ?
        AND provider = ? AND mapping_version = ?`).bind(
      input.now,
      input.now,
      input.workspaceId,
      input.eventId,
      input.bodyDigest,
      input.provider,
      input.mappingVersion,
    ).run();
    receipt = await this.get(input.workspaceId, input.eventId);
    if (!receipt) throw new Error("CRM collision receipt was not observable");
    return { kind: "collision", receipt };
  }

  async get(workspaceId: string, eventId: string): Promise<ReceiptRecord | null> {
    const row = await this.database.prepare(`${SELECT_RECEIPT}
      WHERE workspace_id = ? AND event_id = ? LIMIT 1`).bind(workspaceId, eventId).first<ReceiptRow>();
    return row ? fromRow(row) : null;
  }

  async claim(receipt: ReceiptRecord, now: string, staleBefore: string): Promise<ReceiptClaim> {
    const current = await this.get(receipt.workspaceId, receipt.eventId) ?? receipt;
    if (["succeeded", "superseded", "dead", "quarantined"].includes(current.status)) {
      return { kind: "terminal", receipt: current };
    }
    if (current.status === "processing" || current.availableAt > now) return { kind: "busy", receipt: current };

    const leaseToken = crypto.randomUUID();
    const [, supersedeClaim, aggregateClaim, receiptClaim] = await this.database.batch([
      // Reconcile rows accepted before the watermark invariant was deployed.
      // Equal versions are deterministic: the existing durable winner stays
      // authoritative; a missing winner is filled by received time/event ID.
      this.database.prepare(`INSERT INTO crm_aggregate_state (
        workspace_id, agreement_id, latest_version, latest_event_id,
        provider, mapping_version, updated_at
      )
      SELECT workspace_id, agreement_id, aggregate_version, event_id,
        provider, mapping_version, ?
      FROM crm_event_receipts
      WHERE workspace_id = ? AND agreement_id = ?
        AND provider = ? AND mapping_version = ?
      ORDER BY aggregate_version DESC, received_at, event_id
      LIMIT 1
      ON CONFLICT(workspace_id, agreement_id, provider, mapping_version) DO UPDATE SET
        latest_version = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            THEN excluded.latest_version
          ELSE crm_aggregate_state.latest_version
        END,
        latest_event_id = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            OR (excluded.latest_version = crm_aggregate_state.latest_version
              AND crm_aggregate_state.latest_event_id IS NULL)
            THEN excluded.latest_event_id
          ELSE crm_aggregate_state.latest_event_id
        END,
        updated_at = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            OR (excluded.latest_version = crm_aggregate_state.latest_version
              AND crm_aggregate_state.latest_event_id IS NULL)
            THEN excluded.updated_at
          ELSE crm_aggregate_state.updated_at
        END`).bind(
        now,
        current.workspaceId,
        current.agreementId,
        current.provider,
        current.mappingVersion,
      ),
      this.database.prepare(`UPDATE crm_event_receipts
        SET status = 'superseded', completed_at = ?, updated_at = ?,
            lease_token = NULL, locked_at = NULL, last_error_code = NULL
        WHERE workspace_id = ? AND event_id = ? AND status IN ('received', 'retry')
          AND EXISTS (
            SELECT 1 FROM crm_aggregate_state
            WHERE workspace_id = ? AND agreement_id = ?
              AND provider = ? AND mapping_version = ?
              AND (latest_version > ?
                OR (latest_version = ? AND latest_event_id IS NOT NULL
                  AND latest_event_id <> ?))
          )`).bind(
        now,
        now,
        current.workspaceId,
        current.eventId,
        current.workspaceId,
        current.agreementId,
        current.provider,
        current.mappingVersion,
        current.aggregateVersion,
        current.aggregateVersion,
        current.eventId,
      ),
      this.database.prepare(`UPDATE crm_aggregate_state
        SET lease_token = ?, locked_at = ?, updated_at = ?
        WHERE workspace_id = ? AND agreement_id = ?
          AND provider = ? AND mapping_version = ?
          AND latest_version = ? AND latest_event_id = ?
          AND (lease_token IS NULL OR locked_at < ?)
          AND EXISTS (
            SELECT 1 FROM crm_event_receipts
            WHERE workspace_id = ? AND event_id = ?
              AND status IN ('received', 'retry') AND available_at <= ?
          )`).bind(
        leaseToken,
        now,
        now,
        current.workspaceId,
        current.agreementId,
        current.provider,
        current.mappingVersion,
        current.aggregateVersion,
        current.eventId,
        staleBefore,
        current.workspaceId,
        current.eventId,
        now,
      ),
      this.database.prepare(`UPDATE crm_event_receipts
        SET status = 'processing', attempts = attempts + 1, lease_token = ?,
            locked_at = ?, updated_at = ?, last_error_code = NULL
        WHERE workspace_id = ? AND event_id = ?
          AND status IN ('received', 'retry') AND available_at <= ?
          AND EXISTS (
            SELECT 1 FROM crm_aggregate_state
            WHERE workspace_id = ? AND agreement_id = ?
              AND provider = ? AND mapping_version = ?
              AND latest_version = ? AND latest_event_id = ? AND lease_token = ?
          )`).bind(
        leaseToken,
        now,
        now,
        current.workspaceId,
        current.eventId,
        now,
        current.workspaceId,
        current.agreementId,
        current.provider,
        current.mappingVersion,
        current.aggregateVersion,
        current.eventId,
        leaseToken,
      ),
    ]);

    if ((supersedeClaim.meta.changes ?? 0) > 0) {
      const superseded = await this.get(current.workspaceId, current.eventId);
      if (!superseded) throw new Error("Superseded CRM receipt was not observable");
      return { kind: "superseded", receipt: superseded };
    }
    if ((receiptClaim.meta.changes ?? 0) === 0) {
      if ((aggregateClaim.meta.changes ?? 0) > 0) await this.releaseAggregate(current, leaseToken, now);
      const observed = await this.get(current.workspaceId, current.eventId) ?? current;
      if (observed.status === "superseded") return { kind: "superseded", receipt: observed };
      if (["succeeded", "dead", "quarantined"].includes(observed.status)) {
        return { kind: "terminal", receipt: observed };
      }
      return { kind: "busy", receipt: observed };
    }
    const claimed = await this.get(current.workspaceId, current.eventId);
    if (!claimed) throw new Error("Claimed CRM receipt was not observable");
    return { kind: "claimed", receipt: claimed };
  }

  async complete(receipt: ReceiptRecord, leaseToken: string, providerRecordId: string | null, now: string): Promise<void> {
    await this.database.batch([
      this.database.prepare(`UPDATE crm_aggregate_state
        SET latest_version = CASE WHEN latest_version < ? THEN ? ELSE latest_version END,
            latest_event_id = CASE WHEN latest_version <= ? THEN ? ELSE latest_event_id END,
            provider_record_id = CASE
              WHEN latest_version <= ? THEN COALESCE(?, provider_record_id)
              ELSE provider_record_id
            END,
            lease_token = NULL, locked_at = NULL, updated_at = ?
        WHERE workspace_id = ? AND agreement_id = ?
          AND provider = ? AND mapping_version = ? AND lease_token = ?`).bind(
        receipt.aggregateVersion,
        receipt.aggregateVersion,
        receipt.aggregateVersion,
        receipt.eventId,
        receipt.aggregateVersion,
        providerRecordId,
        now,
        receipt.workspaceId,
        receipt.agreementId,
        receipt.provider,
        receipt.mappingVersion,
        leaseToken,
      ),
      this.database.prepare(`UPDATE crm_event_receipts
        SET status = 'succeeded', provider_record_id = ?, completed_at = ?,
            lease_token = NULL, locked_at = NULL, last_error_code = NULL, updated_at = ?
        WHERE workspace_id = ? AND event_id = ? AND status = 'processing' AND lease_token = ?`).bind(
        providerRecordId,
        now,
        now,
        receipt.workspaceId,
        receipt.eventId,
        leaseToken,
      ),
    ]);
  }

  async fail(receipt: ReceiptRecord, leaseToken: string, input: { terminal: boolean; code: string; availableAt: string; now: string }): Promise<void> {
    await this.database.batch([
      this.database.prepare(`UPDATE crm_event_receipts
        SET status = ?, available_at = ?, last_error_code = ?,
            lease_token = NULL, locked_at = NULL, updated_at = ?,
            completed_at = CASE WHEN ? = 'dead' THEN ? ELSE NULL END
        WHERE workspace_id = ? AND event_id = ? AND status = 'processing' AND lease_token = ?`).bind(
        input.terminal ? "dead" : "retry",
        input.availableAt,
        input.code,
        input.now,
        input.terminal ? "dead" : "retry",
        input.now,
        receipt.workspaceId,
        receipt.eventId,
        leaseToken,
      ),
      this.database.prepare(`UPDATE crm_aggregate_state
        SET lease_token = NULL, locked_at = NULL, updated_at = ?
        WHERE workspace_id = ? AND agreement_id = ?
          AND provider = ? AND mapping_version = ? AND lease_token = ?`).bind(
        input.now,
        receipt.workspaceId,
        receipt.agreementId,
        receipt.provider,
        receipt.mappingVersion,
        leaseToken,
      ),
    ]);
  }

  async listDue(now: string, limit: number, profile: ReceiptProfile): Promise<ReceiptRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.database.prepare(`${SELECT_RECEIPT}
      WHERE provider = ? AND mapping_version = ?
        AND status IN ('received', 'retry') AND available_at <= ?
      ORDER BY available_at, received_at LIMIT ?`).bind(
      profile.provider,
      profile.mappingVersion,
      now,
      boundedLimit,
    ).all<ReceiptRow>();
    return rows.results.map(fromRow);
  }

  async recoverStale(staleBefore: string, now: string, profile: ReceiptProfile): Promise<void> {
    await this.database.batch([
      this.database.prepare(`UPDATE crm_event_receipts
        SET status = 'retry', available_at = ?, lease_token = NULL, locked_at = NULL,
            last_error_code = 'stale_processing_recovered', updated_at = ?
        WHERE provider = ? AND mapping_version = ?
          AND status = 'processing' AND locked_at < ?`).bind(
        now,
        now,
        profile.provider,
        profile.mappingVersion,
        staleBefore,
      ),
      this.database.prepare(`UPDATE crm_aggregate_state
        SET lease_token = NULL, locked_at = NULL, updated_at = ?
        WHERE provider = ? AND mapping_version = ?
          AND lease_token IS NOT NULL AND locked_at < ?`).bind(
        now,
        profile.provider,
        profile.mappingVersion,
        staleBefore,
      ),
    ]);
  }

  async listOperationalReceipts(
    status: ReceiptStatus,
    limit: number,
    profile: ReceiptProfile,
  ): Promise<OperationalReceipt[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.database.prepare(`SELECT
      workspace_id, event_id, topic, agreement_id, aggregate_version, provider,
      mapping_version, status, attempts, last_error_code, received_at, updated_at,
      completed_at, CASE WHEN payload_redacted_at IS NULL THEN 'retained' ELSE 'redacted' END AS payload_state
      FROM crm_event_receipts
      WHERE status = ? AND provider = ? AND mapping_version = ?
      ORDER BY COALESCE(completed_at, updated_at) DESC, workspace_id, event_id
      LIMIT ?`).bind(status, profile.provider, profile.mappingVersion, boundedLimit).all<OperationalReceiptRow>();
    return rows.results.map(fromOperationalRow);
  }

  async requeueDead(input: {
    workspaceId: string;
    eventId: string;
    provider: string;
    mappingVersion: string;
    now: string;
  }): Promise<DeadReceiptRequeue> {
    const receipt = await this.get(input.workspaceId, input.eventId);
    if (!receipt) return { kind: "not_found" };
    if (receipt.status !== "dead") return { kind: "not_dead" };
    if (receipt.payloadRedactedAt !== null || receipt.eventJson.length === 0) return { kind: "payload_redacted" };
    if (receipt.provider !== input.provider || receipt.mappingVersion !== input.mappingVersion) {
      return { kind: "profile_mismatch" };
    }

    const requeued = await this.database.prepare(`UPDATE crm_event_receipts
      SET status = 'retry', attempts = 0, available_at = ?, lease_token = NULL,
          locked_at = NULL, last_error_code = NULL, provider_record_id = NULL,
          completed_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND event_id = ? AND status = 'dead'
        AND payload_redacted_at IS NULL AND event_json <> ''
        AND provider = ? AND mapping_version = ?`).bind(
      input.now,
      input.now,
      input.workspaceId,
      input.eventId,
      input.provider,
      input.mappingVersion,
    ).run();
    if ((requeued.meta.changes ?? 0) > 0) return { kind: "requeued" };

    const current = await this.get(input.workspaceId, input.eventId);
    if (!current) return { kind: "not_found" };
    if (current.status !== "dead") return { kind: "not_dead" };
    if (current.payloadRedactedAt !== null || current.eventJson.length === 0) return { kind: "payload_redacted" };
    return { kind: "profile_mismatch" };
  }

  async redactTerminalPayloads(
    terminalBefore: string,
    now: string,
    limit: number,
    profile: ReceiptProfile,
  ): Promise<void> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    await this.database.prepare(`UPDATE crm_event_receipts
      SET event_json = '', payload_redacted_at = ?, updated_at = ?
      WHERE (workspace_id, event_id) IN (
        SELECT workspace_id, event_id FROM crm_event_receipts
        WHERE provider = ? AND mapping_version = ?
          AND status IN ('succeeded', 'dead', 'quarantined', 'superseded')
          AND payload_redacted_at IS NULL
          AND COALESCE(completed_at, updated_at) < ?
        ORDER BY COALESCE(completed_at, updated_at), workspace_id, event_id
        LIMIT ?
      )`).bind(
      now,
      now,
      profile.provider,
      profile.mappingVersion,
      terminalBefore,
      boundedLimit,
    ).run();
  }

  async pruneTerminalMetadata(terminalBefore: string, limit: number, profile: ReceiptProfile): Promise<void> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    await this.database.batch([
      // Preserve the highest accepted version before deleting legacy terminal
      // metadata. This also upgrades pre-watermark rows that aged directly to
      // pruning without another delivery claim.
      this.database.prepare(`INSERT INTO crm_aggregate_state (
        workspace_id, agreement_id, latest_version, latest_event_id,
        provider, mapping_version, updated_at
      )
      SELECT candidate.workspace_id, candidate.agreement_id,
        candidate.aggregate_version, candidate.event_id, candidate.provider,
        candidate.mapping_version, candidate.updated_at
      FROM crm_event_receipts AS candidate
      WHERE (candidate.workspace_id, candidate.event_id) IN (
        SELECT workspace_id, event_id FROM crm_event_receipts
        WHERE provider = ? AND mapping_version = ?
          AND status IN ('succeeded', 'dead', 'quarantined', 'superseded')
          AND payload_redacted_at IS NOT NULL
          AND COALESCE(completed_at, updated_at) < ?
        ORDER BY COALESCE(completed_at, updated_at), workspace_id, event_id
        LIMIT ?
      )
        AND NOT EXISTS (
          SELECT 1 FROM crm_event_receipts AS newer
          WHERE newer.workspace_id = candidate.workspace_id
            AND newer.agreement_id = candidate.agreement_id
            AND newer.provider = candidate.provider
            AND newer.mapping_version = candidate.mapping_version
            AND (newer.aggregate_version > candidate.aggregate_version
              OR (newer.aggregate_version = candidate.aggregate_version
                AND (newer.received_at < candidate.received_at
                  OR (newer.received_at = candidate.received_at
                    AND newer.event_id < candidate.event_id))))
        )
      ON CONFLICT(workspace_id, agreement_id, provider, mapping_version) DO UPDATE SET
        latest_version = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            THEN excluded.latest_version
          ELSE crm_aggregate_state.latest_version
        END,
        latest_event_id = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            OR (excluded.latest_version = crm_aggregate_state.latest_version
              AND crm_aggregate_state.latest_event_id IS NULL)
            THEN excluded.latest_event_id
          ELSE crm_aggregate_state.latest_event_id
        END,
        updated_at = CASE
          WHEN excluded.latest_version > crm_aggregate_state.latest_version
            OR (excluded.latest_version = crm_aggregate_state.latest_version
              AND crm_aggregate_state.latest_event_id IS NULL)
            THEN excluded.updated_at
          ELSE crm_aggregate_state.updated_at
        END`).bind(
        profile.provider,
        profile.mappingVersion,
        terminalBefore,
        boundedLimit,
      ),
      this.database.prepare(`DELETE FROM crm_event_receipts
        WHERE (workspace_id, event_id) IN (
          SELECT workspace_id, event_id FROM crm_event_receipts
          WHERE provider = ? AND mapping_version = ?
            AND status IN ('succeeded', 'dead', 'quarantined', 'superseded')
            AND payload_redacted_at IS NOT NULL
            AND COALESCE(completed_at, updated_at) < ?
          ORDER BY COALESCE(completed_at, updated_at), workspace_id, event_id
          LIMIT ?
        )`).bind(
        profile.provider,
        profile.mappingVersion,
        terminalBefore,
        boundedLimit,
      ),
    ]);
  }

  async checkReady(): Promise<void> {
    const state = await this.database.prepare(`SELECT schema_version
      FROM crm_gateway_schema_state WHERE singleton = 1 LIMIT 1`).first<{ schema_version: number }>();
    if (state?.schema_version !== CRM_GATEWAY_SCHEMA_VERSION) {
      throw new Error("CRM gateway database migrations are incomplete");
    }
  }

  private async releaseAggregate(receipt: ReceiptRecord, leaseToken: string, now: string): Promise<void> {
    await this.database.prepare(`UPDATE crm_aggregate_state
      SET lease_token = NULL, locked_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND agreement_id = ?
        AND provider = ? AND mapping_version = ? AND lease_token = ?`).bind(
      now,
      receipt.workspaceId,
      receipt.agreementId,
      receipt.provider,
      receipt.mappingVersion,
      leaseToken,
    ).run();
  }
}

function fromRow(row: ReceiptRow): ReceiptRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    bodyDigest: row.body_digest,
    eventJson: row.event_json,
    topic: row.topic,
    agreementId: row.agreement_id,
    aggregateVersion: row.aggregate_version,
    provider: row.provider,
    mappingVersion: row.mapping_version,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseToken: row.lease_token,
    lockedAt: row.locked_at,
    lastErrorCode: safeOperationalErrorCode(row.last_error_code),
    providerRecordId: row.provider_record_id,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    payloadRedactedAt: row.payload_redacted_at,
  });
}

function safeOperationalErrorCode(value: string | null): string | null {
  if (value === null) return null;
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : "operational_error";
}

function fromOperationalRow(row: OperationalReceiptRow): OperationalReceipt {
  return Object.freeze({
    workspaceId: row.workspace_id,
    eventId: row.event_id,
    topic: row.topic,
    agreementId: row.agreement_id,
    aggregateVersion: row.aggregate_version,
    provider: row.provider,
    mappingVersion: row.mapping_version,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: safeOperationalErrorCode(row.last_error_code),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    payloadState: row.payload_state,
  });
}

CREATE TABLE crm_event_receipts (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  event_json TEXT NOT NULL,
  topic TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  provider TEXT NOT NULL CHECK (provider IN ('hubspot', 'salesforce', 'custom')),
  mapping_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'retry', 'succeeded', 'dead', 'quarantined', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  locked_at TEXT,
  last_error_code TEXT,
  provider_record_id TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, event_id)
);

CREATE INDEX idx_crm_receipts_due
  ON crm_event_receipts(provider, mapping_version, status, available_at, received_at);
CREATE INDEX idx_crm_receipts_aggregate
  ON crm_event_receipts(workspace_id, agreement_id, provider, mapping_version, aggregate_version);

CREATE TABLE crm_aggregate_state (
  workspace_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL DEFAULT 0 CHECK (latest_version >= 0),
  latest_event_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('hubspot', 'salesforce', 'custom')),
  mapping_version TEXT NOT NULL,
  provider_record_id TEXT,
  lease_token TEXT,
  locked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agreement_id, provider, mapping_version)
);

CREATE INDEX idx_crm_aggregate_locks
  ON crm_aggregate_state(provider, mapping_version, locked_at);

ALTER TABLE crm_event_receipts
  ADD COLUMN payload_redacted_at TEXT;

CREATE INDEX idx_crm_receipts_operations
  ON crm_event_receipts(provider, mapping_version, status, completed_at, updated_at);

CREATE TABLE crm_gateway_schema_state (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  updated_at TEXT NOT NULL
);

INSERT INTO crm_gateway_schema_state (singleton, schema_version, updated_at)
VALUES (1, 2, CURRENT_TIMESTAMP)
ON CONFLICT(singleton) DO UPDATE SET
  schema_version = excluded.schema_version,
  updated_at = excluded.updated_at;

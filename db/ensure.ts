import { env } from "cloudflare:workers";
import {
  cacheSuccessfulSchemaCheck,
  enforceStorageSchemaPolicy,
  NOTICE_SCHEMA_MARKER_ID,
  NOTICE_SCHEMA_VERSION,
  StorageSchemaError,
  verifyStorageSchema,
} from "./schema-guard";
import { UNASSIGNED_WORKSPACE_ID } from "./schema";

type ColumnInfo = { name: string };

async function ensureColumns(d1: D1Database, table: string, definitions: Record<string, string>): Promise<Set<string>> {
  const result = await d1.prepare(`PRAGMA table_info(${table})`).all<ColumnInfo>();
  const current = new Set(result.results.map((column) => column.name));
  const added = new Set<string>();
  for (const [name, definition] of Object.entries(definitions)) {
    if (!current.has(name)) {
      await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
      added.add(name);
    }
  }
  return added;
}

async function bootstrapStorageSchema(d1: D1Database): Promise<void> {
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS notice_schema_state (
      id text PRIMARY KEY NOT NULL,
      version integer NOT NULL,
      updated_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS mutation_guards (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      operation text NOT NULL,
      guard_changes integer NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT ck_mutation_guards_changes CHECK(guard_changes = 1)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS purge_jobs (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      resource_type text NOT NULL CHECK (resource_type IN ('agreement', 'document')),
      resource_id text NOT NULL,
      object_keys text NOT NULL,
      status text DEFAULT 'storage_pending' NOT NULL CHECK (status IN ('storage_pending', 'completed')),
      guard_changes integer NOT NULL CHECK (guard_changes = 1),
      attempts integer DEFAULT 0 NOT NULL,
      last_error text,
      last_attempt_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      completed_at text
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id text PRIMARY KEY NOT NULL,
      slug text NOT NULL,
      name text NOT NULL,
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'disabled')),
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY NOT NULL,
      identity_provider text NOT NULL,
      identity_subject text NOT NULL,
      email text NOT NULL,
      display_name text NOT NULL,
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'disabled')),
      created_at text NOT NULL,
      updated_at text NOT NULL,
      last_seen_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_memberships (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('admin', 'legal', 'approver', 'requester', 'viewer')),
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'invited', 'disabled')),
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_events (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      sequence integer NOT NULL,
      type text NOT NULL,
      actor_user_id text NOT NULL,
      actor_email text NOT NULL,
      actor text NOT NULL,
      subject_user_id text,
      subject_email text,
      detail text NOT NULL,
      previous_hash text,
      event_hash text NOT NULL,
      created_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_groups (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      name text NOT NULL,
      description text DEFAULT '' NOT NULL,
      external_provider text,
      external_id text,
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'disabled')),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS workspace_group_members (
      workspace_id text NOT NULL,
      group_id text NOT NULL,
      user_id text NOT NULL,
      source text DEFAULT 'manual' NOT NULL CHECK (source IN ('manual', 'scim')),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (workspace_id, group_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES workspace_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS legal_entities (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      legal_name text NOT NULL,
      display_name text NOT NULL,
      entity_type text DEFAULT 'company' NOT NULL,
      jurisdiction text DEFAULT '' NOT NULL,
      registration_number text DEFAULT '' NOT NULL,
      default_currency_code text DEFAULT 'USD' NOT NULL CHECK (length(default_currency_code) = 3 AND default_currency_code = upper(default_currency_code)),
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'inactive')),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS counterparties (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      legal_name text NOT NULL,
      display_name text NOT NULL,
      domain text DEFAULT '' NOT NULL,
      jurisdiction text DEFAULT '' NOT NULL,
      registration_number text DEFAULT '' NOT NULL,
      external_id text DEFAULT '' NOT NULL,
      dedupe_key text NOT NULL,
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'inactive', 'blocked')),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS custom_field_definitions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      resource_type text NOT NULL CHECK (resource_type IN ('agreement', 'counterparty', 'legal_entity')),
      key text NOT NULL,
      label text NOT NULL,
      description text DEFAULT '' NOT NULL,
      data_type text NOT NULL CHECK (data_type IN ('text', 'number', 'date', 'boolean', 'single_select', 'multi_select')),
      options text DEFAULT '[]' NOT NULL CHECK (json_valid(options) = 1 AND json_type(options) = 'array' AND length(options) BETWEEN 2 AND 8192),
      required integer DEFAULT 0 NOT NULL,
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'retired')),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS custom_field_values (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      definition_id text NOT NULL,
      resource_type text NOT NULL CHECK (resource_type IN ('agreement', 'counterparty', 'legal_entity')),
      resource_id text NOT NULL,
      value_json text NOT NULL CHECK (json_valid(value_json) = 1 AND length(value_json) BETWEEN 1 AND 32768),
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (definition_id) REFERENCES custom_field_definitions(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS governed_templates (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      name text NOT NULL,
      description text DEFAULT '' NOT NULL,
      agreement_type text NOT NULL,
      side text NOT NULL CHECK (side IN ('Sell-side', 'Buy-side', 'Corporate')),
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
      current_published_version integer,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS governed_template_versions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      template_id text NOT NULL,
      version integer NOT NULL,
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
      body text NOT NULL,
      variable_schema text NOT NULL CHECK (json_valid(variable_schema) = 1 AND json_type(variable_schema) = 'object' AND length(variable_schema) BETWEEN 2 AND 65536),
      language_block_ids text DEFAULT '[]' NOT NULL CHECK (json_valid(language_block_ids) = 1 AND json_type(language_block_ids) = 'array' AND length(language_block_ids) BETWEEN 2 AND 65536),
      content_sha256 text NOT NULL CHECK (length(content_sha256) = 64 AND lower(content_sha256) NOT GLOB '*[^0-9a-f]*'),
      change_summary text NOT NULL,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      reviewed_by_user_id text,
      reviewed_at text,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES governed_templates(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS governed_template_creation_receipts (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      idempotency_key_sha256 text NOT NULL CHECK (length(idempotency_key_sha256) = 64 AND lower(idempotency_key_sha256) NOT GLOB '*[^0-9a-f]*'),
      request_sha256 text NOT NULL CHECK (length(request_sha256) = 64 AND lower(request_sha256) NOT GLOB '*[^0-9a-f]*'),
      template_id text NOT NULL,
      template_version_id text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (workspace_id, user_id, idempotency_key_sha256),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES governed_templates(id) ON DELETE CASCADE,
      FOREIGN KEY (template_version_id) REFERENCES governed_template_versions(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS workflow_definitions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      name text NOT NULL,
      description text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
      definition text NOT NULL CHECK (json_valid(definition) = 1 AND json_type(definition) = 'object' AND length(definition) BETWEEN 2 AND 65536),
      definition_sha256 text NOT NULL CHECK (length(definition_sha256) = 64 AND lower(definition_sha256) NOT GLOB '*[^0-9a-f]*'),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      published_by_user_id text,
      published_at text,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS approval_lane_authorities (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      lane text NOT NULL,
      subject_type text NOT NULL CHECK (subject_type IN ('user', 'group')),
      subject_id text NOT NULL,
      currency_code text DEFAULT 'USD' NOT NULL CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code)),
      amount_limit_minor integer CHECK (amount_limit_minor IS NULL OR amount_limit_minor >= 0),
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'revoked')),
      reason text NOT NULL,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS intake_forms (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      name text NOT NULL,
      description text DEFAULT '' NOT NULL,
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
      form_schema text NOT NULL CHECK (json_valid(form_schema) = 1 AND json_type(form_schema) = 'object' AND length(form_schema) BETWEEN 2 AND 65536),
      template_id text,
      template_version_id text,
      workflow_definition_id text,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (template_version_id) REFERENCES governed_template_versions(id) ON DELETE RESTRICT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS intake_submissions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      form_id text NOT NULL,
      form_version integer NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'submitted', 'converted', 'rejected')),
      answers text NOT NULL CHECK (json_valid(answers) = 1 AND json_type(answers) = 'object' AND length(answers) BETWEEN 2 AND 131072),
      submitted_by_user_id text NOT NULL,
      agreement_id integer,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      submitted_at text,
      converted_at text,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (form_id) REFERENCES intake_forms(id) ON DELETE RESTRICT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS saved_views (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      owner_user_id text NOT NULL,
      resource_type text NOT NULL,
      name text NOT NULL,
      filter text NOT NULL CHECK (json_valid(filter) = 1 AND json_type(filter) = 'object' AND length(filter) BETWEEN 2 AND 16384),
      sort text NOT NULL CHECK (json_valid(sort) = 1 AND json_type(sort) = 'object' AND length(sort) BETWEEN 2 AND 4096),
      shared integer DEFAULT 0 NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS integration_diagnostics (
      workspace_id text NOT NULL,
      integration_id text NOT NULL CHECK (integration_id IN ('docuseal', 'scanner', 'delivery', 'crm')),
      configuration_fingerprint text NOT NULL,
      status text NOT NULL CHECK (status IN ('passed', 'failed')),
      tested_at text NOT NULL,
      detail text NOT NULL,
      tested_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (workspace_id, integration_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS crm_legacy_cleanup_attestations (
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      event_id text NOT NULL,
      event_payload_sha256 text NOT NULL CHECK (length(event_payload_sha256) = 64),
      provider_selection text NOT NULL CHECK (provider_selection IN ('Salesforce', 'HubSpot', 'Custom CRM')),
      reason text NOT NULL,
      attested_by_user_id text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (workspace_id, event_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agreements (
      id integer PRIMARY KEY NOT NULL,
      workspace_id text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      party text NOT NULL,
      initials text NOT NULL,
      side text NOT NULL,
      type text NOT NULL,
      value integer DEFAULT 0 NOT NULL,
      value_minor integer DEFAULT 0 NOT NULL CHECK (value_minor >= 0),
      currency_code text DEFAULT 'USD' NOT NULL CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code)),
      stage text NOT NULL,
      owner text NOT NULL,
      owner_user_id text,
      primary_counterparty_id text,
      legal_entity_id text,
      governed_template_version_id text,
      workflow_definition_id text,
      next_action text NOT NULL,
      due text NOT NULL,
      crm text NOT NULL,
      crm_record text NOT NULL,
      tags text NOT NULL,
      updated text NOT NULL,
      created_at text DEFAULT '' NOT NULL,
      updated_at text DEFAULT '' NOT NULL,
      created_by_user_id text,
      updated_by_user_id text,
      legal_hold integer DEFAULT 0 NOT NULL,
      retention_until text,
      deleted_at text,
      department text DEFAULT 'Legal' NOT NULL,
      risk text DEFAULT 'Low' NOT NULL,
      risk_disposition text,
      risk_basis_hash text,
      risk_document_version integer,
      risk_document_sha256 text,
      risk_decision_reason text,
      risk_decided_by_user_id text,
      risk_decided_at text,
      approval_status text DEFAULT 'Not required' NOT NULL,
      signature_status text DEFAULT 'Not sent' NOT NULL,
      effective_date text DEFAULT '' NOT NULL,
      expiration_date text DEFAULT '' NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agreement_parties (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      role text NOT NULL CHECK (role IN ('our_entity', 'counterparty', 'guarantor', 'affiliate', 'other')),
      legal_entity_id text,
      counterparty_id text,
      "primary" integer DEFAULT 0 NOT NULL,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT ck_agreement_parties_exact_target CHECK ((legal_entity_id IS NULL) <> (counterparty_id IS NULL)),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agreement_id) REFERENCES agreements(id) ON DELETE CASCADE,
      FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id) ON DELETE RESTRICT,
      FOREIGN KEY (counterparty_id) REFERENCES counterparties(id) ON DELETE RESTRICT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agreement_relationships (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      source_agreement_id integer NOT NULL,
      target_agreement_id integer NOT NULL,
      relationship_type text NOT NULL CHECK (relationship_type IN ('master', 'amends', 'order_under', 'dpa_for', 'renews', 'supersedes', 'related')),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT ck_agreement_relationships_distinct CHECK (source_agreement_id <> target_agreement_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (source_agreement_id) REFERENCES agreements(id) ON DELETE CASCADE,
      FOREIGN KEY (target_agreement_id) REFERENCES agreements(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agreement_creation_receipts (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      idempotency_key text NOT NULL CHECK (length(idempotency_key) = 36),
      request_sha256 text NOT NULL CHECK (length(request_sha256) = 64),
      creation_mode text NOT NULL CHECK (creation_mode IN ('manual', 'generated', 'imported')),
      agreement_id integer NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (workspace_id, user_id, idempotency_key),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (agreement_id) REFERENCES agreements(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS documents (
      id text PRIMARY KEY NOT NULL,
      workspace_id text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      agreement_id integer,
      role text DEFAULT 'supporting' NOT NULL,
      direction text DEFAULT 'internal' NOT NULL,
      negotiation_round_id text,
      provider_message_id text,
      parent_sha256 text,
      original_sender_email text,
      file_name text NOT NULL,
      object_key text NOT NULL,
      content_type text NOT NULL,
      size integer NOT NULL,
      tags text NOT NULL,
      extracted text NOT NULL,
      extraction_mode text DEFAULT 'Metadata classification' NOT NULL,
      sha256 text DEFAULT '' NOT NULL,
      scan_status text DEFAULT 'unscanned' NOT NULL,
      scan_provider text,
      scanned_at text,
      created_by_user_id text,
      legal_hold integer DEFAULT 0 NOT NULL,
      retention_until text,
      deleted_at text,
      created_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS document_upload_receipts (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      key_digest text NOT NULL CHECK (length(key_digest) = 64),
      request_digest text NOT NULL CHECK (length(request_digest) = 64),
      document_id text NOT NULL,
      response_json text NOT NULL CHECK (json_valid(response_json) = 1 AND length(response_json) BETWEEN 2 AND 65536),
      response_status integer NOT NULL CHECK (response_status IN (201, 202)),
      created_at text NOT NULL,
      expires_at text NOT NULL CHECK (expires_at > created_at),
      linked_at text,
      PRIMARY KEY (workspace_id, user_id, key_digest),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS negotiation_rounds (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      round_number integer NOT NULL CHECK (round_number > 0),
      status text DEFAULT 'prepared' NOT NULL CHECK (status IN ('prepared', 'outbound', 'returned', 'review', 'resolved', 'closed')),
      active_key text,
      alias_code text NOT NULL,
      counterparty_email text,
      counterparty_name text,
      base_document_version integer CHECK (base_document_version IS NULL OR base_document_version > 0),
      base_document_id text,
      base_sha256 text NOT NULL CHECK (length(base_sha256) = 64),
      outbound_document_id text NOT NULL,
      outbound_sha256 text NOT NULL CHECK (length(outbound_sha256) = 64),
      portal_token_hash text CHECK (portal_token_hash IS NULL OR length(portal_token_hash) = 64),
      portal_expires_at text,
      portal_upload_attempts integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_attempts CHECK (portal_upload_attempts BETWEEN 0 AND 10),
      portal_upload_accepted integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_accepted CHECK (portal_upload_accepted BETWEEN 0 AND 4),
      portal_upload_rejected integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_rejected CHECK (portal_upload_rejected BETWEEN 0 AND 6),
      portal_upload_bytes integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_bytes CHECK (portal_upload_bytes BETWEEN 0 AND 100663296),
      portal_upload_reservation_id text,
      portal_upload_reservation_expires_at text,
      portal_upload_reservation_bytes integer CONSTRAINT ck_negotiation_rounds_portal_upload_reservation CHECK (
        (
          portal_upload_reservation_id IS NULL
          AND portal_upload_reservation_expires_at IS NULL
          AND portal_upload_reservation_bytes IS NULL
          AND portal_upload_attempts = portal_upload_accepted + portal_upload_rejected
        ) OR (
          portal_upload_reservation_id IS NOT NULL
          AND portal_upload_reservation_expires_at IS NOT NULL
          AND portal_upload_reservation_bytes BETWEEN 1 AND 22020096
          AND portal_upload_attempts = portal_upload_accepted + portal_upload_rejected + 1
        )
      ),
      portal_download_attempts integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_download_attempts CHECK (portal_download_attempts BETWEEN 0 AND 20),
      portal_download_bytes integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_download_bytes CHECK (portal_download_bytes BETWEEN 0 AND 268435456),
      delivery_method text CHECK (delivery_method IS NULL OR delivery_method IN ('manual', 'email_gateway', 'portal')),
      provider_message_id text,
      resolved_document_version integer CHECK (resolved_document_version IS NULL OR resolved_document_version > 0),
      resolved_sha256 text CHECK (resolved_sha256 IS NULL OR length(resolved_sha256) = 64),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      sent_at text,
      resolved_at text,
      closed_at text,
      CONSTRAINT ck_negotiation_rounds_baseline CHECK (
        (base_document_version IS NOT NULL AND base_document_id IS NULL)
        OR (base_document_version IS NULL AND base_document_id IS NOT NULL)
      )
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS negotiation_submissions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      round_id text NOT NULL,
      source text NOT NULL CHECK (source IN ('email', 'portal', 'manual')),
      status text NOT NULL CHECK (status IN ('ready', 'sender_review', 'quarantined', 'rejected', 'promoted', 'late', 'no_attachment')),
      sender_email text,
      sender_name text,
      provider_message_id text,
      document_id text,
      document_sha256 text CHECK (document_sha256 IS NULL OR length(document_sha256) = 64),
      review_text_object_key text,
      review_text_sha256 text CHECK (review_text_sha256 IS NULL OR length(review_text_sha256) = 64),
      review_text_size integer CHECK (review_text_size IS NULL OR review_text_size >= 0),
      review_text_provenance text,
      reviewed_by_user_id text,
      reviewed_at text,
      decision_note text,
      created_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS document_comparisons (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      round_id text NOT NULL,
      submission_id text NOT NULL,
      base_sha256 text CHECK (base_sha256 IS NULL OR length(base_sha256) = 64),
      proposed_sha256 text CHECK (proposed_sha256 IS NULL OR length(proposed_sha256) = 64),
      base_text_sha256 text CHECK (base_text_sha256 IS NULL OR length(base_text_sha256) = 64),
      proposed_text_sha256 text CHECK (proposed_text_sha256 IS NULL OR length(proposed_text_sha256) = 64),
      extractor text,
      provenance text,
      status text DEFAULT 'ready' NOT NULL CHECK (status IN ('ready', 'manual_required', 'accepted', 'rejected', 'superseded')),
      decision_note text,
      decided_by_user_id text,
      decided_at text,
      resulting_document_version integer CHECK (resulting_document_version IS NULL OR resulting_document_version > 0),
      resulting_sha256 text CHECK (resulting_sha256 IS NULL OR length(resulting_sha256) = 64),
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS language_blocks (
      id integer PRIMARY KEY NOT NULL,
      workspace_id text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      title text NOT NULL,
      category text NOT NULL,
      profile text NOT NULL,
      summary text NOT NULL,
      language text NOT NULL,
      uses integer DEFAULT 0 NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS approval_requests (
      id text PRIMARY KEY NOT NULL,
      workspace_id text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      agreement_id integer NOT NULL,
      basis_hash text DEFAULT '' NOT NULL,
      document_version integer DEFAULT 0 NOT NULL,
      document_sha256 text DEFAULT '' NOT NULL,
      role text NOT NULL,
      requested_by_user_id text DEFAULT '' NOT NULL,
      approver text NOT NULL,
      approver_user_id text,
      status text NOT NULL,
      decided_by_user_id text,
      decided_at text,
      basis_confirmed_at text,
      source_agent_plan_id text,
      source_agent_plan_reviewer_user_id text,
      comment text,
      due text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT ck_approval_requests_source_agent_plan_id CHECK (
        source_agent_plan_id IS NULL OR (
          length(source_agent_plan_id) = 36
          AND substr(source_agent_plan_id, 9, 1) = '-'
          AND substr(source_agent_plan_id, 14, 1) = '-'
          AND substr(source_agent_plan_id, 19, 1) = '-'
          AND substr(source_agent_plan_id, 24, 1) = '-'
          AND length(replace(source_agent_plan_id, '-', '')) = 32
          AND lower(replace(source_agent_plan_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
        )
      ),
      CONSTRAINT ck_approval_requests_source_agent_plan_reviewer CHECK (
        source_agent_plan_reviewer_user_id IS NULL OR (
          length(source_agent_plan_reviewer_user_id) = 36
          AND substr(source_agent_plan_reviewer_user_id, 9, 1) = '-'
          AND substr(source_agent_plan_reviewer_user_id, 14, 1) = '-'
          AND substr(source_agent_plan_reviewer_user_id, 19, 1) = '-'
          AND substr(source_agent_plan_reviewer_user_id, 24, 1) = '-'
          AND length(replace(source_agent_plan_reviewer_user_id, '-', '')) = 32
          AND lower(replace(source_agent_plan_reviewer_user_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
        )
      )
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS obligation_schedules (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      title text NOT NULL,
      source text NOT NULL,
      owner_user_id text,
      owner text NOT NULL,
      timezone text NOT NULL,
      recurrence_unit text NOT NULL,
      recurrence_interval integer NOT NULL,
      anchor_date text NOT NULL,
      end_date text,
      reminder_lead_days text NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      next_occurrence_number integer,
      next_occurrence_date text,
      next_materialization_date text,
      supersedes_schedule_id text,
      created_by_user_id text,
      created_at text NOT NULL,
      updated_by_user_id text,
      updated_at text NOT NULL,
      CONSTRAINT ck_obligation_schedules_status CHECK (status in ('active', 'paused', 'ended')),
      CONSTRAINT ck_obligation_schedules_unit CHECK (recurrence_unit in ('once', 'week', 'month', 'year')),
      CONSTRAINT ck_obligation_schedules_interval CHECK (recurrence_interval between 1 and 12 and (recurrence_unit <> 'once' or recurrence_interval = 1)),
      CONSTRAINT ck_obligation_schedules_reminders CHECK (json_valid(reminder_lead_days) = 1 and json_type(reminder_lead_days) = 'array' and json_array_length(reminder_lead_days) between 1 and 8 and length(reminder_lead_days) between 3 and 128),
      CONSTRAINT ck_obligation_schedules_end CHECK (end_date is null or end_date >= anchor_date),
      CONSTRAINT ck_obligation_schedules_next_cursor CHECK (
        (next_occurrence_number is null and next_occurrence_date is null and next_materialization_date is null)
        or (next_occurrence_number > 0 and next_occurrence_date is not null and next_materialization_date is not null)
      )
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS obligations (
      id text PRIMARY KEY NOT NULL,
      workspace_id text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      agreement_id integer NOT NULL,
      schedule_id text NOT NULL,
      occurrence_number integer NOT NULL,
      title text NOT NULL,
      due_date text NOT NULL,
      owner text NOT NULL,
      owner_user_id text,
      status text NOT NULL,
      completed_by_user_id text,
      completed_at text,
      completion_evidence text,
      cadence text NOT NULL,
      source text NOT NULL,
      timezone text NOT NULL,
      reminder_lead_days text NOT NULL,
      next_reminder_date text,
      created_by_user_id text,
      created_at text NOT NULL,
      CONSTRAINT ck_obligations_occurrence_number CHECK (occurrence_number > 0),
      CONSTRAINT ck_obligations_reminder_days CHECK (json_valid(reminder_lead_days) = 1 and json_type(reminder_lead_days) = 'array' and json_array_length(reminder_lead_days) between 1 and 8 and length(reminder_lead_days) between 3 and 128)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS obligation_evidence (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      obligation_id text NOT NULL,
      evidence_text text NOT NULL,
      evidence_sha256 text,
      submitted_by_user_id text,
      override_reason text,
      provenance text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT ck_obligation_evidence_provenance CHECK (provenance in ('native', 'legacy_v16')),
      CONSTRAINT ck_obligation_evidence_digest CHECK (
        (provenance = 'native' and length(evidence_sha256) = 64
          and lower(evidence_sha256) not glob '*[^0-9a-f]*')
        or (provenance = 'legacy_v16' and (evidence_sha256 is null or (
          length(evidence_sha256) = 64 and lower(evidence_sha256) not glob '*[^0-9a-f]*'
        )))
      )
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS obligation_creation_receipts (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      idempotency_key text NOT NULL,
      request_sha256 text NOT NULL,
      agreement_id integer NOT NULL,
      schedule_id text NOT NULL,
      obligation_id text NOT NULL,
      agreement_event_id text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY(workspace_id, user_id, idempotency_key),
      CONSTRAINT ck_obligation_creation_receipts_key CHECK (length(idempotency_key) = 36),
      CONSTRAINT ck_obligation_creation_receipts_digest CHECK (length(request_sha256) = 64)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agreement_events (
      id text PRIMARY KEY NOT NULL,
      workspace_id text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL,
      agreement_id integer NOT NULL,
      type text NOT NULL,
      actor_user_id text,
      actor_email text,
      actor text NOT NULL,
      detail text NOT NULL,
      previous_hash text,
      event_hash text,
      sequence integer DEFAULT 0 NOT NULL,
      source_agent_plan_id text,
      created_at text NOT NULL,
      CONSTRAINT ck_agreement_events_source_agent_plan_id CHECK (
        source_agent_plan_id IS NULL OR (
          length(source_agent_plan_id) = 36
          AND substr(source_agent_plan_id, 9, 1) = '-'
          AND substr(source_agent_plan_id, 14, 1) = '-'
          AND substr(source_agent_plan_id, 19, 1) = '-'
          AND substr(source_agent_plan_id, 24, 1) = '-'
          AND length(replace(source_agent_plan_id, '-', '')) = 32
          AND lower(replace(source_agent_plan_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
        )
      )
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agreement_versions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      version integer NOT NULL,
      snapshot text NOT NULL,
      source_event_id text,
      checksum_sha256 text NOT NULL,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agreement_document_versions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      version integer NOT NULL,
      label text NOT NULL,
      object_key text NOT NULL,
      content_type text NOT NULL,
      size integer NOT NULL,
      sha256 text NOT NULL,
      source_document_id text,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS outbox_events (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      topic text NOT NULL,
      aggregate_type text NOT NULL,
      aggregate_id text NOT NULL,
      payload text NOT NULL,
      status text DEFAULT 'pending' NOT NULL,
      attempts integer DEFAULT 0 NOT NULL,
      available_at text NOT NULL,
      locked_at text,
      processed_at text,
      last_error text,
      created_at text NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS outbox_deliveries (
      event_id text NOT NULL,
      sink text NOT NULL CHECK (sink IN ('delivery', 'crm')),
      workspace_id text NOT NULL,
      status text DEFAULT 'pending' NOT NULL CHECK (status IN ('pending', 'accepted', 'dead')),
      attempts integer DEFAULT 0 NOT NULL,
      available_at text NOT NULL,
      accepted_at text,
      last_error text,
      crm_provider text,
      crm_mapping_version text,
      crm_destination_fingerprint text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (event_id, sink),
      FOREIGN KEY (event_id) REFERENCES outbox_events(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS signature_packets (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agreement_id integer NOT NULL,
      basis_hash text DEFAULT '' NOT NULL,
      document_version integer DEFAULT 0 NOT NULL,
      document_sha256 text DEFAULT '' NOT NULL,
      active_key text,
      provider text NOT NULL,
      external_id text NOT NULL,
      submission_id text,
      status text NOT NULL,
      signers text NOT NULL,
      evidence_document_id text,
      version integer DEFAULT 1 NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      completed_at text
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS webhook_receipts (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      provider text NOT NULL,
      provider_event_id text,
      payload_digest text NOT NULL,
      aggregate_type text,
      aggregate_id text,
      status text DEFAULT 'received' NOT NULL,
      received_at text NOT NULL,
      processed_at text,
      error text
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS service_principals (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      name text NOT NULL,
      issuer text NOT NULL,
      subject text NOT NULL,
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'disabled')),
      version integer DEFAULT 1 NOT NULL CHECK (version > 0),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      last_seen_at text,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_grants (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      principal_id text NOT NULL,
      delegator_user_id text NOT NULL,
      status text DEFAULT 'active' NOT NULL CHECK (status IN ('active', 'revoked')),
      action_ids text NOT NULL CHECK (json_valid(action_ids) = 1 AND length(action_ids) BETWEEN 2 AND 16384),
      resource_constraints text NOT NULL CHECK (json_valid(resource_constraints) = 1 AND length(resource_constraints) BETWEEN 2 AND 65536),
      policy_version text NOT NULL,
      starts_at text NOT NULL,
      expires_at text NOT NULL CHECK (expires_at > starts_at),
      revoked_at text,
      revoked_by_user_id text,
      revocation_reason text,
      version integer DEFAULT 1 NOT NULL CHECK (version > 0),
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (principal_id) REFERENCES service_principals(id) ON DELETE CASCADE,
      FOREIGN KEY (delegator_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_runs (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      principal_id text NOT NULL,
      grant_id text NOT NULL,
      sponsor_user_id text NOT NULL,
      purpose text NOT NULL,
      status text DEFAULT 'running' NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
      model_provider text,
      model_id text,
      tool_version text NOT NULL,
      prompt_sha256 text CHECK (prompt_sha256 IS NULL OR length(prompt_sha256) = 64),
      context_sha256 text CHECK (context_sha256 IS NULL OR length(context_sha256) = 64),
      started_at text NOT NULL,
      completed_at text,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (principal_id) REFERENCES service_principals(id) ON DELETE CASCADE,
      FOREIGN KEY (grant_id) REFERENCES agent_grants(id),
      FOREIGN KEY (sponsor_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_action_plans (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      principal_id text NOT NULL,
      grant_id text NOT NULL,
      run_id text,
      action_id text NOT NULL,
      resource_type text NOT NULL,
      resource_id text NOT NULL,
      agreement_id integer,
      canonical_input text NOT NULL CHECK (json_valid(canonical_input) = 1 AND length(canonical_input) BETWEEN 2 AND 262144),
      input_sha256 text NOT NULL CHECK (length(input_sha256) = 64),
      plan_sha256 text NOT NULL CHECK (length(plan_sha256) = 64),
      expected_version integer,
      basis_hash text CHECK (basis_hash IS NULL OR length(basis_hash) = 64),
      document_version integer,
      document_sha256 text CHECK (document_sha256 IS NULL OR length(document_sha256) = 64),
      policy_version text NOT NULL,
      risk_tier text NOT NULL CHECK (risk_tier IN ('low', 'medium', 'high', 'critical')),
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'pending_approval', 'approved', 'executing', 'succeeded', 'failed_retryable', 'failed_terminal', 'superseded', 'expired', 'rejected', 'cancelled')),
      before_snapshot text,
      proposed_diff text NOT NULL CHECK (json_valid(proposed_diff) = 1 AND length(proposed_diff) BETWEEN 2 AND 262144),
      blockers text NOT NULL CHECK (json_valid(blockers) = 1 AND length(blockers) BETWEEN 2 AND 65536),
      provenance text NOT NULL CHECK (json_valid(provenance) = 1 AND length(provenance) BETWEEN 2 AND 65536),
      created_by_user_id text,
      expires_at text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (principal_id) REFERENCES service_principals(id) ON DELETE CASCADE,
      FOREIGN KEY (grant_id) REFERENCES agent_grants(id),
      FOREIGN KEY (run_id) REFERENCES agent_runs(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_plan_decisions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      plan_id text NOT NULL,
      plan_sha256 text NOT NULL CHECK (length(plan_sha256) = 64),
      decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
      reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 4000),
      decided_by_user_id text NOT NULL,
      decided_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES agent_action_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (decided_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_action_executions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      plan_id text NOT NULL,
      principal_id text NOT NULL,
      grant_id text NOT NULL,
      action_id text NOT NULL,
      plan_sha256 text NOT NULL CHECK (length(plan_sha256) = 64),
      request_sha256 text NOT NULL CHECK (length(request_sha256) = 64),
      idempotency_key_sha256 text NOT NULL CHECK (length(idempotency_key_sha256) = 64),
      status text DEFAULT 'executing' NOT NULL CHECK (status IN ('executing', 'succeeded', 'failed_retryable', 'failed_terminal')),
      result text,
      agreement_event_ids text NOT NULL CHECK (json_valid(agreement_event_ids) = 1 AND length(agreement_event_ids) BETWEEN 2 AND 65536),
      provenance text NOT NULL CHECK (json_valid(provenance) = 1 AND length(provenance) BETWEEN 2 AND 65536),
      started_at text NOT NULL,
      completed_at text,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES agent_action_plans(id),
      FOREIGN KEY (principal_id) REFERENCES service_principals(id),
      FOREIGN KEY (grant_id) REFERENCES agent_grants(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS clause_playbooks (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      name text NOT NULL,
      description text DEFAULT '' NOT NULL,
      scope text NOT NULL CHECK (json_valid(scope) = 1 AND json_type(scope) = 'object' AND length(scope) BETWEEN 2 AND 32768),
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
      current_published_version integer CHECK (current_published_version IS NULL OR current_published_version > 0),
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_by_user_id text NOT NULL,
      updated_at text NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS clause_playbook_versions (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      playbook_id text NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      status text DEFAULT 'draft' NOT NULL CHECK (status IN ('draft', 'published')),
      rules text NOT NULL CHECK (json_valid(rules) = 1 AND json_type(rules) = 'object' AND length(rules) BETWEEN 2 AND 262144),
      content_sha256 text NOT NULL CHECK (length(content_sha256) = 64 AND lower(content_sha256) NOT GLOB '*[^0-9a-f]*'),
      change_summary text NOT NULL,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      published_by_user_id text,
      published_at text,
      CHECK ((status = 'draft' AND published_by_user_id IS NULL AND published_at IS NULL) OR (status = 'published' AND published_by_user_id IS NOT NULL AND published_at IS NOT NULL AND published_by_user_id <> created_by_user_id)),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (playbook_id) REFERENCES clause_playbooks(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      FOREIGN KEY (published_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS clause_playbook_creation_receipts (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      idempotency_key_sha256 text NOT NULL CHECK (length(idempotency_key_sha256) = 64 AND lower(idempotency_key_sha256) NOT GLOB '*[^0-9a-f]*'),
      request_sha256 text NOT NULL CHECK (length(request_sha256) = 64 AND lower(request_sha256) NOT GLOB '*[^0-9a-f]*'),
      playbook_id text NOT NULL,
      playbook_version_id text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (workspace_id, user_id, idempotency_key_sha256),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (playbook_id) REFERENCES clause_playbooks(id) ON DELETE CASCADE,
      FOREIGN KEY (playbook_version_id) REFERENCES clause_playbook_versions(id) ON DELETE CASCADE
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS ingestion_batches (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      created_by_user_id text NOT NULL,
      idempotency_key_sha256 text NOT NULL CHECK (length(idempotency_key_sha256) = 64 AND lower(idempotency_key_sha256) NOT GLOB '*[^0-9a-f]*'),
      request_sha256 text NOT NULL CHECK (length(request_sha256) = 64 AND lower(request_sha256) NOT GLOB '*[^0-9a-f]*'),
      status text NOT NULL CHECK (status IN ('awaiting_upload', 'review', 'completed', 'cancelled')),
      item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 50),
      accepted_count integer DEFAULT 0 NOT NULL,
      rejected_count integer DEFAULT 0 NOT NULL,
      blocker_code text,
      blocker_message text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      completed_at text,
      CHECK (accepted_count >= 0 AND rejected_count >= 0 AND accepted_count + rejected_count <= item_count),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS ingestion_items (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      batch_id text NOT NULL,
      ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 49),
      file_name text NOT NULL,
      content_type text NOT NULL,
      size integer NOT NULL CHECK (size BETWEEN 1 AND 20971520),
      source_sha256 text NOT NULL CHECK (length(source_sha256) = 64 AND lower(source_sha256) NOT GLOB '*[^0-9a-f]*'),
      dedupe_sha256 text NOT NULL CHECK (length(dedupe_sha256) = 64 AND lower(dedupe_sha256) NOT GLOB '*[^0-9a-f]*'),
      document_id text,
      duplicate_of_document_id text,
      status text NOT NULL CHECK (status IN ('awaiting_upload', 'duplicate', 'pending_extraction', 'review_required', 'accepted', 'rejected', 'failed')),
      blocker_code text,
      blocker_message text,
      reviewed_by_user_id text,
      reviewed_at text,
      review_reason text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CHECK ((status IN ('accepted', 'rejected') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(trim(review_reason)) BETWEEN 3 AND 4000) OR (status NOT IN ('accepted', 'rejected') AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES ingestion_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
      FOREIGN KEY (duplicate_of_document_id) REFERENCES documents(id) ON DELETE SET NULL,
      FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS repository_fragments (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document_version_id text NOT NULL,
      agreement_id integer NOT NULL,
      document_version integer NOT NULL CHECK (document_version > 0),
      document_sha256 text NOT NULL CHECK (length(document_sha256) = 64 AND lower(document_sha256) NOT GLOB '*[^0-9a-f]*'),
      source_text_sha256 text NOT NULL CHECK (length(source_text_sha256) = 64 AND lower(source_text_sha256) NOT GLOB '*[^0-9a-f]*'),
      ordinal integer NOT NULL,
      start_offset integer NOT NULL,
      end_offset integer NOT NULL,
      content text NOT NULL CHECK (length(content) BETWEEN 1 AND 12000),
      content_sha256 text NOT NULL CHECK (length(content_sha256) = 64 AND lower(content_sha256) NOT GLOB '*[^0-9a-f]*'),
      extractor text NOT NULL,
      extractor_version text NOT NULL,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      CHECK (ordinal >= 0 AND start_offset >= 0 AND end_offset > start_offset AND end_offset - start_offset <= 12000),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (document_version_id) REFERENCES agreement_document_versions(id) ON DELETE CASCADE,
      FOREIGN KEY (agreement_id) REFERENCES agreements(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS extraction_proposals (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document_version_id text NOT NULL,
      agreement_id integer NOT NULL,
      ingestion_item_id text,
      document_version integer NOT NULL CHECK (document_version > 0),
      document_sha256 text NOT NULL CHECK (length(document_sha256) = 64 AND lower(document_sha256) NOT GLOB '*[^0-9a-f]*'),
      source_text_sha256 text NOT NULL CHECK (length(source_text_sha256) = 64 AND lower(source_text_sha256) NOT GLOB '*[^0-9a-f]*'),
      target_type text NOT NULL,
      target_field text NOT NULL,
      custom_field_definition_id text,
      proposed_value text NOT NULL CHECK (json_valid(proposed_value) = 1 AND length(proposed_value) BETWEEN 1 AND 32768),
      confidence_ppm integer NOT NULL CHECK (confidence_ppm BETWEEN 0 AND 1000000),
      extractor text NOT NULL,
      extractor_version text NOT NULL,
      status text DEFAULT 'pending_review' NOT NULL CHECK (status IN ('pending_review', 'accepted', 'rejected', 'superseded')),
      application_status text DEFAULT 'not_reviewed' NOT NULL CHECK (application_status IN ('not_reviewed', 'blocked')),
      blocker_code text DEFAULT 'human_review_required' NOT NULL,
      blocker_message text DEFAULT 'A human reviewer must accept or reject this proposal.' NOT NULL,
      reviewed_by_user_id text,
      reviewed_at text,
      review_reason text,
      created_by_user_id text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CHECK ((target_type = 'agreement_field' AND custom_field_definition_id IS NULL) OR (target_type = 'custom_field' AND custom_field_definition_id IS NOT NULL)),
      CHECK ((status = 'pending_review' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL AND application_status = 'not_reviewed' AND blocker_code = 'human_review_required') OR (status IN ('accepted', 'rejected', 'superseded') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(trim(review_reason)) BETWEEN 3 AND 4000 AND application_status = 'blocked')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (document_version_id) REFERENCES agreement_document_versions(id) ON DELETE CASCADE,
      FOREIGN KEY (agreement_id) REFERENCES agreements(id) ON DELETE CASCADE,
      FOREIGN KEY (ingestion_item_id) REFERENCES ingestion_items(id) ON DELETE SET NULL,
      FOREIGN KEY (custom_field_definition_id) REFERENCES custom_field_definitions(id) ON DELETE RESTRICT,
      FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS extraction_proposal_citations (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      proposal_id text NOT NULL,
      fragment_id text NOT NULL,
      document_version_id text NOT NULL,
      document_version integer NOT NULL CHECK (document_version > 0),
      document_sha256 text NOT NULL CHECK (length(document_sha256) = 64 AND lower(document_sha256) NOT GLOB '*[^0-9a-f]*'),
      source_text_sha256 text NOT NULL CHECK (length(source_text_sha256) = 64 AND lower(source_text_sha256) NOT GLOB '*[^0-9a-f]*'),
      start_offset integer NOT NULL,
      end_offset integer NOT NULL,
      quote text NOT NULL,
      quote_sha256 text NOT NULL CHECK (length(quote_sha256) = 64 AND lower(quote_sha256) NOT GLOB '*[^0-9a-f]*'),
      CHECK (start_offset >= 0 AND end_offset > start_offset AND length(quote) BETWEEN 1 AND 12000),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (proposal_id) REFERENCES extraction_proposals(id) ON DELETE CASCADE,
      FOREIGN KEY (fragment_id) REFERENCES repository_fragments(id) ON DELETE CASCADE,
      FOREIGN KEY (document_version_id) REFERENCES agreement_document_versions(id) ON DELETE CASCADE
    )`),
  ]);

  const priorSchemaMarker = await d1.prepare(
    "SELECT version FROM notice_schema_state WHERE id = ? LIMIT 1",
  ).bind(NOTICE_SCHEMA_MARKER_ID).first<{ version: number }>();

  await ensureColumns(d1, "negotiation_rounds", {
    portal_upload_attempts: "integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_attempts CHECK (portal_upload_attempts BETWEEN 0 AND 10)",
    portal_upload_accepted: "integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_accepted CHECK (portal_upload_accepted BETWEEN 0 AND 4)",
    portal_upload_rejected: "integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_rejected CHECK (portal_upload_rejected BETWEEN 0 AND 6)",
    portal_upload_bytes: "integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_upload_bytes CHECK (portal_upload_bytes BETWEEN 0 AND 100663296)",
    portal_upload_reservation_id: "text",
    portal_upload_reservation_expires_at: "text",
    portal_upload_reservation_bytes: `integer CONSTRAINT ck_negotiation_rounds_portal_upload_reservation CHECK (
      (
        portal_upload_reservation_id IS NULL
        AND portal_upload_reservation_expires_at IS NULL
        AND portal_upload_reservation_bytes IS NULL
        AND portal_upload_attempts = portal_upload_accepted + portal_upload_rejected
      ) OR (
        portal_upload_reservation_id IS NOT NULL
        AND portal_upload_reservation_expires_at IS NOT NULL
        AND portal_upload_reservation_bytes BETWEEN 1 AND 22020096
        AND portal_upload_attempts = portal_upload_accepted + portal_upload_rejected + 1
      )
    )`,
    portal_download_attempts: "integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_download_attempts CHECK (portal_download_attempts BETWEEN 0 AND 20)",
    portal_download_bytes: "integer DEFAULT 0 NOT NULL CONSTRAINT ck_negotiation_rounds_portal_download_bytes CHECK (portal_download_bytes BETWEEN 0 AND 268435456)",
  });

  const addedAgreementColumns = await ensureColumns(d1, "agreements", {
    workspace_id: `text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL`,
    version: "integer DEFAULT 1 NOT NULL",
    created_at: "text DEFAULT '' NOT NULL",
    updated_at: "text DEFAULT '' NOT NULL",
    created_by_user_id: "text",
    updated_by_user_id: "text",
    legal_hold: "integer DEFAULT 0 NOT NULL",
    retention_until: "text",
    deleted_at: "text",
    department: "text DEFAULT 'Legal' NOT NULL",
    risk: "text DEFAULT 'Low' NOT NULL",
    risk_disposition: "text",
    risk_basis_hash: "text",
    risk_document_version: "integer",
    risk_document_sha256: "text",
    risk_decision_reason: "text",
    risk_decided_by_user_id: "text",
    risk_decided_at: "text",
    approval_status: "text DEFAULT 'Not required' NOT NULL",
    signature_status: "text DEFAULT 'Not sent' NOT NULL",
    effective_date: "text DEFAULT '' NOT NULL",
    expiration_date: "text DEFAULT '' NOT NULL",
    value_minor: "integer DEFAULT 0 NOT NULL",
    currency_code: "text DEFAULT 'USD' NOT NULL",
    owner_user_id: "text",
    primary_counterparty_id: "text",
    legal_entity_id: "text",
    governed_template_version_id: "text",
    workflow_definition_id: "text",
    workflow_policy_sha256: "text",
    workflow_approval_lanes: "text",
  });
  await ensureColumns(d1, "intake_forms", {
    template_version_id: "text REFERENCES governed_template_versions(id) ON DELETE RESTRICT",
  });
  if (addedAgreementColumns.has("value_minor")) {
    await d1.prepare(`UPDATE agreements
      SET value_minor = CASE
        WHEN value > 90000000000000 THEN 9000000000000000
        ELSE value * 100
      END,
      currency_code = 'USD'`).run();
  }
  if (priorSchemaMarker && priorSchemaMarker.version < 18) {
    // Currency and minor-unit fields are material approval terms. The v18
    // basis digest binds both, so older in-flight risk, approval, and signature
    // evidence is visibly superseded rather than silently accepted.
    await d1.batch([
      d1.prepare(`UPDATE approval_requests
        SET status = 'Superseded', version = version + 1
        WHERE status IN ('Pending', 'Approved', 'Changes requested')
          AND EXISTS (
            SELECT 1 FROM agreements
            WHERE agreements.workspace_id = approval_requests.workspace_id
              AND agreements.id = approval_requests.agreement_id
              AND agreements.stage <> 'Active'
              AND agreements.signature_status <> 'Completed'
          )`),
      d1.prepare(`UPDATE signature_packets
        SET status = 'superseded', active_key = NULL,
          updated_at = CURRENT_TIMESTAMP, version = version + 1
        WHERE status IN ('creating', 'pending', 'partially_signed', 'reconciling', 'archived', 'completed_review_required')
          AND EXISTS (
            SELECT 1 FROM agreements
            WHERE agreements.workspace_id = signature_packets.workspace_id
              AND agreements.id = signature_packets.agreement_id
              AND agreements.stage <> 'Active'
              AND agreements.signature_status <> 'Completed'
          )`),
      d1.prepare(`UPDATE agreements
        SET risk = 'Unassessed', risk_disposition = NULL,
          risk_basis_hash = NULL, risk_document_version = NULL,
          risk_document_sha256 = NULL, risk_decision_reason = NULL,
          risk_decided_by_user_id = NULL, risk_decided_at = NULL,
          approval_status = 'Required', signature_status = 'Not sent',
          stage = CASE WHEN stage = 'Signature' THEN 'Review' ELSE stage END,
          next_action = 'Assess risk after the currency-aware basis upgrade',
          version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE stage <> 'Active' AND signature_status <> 'Completed'`),
    ]);
  }
  const addedDocumentColumns = await ensureColumns(d1, "documents", {
    workspace_id: `text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL`,
    version: "integer DEFAULT 1 NOT NULL",
    role: "text DEFAULT 'supporting' NOT NULL",
    direction: "text DEFAULT 'internal' NOT NULL",
    negotiation_round_id: "text",
    provider_message_id: "text",
    parent_sha256: "text",
    original_sender_email: "text",
    extraction_mode: "text DEFAULT 'Metadata classification' NOT NULL",
    sha256: "text DEFAULT '' NOT NULL",
    scan_status: "text DEFAULT 'unscanned' NOT NULL",
    scan_provider: "text",
    scanned_at: "text",
    created_by_user_id: "text",
    legal_hold: "integer DEFAULT 0 NOT NULL",
    retention_until: "text",
    deleted_at: "text",
  });
  if (
    addedDocumentColumns.has("role")
    || addedDocumentColumns.has("direction")
    || Boolean(priorSchemaMarker && priorSchemaMarker.version < NOTICE_SCHEMA_VERSION)
  ) {
    // Local/evaluation compatibility mirrors migration 0014. Supported
    // pre-v14 writers produced either user-imported sources or DocuSeal
    // evidence; do not leave those rows under the new supporting/internal
    // defaults, and do not reclassify an already-current local database.
    await d1.prepare(`UPDATE documents
      SET
        role = CASE
          WHEN EXISTS (
            SELECT 1
            FROM signature_packets AS legacy_signature_packet
            WHERE legacy_signature_packet.workspace_id = documents.workspace_id
              AND legacy_signature_packet.evidence_document_id = documents.id
          )
          OR documents.created_by_user_id = 'system:docuseal'
          OR documents.extraction_mode = 'Signed artifact; extraction intentionally skipped'
          OR substr(
            documents.object_key,
            1,
            length('workspaces/' || documents.workspace_id || '/signed/')
          ) = 'workspaces/' || documents.workspace_id || '/signed/'
          THEN 'signed_artifact'
          ELSE 'initial_source'
        END,
        direction = 'inbound'
      WHERE role = 'supporting'
        AND direction = 'internal'
        AND negotiation_round_id IS NULL`).run();
    await d1.prepare(`UPDATE documents
      SET
        provider_message_id = COALESCE(
          provider_message_id,
          (
            SELECT path_packet.submission_id
            FROM signature_packets AS path_packet
            WHERE path_packet.workspace_id = documents.workspace_id
              AND path_packet.agreement_id = documents.agreement_id
              AND path_packet.submission_id IS NOT NULL
              AND length(path_packet.submission_id) > 0
              AND length(path_packet.document_sha256) = 64
              AND substr(
                documents.object_key,
                1,
                length('workspaces/' || documents.workspace_id || '/signed/' || documents.agreement_id || '/' || path_packet.id || '/')
              ) = 'workspaces/' || documents.workspace_id || '/signed/' || documents.agreement_id || '/' || path_packet.id || '/'
            ORDER BY path_packet.id
            LIMIT 1
          ),
          (
            SELECT direct_packet.submission_id
            FROM signature_packets AS direct_packet
            WHERE direct_packet.workspace_id = documents.workspace_id
              AND direct_packet.agreement_id = documents.agreement_id
              AND direct_packet.evidence_document_id = documents.id
              AND direct_packet.submission_id IS NOT NULL
              AND length(direct_packet.submission_id) > 0
              AND length(direct_packet.document_sha256) = 64
              AND 1 = (
                SELECT count(*)
                FROM signature_packets AS reference_packet
                WHERE reference_packet.workspace_id = documents.workspace_id
                  AND reference_packet.agreement_id = documents.agreement_id
                  AND reference_packet.evidence_document_id = documents.id
              )
            LIMIT 1
          )
        ),
        parent_sha256 = COALESCE(
          parent_sha256,
          (
            SELECT path_packet.document_sha256
            FROM signature_packets AS path_packet
            WHERE path_packet.workspace_id = documents.workspace_id
              AND path_packet.agreement_id = documents.agreement_id
              AND path_packet.submission_id IS NOT NULL
              AND length(path_packet.submission_id) > 0
              AND length(path_packet.document_sha256) = 64
              AND substr(
                documents.object_key,
                1,
                length('workspaces/' || documents.workspace_id || '/signed/' || documents.agreement_id || '/' || path_packet.id || '/')
              ) = 'workspaces/' || documents.workspace_id || '/signed/' || documents.agreement_id || '/' || path_packet.id || '/'
            ORDER BY path_packet.id
            LIMIT 1
          ),
          (
            SELECT direct_packet.document_sha256
            FROM signature_packets AS direct_packet
            WHERE direct_packet.workspace_id = documents.workspace_id
              AND direct_packet.agreement_id = documents.agreement_id
              AND direct_packet.evidence_document_id = documents.id
              AND direct_packet.submission_id IS NOT NULL
              AND length(direct_packet.submission_id) > 0
              AND length(direct_packet.document_sha256) = 64
              AND 1 = (
                SELECT count(*)
                FROM signature_packets AS reference_packet
                WHERE reference_packet.workspace_id = documents.workspace_id
                  AND reference_packet.agreement_id = documents.agreement_id
                  AND reference_packet.evidence_document_id = documents.id
              )
            LIMIT 1
          )
        )
      WHERE role = 'signed_artifact'
        AND direction = 'inbound'
        AND negotiation_round_id IS NULL
        AND (provider_message_id IS NULL OR parent_sha256 IS NULL)`).run();
  }
  await ensureColumns(d1, "language_blocks", {
    workspace_id: `text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL`,
    version: "integer DEFAULT 1 NOT NULL",
  });
  await ensureColumns(d1, "approval_requests", {
    workspace_id: `text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL`,
    version: "integer DEFAULT 1 NOT NULL",
    basis_hash: "text DEFAULT '' NOT NULL",
    document_version: "integer DEFAULT 0 NOT NULL",
    document_sha256: "text DEFAULT '' NOT NULL",
    requested_by_user_id: "text DEFAULT '' NOT NULL",
    approver_user_id: "text",
    decided_by_user_id: "text",
    decided_at: "text",
    basis_confirmed_at: "text",
    source_agent_plan_id: `text CONSTRAINT ck_approval_requests_source_agent_plan_id CHECK (
      source_agent_plan_id IS NULL OR (
        length(source_agent_plan_id) = 36
        AND substr(source_agent_plan_id, 9, 1) = '-'
        AND substr(source_agent_plan_id, 14, 1) = '-'
        AND substr(source_agent_plan_id, 19, 1) = '-'
        AND substr(source_agent_plan_id, 24, 1) = '-'
        AND length(replace(source_agent_plan_id, '-', '')) = 32
        AND lower(replace(source_agent_plan_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
    source_agent_plan_reviewer_user_id: `text CONSTRAINT ck_approval_requests_source_agent_plan_reviewer CHECK (
      source_agent_plan_reviewer_user_id IS NULL OR (
        length(source_agent_plan_reviewer_user_id) = 36
        AND substr(source_agent_plan_reviewer_user_id, 9, 1) = '-'
        AND substr(source_agent_plan_reviewer_user_id, 14, 1) = '-'
        AND substr(source_agent_plan_reviewer_user_id, 19, 1) = '-'
        AND substr(source_agent_plan_reviewer_user_id, 24, 1) = '-'
        AND length(replace(source_agent_plan_reviewer_user_id, '-', '')) = 32
        AND lower(replace(source_agent_plan_reviewer_user_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
    comment: "text",
  });
  await ensureColumns(d1, "obligations", {
    workspace_id: `text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL`,
    version: "integer DEFAULT 1 NOT NULL",
    schedule_id: "text",
    occurrence_number: "integer",
    owner_user_id: "text",
    completed_by_user_id: "text",
    completed_at: "text",
    completion_evidence: "text",
    timezone: "text",
    reminder_lead_days: "text",
    next_reminder_date: "text",
    created_by_user_id: "text",
    created_at: "text",
  });
  await d1.prepare(`INSERT OR IGNORE INTO obligation_schedules (
      id, workspace_id, agreement_id, version, title, source,
      owner_user_id, owner, timezone, recurrence_unit, recurrence_interval,
      anchor_date, end_date, reminder_lead_days, status,
      next_occurrence_number, next_occurrence_date, next_materialization_date,
      supersedes_schedule_id, created_by_user_id, created_at, updated_by_user_id, updated_at
    )
    SELECT
      id, workspace_id, agreement_id, 1, title, source,
      owner_user_id, owner, 'Etc/UTC', 'once', 1,
      due_date, NULL, '[0]', 'ended',
      NULL, NULL, NULL,
      NULL, NULL, COALESCE(completed_at, CURRENT_TIMESTAMP), NULL, COALESCE(completed_at, CURRENT_TIMESTAMP)
    FROM obligations
    WHERE schedule_id IS NULL`).run();
  await d1.prepare(`UPDATE obligations
    SET schedule_id = id,
        occurrence_number = 1,
        timezone = 'Etc/UTC',
        reminder_lead_days = '[0]',
        next_reminder_date = CASE
          WHEN status = 'Open'
            AND length(due_date) = 10
            AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND date(due_date) = due_date
          THEN due_date
          ELSE NULL
        END,
        created_by_user_id = NULL,
        created_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
    WHERE schedule_id IS NULL`).run();
  await d1.prepare(`INSERT OR IGNORE INTO obligation_evidence (
      id, workspace_id, agreement_id, obligation_id, evidence_text,
      evidence_sha256, submitted_by_user_id, override_reason, provenance, created_at
    )
    SELECT id, workspace_id, agreement_id, id, completion_evidence,
      NULL, completed_by_user_id, NULL, 'legacy_v16', COALESCE(completed_at, CURRENT_TIMESTAMP)
    FROM obligations
    WHERE completion_evidence IS NOT NULL AND length(trim(completion_evidence)) > 0`).run();
  await ensureColumns(d1, "outbox_deliveries", {
    crm_provider: "text",
    crm_mapping_version: "text",
    crm_destination_fingerprint: "text",
  });
  await ensureColumns(d1, "agreement_events", {
    workspace_id: `text DEFAULT '${UNASSIGNED_WORKSPACE_ID}' NOT NULL`,
    actor_user_id: "text",
    actor_email: "text",
    previous_hash: "text",
    event_hash: "text",
    sequence: "integer DEFAULT 0 NOT NULL",
    source_agent_plan_id: `text CONSTRAINT ck_agreement_events_source_agent_plan_id CHECK (
      source_agent_plan_id IS NULL OR (
        length(source_agent_plan_id) = 36
        AND substr(source_agent_plan_id, 9, 1) = '-'
        AND substr(source_agent_plan_id, 14, 1) = '-'
        AND substr(source_agent_plan_id, 19, 1) = '-'
        AND substr(source_agent_plan_id, 24, 1) = '-'
        AND length(replace(source_agent_plan_id, '-', '')) = 32
        AND lower(replace(source_agent_plan_id, '-', '')) NOT GLOB '*[^0-9a-f]*'
      )
    )`,
  });
  await ensureColumns(d1, "signature_packets", {
    basis_hash: "text DEFAULT '' NOT NULL",
    document_version: "integer DEFAULT 0 NOT NULL",
    document_sha256: "text DEFAULT '' NOT NULL",
    active_key: "text",
  });
  if (priorSchemaMarker && priorSchemaMarker.version < 15) {
    // Local/evaluation compatibility mirrors migration 0015. Resetting risk
    // authority without superseding its approval rows would leave visibly
    // approved decisions attached to an intentionally unassessed record.
    await d1.batch([
      d1.prepare(`UPDATE agreements
        SET risk = 'Unassessed', risk_disposition = NULL, risk_basis_hash = NULL,
          risk_document_version = NULL, risk_document_sha256 = NULL,
          risk_decision_reason = NULL, risk_decided_by_user_id = NULL,
          risk_decided_at = NULL, approval_status = 'Required'
        WHERE stage <> 'Active' AND signature_status <> 'Completed'`),
      d1.prepare(`UPDATE approval_requests
        SET status = 'Superseded', version = version + 1
        WHERE status IN ('Pending', 'Approved', 'Changes requested')
          AND EXISTS (
            SELECT 1 FROM agreements
            WHERE agreements.workspace_id = approval_requests.workspace_id
              AND agreements.id = approval_requests.agreement_id
              AND agreements.stage <> 'Active'
              AND agreements.signature_status <> 'Completed'
          )`),
      d1.prepare(`UPDATE signature_packets
        SET status = 'superseded', active_key = NULL,
          updated_at = CURRENT_TIMESTAMP, version = version + 1
        WHERE active_key IS NOT NULL
          AND status IN ('creating', 'pending', 'partially_signed', 'reconciling', 'archived')`),
      d1.prepare(`UPDATE agreements
        SET signature_status = 'Not sent', stage = 'Review',
          next_action = 'Assess risk before approval and signature',
          version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE stage = 'Signature' AND signature_status <> 'Completed'`),
    ]);
  }
  await ensureColumns(d1, "webhook_receipts", {
    aggregate_type: "text",
    aggregate_id: "text",
  });

  // Local compatibility mirrors migration 0014: uniquely matchable legacy
  // DocuSeal receipts inherit the packet aggregate so evaluation-mode hard
  // purge does not retain provider identifiers after their agreement.
  await d1.prepare(`UPDATE webhook_receipts
    SET
      aggregate_type = 'signature_packet',
      aggregate_id = (
        SELECT min(legacy_signature_packet.id)
        FROM signature_packets AS legacy_signature_packet
        WHERE legacy_signature_packet.workspace_id = webhook_receipts.workspace_id
          AND legacy_signature_packet.provider = 'docuseal'
          AND legacy_signature_packet.submission_id = substr(
            webhook_receipts.provider_event_id,
            instr(webhook_receipts.provider_event_id, ':') + 1,
            instr(substr(webhook_receipts.provider_event_id, instr(webhook_receipts.provider_event_id, ':') + 1), ':') - 1
          )
      )
    WHERE provider = 'docuseal'
      AND provider_event_id IS NOT NULL
      AND aggregate_type IS NULL
      AND aggregate_id IS NULL
      AND instr(provider_event_id, ':') > 0
      AND instr(substr(provider_event_id, instr(provider_event_id, ':') + 1), ':') > 1
      AND 1 = (
        SELECT count(*)
        FROM signature_packets AS legacy_signature_packet
        WHERE legacy_signature_packet.workspace_id = webhook_receipts.workspace_id
          AND legacy_signature_packet.provider = 'docuseal'
          AND legacy_signature_packet.submission_id = substr(
            webhook_receipts.provider_event_id,
            instr(webhook_receipts.provider_event_id, ':') + 1,
            instr(substr(webhook_receipts.provider_event_id, instr(webhook_receipts.provider_event_id, ':') + 1), ':') - 1
          )
      )`).run();

  // Give pre-isolation events a stable sequence before enforcing one chain
  // position per agreement. New writers must allocate sequence server-side;
  // the unique index makes concurrent chain forks fail closed.
  await d1.prepare(`WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY workspace_id, agreement_id
      ORDER BY created_at, id
    ) AS sequence_number
    FROM agreement_events
  )
  UPDATE agreement_events
  SET sequence = (SELECT sequence_number FROM ranked WHERE ranked.id = agreement_events.id)
  WHERE sequence = 0`).run();

  await d1.batch([
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_slug ON workspaces(slug)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_purge_jobs_workspace_resource ON purge_jobs(workspace_id, resource_type, resource_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_purge_jobs_workspace_status_created_at ON purge_jobs(workspace_id, status, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_identity ON users(identity_provider, identity_subject)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user_status ON workspace_memberships(user_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_memberships_workspace_role ON workspace_memberships(workspace_id, role)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_events_workspace_sequence ON workspace_events(workspace_id, sequence)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_events_workspace_created_at ON workspace_events(workspace_id, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_groups_workspace_name ON workspace_groups(workspace_id, name)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_groups_workspace_external ON workspace_groups(workspace_id, external_provider, external_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_groups_workspace_status ON workspace_groups(workspace_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_workspace_group_members_workspace_user ON workspace_group_members(workspace_id, user_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_legal_entities_workspace_name ON legal_entities(workspace_id, legal_name)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_legal_entities_workspace_status ON legal_entities(workspace_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_counterparties_workspace_dedupe ON counterparties(workspace_id, dedupe_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_counterparties_workspace_status_name ON counterparties(workspace_id, status, display_name)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_counterparties_workspace_external ON counterparties(workspace_id, external_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_definitions_workspace_resource_key ON custom_field_definitions(workspace_id, resource_type, key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_custom_field_definitions_workspace_status ON custom_field_definitions(workspace_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_values_workspace_definition_resource ON custom_field_values(workspace_id, definition_id, resource_type, resource_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_custom_field_values_workspace_resource ON custom_field_values(workspace_id, resource_type, resource_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_governed_templates_workspace_name ON governed_templates(workspace_id, name)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_governed_templates_workspace_status ON governed_templates(workspace_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_governed_template_versions_workspace_template_version ON governed_template_versions(workspace_id, template_id, version)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_governed_template_versions_workspace_status ON governed_template_versions(workspace_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_governed_template_creation_receipts_workspace_template ON governed_template_creation_receipts(workspace_id, template_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_governed_template_creation_receipts_workspace_version ON governed_template_creation_receipts(workspace_id, template_version_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_governed_template_creation_receipts_workspace_created ON governed_template_creation_receipts(workspace_id, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_definitions_workspace_name_version ON workflow_definitions(workspace_id, name, version)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_workflow_definitions_workspace_name ON workflow_definitions(workspace_id, name)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_workflow_definitions_workspace_status ON workflow_definitions(workspace_id, status)"),
    d1.prepare("DROP INDEX IF EXISTS uq_approval_lane_authorities_workspace_lane_subject_currency"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_lane_authorities_active_identity ON approval_lane_authorities(workspace_id, lane, subject_type, subject_id, currency_code) WHERE status = 'active'"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_approval_lane_authorities_workspace_lane_status ON approval_lane_authorities(workspace_id, lane, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_intake_forms_workspace_name ON intake_forms(workspace_id, name)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_intake_forms_workspace_status ON intake_forms(workspace_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_intake_forms_workspace_template_version ON intake_forms(workspace_id, template_version_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_intake_submissions_workspace_status_updated ON intake_submissions(workspace_id, status, updated_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_intake_submissions_workspace_form ON intake_submissions(workspace_id, form_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_views_workspace_owner_resource_name ON saved_views(workspace_id, owner_user_id, resource_type, name)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_saved_views_workspace_resource_shared ON saved_views(workspace_id, resource_type, shared)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_integration_diagnostics_workspace_status ON integration_diagnostics(workspace_id, status)"),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS prevent_last_active_admin_update
      BEFORE UPDATE OF role, status ON workspace_memberships
      WHEN OLD.role = 'admin' AND OLD.status = 'active'
        AND (NEW.role <> 'admin' OR NEW.status <> 'active')
        AND (SELECT COUNT(*) FROM workspace_memberships
          WHERE workspace_id = OLD.workspace_id AND role = 'admin' AND status = 'active') <= 1
      BEGIN SELECT RAISE(ABORT, 'last_active_admin'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS prevent_last_active_admin_delete
      BEFORE DELETE ON workspace_memberships
      WHEN OLD.role = 'admin' AND OLD.status = 'active'
        AND (SELECT COUNT(*) FROM workspace_memberships
          WHERE workspace_id = OLD.workspace_id AND role = 'admin' AND status = 'active') <= 1
      BEGIN SELECT RAISE(ABORT, 'last_active_admin'); END`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_stage ON agreements(workspace_id, stage)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_owner ON agreements(workspace_id, owner)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_owner_user ON agreements(workspace_id, owner_user_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_counterparty ON agreements(workspace_id, primary_counterparty_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_legal_entity ON agreements(workspace_id, legal_entity_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_live_updated ON agreements(workspace_id, deleted_at, updated_at, id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_live_value ON agreements(workspace_id, deleted_at, value, id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_live_currency_value ON agreements(workspace_id, deleted_at, currency_code, value_minor, id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_workflow_policy ON agreements(workspace_id, workflow_definition_id, workflow_policy_sha256)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_workspace_live_risk ON agreements(workspace_id, deleted_at, risk, id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_stage ON agreements(stage)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_side ON agreements(side)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreements_owner ON agreements(owner)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_parties_workspace_agreement_role_target ON agreement_parties(workspace_id, agreement_id, role, legal_entity_id, counterparty_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_parties_workspace_agreement_role_primary ON agreement_parties(workspace_id, agreement_id, role) WHERE `primary` = 1"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_parties_legal_entity_identity ON agreement_parties(workspace_id, agreement_id, role, legal_entity_id) WHERE legal_entity_id IS NOT NULL"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_parties_counterparty_identity ON agreement_parties(workspace_id, agreement_id, role, counterparty_id) WHERE counterparty_id IS NOT NULL"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_parties_workspace_agreement ON agreement_parties(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_parties_workspace_counterparty ON agreement_parties(workspace_id, counterparty_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_parties_workspace_entity ON agreement_parties(workspace_id, legal_entity_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_relationships_workspace_source_target_type ON agreement_relationships(workspace_id, source_agreement_id, target_agreement_id, relationship_type)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_relationships_workspace_source ON agreement_relationships(workspace_id, source_agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_relationships_workspace_target ON agreement_relationships(workspace_id, target_agreement_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_creation_receipts_workspace_agreement ON agreement_creation_receipts(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_creation_receipts_workspace_created_at ON agreement_creation_receipts(workspace_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_documents_agreement_id ON documents(agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_documents_workspace_agreement_id ON documents(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_documents_workspace_scan_status ON documents(workspace_id, scan_status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_documents_workspace_role ON documents(workspace_id, role)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_documents_workspace_negotiation_round ON documents(workspace_id, negotiation_round_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_document_upload_receipts_workspace_document ON document_upload_receipts(workspace_id, document_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_document_upload_receipts_workspace_expiry ON document_upload_receipts(workspace_id, expires_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_negotiation_rounds_workspace_agreement_round ON negotiation_rounds(workspace_id, agreement_id, round_number)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_negotiation_rounds_workspace_active_key ON negotiation_rounds(workspace_id, active_key)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_negotiation_rounds_workspace_alias_code ON negotiation_rounds(workspace_id, alias_code)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_negotiation_rounds_workspace_portal_token_hash ON negotiation_rounds(workspace_id, portal_token_hash)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_negotiation_rounds_workspace_agreement_status ON negotiation_rounds(workspace_id, agreement_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_negotiation_rounds_workspace_updated_at ON negotiation_rounds(workspace_id, updated_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_negotiation_submissions_workspace_round_document ON negotiation_submissions(workspace_id, round_id, document_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_negotiation_submissions_workspace_agreement_round ON negotiation_submissions(workspace_id, agreement_id, round_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_negotiation_submissions_workspace_status_created_at ON negotiation_submissions(workspace_id, status, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_negotiation_submissions_workspace_provider_message ON negotiation_submissions(workspace_id, provider_message_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_document_comparisons_workspace_round_submission ON document_comparisons(workspace_id, round_id, submission_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_document_comparisons_workspace_agreement_round ON document_comparisons(workspace_id, agreement_id, round_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_document_comparisons_workspace_status_updated_at ON document_comparisons(workspace_id, status, updated_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_language_blocks_workspace ON language_blocks(workspace_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_approval_requests_agreement_id ON approval_requests(agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_status ON approval_requests(workspace_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_agreement_id ON approval_requests(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_source_agent_plan ON approval_requests(workspace_id, source_agent_plan_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_approval_requests_workspace_agent_plan_reviewer ON approval_requests(workspace_id, source_agent_plan_reviewer_user_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligations_status_due_date ON obligations(status, due_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligations_agreement_id ON obligations(agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligations_workspace_status_due_date ON obligations(workspace_id, status, due_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligations_workspace_agreement_id ON obligations(workspace_id, agreement_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_obligations_workspace_schedule_occurrence ON obligations(workspace_id, schedule_id, occurrence_number)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligations_workspace_status_next_reminder ON obligations(workspace_id, status, next_reminder_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligations_workspace_owner_status ON obligations(workspace_id, owner_user_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligation_schedules_workspace_agreement ON obligation_schedules(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligation_schedules_workspace_status_materialization ON obligation_schedules(workspace_id, status, next_materialization_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligation_schedules_workspace_owner_status ON obligation_schedules(workspace_id, owner_user_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_obligation_evidence_workspace_obligation ON obligation_evidence(workspace_id, obligation_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligation_evidence_workspace_agreement ON obligation_evidence(workspace_id, agreement_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_obligation_creation_receipts_workspace_schedule ON obligation_creation_receipts(workspace_id, schedule_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_obligation_creation_receipts_workspace_obligation ON obligation_creation_receipts(workspace_id, obligation_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligation_creation_receipts_workspace_agreement ON obligation_creation_receipts(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_obligation_creation_receipts_workspace_created_at ON obligation_creation_receipts(workspace_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_events_agreement_id_created_at ON agreement_events(agreement_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_events_workspace_agreement_created_at ON agreement_events(workspace_id, agreement_id, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_events_workspace_agreement_sequence ON agreement_events(workspace_id, agreement_id, sequence)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_events_workspace_source_agent_plan ON agreement_events(workspace_id, source_agent_plan_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_versions_workspace_agreement_version ON agreement_versions(workspace_id, agreement_id, version)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_versions_workspace_created_at ON agreement_versions(workspace_id, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agreement_document_versions_workspace_agreement_version ON agreement_document_versions(workspace_id, agreement_id, version)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agreement_document_versions_workspace_created_at ON agreement_document_versions(workspace_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_outbox_events_status_available_at ON outbox_events(status, available_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_outbox_events_workspace_created_at ON outbox_events(workspace_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_workspace_status_available_at ON outbox_deliveries(workspace_id, status, available_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_workspace_event ON outbox_deliveries(workspace_id, event_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_crm_legacy_cleanup_workspace_agreement ON crm_legacy_cleanup_attestations(workspace_id, agreement_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_packets_workspace_provider_external ON signature_packets(workspace_id, provider, external_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_signature_packets_workspace_active_key ON signature_packets(workspace_id, active_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_signature_packets_workspace_agreement ON signature_packets(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_signature_packets_workspace_status ON signature_packets(workspace_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_receipts_workspace_provider_event ON webhook_receipts(workspace_id, provider, provider_event_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_receipts_workspace_provider_digest ON webhook_receipts(workspace_id, provider, payload_digest)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_webhook_receipts_workspace_received_at ON webhook_receipts(workspace_id, received_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_webhook_receipts_workspace_aggregate ON webhook_receipts(workspace_id, aggregate_type, aggregate_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_service_principals_workspace_identity ON service_principals(workspace_id, issuer, subject)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_service_principals_workspace_status ON service_principals(workspace_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_grants_workspace_principal_status ON agent_grants(workspace_id, principal_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_grants_workspace_delegator ON agent_grants(workspace_id, delegator_user_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_grants_workspace_expiry ON agent_grants(workspace_id, expires_at)"),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS enforce_agent_grant_cap_insert_v15
      BEFORE INSERT ON agent_grants
      WHEN NEW.status = 'active'
        AND (SELECT count(*) FROM agent_grants
          WHERE workspace_id = NEW.workspace_id
            AND principal_id = NEW.principal_id
            AND status = 'active'
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) >= 50
      BEGIN SELECT RAISE(ABORT, 'agent_grant_limit_reached'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS enforce_agent_grant_cap_update_v15
      BEFORE UPDATE OF workspace_id, principal_id, status, expires_at ON agent_grants
      WHEN NEW.status = 'active'
        AND (SELECT count(*) FROM agent_grants
          WHERE workspace_id = NEW.workspace_id
            AND principal_id = NEW.principal_id
            AND status = 'active'
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND id <> OLD.id) >= 50
      BEGIN SELECT RAISE(ABORT, 'agent_grant_limit_reached'); END`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_principal_started ON agent_runs(workspace_id, principal_id, started_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_status ON agent_runs(workspace_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_action_plans_workspace_principal_status ON agent_action_plans(workspace_id, principal_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_action_plans_workspace_agreement ON agent_action_plans(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_action_plans_workspace_expires ON agent_action_plans(workspace_id, expires_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_plan_decisions_workspace_plan ON agent_plan_decisions(workspace_id, plan_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_plan_decisions_workspace_decided ON agent_plan_decisions(workspace_id, decided_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_action_executions_workspace_principal_key ON agent_action_executions(workspace_id, principal_id, idempotency_key_sha256)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_action_executions_workspace_plan ON agent_action_executions(workspace_id, plan_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_action_executions_workspace_started ON agent_action_executions(workspace_id, started_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_clause_playbooks_workspace_name ON clause_playbooks(workspace_id, name)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_clause_playbooks_workspace_status_updated ON clause_playbooks(workspace_id, status, updated_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_clause_playbook_versions_workspace_playbook_version ON clause_playbook_versions(workspace_id, playbook_id, version)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_clause_playbook_versions_workspace_playbook_status ON clause_playbook_versions(workspace_id, playbook_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_clause_playbook_creation_receipts_workspace_playbook ON clause_playbook_creation_receipts(workspace_id, playbook_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_clause_playbook_creation_receipts_workspace_version ON clause_playbook_creation_receipts(workspace_id, playbook_version_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_clause_playbook_creation_receipts_workspace_created ON clause_playbook_creation_receipts(workspace_id, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_ingestion_batches_workspace_user_key ON ingestion_batches(workspace_id, created_by_user_id, idempotency_key_sha256)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_ingestion_batches_workspace_status_updated ON ingestion_batches(workspace_id, status, updated_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_ingestion_items_workspace_batch_ordinal ON ingestion_items(workspace_id, batch_id, ordinal)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_ingestion_items_workspace_batch_status ON ingestion_items(workspace_id, batch_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_ingestion_items_workspace_dedupe ON ingestion_items(workspace_id, dedupe_sha256)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_repository_fragments_workspace_source_ordinal ON repository_fragments(workspace_id, document_version_id, source_text_sha256, ordinal)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_repository_fragments_workspace_document ON repository_fragments(workspace_id, document_version_id, document_version)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_repository_fragments_workspace_agreement ON repository_fragments(workspace_id, agreement_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_repository_fragments_workspace_created ON repository_fragments(workspace_id, created_at, id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_extraction_proposals_workspace_status_updated ON extraction_proposals(workspace_id, status, updated_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_extraction_proposals_workspace_document ON extraction_proposals(workspace_id, document_version_id, document_version)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_extraction_proposals_workspace_agreement ON extraction_proposals(workspace_id, agreement_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_extraction_proposal_citations_workspace_proposal_fragment_offsets ON extraction_proposal_citations(workspace_id, proposal_id, fragment_id, start_offset, end_offset)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_extraction_proposal_citations_workspace_proposal ON extraction_proposal_citations(workspace_id, proposal_id)"),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agent_action_plan_agreement_insert_v15
      BEFORE INSERT ON agent_action_plans
      WHEN (NEW.resource_type = 'agreement' AND (
        NEW.agreement_id IS NULL
        OR NEW.resource_id <> CAST(NEW.agreement_id AS text)
        OR NOT EXISTS (
          SELECT 1 FROM agreements
          WHERE workspace_id = NEW.workspace_id
            AND id = NEW.agreement_id
        )
      )) OR (NEW.resource_type <> 'agreement' AND NEW.agreement_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'agent_plan_agreement_missing_or_mismatched'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agent_action_plan_agreement_update_v15
      BEFORE UPDATE OF workspace_id, resource_type, resource_id, agreement_id ON agent_action_plans
      WHEN (NEW.resource_type = 'agreement' AND (
        NEW.agreement_id IS NULL
        OR NEW.resource_id <> CAST(NEW.agreement_id AS text)
        OR NOT EXISTS (
          SELECT 1 FROM agreements
          WHERE workspace_id = NEW.workspace_id
            AND id = NEW.agreement_id
        )
      )) OR (NEW.resource_type <> 'agreement' AND NEW.agreement_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'agent_plan_agreement_missing_or_mismatched'); END`),
    d1.prepare("DROP TRIGGER IF EXISTS purge_agent_action_evidence_before_agreement_delete_v15"),
    d1.prepare("DROP TRIGGER IF EXISTS purge_agent_action_evidence_before_agreement_delete_v16"),
    d1.prepare(`CREATE TRIGGER purge_agent_action_evidence_before_agreement_delete_v16
      BEFORE DELETE ON agreements
      BEGIN
        UPDATE agent_runs
        SET purpose = 'Retention-purged agreement run',
          model_provider = NULL,
          model_id = NULL,
          tool_version = 'retention-redacted',
          prompt_sha256 = NULL,
          context_sha256 = NULL
        WHERE workspace_id = OLD.workspace_id
          AND id IN (
            SELECT run_id FROM agent_action_plans
            WHERE workspace_id = OLD.workspace_id
              AND agreement_id = OLD.id
              AND run_id IS NOT NULL
          );
        DELETE FROM agent_action_executions
        WHERE workspace_id = OLD.workspace_id
          AND plan_id IN (
            SELECT id FROM agent_action_plans
            WHERE workspace_id = OLD.workspace_id
              AND agreement_id = OLD.id
          );
        DELETE FROM agent_plan_decisions
        WHERE workspace_id = OLD.workspace_id
          AND plan_id IN (
            SELECT id FROM agent_action_plans
            WHERE workspace_id = OLD.workspace_id
              AND agreement_id = OLD.id
          );
        DELETE FROM agent_action_plans
        WHERE workspace_id = OLD.workspace_id
          AND agreement_id = OLD.id;
      END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS normalize_unassessed_risk_insert
      AFTER INSERT ON agreements
      WHEN NEW.risk_disposition IS NULL AND NEW.risk <> 'Unassessed'
      BEGIN UPDATE agreements SET risk = 'Unassessed' WHERE id = NEW.id; END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_risk_insert
      BEFORE INSERT ON agreements
      WHEN NEW.risk NOT IN ('Unassessed', 'Low', 'Medium', 'High')
        OR NEW.risk_disposition NOT IN ('assessed', 'waived') AND NEW.risk_disposition IS NOT NULL
        OR NEW.risk_disposition IS NULL AND (NEW.risk_basis_hash IS NOT NULL OR NEW.risk_document_version IS NOT NULL OR NEW.risk_document_sha256 IS NOT NULL)
        OR NEW.risk_disposition IS NOT NULL AND (NEW.risk_basis_hash IS NULL OR length(NEW.risk_basis_hash) <> 64 OR NEW.risk_document_version IS NULL OR NEW.risk_document_version <= 0 OR NEW.risk_document_sha256 IS NULL OR length(NEW.risk_document_sha256) <> 64)
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_risk'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_risk_update
      BEFORE UPDATE OF risk, risk_disposition, risk_basis_hash, risk_document_version, risk_document_sha256 ON agreements
      WHEN NEW.risk NOT IN ('Unassessed', 'Low', 'Medium', 'High')
        OR NEW.risk_disposition NOT IN ('assessed', 'waived') AND NEW.risk_disposition IS NOT NULL
        OR NEW.risk_disposition IS NULL AND (NEW.risk_basis_hash IS NOT NULL OR NEW.risk_document_version IS NOT NULL OR NEW.risk_document_sha256 IS NOT NULL)
        OR NEW.risk_disposition IS NOT NULL AND (NEW.risk_basis_hash IS NULL OR length(NEW.risk_basis_hash) <> 64 OR NEW.risk_document_version IS NULL OR NEW.risk_document_version <= 0 OR NEW.risk_document_sha256 IS NULL OR length(NEW.risk_document_sha256) <> 64)
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_risk'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_risk_evidence_insert_v15
      BEFORE INSERT ON agreements
      WHEN NEW.risk_disposition = 'assessed' AND NEW.risk NOT IN ('Low', 'Medium', 'High')
        OR NEW.risk_disposition = 'waived' AND NEW.risk <> 'Unassessed'
        OR NEW.risk_disposition IS NULL AND (NEW.risk_decision_reason IS NOT NULL OR NEW.risk_decided_by_user_id IS NOT NULL OR NEW.risk_decided_at IS NOT NULL)
        OR NEW.risk_disposition IS NOT NULL AND (length(trim(coalesce(NEW.risk_decision_reason, ''))) = 0 OR length(trim(coalesce(NEW.risk_decided_by_user_id, ''))) = 0 OR NEW.risk_decided_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_risk_evidence'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_risk_evidence_update_v15
      BEFORE UPDATE OF risk, risk_disposition, risk_basis_hash, risk_document_version, risk_document_sha256, risk_decision_reason, risk_decided_by_user_id, risk_decided_at ON agreements
      WHEN NEW.risk_disposition IS NULL AND NEW.risk <> 'Unassessed'
        OR NEW.risk_disposition = 'assessed' AND NEW.risk NOT IN ('Low', 'Medium', 'High')
        OR NEW.risk_disposition = 'waived' AND NEW.risk <> 'Unassessed'
        OR NEW.risk_disposition IS NULL AND (NEW.risk_decision_reason IS NOT NULL OR NEW.risk_decided_by_user_id IS NOT NULL OR NEW.risk_decided_at IS NOT NULL)
        OR NEW.risk_disposition IS NOT NULL AND (length(trim(coalesce(NEW.risk_decision_reason, ''))) = 0 OR length(trim(coalesce(NEW.risk_decided_by_user_id, ''))) = 0 OR NEW.risk_decided_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_risk_evidence'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_approval_decision_evidence_insert_v15
      BEFORE INSERT ON approval_requests
      WHEN NEW.status NOT IN ('Pending', 'Approved', 'Changes requested', 'Superseded')
        OR NEW.status = 'Pending' AND (NEW.decided_by_user_id IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.basis_confirmed_at IS NOT NULL)
        OR NEW.status IN ('Approved', 'Changes requested') AND (length(trim(NEW.requested_by_user_id)) = 0 OR NEW.decided_by_user_id IS NULL OR NEW.decided_at IS NULL OR NEW.basis_confirmed_at IS NULL OR length(NEW.basis_hash) <> 64 OR NEW.document_version <= 0 OR length(NEW.document_sha256) <> 64)
        OR NEW.status = 'Changes requested' AND length(trim(coalesce(NEW.comment, ''))) = 0
      BEGIN SELECT RAISE(ABORT, 'invalid_approval_decision_evidence'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_approval_decision_evidence_update_v15
      BEFORE UPDATE OF status, decided_by_user_id, decided_at, basis_confirmed_at, comment, basis_hash, document_version, document_sha256 ON approval_requests
      WHEN NEW.status NOT IN ('Pending', 'Approved', 'Changes requested', 'Superseded')
        OR NEW.status = 'Pending' AND (NEW.decided_by_user_id IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.basis_confirmed_at IS NOT NULL)
        OR NEW.status IN ('Approved', 'Changes requested') AND (length(trim(NEW.requested_by_user_id)) = 0 OR NEW.decided_by_user_id IS NULL OR NEW.decided_at IS NULL OR NEW.basis_confirmed_at IS NULL OR length(NEW.basis_hash) <> 64 OR NEW.document_version <= 0 OR length(NEW.document_sha256) <> 64)
        OR NEW.status = 'Changes requested' AND length(trim(coalesce(NEW.comment, ''))) = 0
      BEGIN SELECT RAISE(ABORT, 'invalid_approval_decision_evidence'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_obligation_schedule_reminders_insert_v17
      BEFORE INSERT ON obligation_schedules
      WHEN EXISTS (SELECT 1 FROM json_each(NEW.reminder_lead_days)
        WHERE type <> 'integer' OR value < 0 OR value > 365)
      BEGIN SELECT RAISE(ABORT, 'invalid_obligation_reminder_days'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_obligation_schedule_reminders_update_v17
      BEFORE UPDATE OF reminder_lead_days ON obligation_schedules
      WHEN EXISTS (SELECT 1 FROM json_each(NEW.reminder_lead_days)
        WHERE type <> 'integer' OR value < 0 OR value > 365)
      BEGIN SELECT RAISE(ABORT, 'invalid_obligation_reminder_days'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_obligation_schedule_rule_v17
      BEFORE UPDATE OF agreement_id, title, source, timezone, recurrence_unit, recurrence_interval, anchor_date, end_date, reminder_lead_days, supersedes_schedule_id, created_by_user_id, created_at
      ON obligation_schedules
      BEGIN SELECT RAISE(ABORT, 'immutable_obligation_schedule_rule'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_obligation_occurrence_insert_v17
      BEFORE INSERT ON obligations
      WHEN NEW.schedule_id IS NULL
        OR NEW.occurrence_number IS NULL
        OR NEW.occurrence_number < 1
        OR NEW.timezone IS NULL
        OR NEW.reminder_lead_days IS NULL
        OR json_valid(NEW.reminder_lead_days) <> 1
        OR json_type(NEW.reminder_lead_days) <> 'array'
        OR json_array_length(NEW.reminder_lead_days) NOT BETWEEN 1 AND 8
        OR length(NEW.reminder_lead_days) NOT BETWEEN 3 AND 128
        OR NEW.created_at IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM obligation_schedules AS occurrence_schedule
          WHERE occurrence_schedule.id = NEW.schedule_id
            AND occurrence_schedule.workspace_id = NEW.workspace_id
            AND occurrence_schedule.agreement_id = NEW.agreement_id
        )
        OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.reminder_lead_days) THEN NEW.reminder_lead_days ELSE '[]' END)
          WHERE type <> 'integer' OR value < 0 OR value > 365)
      BEGIN SELECT RAISE(ABORT, 'invalid_obligation_occurrence'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_obligation_occurrence_terms_v17
      BEFORE UPDATE OF schedule_id, occurrence_number, agreement_id, title, due_date, cadence, source, timezone, reminder_lead_days, created_by_user_id, created_at
      ON obligations
      BEGIN SELECT RAISE(ABORT, 'immutable_obligation_occurrence_terms'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_completed_obligation_v17
      BEFORE UPDATE OF status, completed_by_user_id, completed_at, completion_evidence
      ON obligations
      WHEN OLD.status = 'Complete' AND (
        NEW.status IS NOT OLD.status
        OR NEW.completed_by_user_id IS NOT OLD.completed_by_user_id
        OR NEW.completed_at IS NOT OLD.completed_at
        OR NEW.completion_evidence IS NOT OLD.completion_evidence
      )
      BEGIN SELECT RAISE(ABORT, 'immutable_completed_obligation'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_obligation_evidence_insert_v17
      BEFORE INSERT ON obligation_evidence
      WHEN length(trim(NEW.evidence_text)) = 0
        OR NEW.created_at IS NULL
        OR (NEW.provenance = 'native' AND NEW.submitted_by_user_id IS NULL)
        OR NOT EXISTS (
          SELECT 1 FROM obligations AS evidence_occurrence
          WHERE evidence_occurrence.workspace_id = NEW.workspace_id
            AND evidence_occurrence.agreement_id = NEW.agreement_id
            AND evidence_occurrence.id = NEW.obligation_id
            AND evidence_occurrence.status = 'Complete'
            AND evidence_occurrence.completion_evidence = NEW.evidence_text
            AND (NEW.provenance <> 'native' OR evidence_occurrence.completed_by_user_id = NEW.submitted_by_user_id)
        )
      BEGIN SELECT RAISE(ABORT, 'invalid_obligation_evidence'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_obligation_evidence_update_v17
      BEFORE UPDATE ON obligation_evidence
      BEGIN SELECT RAISE(ABORT, 'immutable_obligation_evidence'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS protect_active_obligation_evidence_delete_v17
      BEFORE DELETE ON obligation_evidence
      WHEN EXISTS (
        SELECT 1 FROM agreements AS evidence_parent
        WHERE evidence_parent.workspace_id = OLD.workspace_id
          AND evidence_parent.id = OLD.agreement_id
          AND evidence_parent.deleted_at IS NULL
      )
      BEGIN SELECT RAISE(ABORT, 'active_obligation_evidence_immutable'); END`),
    d1.prepare("DROP TRIGGER IF EXISTS validate_agreement_enterprise_fields_insert_v18"),
    d1.prepare(`CREATE TRIGGER validate_agreement_enterprise_fields_insert_v18
      BEFORE INSERT ON agreements
      WHEN NEW.value_minor < 0
        OR length(NEW.currency_code) <> 3
        OR NEW.currency_code <> upper(NEW.currency_code)
        OR (NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workspace_memberships AS owner_membership
          JOIN users AS owner_user ON owner_user.id = owner_membership.user_id
          WHERE owner_membership.workspace_id = NEW.workspace_id
            AND owner_membership.user_id = NEW.owner_user_id
            AND owner_membership.status = 'active' AND owner_user.status = 'active'
        ))
        OR (NEW.primary_counterparty_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM counterparties WHERE workspace_id = NEW.workspace_id
            AND id = NEW.primary_counterparty_id AND status = 'active'
        ))
        OR (NEW.legal_entity_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM legal_entities WHERE workspace_id = NEW.workspace_id
            AND id = NEW.legal_entity_id AND status = 'active'
        ))
        OR (NEW.governed_template_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM governed_template_versions AS selected_version
          JOIN governed_templates AS selected_template
            ON selected_template.workspace_id = selected_version.workspace_id
            AND selected_template.id = selected_version.template_id
          WHERE selected_version.workspace_id = NEW.workspace_id
            AND selected_version.id = NEW.governed_template_version_id
            AND selected_version.status = 'published'
            AND selected_template.status = 'published'
            AND selected_template.current_published_version = selected_version.version
        ) AND NOT EXISTS (
          SELECT 1 FROM intake_submissions AS converted_submission
          JOIN intake_forms AS pinned_form
            ON pinned_form.workspace_id = converted_submission.workspace_id
            AND pinned_form.id = converted_submission.form_id
            AND pinned_form.version = converted_submission.form_version
          JOIN governed_template_versions AS pinned_version
            ON pinned_version.workspace_id = pinned_form.workspace_id
            AND pinned_version.id = pinned_form.template_version_id
          JOIN governed_templates AS pinned_template
            ON pinned_template.workspace_id = pinned_version.workspace_id
            AND pinned_template.id = pinned_version.template_id
          WHERE converted_submission.workspace_id = NEW.workspace_id
            AND converted_submission.agreement_id = NEW.id
            AND converted_submission.status = 'converted'
            AND pinned_form.status = 'published'
            AND pinned_form.template_version_id = NEW.governed_template_version_id
            AND pinned_version.status = 'published'
            AND pinned_template.status = 'published'
        ))
        OR (NEW.workflow_definition_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workflow_definitions WHERE workspace_id = NEW.workspace_id
            AND id = NEW.workflow_definition_id AND status = 'published'
        ))
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_enterprise_fields'); END`),
    d1.prepare("DROP TRIGGER IF EXISTS validate_agreement_enterprise_fields_update_v18"),
    d1.prepare(`CREATE TRIGGER validate_agreement_enterprise_fields_update_v18
      BEFORE UPDATE OF value_minor, currency_code, owner_user_id, primary_counterparty_id, legal_entity_id, governed_template_version_id, workflow_definition_id, workspace_id ON agreements
      WHEN NEW.value_minor < 0
        OR length(NEW.currency_code) <> 3
        OR NEW.currency_code <> upper(NEW.currency_code)
        OR ((NEW.workspace_id IS NOT OLD.workspace_id OR NEW.owner_user_id IS NOT OLD.owner_user_id)
          AND NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workspace_memberships AS owner_membership
          JOIN users AS owner_user ON owner_user.id = owner_membership.user_id
          WHERE owner_membership.workspace_id = NEW.workspace_id
            AND owner_membership.user_id = NEW.owner_user_id
            AND owner_membership.status = 'active' AND owner_user.status = 'active'
        ))
        OR ((NEW.workspace_id IS NOT OLD.workspace_id OR NEW.primary_counterparty_id IS NOT OLD.primary_counterparty_id)
          AND NEW.primary_counterparty_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM counterparties WHERE workspace_id = NEW.workspace_id
            AND id = NEW.primary_counterparty_id AND status = 'active'
        ))
        OR ((NEW.workspace_id IS NOT OLD.workspace_id OR NEW.legal_entity_id IS NOT OLD.legal_entity_id)
          AND NEW.legal_entity_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM legal_entities WHERE workspace_id = NEW.workspace_id
            AND id = NEW.legal_entity_id AND status = 'active'
        ))
        OR ((NEW.workspace_id IS NOT OLD.workspace_id OR NEW.governed_template_version_id IS NOT OLD.governed_template_version_id)
          AND NEW.governed_template_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM governed_template_versions AS selected_version
          JOIN governed_templates AS selected_template
            ON selected_template.workspace_id = selected_version.workspace_id
            AND selected_template.id = selected_version.template_id
          WHERE selected_version.workspace_id = NEW.workspace_id
            AND selected_version.id = NEW.governed_template_version_id
            AND selected_version.status = 'published'
            AND selected_template.status = 'published'
            AND selected_template.current_published_version = selected_version.version
        ))
        OR ((NEW.workspace_id IS NOT OLD.workspace_id OR NEW.workflow_definition_id IS NOT OLD.workflow_definition_id)
          AND NEW.workflow_definition_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workflow_definitions WHERE workspace_id = NEW.workspace_id
            AND id = NEW.workflow_definition_id AND status = 'published'
        ))
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_enterprise_fields'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_party_scope_insert_v18
      BEFORE INSERT ON agreement_parties
      WHEN NOT EXISTS (SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND id = NEW.agreement_id AND deleted_at IS NULL)
        OR (NEW.legal_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM legal_entities WHERE workspace_id = NEW.workspace_id AND id = NEW.legal_entity_id AND status = 'active'))
        OR (NEW.counterparty_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM counterparties WHERE workspace_id = NEW.workspace_id AND id = NEW.counterparty_id AND status = 'active'))
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_party_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_agreement_party_identity_v18
      BEFORE UPDATE OF workspace_id, agreement_id, role, legal_entity_id, counterparty_id, created_by_user_id, created_at ON agreement_parties
      BEGIN SELECT RAISE(ABORT, 'immutable_agreement_party_identity'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_party_scope_update_v19
      BEFORE UPDATE ON agreement_parties
      WHEN NOT EXISTS (SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND id = NEW.agreement_id AND deleted_at IS NULL)
        OR (NEW.legal_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM legal_entities WHERE workspace_id = NEW.workspace_id AND id = NEW.legal_entity_id AND status = 'active'))
        OR (NEW.counterparty_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM counterparties WHERE workspace_id = NEW.workspace_id AND id = NEW.counterparty_id AND status = 'active'))
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_party_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_relationship_scope_insert_v18
      BEFORE INSERT ON agreement_relationships
      WHEN NOT EXISTS (SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND id = NEW.source_agreement_id AND deleted_at IS NULL)
        OR NOT EXISTS (SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND id = NEW.target_agreement_id AND deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_relationship_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_agreement_relationship_v18
      BEFORE UPDATE ON agreement_relationships
      BEGIN SELECT RAISE(ABORT, 'immutable_agreement_relationship'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_workspace_group_member_scope_insert_v18
      BEFORE INSERT ON workspace_group_members
      WHEN NOT EXISTS (SELECT 1 FROM workspace_groups WHERE workspace_id = NEW.workspace_id AND id = NEW.group_id AND status = 'active')
        OR NOT EXISTS (
          SELECT 1 FROM workspace_memberships AS group_membership
          JOIN users AS group_user ON group_user.id = group_membership.user_id
          WHERE group_membership.workspace_id = NEW.workspace_id AND group_membership.user_id = NEW.user_id
            AND group_membership.status = 'active' AND group_user.status = 'active'
        )
      BEGIN SELECT RAISE(ABORT, 'invalid_workspace_group_member_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_custom_field_value_insert_v18
      BEFORE INSERT ON custom_field_values
      WHEN NOT EXISTS (
        SELECT 1 FROM custom_field_definitions WHERE workspace_id = NEW.workspace_id
          AND id = NEW.definition_id AND resource_type = NEW.resource_type AND status = 'active'
      ) OR NOT (
        (NEW.resource_type = 'agreement' AND EXISTS (SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND CAST(id AS TEXT) = NEW.resource_id AND deleted_at IS NULL))
        OR (NEW.resource_type = 'counterparty' AND EXISTS (SELECT 1 FROM counterparties WHERE workspace_id = NEW.workspace_id AND id = NEW.resource_id AND status = 'active'))
        OR (NEW.resource_type = 'legal_entity' AND EXISTS (SELECT 1 FROM legal_entities WHERE workspace_id = NEW.workspace_id AND id = NEW.resource_id AND status = 'active'))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_custom_field_value_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_custom_field_value_update_v18
      BEFORE UPDATE ON custom_field_values
      WHEN NOT EXISTS (
        SELECT 1 FROM custom_field_definitions WHERE workspace_id = NEW.workspace_id
          AND id = NEW.definition_id AND resource_type = NEW.resource_type AND status = 'active'
      ) OR NOT (
        (NEW.resource_type = 'agreement' AND EXISTS (SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND CAST(id AS TEXT) = NEW.resource_id AND deleted_at IS NULL))
        OR (NEW.resource_type = 'counterparty' AND EXISTS (SELECT 1 FROM counterparties WHERE workspace_id = NEW.workspace_id AND id = NEW.resource_id AND status = 'active'))
        OR (NEW.resource_type = 'legal_entity' AND EXISTS (SELECT 1 FROM legal_entities WHERE workspace_id = NEW.workspace_id AND id = NEW.resource_id AND status = 'active'))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_custom_field_value_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_custom_field_value_identity_v18
      BEFORE UPDATE OF workspace_id, definition_id, resource_type, resource_id ON custom_field_values
      BEGIN SELECT RAISE(ABORT, 'immutable_custom_field_value_identity'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_template_version_scope_insert_v18
      BEFORE INSERT ON governed_template_versions
      WHEN NOT EXISTS (SELECT 1 FROM governed_templates WHERE workspace_id = NEW.workspace_id AND id = NEW.template_id AND status <> 'retired')
      BEGIN SELECT RAISE(ABORT, 'invalid_template_version_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_published_template_version_v18
      BEFORE UPDATE ON governed_template_versions WHEN OLD.status IN ('published', 'retired')
      BEGIN SELECT RAISE(ABORT, 'immutable_published_template_version'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_published_workflow_definition_v18
      BEFORE UPDATE OF name, description, definition, definition_sha256, created_by_user_id, created_at ON workflow_definitions
      WHEN OLD.status IN ('published', 'retired')
      BEGIN SELECT RAISE(ABORT, 'immutable_published_workflow_definition'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_approval_lane_authority_insert_v18
      BEFORE INSERT ON approval_lane_authorities
      WHEN (NEW.subject_type = 'user' AND NOT EXISTS (
        SELECT 1 FROM workspace_memberships AS authority_membership
        JOIN users AS authority_user ON authority_user.id = authority_membership.user_id
        WHERE authority_membership.workspace_id = NEW.workspace_id AND authority_membership.user_id = NEW.subject_id
          AND authority_membership.status = 'active' AND authority_user.status = 'active'
      )) OR (NEW.subject_type = 'group' AND NOT EXISTS (
        SELECT 1 FROM workspace_groups WHERE workspace_id = NEW.workspace_id AND id = NEW.subject_id AND status = 'active'
      ))
      BEGIN SELECT RAISE(ABORT, 'invalid_approval_lane_authority_subject'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_approval_lane_authority_identity_v18
      BEFORE UPDATE OF workspace_id, lane, subject_type, subject_id ON approval_lane_authorities
      BEGIN SELECT RAISE(ABORT, 'immutable_approval_lane_authority_identity'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS prevent_disable_group_with_active_authority_v19
      BEFORE UPDATE OF status ON workspace_groups
      WHEN NEW.status = 'disabled' AND EXISTS (
        SELECT 1 FROM approval_lane_authorities
        WHERE workspace_id = NEW.workspace_id AND subject_type = 'group'
          AND subject_id = NEW.id AND status = 'active'
      )
      BEGIN SELECT RAISE(ABORT, 'group_has_active_authority'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_intake_form_scope_insert_v18
      BEFORE INSERT ON intake_forms
      WHEN (NEW.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM governed_templates WHERE workspace_id = NEW.workspace_id AND id = NEW.template_id AND status <> 'retired'))
        OR (NEW.workflow_definition_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_definition_id AND status = 'published'))
      BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_intake_form_scope_update_v18
      BEFORE UPDATE ON intake_forms
      WHEN (NEW.template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM governed_templates WHERE workspace_id = NEW.workspace_id AND id = NEW.template_id AND status <> 'retired'))
        OR (NEW.workflow_definition_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_definition_id AND status = 'published'))
      BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_intake_form_workspace_v18
      BEFORE UPDATE OF workspace_id ON intake_forms
      BEGIN SELECT RAISE(ABORT, 'immutable_intake_form_workspace'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_intake_submission_scope_insert_v18
      BEFORE INSERT ON intake_submissions
      WHEN NOT EXISTS (SELECT 1 FROM intake_forms WHERE workspace_id = NEW.workspace_id AND id = NEW.form_id AND version = NEW.form_version AND status = 'published')
        OR NOT EXISTS (SELECT 1 FROM workspace_memberships WHERE workspace_id = NEW.workspace_id AND user_id = NEW.submitted_by_user_id AND status = 'active')
      BEGIN SELECT RAISE(ABORT, 'invalid_intake_submission_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_clause_playbook_version_scope_insert_v19
      BEFORE INSERT ON clause_playbook_versions
      WHEN NOT EXISTS (SELECT 1 FROM clause_playbooks WHERE workspace_id = NEW.workspace_id AND id = NEW.playbook_id AND status <> 'retired')
      BEGIN SELECT RAISE(ABORT, 'invalid_clause_playbook_version_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_published_clause_playbook_version_v19
      BEFORE UPDATE ON clause_playbook_versions WHEN OLD.status = 'published'
      BEGIN SELECT RAISE(ABORT, 'immutable_published_clause_playbook_version'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_clause_playbook_lifecycle_v19
      BEFORE UPDATE OF status, current_published_version ON clause_playbooks
      WHEN OLD.status = 'retired'
        OR (NEW.status = 'draft' AND OLD.status <> 'draft')
        OR (NEW.status = 'retired' AND OLD.status <> 'published')
        OR (OLD.status = 'published' AND NEW.status = 'published'
          AND NEW.current_published_version <= OLD.current_published_version)
        OR (NEW.status IN ('published', 'retired') AND NOT EXISTS (
          SELECT 1 FROM clause_playbook_versions WHERE workspace_id = NEW.workspace_id AND playbook_id = NEW.id
            AND version = NEW.current_published_version AND status = 'published'
        ))
      BEGIN SELECT RAISE(ABORT, 'invalid_clause_playbook_lifecycle'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_clause_playbook_scope_v19
      BEFORE UPDATE OF scope ON clause_playbooks
      WHEN NEW.scope <> OLD.scope AND EXISTS (
        SELECT 1 FROM clause_playbook_versions
        WHERE workspace_id = OLD.workspace_id AND playbook_id = OLD.id
      )
      BEGIN SELECT RAISE(ABORT, 'immutable_clause_playbook_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_template_pin_insert_v19
      BEFORE INSERT ON agreements
      WHEN NEW.governed_template_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_template_versions AS selected_version
        JOIN governed_templates AS selected_template
          ON selected_template.workspace_id = selected_version.workspace_id
          AND selected_template.id = selected_version.template_id
        WHERE selected_version.workspace_id = NEW.workspace_id
          AND selected_version.id = NEW.governed_template_version_id
          AND selected_version.status = 'published'
          AND selected_template.status = 'published'
          AND selected_template.current_published_version = selected_version.version
      )
      AND NOT EXISTS (
        SELECT 1 FROM intake_submissions AS converted_submission
        JOIN intake_forms AS pinned_form
          ON pinned_form.workspace_id = converted_submission.workspace_id
          AND pinned_form.id = converted_submission.form_id
          AND pinned_form.version = converted_submission.form_version
        JOIN governed_template_versions AS pinned_version
          ON pinned_version.workspace_id = pinned_form.workspace_id
          AND pinned_version.id = pinned_form.template_version_id
        JOIN governed_templates AS pinned_template
          ON pinned_template.workspace_id = pinned_version.workspace_id
          AND pinned_template.id = pinned_version.template_id
        WHERE converted_submission.workspace_id = NEW.workspace_id
          AND converted_submission.agreement_id = NEW.id
          AND converted_submission.status = 'converted'
          AND pinned_form.status = 'published'
          AND pinned_form.template_version_id = NEW.governed_template_version_id
          AND pinned_version.status = 'published'
          AND pinned_template.status = 'published'
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_template_pin'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_template_pin_update_v19
      BEFORE UPDATE OF workspace_id, governed_template_version_id ON agreements
      WHEN (NEW.workspace_id IS NOT OLD.workspace_id
          OR NEW.governed_template_version_id IS NOT OLD.governed_template_version_id)
        AND NEW.governed_template_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_template_versions AS selected_version
        JOIN governed_templates AS selected_template
          ON selected_template.workspace_id = selected_version.workspace_id
          AND selected_template.id = selected_version.template_id
        WHERE selected_version.workspace_id = NEW.workspace_id
          AND selected_version.id = NEW.governed_template_version_id
          AND selected_version.status = 'published'
          AND selected_template.status = 'published'
          AND selected_template.current_published_version = selected_version.version
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_template_pin'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_custom_field_counterparty_active_insert_v19
      BEFORE INSERT ON custom_field_values
      WHEN NEW.resource_type = 'counterparty' AND NOT EXISTS (
        SELECT 1 FROM counterparties
        WHERE workspace_id = NEW.workspace_id
          AND id = NEW.resource_id
          AND status = 'active'
      )
      BEGIN SELECT RAISE(ABORT, 'inactive_custom_field_counterparty'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_custom_field_counterparty_active_update_v19
      BEFORE UPDATE ON custom_field_values
      WHEN NEW.resource_type = 'counterparty' AND NOT EXISTS (
        SELECT 1 FROM counterparties
        WHERE workspace_id = NEW.workspace_id
          AND id = NEW.resource_id
          AND status = 'active'
      )
      BEGIN SELECT RAISE(ABORT, 'inactive_custom_field_counterparty'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_published_intake_template_current_insert_v19
      BEFORE INSERT ON intake_forms
      WHEN NEW.status = 'published' AND NEW.template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_template_versions AS selected_version
        JOIN governed_templates AS selected_template
          ON selected_template.workspace_id = selected_version.workspace_id
          AND selected_template.id = selected_version.template_id
        WHERE selected_version.workspace_id = NEW.workspace_id
          AND selected_version.id = NEW.template_version_id
          AND selected_version.template_id = NEW.template_id
          AND selected_version.status = 'published'
          AND selected_template.status = 'published'
          AND selected_template.current_published_version = selected_version.version
      )
      BEGIN SELECT RAISE(ABORT, 'intake_template_version_not_current'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_published_intake_template_current_update_v19
      BEFORE UPDATE ON intake_forms
      WHEN NEW.status = 'published'
        AND (OLD.status <> 'published' OR NEW.template_id IS NOT OLD.template_id OR NEW.template_version_id IS NOT OLD.template_version_id)
        AND NEW.template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM governed_template_versions AS selected_version
        JOIN governed_templates AS selected_template
          ON selected_template.workspace_id = selected_version.workspace_id
          AND selected_template.id = selected_version.template_id
        WHERE selected_version.workspace_id = NEW.workspace_id
          AND selected_version.id = NEW.template_version_id
          AND selected_version.template_id = NEW.template_id
          AND selected_version.status = 'published'
          AND selected_template.status = 'published'
          AND selected_template.current_published_version = selected_version.version
      )
      BEGIN SELECT RAISE(ABORT, 'intake_template_version_not_current'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_intake_submission_publish_state_v19
      BEFORE UPDATE OF status ON intake_submissions
      WHEN OLD.status = 'draft' AND NEW.status = 'submitted' AND NOT EXISTS (
        SELECT 1 FROM intake_forms
        WHERE workspace_id = NEW.workspace_id
          AND id = NEW.form_id
          AND version = NEW.form_version
          AND status = 'published'
      )
      BEGIN SELECT RAISE(ABORT, 'intake_form_not_published'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_ingestion_batch_identity_v19
      BEFORE UPDATE OF workspace_id, created_by_user_id, idempotency_key_sha256, request_sha256, item_count, created_at ON ingestion_batches
      BEGIN SELECT RAISE(ABORT, 'immutable_ingestion_batch_identity'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_ingestion_item_scope_insert_v19
      BEFORE INSERT ON ingestion_items
      WHEN NOT EXISTS (SELECT 1 FROM ingestion_batches WHERE workspace_id = NEW.workspace_id AND id = NEW.batch_id AND NEW.ordinal < item_count AND status <> 'cancelled')
        OR (NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE workspace_id = NEW.workspace_id AND id = NEW.document_id AND sha256 = NEW.source_sha256 AND deleted_at IS NULL))
        OR (NEW.duplicate_of_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE workspace_id = NEW.workspace_id AND id = NEW.duplicate_of_document_id AND sha256 = NEW.source_sha256 AND deleted_at IS NULL))
      BEGIN SELECT RAISE(ABORT, 'invalid_ingestion_item_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_ingestion_item_scope_update_v19
      BEFORE UPDATE OF document_id, duplicate_of_document_id, status ON ingestion_items
      WHEN (NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE workspace_id = NEW.workspace_id AND id = NEW.document_id AND sha256 = NEW.source_sha256 AND deleted_at IS NULL))
        OR (NEW.duplicate_of_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE workspace_id = NEW.workspace_id AND id = NEW.duplicate_of_document_id AND sha256 = NEW.source_sha256 AND deleted_at IS NULL))
      BEGIN SELECT RAISE(ABORT, 'invalid_ingestion_item_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_ingestion_item_source_v19
      BEFORE UPDATE OF workspace_id, batch_id, ordinal, file_name, content_type, size, source_sha256, dedupe_sha256, created_at ON ingestion_items
      BEGIN SELECT RAISE(ABORT, 'immutable_ingestion_item_source'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_ingestion_item_review_transition_v19
      BEFORE UPDATE OF status ON ingestion_items
      WHEN NEW.status IN ('accepted', 'rejected') AND OLD.status <> 'review_required'
      BEGIN SELECT RAISE(ABORT, 'invalid_ingestion_item_review_transition'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_repository_fragment_source_insert_v19
      BEFORE INSERT ON repository_fragments
      WHEN NOT EXISTS (
        SELECT 1 FROM agreement_document_versions WHERE workspace_id = NEW.workspace_id AND id = NEW.document_version_id
          AND agreement_id = NEW.agreement_id AND version = NEW.document_version AND sha256 = NEW.document_sha256
      ) OR NOT EXISTS (
        SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND id = NEW.agreement_id AND deleted_at IS NULL
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_repository_fragment_source'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_repository_fragment_v19
      BEFORE UPDATE ON repository_fragments
      BEGIN SELECT RAISE(ABORT, 'immutable_repository_fragment'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS prevent_repository_fragment_overlap_insert_v19
      BEFORE INSERT ON repository_fragments
      WHEN EXISTS (
        SELECT 1 FROM repository_fragments AS existing_fragment
        WHERE existing_fragment.workspace_id = NEW.workspace_id
          AND existing_fragment.document_version_id = NEW.document_version_id
          AND existing_fragment.source_text_sha256 = NEW.source_text_sha256
          AND NEW.start_offset < existing_fragment.end_offset
          AND NEW.end_offset > existing_fragment.start_offset
      )
      BEGIN SELECT RAISE(ABORT, 'repository_fragment_overlap'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS bound_repository_fragment_total_insert_v19
      BEFORE INSERT ON repository_fragments
      WHEN (SELECT count(*) FROM repository_fragments AS existing_fragment
        WHERE existing_fragment.workspace_id = NEW.workspace_id
          AND existing_fragment.document_version_id = NEW.document_version_id
          AND existing_fragment.source_text_sha256 = NEW.source_text_sha256) >= 500
      BEGIN SELECT RAISE(ABORT, 'repository_fragment_limit'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_extraction_proposal_source_insert_v19
      BEFORE INSERT ON extraction_proposals
      WHEN NOT EXISTS (
        SELECT 1 FROM agreement_document_versions WHERE workspace_id = NEW.workspace_id AND id = NEW.document_version_id
          AND agreement_id = NEW.agreement_id AND version = NEW.document_version AND sha256 = NEW.document_sha256
      ) OR NOT EXISTS (
        SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND id = NEW.agreement_id AND deleted_at IS NULL
      ) OR (NEW.custom_field_definition_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM custom_field_definitions WHERE workspace_id = NEW.workspace_id AND id = NEW.custom_field_definition_id AND resource_type = 'agreement' AND status = 'active'
      )) OR (NEW.ingestion_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ingestion_items AS source_item
        JOIN agreement_document_versions AS source_version ON source_version.workspace_id = source_item.workspace_id
          AND source_version.source_document_id = source_item.document_id
        WHERE source_item.workspace_id = NEW.workspace_id AND source_item.id = NEW.ingestion_item_id
          AND source_version.id = NEW.document_version_id
      ))
      BEGIN SELECT RAISE(ABORT, 'invalid_extraction_proposal_source'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_extraction_proposal_basis_v19
      BEFORE UPDATE OF workspace_id, document_version_id, agreement_id, ingestion_item_id, document_version, document_sha256, source_text_sha256, target_type, target_field, custom_field_definition_id, proposed_value, confidence_ppm, extractor, extractor_version, created_by_user_id, created_at ON extraction_proposals
      BEGIN SELECT RAISE(ABORT, 'immutable_extraction_proposal_basis'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_extraction_proposal_review_v19
      BEFORE UPDATE OF status ON extraction_proposals
      WHEN OLD.status <> 'pending_review' OR NEW.status NOT IN ('accepted', 'rejected', 'superseded')
        OR NOT EXISTS (SELECT 1 FROM agreement_document_versions WHERE workspace_id = NEW.workspace_id AND id = NEW.document_version_id AND agreement_id = NEW.agreement_id AND version = NEW.document_version AND sha256 = NEW.document_sha256)
        OR NOT EXISTS (SELECT 1 FROM agreements WHERE workspace_id = NEW.workspace_id AND id = NEW.agreement_id AND deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid_extraction_proposal_review'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_extraction_proposal_citation_insert_v19
      BEFORE INSERT ON extraction_proposal_citations
      WHEN NOT EXISTS (
        SELECT 1 FROM extraction_proposals AS proposal
        JOIN repository_fragments AS fragment ON fragment.workspace_id = proposal.workspace_id
          AND fragment.document_version_id = proposal.document_version_id AND fragment.document_version = proposal.document_version
          AND fragment.document_sha256 = proposal.document_sha256 AND fragment.source_text_sha256 = proposal.source_text_sha256
        WHERE proposal.workspace_id = NEW.workspace_id AND proposal.id = NEW.proposal_id AND fragment.id = NEW.fragment_id
          AND NEW.document_version_id = proposal.document_version_id AND NEW.document_version = proposal.document_version
          AND NEW.document_sha256 = proposal.document_sha256 AND NEW.source_text_sha256 = proposal.source_text_sha256
          AND NEW.start_offset >= fragment.start_offset AND NEW.end_offset <= fragment.end_offset
          AND NEW.quote = substr(fragment.content, NEW.start_offset - fragment.start_offset + 1, NEW.end_offset - NEW.start_offset)
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_extraction_proposal_citation'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_extraction_proposal_citation_v19
      BEFORE UPDATE ON extraction_proposal_citations
      BEGIN SELECT RAISE(ABORT, 'immutable_extraction_proposal_citation'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_workflow_snapshot_insert_v19
      BEFORE INSERT ON agreements
      WHEN NOT ((NEW.workflow_policy_sha256 IS NULL AND NEW.workflow_approval_lanes IS NULL) OR (
        NEW.workflow_definition_id IS NOT NULL AND length(NEW.workflow_policy_sha256) = 64
        AND lower(NEW.workflow_policy_sha256) NOT GLOB '*[^0-9a-f]*'
        AND json_valid(NEW.workflow_approval_lanes) = 1 AND json_type(NEW.workflow_approval_lanes) = 'array'
        AND json_array_length(NEW.workflow_approval_lanes) BETWEEN 1 AND 20 AND length(NEW.workflow_approval_lanes) BETWEEN 3 AND 2048
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.workflow_approval_lanes) THEN NEW.workflow_approval_lanes ELSE '[]' END) WHERE type <> 'text' OR length(trim(CAST(value AS TEXT))) NOT BETWEEN 1 AND 120)
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.workflow_approval_lanes) THEN NEW.workflow_approval_lanes ELSE '[]' END) AS lane GROUP BY lower(trim(CAST(lane.value AS TEXT))) HAVING count(*) > 1)
        AND EXISTS (SELECT 1 FROM workflow_definitions WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_definition_id
          AND status = 'published' AND definition_sha256 = NEW.workflow_policy_sha256)
      ))
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_workflow_snapshot'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_intake_form_template_version_insert_v19
      BEFORE INSERT ON intake_forms
      WHEN (NEW.template_id IS NULL AND NEW.template_version_id IS NOT NULL)
        OR (NEW.status = 'published' AND NEW.template_id IS NOT NULL AND NEW.template_version_id IS NULL)
        OR (NEW.template_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM governed_template_versions WHERE workspace_id = NEW.workspace_id AND template_id = NEW.template_id
            AND id = NEW.template_version_id AND status = 'published'
        ))
      BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_template_version'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_intake_form_template_version_update_v19
      BEFORE UPDATE ON intake_forms
      WHEN (NEW.template_id IS NULL AND NEW.template_version_id IS NOT NULL)
        OR (NEW.status = 'published' AND NEW.template_id IS NOT NULL AND NEW.template_version_id IS NULL)
        OR (NEW.template_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM governed_template_versions WHERE workspace_id = NEW.workspace_id AND template_id = NEW.template_id
            AND id = NEW.template_version_id AND status = 'published'
        ))
      BEGIN SELECT RAISE(ABORT, 'invalid_intake_form_template_version'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_published_intake_form_template_pin_v19
      BEFORE UPDATE OF template_id, template_version_id ON intake_forms WHEN OLD.status IN ('published', 'retired')
      BEGIN SELECT RAISE(ABORT, 'immutable_published_intake_form_template_pin'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_agreement_workflow_snapshot_update_v19
      BEFORE UPDATE OF workspace_id, workflow_definition_id, workflow_policy_sha256, workflow_approval_lanes ON agreements
      WHEN NOT ((NEW.workflow_policy_sha256 IS NULL AND NEW.workflow_approval_lanes IS NULL) OR (
        NEW.workflow_definition_id IS NOT NULL AND length(NEW.workflow_policy_sha256) = 64
        AND lower(NEW.workflow_policy_sha256) NOT GLOB '*[^0-9a-f]*'
        AND json_valid(NEW.workflow_approval_lanes) = 1 AND json_type(NEW.workflow_approval_lanes) = 'array'
        AND json_array_length(NEW.workflow_approval_lanes) BETWEEN 1 AND 20 AND length(NEW.workflow_approval_lanes) BETWEEN 3 AND 2048
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.workflow_approval_lanes) THEN NEW.workflow_approval_lanes ELSE '[]' END) WHERE type <> 'text' OR length(trim(CAST(value AS TEXT))) NOT BETWEEN 1 AND 120)
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.workflow_approval_lanes) THEN NEW.workflow_approval_lanes ELSE '[]' END) AS lane GROUP BY lower(trim(CAST(lane.value AS TEXT))) HAVING count(*) > 1)
        AND EXISTS (SELECT 1 FROM workflow_definitions WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_definition_id
          AND (status = 'published' OR (status = 'retired' AND NEW.workflow_definition_id = OLD.workflow_definition_id))
          AND definition_sha256 = NEW.workflow_policy_sha256)
      ))
      BEGIN SELECT RAISE(ABORT, 'invalid_agreement_workflow_snapshot'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_governed_template_scope_v19
      BEFORE UPDATE OF agreement_type, side ON governed_templates
      WHEN (NEW.agreement_type <> OLD.agreement_type OR NEW.side <> OLD.side)
        AND EXISTS (
          SELECT 1 FROM governed_template_versions
          WHERE workspace_id = OLD.workspace_id AND template_id = OLD.id
        )
      BEGIN SELECT RAISE(ABORT, 'immutable_governed_template_scope'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_governed_template_creation_receipt_insert_v20
      BEFORE INSERT ON governed_template_creation_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM governed_templates AS initial_template
        JOIN governed_template_versions AS initial_version
          ON initial_version.workspace_id = initial_template.workspace_id
          AND initial_version.template_id = initial_template.id
        WHERE initial_template.workspace_id = NEW.workspace_id
          AND initial_template.id = NEW.template_id
          AND initial_template.created_by_user_id = NEW.user_id
          AND initial_version.id = NEW.template_version_id
          AND initial_version.version = 1
          AND initial_version.created_by_user_id = NEW.user_id
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_governed_template_creation_receipt'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_governed_template_creation_receipt_v20
      BEFORE UPDATE ON governed_template_creation_receipts
      BEGIN SELECT RAISE(ABORT, 'immutable_governed_template_creation_receipt'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS validate_clause_playbook_creation_receipt_insert_v20
      BEFORE INSERT ON clause_playbook_creation_receipts
      WHEN NOT EXISTS (
        SELECT 1 FROM clause_playbooks AS initial_playbook
        JOIN clause_playbook_versions AS initial_version
          ON initial_version.workspace_id = initial_playbook.workspace_id
          AND initial_version.playbook_id = initial_playbook.id
        WHERE initial_playbook.workspace_id = NEW.workspace_id
          AND initial_playbook.id = NEW.playbook_id
          AND initial_playbook.created_by_user_id = NEW.user_id
          AND initial_version.id = NEW.playbook_version_id
          AND initial_version.version = 1
          AND initial_version.created_by_user_id = NEW.user_id
      )
      BEGIN SELECT RAISE(ABORT, 'invalid_clause_playbook_creation_receipt'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS immutable_clause_playbook_creation_receipt_v20
      BEFORE UPDATE ON clause_playbook_creation_receipts
      BEGIN SELECT RAISE(ABORT, 'immutable_clause_playbook_creation_receipt'); END`),
    d1.prepare(`CREATE TRIGGER IF NOT EXISTS prevent_duplicate_agreement_party_v19
      BEFORE INSERT ON agreement_parties
      WHEN EXISTS (
        SELECT 1 FROM agreement_parties
        WHERE workspace_id = NEW.workspace_id
          AND agreement_id = NEW.agreement_id
          AND role = NEW.role
          AND legal_entity_id IS NEW.legal_entity_id
          AND counterparty_id IS NEW.counterparty_id
      )
      BEGIN SELECT RAISE(ABORT, 'duplicate_agreement_party'); END`),
  ]);
  await d1.prepare("PRAGMA optimize").run();

  // The marker is written last. A partial local bootstrap can therefore never
  // masquerade as a schema that passed the complete compatibility sequence.
  await d1.prepare(`INSERT INTO notice_schema_state (id, version, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`)
    .bind(NOTICE_SCHEMA_MARKER_ID, NOTICE_SCHEMA_VERSION, new Date().toISOString())
    .run();
  await verifyStorageSchema(d1);
}

const ensureOnce = cacheSuccessfulSchemaCheck(async () => {
  const bindings = env as unknown as Record<string, unknown> & { DB?: D1Database };
  const d1 = bindings.DB;
  if (!d1) throw new StorageSchemaError("Cloudflare D1 binding `DB` is unavailable.");

  try {
    await enforceStorageSchemaPolicy(d1, bindings, bootstrapStorageSchema);
  } catch (error) {
    if (error instanceof StorageSchemaError) throw error;
    throw new StorageSchemaError("Notice local storage schema bootstrap failed.", error);
  }
});

/**
 * Production verifies the reviewed migration marker and performs no DDL.
 * Runtime bootstrap is restricted to evaluation and the explicit isolated
 * production-evidence harness configured by vite.config.ts.
 */
export function ensureStorageSchema(): Promise<void> {
  return ensureOnce();
}

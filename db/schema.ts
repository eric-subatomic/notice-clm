import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Rows created before workspace isolation was introduced are deliberately kept
 * outside every real workspace. Production request handlers must always scope
 * queries to PermissionContext.workspace.id, so legacy data is fail-closed
 * until an operator explicitly assigns it during a reviewed migration.
 */
export const UNASSIGNED_WORKSPACE_ID = "__unassigned__";

export const noticeSchemaState = sqliteTable("notice_schema_state", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Transaction-local assertions used to abort a D1 batch when its immediately
 * preceding optimistic mutation changed anything other than one row. */
export const mutationGuards = sqliteTable("mutation_guards", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  operation: text("operation").notNull(),
  guardChanges: integer("guard_changes").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("ck_mutation_guards_changes", sql`${table.guardChanges} = 1`),
]);

export const purgeJobStatuses = ["storage_pending", "completed"] as const;
export type PurgeJobStatus = (typeof purgeJobStatuses)[number];
export const purgeJobResourceTypes = ["agreement", "document"] as const;
export type PurgeJobResourceType = (typeof purgeJobResourceTypes)[number];

export const purgeJobs = sqliteTable("purge_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  resourceType: text("resource_type").$type<PurgeJobResourceType>().notNull(),
  resourceId: text("resource_id").notNull(),
  objectKeys: text("object_keys", { mode: "json" }).$type<string[]>().notNull(),
  status: text("status").$type<PurgeJobStatus>().notNull().default("storage_pending"),
  guardChanges: integer("guard_changes").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: text("last_attempt_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  check("ck_purge_jobs_guard_changes", sql`${table.guardChanges} = 1`),
  check("ck_purge_jobs_status", sql`${table.status} in ('storage_pending', 'completed')`),
  check("ck_purge_jobs_resource_type", sql`${table.resourceType} in ('agreement', 'document')`),
  uniqueIndex("uq_purge_jobs_workspace_resource").on(table.workspaceId, table.resourceType, table.resourceId),
  index("idx_purge_jobs_workspace_status_created_at").on(table.workspaceId, table.status, table.createdAt),
]);

export const workspaceRoles = ["admin", "legal", "approver", "requester", "viewer"] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

export const membershipStatuses = ["active", "invited", "disabled"] as const;
export type MembershipStatus = (typeof membershipStatuses)[number];

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_workspaces_slug").on(table.slug),
]);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  identityProvider: text("identity_provider").notNull(),
  identitySubject: text("identity_subject").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  uniqueIndex("uq_users_identity").on(table.identityProvider, table.identitySubject),
  uniqueIndex("uq_users_email").on(table.email),
]);

export const workspaceMemberships = sqliteTable("workspace_memberships", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").$type<WorkspaceRole>().notNull(),
  status: text("status").$type<MembershipStatus>().notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index("idx_workspace_memberships_user_status").on(table.userId, table.status),
  index("idx_workspace_memberships_workspace_role").on(table.workspaceId, table.role),
]);

export const workspaceEvents = sqliteTable("workspace_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  actorEmail: text("actor_email").notNull(),
  actor: text("actor").notNull(),
  subjectUserId: text("subject_user_id"),
  subjectEmail: text("subject_email"),
  detail: text("detail").notNull(),
  previousHash: text("previous_hash"),
  eventHash: text("event_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_workspace_events_workspace_sequence").on(table.workspaceId, table.sequence),
  index("idx_workspace_events_workspace_created_at").on(table.workspaceId, table.createdAt),
]);

export const workspaceGroupStatuses = ["active", "disabled"] as const;
export type WorkspaceGroupStatus = (typeof workspaceGroupStatuses)[number];

/** Workspace-owned groups support IdP/SCIM synchronization and explicit
 * approval-lane authority without broadening the fixed application roles. */
export const workspaceGroups = sqliteTable("workspace_groups", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  externalProvider: text("external_provider"),
  externalId: text("external_id"),
  status: text("status").$type<WorkspaceGroupStatus>().notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_workspace_groups_status", sql`${table.status} in ('active', 'disabled')`),
  uniqueIndex("uq_workspace_groups_workspace_name").on(table.workspaceId, table.name),
  uniqueIndex("uq_workspace_groups_workspace_external").on(table.workspaceId, table.externalProvider, table.externalId),
  index("idx_workspace_groups_workspace_status").on(table.workspaceId, table.status),
]);

export const workspaceGroupMembers = sqliteTable("workspace_group_members", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  groupId: text("group_id").notNull().references(() => workspaceGroups.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  source: text("source").$type<"manual" | "scim">().notNull().default("manual"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.groupId, table.userId] }),
  check("ck_workspace_group_members_source", sql`${table.source} in ('manual', 'scim')`),
  index("idx_workspace_group_members_workspace_user").on(table.workspaceId, table.userId),
]);

export const legalEntityStatuses = ["active", "inactive"] as const;
export type LegalEntityStatus = (typeof legalEntityStatuses)[number];

export const legalEntities = sqliteTable("legal_entities", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name").notNull(),
  entityType: text("entity_type").notNull().default("company"),
  jurisdiction: text("jurisdiction").notNull().default(""),
  registrationNumber: text("registration_number").notNull().default(""),
  defaultCurrencyCode: text("default_currency_code").notNull().default("USD"),
  status: text("status").$type<LegalEntityStatus>().notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_legal_entities_status", sql`${table.status} in ('active', 'inactive')`),
  check("ck_legal_entities_currency", sql`length(${table.defaultCurrencyCode}) = 3 and ${table.defaultCurrencyCode} = upper(${table.defaultCurrencyCode})`),
  uniqueIndex("uq_legal_entities_workspace_name").on(table.workspaceId, table.legalName),
  index("idx_legal_entities_workspace_status").on(table.workspaceId, table.status),
]);

export const counterpartyStatuses = ["active", "inactive", "blocked"] as const;
export type CounterpartyStatus = (typeof counterpartyStatuses)[number];

export const counterparties = sqliteTable("counterparties", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name").notNull(),
  domain: text("domain").notNull().default(""),
  jurisdiction: text("jurisdiction").notNull().default(""),
  registrationNumber: text("registration_number").notNull().default(""),
  externalId: text("external_id").notNull().default(""),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status").$type<CounterpartyStatus>().notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_counterparties_status", sql`${table.status} in ('active', 'inactive', 'blocked')`),
  uniqueIndex("uq_counterparties_workspace_dedupe").on(table.workspaceId, table.dedupeKey),
  index("idx_counterparties_workspace_status_name").on(table.workspaceId, table.status, table.displayName),
  index("idx_counterparties_workspace_external").on(table.workspaceId, table.externalId),
]);

export const customFieldResourceTypes = ["agreement", "counterparty", "legal_entity"] as const;
export type CustomFieldResourceType = (typeof customFieldResourceTypes)[number];
export const customFieldDataTypes = ["text", "number", "date", "boolean", "single_select", "multi_select"] as const;
export type CustomFieldDataType = (typeof customFieldDataTypes)[number];

export const customFieldDefinitions = sqliteTable("custom_field_definitions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  resourceType: text("resource_type").$type<CustomFieldResourceType>().notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  dataType: text("data_type").$type<CustomFieldDataType>().notNull(),
  options: text("options", { mode: "json" }).$type<string[]>().notNull().default([]),
  required: integer("required", { mode: "boolean" }).notNull().default(false),
  status: text("status").$type<"active" | "retired">().notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_custom_field_definitions_resource", sql`${table.resourceType} in ('agreement', 'counterparty', 'legal_entity')`),
  check("ck_custom_field_definitions_type", sql`${table.dataType} in ('text', 'number', 'date', 'boolean', 'single_select', 'multi_select')`),
  check("ck_custom_field_definitions_status", sql`${table.status} in ('active', 'retired')`),
  check("ck_custom_field_definitions_options", sql`json_valid(${table.options}) = 1 and json_type(${table.options}) = 'array' and length(${table.options}) between 2 and 8192`),
  uniqueIndex("uq_custom_field_definitions_workspace_resource_key").on(table.workspaceId, table.resourceType, table.key),
  index("idx_custom_field_definitions_workspace_status").on(table.workspaceId, table.status),
]);

export const customFieldValues = sqliteTable("custom_field_values", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  definitionId: text("definition_id").notNull().references(() => customFieldDefinitions.id, { onDelete: "cascade" }),
  resourceType: text("resource_type").$type<CustomFieldResourceType>().notNull(),
  resourceId: text("resource_id").notNull(),
  valueJson: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_custom_field_values_resource", sql`${table.resourceType} in ('agreement', 'counterparty', 'legal_entity')`),
  check("ck_custom_field_values_json", sql`json_valid(${table.valueJson}) = 1 and length(${table.valueJson}) between 1 and 32768`),
  uniqueIndex("uq_custom_field_values_workspace_definition_resource").on(table.workspaceId, table.definitionId, table.resourceType, table.resourceId),
  index("idx_custom_field_values_workspace_resource").on(table.workspaceId, table.resourceType, table.resourceId),
]);

export const governedTemplateStatuses = ["draft", "published", "retired"] as const;
export type GovernedTemplateStatus = (typeof governedTemplateStatuses)[number];

export const governedTemplates = sqliteTable("governed_templates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  agreementType: text("agreement_type").notNull(),
  side: text("side").notNull(),
  status: text("status").$type<GovernedTemplateStatus>().notNull().default("draft"),
  currentPublishedVersion: integer("current_published_version"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_governed_templates_side", sql`${table.side} in ('Sell-side', 'Buy-side', 'Corporate')`),
  check("ck_governed_templates_status", sql`${table.status} in ('draft', 'published', 'retired')`),
  uniqueIndex("uq_governed_templates_workspace_name").on(table.workspaceId, table.name),
  index("idx_governed_templates_workspace_status").on(table.workspaceId, table.status),
]);

export const governedTemplateVersions = sqliteTable("governed_template_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  templateId: text("template_id").notNull().references(() => governedTemplates.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").$type<GovernedTemplateStatus>().notNull().default("draft"),
  body: text("body").notNull(),
  variableSchema: text("variable_schema", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  languageBlockIds: text("language_block_ids", { mode: "json" }).$type<number[]>().notNull().default([]),
  contentSha256: text("content_sha256").notNull(),
  changeSummary: text("change_summary").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewedAt: text("reviewed_at"),
}, (table) => [
  check("ck_governed_template_versions_status", sql`${table.status} in ('draft', 'published', 'retired')`),
  check("ck_governed_template_versions_schema", sql`json_valid(${table.variableSchema}) = 1 and json_type(${table.variableSchema}) = 'object' and length(${table.variableSchema}) between 2 and 65536`),
  check("ck_governed_template_versions_blocks", sql`json_valid(${table.languageBlockIds}) = 1 and json_type(${table.languageBlockIds}) = 'array' and length(${table.languageBlockIds}) between 2 and 65536`),
  check("ck_governed_template_versions_digest", sql`length(${table.contentSha256}) = 64 and lower(${table.contentSha256}) not glob '*[^0-9a-f]*'`),
  uniqueIndex("uq_governed_template_versions_workspace_template_version").on(table.workspaceId, table.templateId, table.version),
  index("idx_governed_template_versions_workspace_status").on(table.workspaceId, table.status),
]);

/**
 * Tenant- and administrator-bound receipts make initial governed-template
 * creation atomic and safe to retry after an ambiguous response. Only the
 * one-way key digest and the two durable target IDs are retained.
 */
export const governedTemplateCreationReceipts = sqliteTable("governed_template_creation_receipts", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  idempotencyKeySha256: text("idempotency_key_sha256").notNull(),
  requestSha256: text("request_sha256").notNull(),
  templateId: text("template_id").notNull().references(() => governedTemplates.id, { onDelete: "cascade" }),
  templateVersionId: text("template_version_id").notNull().references(() => governedTemplateVersions.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId, table.idempotencyKeySha256] }),
  check("ck_governed_template_creation_receipts_key_digest", sql`length(${table.idempotencyKeySha256}) = 64 and lower(${table.idempotencyKeySha256}) not glob '*[^0-9a-f]*'`),
  check("ck_governed_template_creation_receipts_request_digest", sql`length(${table.requestSha256}) = 64 and lower(${table.requestSha256}) not glob '*[^0-9a-f]*'`),
  uniqueIndex("uq_governed_template_creation_receipts_workspace_template").on(table.workspaceId, table.templateId),
  uniqueIndex("uq_governed_template_creation_receipts_workspace_version").on(table.workspaceId, table.templateVersionId),
  index("idx_governed_template_creation_receipts_workspace_created").on(table.workspaceId, table.createdAt),
]);

export const workflowDefinitionStatuses = ["draft", "published", "retired"] as const;
export type WorkflowDefinitionStatus = (typeof workflowDefinitionStatuses)[number];

export const workflowDefinitions = sqliteTable("workflow_definitions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").$type<WorkflowDefinitionStatus>().notNull().default("draft"),
  definition: text("definition", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  definitionSha256: text("definition_sha256").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
  publishedByUserId: text("published_by_user_id"),
  publishedAt: text("published_at"),
}, (table) => [
  check("ck_workflow_definitions_status", sql`${table.status} in ('draft', 'published', 'retired')`),
  check("ck_workflow_definitions_json", sql`json_valid(${table.definition}) = 1 and json_type(${table.definition}) = 'object' and length(${table.definition}) between 2 and 65536`),
  check("ck_workflow_definitions_digest", sql`length(${table.definitionSha256}) = 64 and lower(${table.definitionSha256}) not glob '*[^0-9a-f]*'`),
  uniqueIndex("uq_workflow_definitions_workspace_name_version").on(table.workspaceId, table.name, table.version),
  index("idx_workflow_definitions_workspace_name").on(table.workspaceId, table.name),
  index("idx_workflow_definitions_workspace_status").on(table.workspaceId, table.status),
]);

export const approvalLaneAuthorities = sqliteTable("approval_lane_authorities", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  lane: text("lane").notNull(),
  subjectType: text("subject_type").$type<"user" | "group">().notNull(),
  subjectId: text("subject_id").notNull(),
  currencyCode: text("currency_code").notNull().default("USD"),
  amountLimitMinor: integer("amount_limit_minor"),
  status: text("status").$type<"active" | "revoked">().notNull().default("active"),
  reason: text("reason").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_approval_lane_authorities_subject", sql`${table.subjectType} in ('user', 'group')`),
  check("ck_approval_lane_authorities_currency", sql`length(${table.currencyCode}) = 3 and ${table.currencyCode} = upper(${table.currencyCode})`),
  check("ck_approval_lane_authorities_limit", sql`${table.amountLimitMinor} is null or ${table.amountLimitMinor} >= 0`),
  check("ck_approval_lane_authorities_status", sql`${table.status} in ('active', 'revoked')`),
  uniqueIndex("uq_approval_lane_authorities_active_identity")
    .on(table.workspaceId, table.lane, table.subjectType, table.subjectId, table.currencyCode)
    .where(sql`${table.status} = 'active'`),
  index("idx_approval_lane_authorities_workspace_lane_status").on(table.workspaceId, table.lane, table.status),
]);

export const intakeForms = sqliteTable("intake_forms", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").$type<"draft" | "published" | "retired">().notNull().default("draft"),
  formSchema: text("form_schema", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  templateId: text("template_id"),
  templateVersionId: text("template_version_id").references(() => governedTemplateVersions.id, { onDelete: "restrict" }),
  workflowDefinitionId: text("workflow_definition_id"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_intake_forms_status", sql`${table.status} in ('draft', 'published', 'retired')`),
  check("ck_intake_forms_schema", sql`json_valid(${table.formSchema}) = 1 and json_type(${table.formSchema}) = 'object' and length(${table.formSchema}) between 2 and 65536`),
  uniqueIndex("uq_intake_forms_workspace_name").on(table.workspaceId, table.name),
  index("idx_intake_forms_workspace_status").on(table.workspaceId, table.status),
  index("idx_intake_forms_workspace_template_version").on(table.workspaceId, table.templateVersionId),
]);

export const intakeSubmissions = sqliteTable("intake_submissions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  formId: text("form_id").notNull().references(() => intakeForms.id, { onDelete: "restrict" }),
  formVersion: integer("form_version").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").$type<"draft" | "submitted" | "converted" | "rejected">().notNull().default("draft"),
  answers: text("answers", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  submittedByUserId: text("submitted_by_user_id").notNull(),
  agreementId: integer("agreement_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  submittedAt: text("submitted_at"),
  convertedAt: text("converted_at"),
}, (table) => [
  check("ck_intake_submissions_status", sql`${table.status} in ('draft', 'submitted', 'converted', 'rejected')`),
  check("ck_intake_submissions_answers", sql`json_valid(${table.answers}) = 1 and json_type(${table.answers}) = 'object' and length(${table.answers}) between 2 and 131072`),
  index("idx_intake_submissions_workspace_status_updated").on(table.workspaceId, table.status, table.updatedAt),
  index("idx_intake_submissions_workspace_form").on(table.workspaceId, table.formId),
]);

export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  resourceType: text("resource_type").notNull(),
  name: text("name").notNull(),
  filter: text("filter", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  sort: text("sort", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_saved_views_filter", sql`json_valid(${table.filter}) = 1 and json_type(${table.filter}) = 'object' and length(${table.filter}) between 2 and 16384`),
  check("ck_saved_views_sort", sql`json_valid(${table.sort}) = 1 and json_type(${table.sort}) = 'object' and length(${table.sort}) between 2 and 4096`),
  uniqueIndex("uq_saved_views_workspace_owner_resource_name").on(table.workspaceId, table.ownerUserId, table.resourceType, table.name),
  index("idx_saved_views_workspace_resource_shared").on(table.workspaceId, table.resourceType, table.shared),
]);

export const integrationDiagnosticStatuses = ["passed", "failed"] as const;
export type IntegrationDiagnosticStatus = (typeof integrationDiagnosticStatuses)[number];

/**
 * Durable, admin-visible proof of the latest live provider check. The
 * configuration fingerprint is one-way and includes the secret-backed profile,
 * so rotating a credential or mapping invalidates stale evidence without
 * exposing any configuration value.
 */
export const integrationDiagnostics = sqliteTable("integration_diagnostics", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  integrationId: text("integration_id").notNull(),
  configurationFingerprint: text("configuration_fingerprint").notNull(),
  status: text("status").$type<IntegrationDiagnosticStatus>().notNull(),
  testedAt: text("tested_at").notNull(),
  detail: text("detail").notNull(),
  testedByUserId: text("tested_by_user_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.integrationId] }),
  check("ck_integration_diagnostics_id", sql`${table.integrationId} in ('docuseal', 'scanner', 'delivery', 'crm')`),
  check("ck_integration_diagnostics_status", sql`${table.status} in ('passed', 'failed')`),
  index("idx_integration_diagnostics_workspace_status").on(table.workspaceId, table.status),
]);

/**
 * Explicit administrator evidence for pre-delivery-ledger CRM events whose
 * exact remote destination cannot be reconstructed. These rows never pretend
 * that a gateway accepted a tombstone; they record separately verified
 * downstream cleanup against the digest of the legacy event being waived.
 */
export const crmLegacyCleanupAttestations = sqliteTable("crm_legacy_cleanup_attestations", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  agreementId: integer("agreement_id").notNull(),
  eventId: text("event_id").notNull(),
  eventPayloadSha256: text("event_payload_sha256").notNull(),
  providerSelection: text("provider_selection").$type<"Salesforce" | "HubSpot" | "Custom CRM">().notNull(),
  reason: text("reason").notNull(),
  attestedByUserId: text("attested_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.eventId] }),
  check("ck_crm_legacy_cleanup_provider", sql`${table.providerSelection} in ('Salesforce', 'HubSpot', 'Custom CRM')`),
  check("ck_crm_legacy_cleanup_digest", sql`length(${table.eventPayloadSha256}) = 64`),
  index("idx_crm_legacy_cleanup_workspace_agreement").on(table.workspaceId, table.agreementId),
]);

export const agreements = sqliteTable("agreements", {
  id: integer("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(UNASSIGNED_WORKSPACE_ID),
  version: integer("version").notNull().default(1),
  party: text("party").notNull(),
  initials: text("initials").notNull(),
  side: text("side").notNull(),
  type: text("type").notNull(),
  value: integer("value").notNull().default(0),
  /** Canonical monetary representation. `value` remains a whole-unit legacy
   * projection until every older client has moved to `valueMinor`. */
  valueMinor: integer("value_minor").notNull().default(0),
  currencyCode: text("currency_code").notNull().default("USD"),
  stage: text("stage").notNull(),
  owner: text("owner").notNull(),
  ownerUserId: text("owner_user_id"),
  primaryCounterpartyId: text("primary_counterparty_id"),
  legalEntityId: text("legal_entity_id"),
  governedTemplateVersionId: text("governed_template_version_id"),
  workflowDefinitionId: text("workflow_definition_id"),
  workflowPolicySha256: text("workflow_policy_sha256"),
  workflowApprovalLanes: text("workflow_approval_lanes", { mode: "json" }).$type<string[] | null>(),
  nextAction: text("next_action").notNull(),
  due: text("due").notNull(),
  crm: text("crm").notNull(),
  crmRecord: text("crm_record").notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  updated: text("updated").notNull(),
  createdAt: text("created_at").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(""),
  createdByUserId: text("created_by_user_id"),
  updatedByUserId: text("updated_by_user_id"),
  legalHold: integer("legal_hold", { mode: "boolean" }).notNull().default(false),
  retentionUntil: text("retention_until"),
  deletedAt: text("deleted_at"),
  department: text("department").notNull().default("Legal"),
  /**
   * The physical legacy column still has a Low default in pre-v15 databases.
   * Application writers always set Unassessed explicitly and migration 0015
   * installs a trigger that fail-closes omitted risk evidence to Unassessed.
   */
  risk: text("risk").notNull().default("Low"),
  riskDisposition: text("risk_disposition").$type<"assessed" | "waived">(),
  riskBasisHash: text("risk_basis_hash"),
  riskDocumentVersion: integer("risk_document_version"),
  riskDocumentSha256: text("risk_document_sha256"),
  riskDecisionReason: text("risk_decision_reason"),
  riskDecidedByUserId: text("risk_decided_by_user_id"),
  riskDecidedAt: text("risk_decided_at"),
  approvalStatus: text("approval_status").notNull().default("Not required"),
  signatureStatus: text("signature_status").notNull().default("Not sent"),
  effectiveDate: text("effective_date").notNull().default(""),
  expirationDate: text("expiration_date").notNull().default(""),
}, (table) => [
  index("idx_agreements_workspace_stage").on(table.workspaceId, table.stage),
  index("idx_agreements_workspace_owner").on(table.workspaceId, table.owner),
  index("idx_agreements_workspace_owner_user").on(table.workspaceId, table.ownerUserId),
  index("idx_agreements_workspace_counterparty").on(table.workspaceId, table.primaryCounterpartyId),
  index("idx_agreements_workspace_legal_entity").on(table.workspaceId, table.legalEntityId),
  index("idx_agreements_workspace_live_updated").on(table.workspaceId, table.deletedAt, table.updatedAt, table.id),
  index("idx_agreements_workspace_live_value").on(table.workspaceId, table.deletedAt, table.value, table.id),
  index("idx_agreements_workspace_live_currency_value").on(table.workspaceId, table.deletedAt, table.currencyCode, table.valueMinor, table.id),
  index("idx_agreements_workspace_workflow_policy").on(table.workspaceId, table.workflowDefinitionId, table.workflowPolicySha256),
  index("idx_agreements_workspace_live_risk").on(table.workspaceId, table.deletedAt, table.risk, table.id),
  check("ck_agreements_value_minor", sql`${table.valueMinor} >= 0`),
  check("ck_agreements_currency", sql`length(${table.currencyCode}) = 3 and ${table.currencyCode} = upper(${table.currencyCode})`),
  check("ck_agreements_workflow_policy_digest", sql`${table.workflowPolicySha256} is null or (length(${table.workflowPolicySha256}) = 64 and lower(${table.workflowPolicySha256}) not glob '*[^0-9a-f]*')`),
  check("ck_agreements_workflow_lanes", sql`(${table.workflowPolicySha256} is null and ${table.workflowApprovalLanes} is null) or (${table.workflowPolicySha256} is not null and json_valid(${table.workflowApprovalLanes}) = 1 and json_type(${table.workflowApprovalLanes}) = 'array' and json_array_length(${table.workflowApprovalLanes}) between 1 and 20 and length(${table.workflowApprovalLanes}) between 3 and 2048)`),
  index("idx_agreements_stage").on(table.stage),
  index("idx_agreements_side").on(table.side),
  index("idx_agreements_owner").on(table.owner),
]);

export const agreementPartyRoles = ["our_entity", "counterparty", "guarantor", "affiliate", "other"] as const;
export type AgreementPartyRole = (typeof agreementPartyRoles)[number];

export const agreementParties = sqliteTable("agreement_parties", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  agreementId: integer("agreement_id").notNull().references(() => agreements.id, { onDelete: "cascade" }),
  role: text("role").$type<AgreementPartyRole>().notNull(),
  legalEntityId: text("legal_entity_id").references(() => legalEntities.id, { onDelete: "restrict" }),
  counterpartyId: text("counterparty_id").references(() => counterparties.id, { onDelete: "restrict" }),
  primary: integer("primary", { mode: "boolean" }).notNull().default(false),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("ck_agreement_parties_role", sql`${table.role} in ('our_entity', 'counterparty', 'guarantor', 'affiliate', 'other')`),
  check("ck_agreement_parties_exact_target", sql`(${table.legalEntityId} is null) <> (${table.counterpartyId} is null)`),
  uniqueIndex("uq_agreement_parties_workspace_agreement_role_target").on(table.workspaceId, table.agreementId, table.role, table.legalEntityId, table.counterpartyId),
  uniqueIndex("uq_agreement_parties_workspace_agreement_role_primary").on(table.workspaceId, table.agreementId, table.role).where(sql`${table.primary} = 1`),
  uniqueIndex("uq_agreement_parties_legal_entity_identity")
    .on(table.workspaceId, table.agreementId, table.role, table.legalEntityId)
    .where(sql`${table.legalEntityId} is not null`),
  uniqueIndex("uq_agreement_parties_counterparty_identity")
    .on(table.workspaceId, table.agreementId, table.role, table.counterpartyId)
    .where(sql`${table.counterpartyId} is not null`),
  index("idx_agreement_parties_workspace_agreement").on(table.workspaceId, table.agreementId),
  index("idx_agreement_parties_workspace_counterparty").on(table.workspaceId, table.counterpartyId),
  index("idx_agreement_parties_workspace_entity").on(table.workspaceId, table.legalEntityId),
]);

export const agreementRelationshipTypes = ["master", "amends", "order_under", "dpa_for", "renews", "supersedes", "related"] as const;
export type AgreementRelationshipType = (typeof agreementRelationshipTypes)[number];

export const agreementRelationships = sqliteTable("agreement_relationships", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sourceAgreementId: integer("source_agreement_id").notNull().references(() => agreements.id, { onDelete: "cascade" }),
  targetAgreementId: integer("target_agreement_id").notNull().references(() => agreements.id, { onDelete: "cascade" }),
  relationshipType: text("relationship_type").$type<AgreementRelationshipType>().notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("ck_agreement_relationships_type", sql`${table.relationshipType} in ('master', 'amends', 'order_under', 'dpa_for', 'renews', 'supersedes', 'related')`),
  check("ck_agreement_relationships_distinct", sql`${table.sourceAgreementId} <> ${table.targetAgreementId}`),
  uniqueIndex("uq_agreement_relationships_workspace_source_target_type").on(table.workspaceId, table.sourceAgreementId, table.targetAgreementId, table.relationshipType),
  index("idx_agreement_relationships_workspace_source").on(table.workspaceId, table.sourceAgreementId),
  index("idx_agreement_relationships_workspace_target").on(table.workspaceId, table.targetAgreementId),
]);

/**
 * User-bound creation receipts make agreement POST retries durable without
 * exposing idempotency keys through ordinary agreement responses. The request
 * digest rejects reuse of the same key for different intake data.
 */
export const agreementCreationReceipts = sqliteTable("agreement_creation_receipts", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  requestSha256: text("request_sha256").notNull(),
  creationMode: text("creation_mode").$type<"manual" | "generated" | "imported">().notNull(),
  agreementId: integer("agreement_id").notNull().references(() => agreements.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId, table.idempotencyKey] }),
  check("ck_agreement_creation_receipts_key", sql`length(${table.idempotencyKey}) = 36`),
  check("ck_agreement_creation_receipts_digest", sql`length(${table.requestSha256}) = 64`),
  check("ck_agreement_creation_receipts_mode", sql`${table.creationMode} in ('manual', 'generated', 'imported')`),
  uniqueIndex("uq_agreement_creation_receipts_workspace_agreement").on(table.workspaceId, table.agreementId),
  index("idx_agreement_creation_receipts_workspace_created_at").on(table.workspaceId, table.createdAt),
]);

export const documentRoles = ["initial_source", "counterparty_return", "outbound_round", "signed_artifact", "supporting"] as const;
export type DocumentRole = (typeof documentRoles)[number];
export const documentDirections = ["inbound", "outbound", "internal"] as const;
export type DocumentDirection = (typeof documentDirections)[number];

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(UNASSIGNED_WORKSPACE_ID),
  version: integer("version").notNull().default(1),
  agreementId: integer("agreement_id"),
  role: text("role").$type<DocumentRole>().notNull().default("supporting"),
  direction: text("direction").$type<DocumentDirection>().notNull().default("internal"),
  negotiationRoundId: text("negotiation_round_id"),
  providerMessageId: text("provider_message_id"),
  parentSha256: text("parent_sha256"),
  originalSenderEmail: text("original_sender_email"),
  fileName: text("file_name").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  extracted: text("extracted", { mode: "json" }).$type<Record<string, string>>().notNull(),
  extractionMode: text("extraction_mode").notNull().default("Metadata classification"),
  sha256: text("sha256").notNull().default(""),
  scanStatus: text("scan_status").notNull().default("unscanned"),
  scanProvider: text("scan_provider"),
  scannedAt: text("scanned_at"),
  createdByUserId: text("created_by_user_id"),
  legalHold: integer("legal_hold", { mode: "boolean" }).notNull().default(false),
  retentionUntil: text("retention_until"),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_documents_workspace_agreement_id").on(table.workspaceId, table.agreementId),
  index("idx_documents_workspace_scan_status").on(table.workspaceId, table.scanStatus),
  index("idx_documents_workspace_role").on(table.workspaceId, table.role),
  index("idx_documents_workspace_negotiation_round").on(table.workspaceId, table.negotiationRoundId),
  index("idx_documents_agreement_id").on(table.agreementId),
]);

/**
 * Tenant- and user-bound upload receipts recover a committed import after a
 * lost response without persisting the caller's UUID. The response snapshot is
 * restricted to the safe upload-analysis projection returned by the route.
 */
export const documentUploadReceipts = sqliteTable("document_upload_receipts", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  keyDigest: text("key_digest").notNull(),
  requestDigest: text("request_digest").notNull(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  responseJson: text("response_json").notNull(),
  responseStatus: integer("response_status").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  linkedAt: text("linked_at"),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId, table.keyDigest] }),
  check("ck_document_upload_receipts_key_digest", sql`length(${table.keyDigest}) = 64`),
  check("ck_document_upload_receipts_request_digest", sql`length(${table.requestDigest}) = 64`),
  check("ck_document_upload_receipts_response_status", sql`${table.responseStatus} in (201, 202)`),
  check("ck_document_upload_receipts_response_json", sql`json_valid(${table.responseJson}) = 1 and length(${table.responseJson}) between 2 and 65536`),
  check("ck_document_upload_receipts_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
  uniqueIndex("uq_document_upload_receipts_workspace_document").on(table.workspaceId, table.documentId),
  index("idx_document_upload_receipts_workspace_expiry").on(table.workspaceId, table.expiresAt),
]);

export const negotiationRoundStatuses = ["prepared", "outbound", "returned", "review", "resolved", "closed"] as const;
export type NegotiationRoundStatus = (typeof negotiationRoundStatuses)[number];
export const negotiationDeliveryMethods = ["manual", "email_gateway", "portal"] as const;
export type NegotiationDeliveryMethod = (typeof negotiationDeliveryMethods)[number];

export const negotiationRounds = sqliteTable("negotiation_rounds", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  roundNumber: integer("round_number").notNull(),
  status: text("status").$type<NegotiationRoundStatus>().notNull().default("prepared"),
  activeKey: text("active_key"),
  aliasCode: text("alias_code").notNull(),
  counterpartyEmail: text("counterparty_email"),
  counterpartyName: text("counterparty_name"),
  baseDocumentVersion: integer("base_document_version"),
  baseDocumentId: text("base_document_id"),
  baseSha256: text("base_sha256").notNull(),
  outboundDocumentId: text("outbound_document_id").notNull(),
  outboundSha256: text("outbound_sha256").notNull(),
  portalTokenHash: text("portal_token_hash"),
  portalExpiresAt: text("portal_expires_at"),
  portalUploadAttempts: integer("portal_upload_attempts").notNull().default(0),
  portalUploadAccepted: integer("portal_upload_accepted").notNull().default(0),
  portalUploadRejected: integer("portal_upload_rejected").notNull().default(0),
  portalUploadBytes: integer("portal_upload_bytes").notNull().default(0),
  portalUploadReservationId: text("portal_upload_reservation_id"),
  portalUploadReservationExpiresAt: text("portal_upload_reservation_expires_at"),
  portalUploadReservationBytes: integer("portal_upload_reservation_bytes"),
  portalDownloadAttempts: integer("portal_download_attempts").notNull().default(0),
  portalDownloadBytes: integer("portal_download_bytes").notNull().default(0),
  deliveryMethod: text("delivery_method").$type<NegotiationDeliveryMethod>(),
  providerMessageId: text("provider_message_id"),
  resolvedDocumentVersion: integer("resolved_document_version"),
  resolvedSha256: text("resolved_sha256"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  sentAt: text("sent_at"),
  resolvedAt: text("resolved_at"),
  closedAt: text("closed_at"),
}, (table) => [
  check("ck_negotiation_rounds_number", sql`${table.roundNumber} > 0`),
  check("ck_negotiation_rounds_status", sql`${table.status} in ('prepared', 'outbound', 'returned', 'review', 'resolved', 'closed')`),
  check("ck_negotiation_rounds_delivery_method", sql`${table.deliveryMethod} is null or ${table.deliveryMethod} in ('manual', 'email_gateway', 'portal')`),
  check("ck_negotiation_rounds_base_sha256", sql`length(${table.baseSha256}) = 64`),
  check("ck_negotiation_rounds_outbound_sha256", sql`length(${table.outboundSha256}) = 64`),
  check("ck_negotiation_rounds_portal_token_hash", sql`${table.portalTokenHash} is null or length(${table.portalTokenHash}) = 64`),
  check("ck_negotiation_rounds_portal_upload_attempts", sql`${table.portalUploadAttempts} between 0 and 10`),
  check("ck_negotiation_rounds_portal_upload_accepted", sql`${table.portalUploadAccepted} between 0 and 4`),
  check("ck_negotiation_rounds_portal_upload_rejected", sql`${table.portalUploadRejected} between 0 and 6`),
  check("ck_negotiation_rounds_portal_upload_bytes", sql`${table.portalUploadBytes} between 0 and 100663296`),
  check("ck_negotiation_rounds_portal_upload_reservation", sql`(
    ${table.portalUploadReservationId} is null
    and ${table.portalUploadReservationExpiresAt} is null
    and ${table.portalUploadReservationBytes} is null
    and ${table.portalUploadAttempts} = ${table.portalUploadAccepted} + ${table.portalUploadRejected}
  ) or (
    ${table.portalUploadReservationId} is not null
    and ${table.portalUploadReservationExpiresAt} is not null
    and ${table.portalUploadReservationBytes} between 1 and 22020096
    and ${table.portalUploadAttempts} = ${table.portalUploadAccepted} + ${table.portalUploadRejected} + 1
  )`),
  check("ck_negotiation_rounds_portal_download_attempts", sql`${table.portalDownloadAttempts} between 0 and 20`),
  check("ck_negotiation_rounds_portal_download_bytes", sql`${table.portalDownloadBytes} between 0 and 268435456`),
  check("ck_negotiation_rounds_resolved_sha256", sql`${table.resolvedSha256} is null or length(${table.resolvedSha256}) = 64`),
  check("ck_negotiation_rounds_baseline", sql`(${table.baseDocumentVersion} is not null and ${table.baseDocumentId} is null) or (${table.baseDocumentVersion} is null and ${table.baseDocumentId} is not null)`),
  check("ck_negotiation_rounds_base_version", sql`${table.baseDocumentVersion} is null or ${table.baseDocumentVersion} > 0`),
  check("ck_negotiation_rounds_resolved_version", sql`${table.resolvedDocumentVersion} is null or ${table.resolvedDocumentVersion} > 0`),
  uniqueIndex("uq_negotiation_rounds_workspace_agreement_round").on(table.workspaceId, table.agreementId, table.roundNumber),
  uniqueIndex("uq_negotiation_rounds_workspace_active_key").on(table.workspaceId, table.activeKey),
  uniqueIndex("uq_negotiation_rounds_workspace_alias_code").on(table.workspaceId, table.aliasCode),
  uniqueIndex("uq_negotiation_rounds_workspace_portal_token_hash").on(table.workspaceId, table.portalTokenHash),
  index("idx_negotiation_rounds_workspace_agreement_status").on(table.workspaceId, table.agreementId, table.status),
  index("idx_negotiation_rounds_workspace_updated_at").on(table.workspaceId, table.updatedAt),
]);

export const negotiationSubmissionSources = ["email", "portal", "manual"] as const;
export type NegotiationSubmissionSource = (typeof negotiationSubmissionSources)[number];
export const negotiationSubmissionStatuses = ["ready", "sender_review", "quarantined", "rejected", "promoted", "late", "no_attachment"] as const;
export type NegotiationSubmissionStatus = (typeof negotiationSubmissionStatuses)[number];

export const negotiationSubmissions = sqliteTable("negotiation_submissions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  roundId: text("round_id").notNull(),
  source: text("source").$type<NegotiationSubmissionSource>().notNull(),
  status: text("status").$type<NegotiationSubmissionStatus>().notNull(),
  senderEmail: text("sender_email"),
  senderName: text("sender_name"),
  providerMessageId: text("provider_message_id"),
  documentId: text("document_id"),
  documentSha256: text("document_sha256"),
  reviewTextObjectKey: text("review_text_object_key"),
  reviewTextSha256: text("review_text_sha256"),
  reviewTextSize: integer("review_text_size"),
  reviewTextProvenance: text("review_text_provenance"),
  reviewedByUserId: text("reviewed_by_user_id"),
  reviewedAt: text("reviewed_at"),
  decisionNote: text("decision_note"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("ck_negotiation_submissions_source", sql`${table.source} in ('email', 'portal', 'manual')`),
  check("ck_negotiation_submissions_status", sql`${table.status} in ('ready', 'sender_review', 'quarantined', 'rejected', 'promoted', 'late', 'no_attachment')`),
  check("ck_negotiation_submissions_document_sha256", sql`${table.documentSha256} is null or length(${table.documentSha256}) = 64`),
  check("ck_negotiation_submissions_review_text_sha256", sql`${table.reviewTextSha256} is null or length(${table.reviewTextSha256}) = 64`),
  check("ck_negotiation_submissions_review_text_size", sql`${table.reviewTextSize} is null or ${table.reviewTextSize} >= 0`),
  uniqueIndex("uq_negotiation_submissions_workspace_round_document").on(table.workspaceId, table.roundId, table.documentId),
  index("idx_negotiation_submissions_workspace_agreement_round").on(table.workspaceId, table.agreementId, table.roundId),
  index("idx_negotiation_submissions_workspace_status_created_at").on(table.workspaceId, table.status, table.createdAt),
  index("idx_negotiation_submissions_workspace_provider_message").on(table.workspaceId, table.providerMessageId),
]);

export const documentComparisonStatuses = ["ready", "manual_required", "accepted", "rejected", "superseded"] as const;
export type DocumentComparisonStatus = (typeof documentComparisonStatuses)[number];

export const documentComparisons = sqliteTable("document_comparisons", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  roundId: text("round_id").notNull(),
  submissionId: text("submission_id").notNull(),
  baseSha256: text("base_sha256"),
  proposedSha256: text("proposed_sha256"),
  baseTextSha256: text("base_text_sha256"),
  proposedTextSha256: text("proposed_text_sha256"),
  extractor: text("extractor"),
  provenance: text("provenance"),
  status: text("status").$type<DocumentComparisonStatus>().notNull().default("ready"),
  decisionNote: text("decision_note"),
  decidedByUserId: text("decided_by_user_id"),
  decidedAt: text("decided_at"),
  resultingDocumentVersion: integer("resulting_document_version"),
  resultingSha256: text("resulting_sha256"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_document_comparisons_status", sql`${table.status} in ('ready', 'manual_required', 'accepted', 'rejected', 'superseded')`),
  check("ck_document_comparisons_base_sha256", sql`${table.baseSha256} is null or length(${table.baseSha256}) = 64`),
  check("ck_document_comparisons_proposed_sha256", sql`${table.proposedSha256} is null or length(${table.proposedSha256}) = 64`),
  check("ck_document_comparisons_base_text_sha256", sql`${table.baseTextSha256} is null or length(${table.baseTextSha256}) = 64`),
  check("ck_document_comparisons_proposed_text_sha256", sql`${table.proposedTextSha256} is null or length(${table.proposedTextSha256}) = 64`),
  check("ck_document_comparisons_resulting_sha256", sql`${table.resultingSha256} is null or length(${table.resultingSha256}) = 64`),
  check("ck_document_comparisons_resulting_version", sql`${table.resultingDocumentVersion} is null or ${table.resultingDocumentVersion} > 0`),
  uniqueIndex("uq_document_comparisons_workspace_round_submission").on(table.workspaceId, table.roundId, table.submissionId),
  index("idx_document_comparisons_workspace_agreement_round").on(table.workspaceId, table.agreementId, table.roundId),
  index("idx_document_comparisons_workspace_status_updated_at").on(table.workspaceId, table.status, table.updatedAt),
]);

export const languageBlocks = sqliteTable("language_blocks", {
  id: integer("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(UNASSIGNED_WORKSPACE_ID),
  version: integer("version").notNull().default(1),
  title: text("title").notNull(),
  category: text("category").notNull(),
  profile: text("profile").notNull(),
  summary: text("summary").notNull(),
  language: text("language").notNull(),
  uses: integer("uses").notNull().default(0),
}, (table) => [index("idx_language_blocks_workspace").on(table.workspaceId)]);

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(UNASSIGNED_WORKSPACE_ID),
  version: integer("version").notNull().default(1),
  agreementId: integer("agreement_id").notNull(),
  basisHash: text("basis_hash").notNull().default(""),
  documentVersion: integer("document_version").notNull().default(0),
  documentSha256: text("document_sha256").notNull().default(""),
  role: text("role").notNull(),
  requestedByUserId: text("requested_by_user_id").notNull().default(""),
  approver: text("approver").notNull(),
  approverUserId: text("approver_user_id"),
  status: text("status").notNull(),
  decidedByUserId: text("decided_by_user_id"),
  decidedAt: text("decided_at"),
  basisConfirmedAt: text("basis_confirmed_at"),
  sourceAgentPlanId: text("source_agent_plan_id"),
  sourceAgentPlanReviewerUserId: text("source_agent_plan_reviewer_user_id"),
  comment: text("comment"),
  due: text("due").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_approval_requests_workspace_status").on(table.workspaceId, table.status),
  index("idx_approval_requests_workspace_agreement_id").on(table.workspaceId, table.agreementId),
  index("idx_approval_requests_workspace_source_agent_plan").on(table.workspaceId, table.sourceAgentPlanId),
  index("idx_approval_requests_workspace_agent_plan_reviewer").on(table.workspaceId, table.sourceAgentPlanReviewerUserId),
  index("idx_approval_requests_status").on(table.status),
  index("idx_approval_requests_agreement_id").on(table.agreementId),
  check("ck_approval_requests_source_agent_plan_id", sql`${table.sourceAgentPlanId} is null or (
    length(${table.sourceAgentPlanId}) = 36
    and substr(${table.sourceAgentPlanId}, 9, 1) = '-'
    and substr(${table.sourceAgentPlanId}, 14, 1) = '-'
    and substr(${table.sourceAgentPlanId}, 19, 1) = '-'
    and substr(${table.sourceAgentPlanId}, 24, 1) = '-'
    and length(replace(${table.sourceAgentPlanId}, '-', '')) = 32
    and lower(replace(${table.sourceAgentPlanId}, '-', '')) not glob '*[^0-9a-f]*'
  )`),
  check("ck_approval_requests_source_agent_plan_reviewer", sql`${table.sourceAgentPlanReviewerUserId} is null or (
    length(${table.sourceAgentPlanReviewerUserId}) = 36
    and substr(${table.sourceAgentPlanReviewerUserId}, 9, 1) = '-'
    and substr(${table.sourceAgentPlanReviewerUserId}, 14, 1) = '-'
    and substr(${table.sourceAgentPlanReviewerUserId}, 19, 1) = '-'
    and substr(${table.sourceAgentPlanReviewerUserId}, 24, 1) = '-'
    and length(replace(${table.sourceAgentPlanReviewerUserId}, '-', '')) = 32
    and lower(replace(${table.sourceAgentPlanReviewerUserId}, '-', '')) not glob '*[^0-9a-f]*'
  )`),
]);

export const obligationScheduleStatuses = ["active", "paused", "ended"] as const;
export type ObligationScheduleStatus = (typeof obligationScheduleStatuses)[number];
export const obligationRecurrenceUnits = ["once", "week", "month", "year"] as const;
export type ObligationRecurrenceUnit = (typeof obligationRecurrenceUnits)[number];

/**
 * A schedule owns the mutable recurrence cursor and assignment. Its recurrence
 * rule is immutable after creation; changing terms ends this schedule and
 * creates a replacement so historical occurrences retain their exact basis.
 */
export const obligationSchedules = sqliteTable("obligation_schedules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  version: integer("version").notNull().default(1),
  title: text("title").notNull(),
  source: text("source").notNull(),
  ownerUserId: text("owner_user_id"),
  owner: text("owner").notNull(),
  timezone: text("timezone").notNull(),
  recurrenceUnit: text("recurrence_unit").$type<ObligationRecurrenceUnit>().notNull(),
  recurrenceInterval: integer("recurrence_interval").notNull(),
  anchorDate: text("anchor_date").notNull(),
  endDate: text("end_date"),
  reminderLeadDays: text("reminder_lead_days", { mode: "json" }).$type<number[]>().notNull(),
  status: text("status").$type<ObligationScheduleStatus>().notNull().default("active"),
  nextOccurrenceNumber: integer("next_occurrence_number"),
  nextOccurrenceDate: text("next_occurrence_date"),
  nextMaterializationDate: text("next_materialization_date"),
  supersedesScheduleId: text("supersedes_schedule_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_obligation_schedules_status", sql`${table.status} in ('active', 'paused', 'ended')`),
  check("ck_obligation_schedules_unit", sql`${table.recurrenceUnit} in ('once', 'week', 'month', 'year')`),
  check("ck_obligation_schedules_interval", sql`${table.recurrenceInterval} between 1 and 12 and (${table.recurrenceUnit} <> 'once' or ${table.recurrenceInterval} = 1)`),
  check("ck_obligation_schedules_reminders", sql`json_valid(${table.reminderLeadDays}) = 1 and json_type(${table.reminderLeadDays}) = 'array' and json_array_length(${table.reminderLeadDays}) between 1 and 8 and length(${table.reminderLeadDays}) between 3 and 128`),
  check("ck_obligation_schedules_end", sql`${table.endDate} is null or ${table.endDate} >= ${table.anchorDate}`),
  check("ck_obligation_schedules_next_cursor", sql`(
    ${table.nextOccurrenceNumber} is null and ${table.nextOccurrenceDate} is null and ${table.nextMaterializationDate} is null
  ) or (
    ${table.nextOccurrenceNumber} > 0 and ${table.nextOccurrenceDate} is not null and ${table.nextMaterializationDate} is not null
  )`),
  index("idx_obligation_schedules_workspace_agreement").on(table.workspaceId, table.agreementId),
  index("idx_obligation_schedules_workspace_status_materialization").on(table.workspaceId, table.status, table.nextMaterializationDate),
  index("idx_obligation_schedules_workspace_owner_status").on(table.workspaceId, table.ownerUserId, table.status),
]);

/**
 * Existing `obligations` rows are occurrence records. Schedule/rule snapshots
 * make each occurrence independently auditable while lifecycle and assignment
 * fields remain optimistically mutable.
 */
export const obligations = sqliteTable("obligations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(UNASSIGNED_WORKSPACE_ID),
  version: integer("version").notNull().default(1),
  agreementId: integer("agreement_id").notNull(),
  scheduleId: text("schedule_id").notNull(),
  occurrenceNumber: integer("occurrence_number").notNull(),
  title: text("title").notNull(),
  dueDate: text("due_date").notNull(),
  owner: text("owner").notNull(),
  ownerUserId: text("owner_user_id"),
  status: text("status").notNull(),
  completedByUserId: text("completed_by_user_id"),
  completedAt: text("completed_at"),
  completionEvidence: text("completion_evidence"),
  cadence: text("cadence").notNull(),
  source: text("source").notNull(),
  timezone: text("timezone").notNull(),
  reminderLeadDays: text("reminder_lead_days", { mode: "json" }).$type<number[]>().notNull(),
  nextReminderDate: text("next_reminder_date"),
  createdByUserId: text("created_by_user_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_obligations_workspace_status_due_date").on(table.workspaceId, table.status, table.dueDate),
  index("idx_obligations_workspace_agreement_id").on(table.workspaceId, table.agreementId),
  uniqueIndex("uq_obligations_workspace_schedule_occurrence").on(table.workspaceId, table.scheduleId, table.occurrenceNumber),
  index("idx_obligations_workspace_status_next_reminder").on(table.workspaceId, table.status, table.nextReminderDate),
  index("idx_obligations_workspace_owner_status").on(table.workspaceId, table.ownerUserId, table.status),
  index("idx_obligations_status_due_date").on(table.status, table.dueDate),
  index("idx_obligations_agreement_id").on(table.agreementId),
  check("ck_obligations_occurrence_number", sql`${table.occurrenceNumber} > 0`),
  check("ck_obligations_reminder_days", sql`json_valid(${table.reminderLeadDays}) = 1 and json_type(${table.reminderLeadDays}) = 'array' and json_array_length(${table.reminderLeadDays}) between 1 and 8 and length(${table.reminderLeadDays}) between 3 and 128`),
]);

export const obligationEvidenceProvenance = ["native", "legacy_v16"] as const;
export type ObligationEvidenceProvenance = (typeof obligationEvidenceProvenance)[number];

/** One immutable completion-evidence receipt per occurrence. */
export const obligationEvidence = sqliteTable("obligation_evidence", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  obligationId: text("obligation_id").notNull(),
  evidenceText: text("evidence_text").notNull(),
  evidenceSha256: text("evidence_sha256"),
  submittedByUserId: text("submitted_by_user_id"),
  overrideReason: text("override_reason"),
  provenance: text("provenance").$type<ObligationEvidenceProvenance>().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_obligation_evidence_workspace_obligation").on(table.workspaceId, table.obligationId),
  index("idx_obligation_evidence_workspace_agreement").on(table.workspaceId, table.agreementId),
  check("ck_obligation_evidence_provenance", sql`${table.provenance} in ('native', 'legacy_v16')`),
  check("ck_obligation_evidence_digest", sql`(
    ${table.provenance} = 'native' and length(${table.evidenceSha256}) = 64
      and lower(${table.evidenceSha256}) not glob '*[^0-9a-f]*'
  ) or (
    ${table.provenance} = 'legacy_v16' and (${table.evidenceSha256} is null or (
      length(${table.evidenceSha256}) = 64 and lower(${table.evidenceSha256}) not glob '*[^0-9a-f]*'
    ))
  )`),
]);

/**
 * Tenant- and human-bound receipts make schedule creation safe to retry after
 * an ambiguous response. The normalized request digest prevents one key from
 * being reused for a different schedule. Only aggregate IDs are retained:
 * replay must re-prove the parent is active and load the live rows.
 */
export const obligationCreationReceipts = sqliteTable("obligation_creation_receipts", {
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestSha256: text("request_sha256").notNull(),
  agreementId: integer("agreement_id").notNull(),
  scheduleId: text("schedule_id").notNull(),
  obligationId: text("obligation_id").notNull(),
  agreementEventId: text("agreement_event_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId, table.idempotencyKey] }),
  uniqueIndex("uq_obligation_creation_receipts_workspace_schedule").on(table.workspaceId, table.scheduleId),
  uniqueIndex("uq_obligation_creation_receipts_workspace_obligation").on(table.workspaceId, table.obligationId),
  index("idx_obligation_creation_receipts_workspace_agreement").on(table.workspaceId, table.agreementId),
  index("idx_obligation_creation_receipts_workspace_created_at").on(table.workspaceId, table.createdAt),
  check("ck_obligation_creation_receipts_key", sql`length(${table.idempotencyKey}) = 36`),
  check("ck_obligation_creation_receipts_digest", sql`length(${table.requestSha256}) = 64`),
]);

export const agreementEvents = sqliteTable("agreement_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default(UNASSIGNED_WORKSPACE_ID),
  agreementId: integer("agreement_id").notNull(),
  type: text("type").notNull(),
  actorUserId: text("actor_user_id"),
  actorEmail: text("actor_email"),
  actor: text("actor").notNull(),
  detail: text("detail").notNull(),
  previousHash: text("previous_hash"),
  eventHash: text("event_hash"),
  sequence: integer("sequence").notNull().default(0),
  sourceAgentPlanId: text("source_agent_plan_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_agreement_events_workspace_agreement_created_at").on(table.workspaceId, table.agreementId, table.createdAt),
  uniqueIndex("uq_agreement_events_workspace_agreement_sequence").on(table.workspaceId, table.agreementId, table.sequence),
  index("idx_agreement_events_workspace_source_agent_plan").on(table.workspaceId, table.sourceAgentPlanId),
  index("idx_agreement_events_agreement_id_created_at").on(table.agreementId, table.createdAt),
  check("ck_agreement_events_source_agent_plan_id", sql`${table.sourceAgentPlanId} is null or (
    length(${table.sourceAgentPlanId}) = 36
    and substr(${table.sourceAgentPlanId}, 9, 1) = '-'
    and substr(${table.sourceAgentPlanId}, 14, 1) = '-'
    and substr(${table.sourceAgentPlanId}, 19, 1) = '-'
    and substr(${table.sourceAgentPlanId}, 24, 1) = '-'
    and length(replace(${table.sourceAgentPlanId}, '-', '')) = 32
    and lower(replace(${table.sourceAgentPlanId}, '-', '')) not glob '*[^0-9a-f]*'
  )`),
]);

export const agreementVersions = sqliteTable("agreement_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  version: integer("version").notNull(),
  snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  sourceEventId: text("source_event_id"),
  checksumSha256: text("checksum_sha256").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_agreement_versions_workspace_agreement_version").on(table.workspaceId, table.agreementId, table.version),
  index("idx_agreement_versions_workspace_created_at").on(table.workspaceId, table.createdAt),
]);

export const agreementDocumentVersions = sqliteTable("agreement_document_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  version: integer("version").notNull(),
  label: text("label").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  sourceDocumentId: text("source_document_id"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("uq_agreement_document_versions_workspace_agreement_version").on(table.workspaceId, table.agreementId, table.version),
  index("idx_agreement_document_versions_workspace_created_at").on(table.workspaceId, table.createdAt),
]);

export const outboxEvents = sqliteTable("outbox_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  topic: text("topic").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: text("available_at").notNull(),
  lockedAt: text("locked_at"),
  processedAt: text("processed_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_outbox_events_status_available_at").on(table.status, table.availableAt),
  index("idx_outbox_events_workspace_created_at").on(table.workspaceId, table.createdAt),
]);

export const outboxDeliverySinks = ["delivery", "crm"] as const;
export type OutboxDeliverySink = (typeof outboxDeliverySinks)[number];
export const outboxDeliveryStatuses = ["pending", "accepted", "dead"] as const;
export type OutboxDeliveryStatus = (typeof outboxDeliveryStatuses)[number];

/**
 * Per-destination delivery state. Keeping this separate from the event makes a
 * partially successful fan-out resumable: a CRM retry never resends an event
 * that the notification gateway has already accepted (and vice versa).
 */
export const outboxDeliveries = sqliteTable("outbox_deliveries", {
  eventId: text("event_id").notNull().references(() => outboxEvents.id, { onDelete: "cascade" }),
  sink: text("sink").$type<OutboxDeliverySink>().notNull(),
  workspaceId: text("workspace_id").notNull(),
  status: text("status").$type<OutboxDeliveryStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: text("available_at").notNull(),
  acceptedAt: text("accepted_at"),
  lastError: text("last_error"),
  crmProvider: text("crm_provider").$type<"hubspot" | "salesforce" | "custom">(),
  crmMappingVersion: text("crm_mapping_version"),
  crmDestinationFingerprint: text("crm_destination_fingerprint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.sink] }),
  check("ck_outbox_deliveries_sink", sql`${table.sink} in ('delivery', 'crm')`),
  check("ck_outbox_deliveries_status", sql`${table.status} in ('pending', 'accepted', 'dead')`),
  index("idx_outbox_deliveries_workspace_status_available_at").on(table.workspaceId, table.status, table.availableAt),
  index("idx_outbox_deliveries_workspace_event").on(table.workspaceId, table.eventId),
]);

export const signaturePackets = sqliteTable("signature_packets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agreementId: integer("agreement_id").notNull(),
  basisHash: text("basis_hash").notNull().default(""),
  documentVersion: integer("document_version").notNull().default(0),
  documentSha256: text("document_sha256").notNull().default(""),
  activeKey: text("active_key"),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  submissionId: text("submission_id"),
  status: text("status").notNull(),
  signers: text("signers", { mode: "json" }).$type<Array<Record<string, unknown>>>().notNull(),
  evidenceDocumentId: text("evidence_document_id"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  uniqueIndex("uq_signature_packets_workspace_provider_external").on(table.workspaceId, table.provider, table.externalId),
  uniqueIndex("uq_signature_packets_workspace_active_key").on(table.workspaceId, table.activeKey),
  index("idx_signature_packets_workspace_agreement").on(table.workspaceId, table.agreementId),
  index("idx_signature_packets_workspace_status").on(table.workspaceId, table.status),
]);

export const webhookReceipts = sqliteTable("webhook_receipts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id"),
  payloadDigest: text("payload_digest").notNull(),
  aggregateType: text("aggregate_type"),
  aggregateId: text("aggregate_id"),
  status: text("status").notNull().default("received"),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
  error: text("error"),
}, (table) => [
  uniqueIndex("uq_webhook_receipts_workspace_provider_event").on(table.workspaceId, table.provider, table.providerEventId),
  uniqueIndex("uq_webhook_receipts_workspace_provider_digest").on(table.workspaceId, table.provider, table.payloadDigest),
  index("idx_webhook_receipts_workspace_received_at").on(table.workspaceId, table.receivedAt),
  index("idx_webhook_receipts_workspace_aggregate").on(table.workspaceId, table.aggregateType, table.aggregateId),
]);

export const servicePrincipalStatuses = ["active", "disabled"] as const;
export type ServicePrincipalStatus = (typeof servicePrincipalStatuses)[number];

/**
 * A workload identity is registered by its verified issuer/subject pair. Notice
 * never stores the Cloudflare Access service-token secret or another bearer.
 */
export const servicePrincipals = sqliteTable("service_principals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  status: text("status").$type<ServicePrincipalStatus>().notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at"),
}, (table) => [
  check("ck_service_principals_status", sql`${table.status} in ('active', 'disabled')`),
  check("ck_service_principals_version", sql`${table.version} > 0`),
  uniqueIndex("uq_service_principals_workspace_identity").on(table.workspaceId, table.issuer, table.subject),
  index("idx_service_principals_workspace_status").on(table.workspaceId, table.status),
]);

export const agentGrantStatuses = ["active", "revoked"] as const;
export type AgentGrantStatus = (typeof agentGrantStatuses)[number];

export const agentGrants = sqliteTable("agent_grants", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  principalId: text("principal_id").notNull().references(() => servicePrincipals.id, { onDelete: "cascade" }),
  delegatorUserId: text("delegator_user_id").notNull().references(() => users.id),
  status: text("status").$type<AgentGrantStatus>().notNull().default("active"),
  actionIds: text("action_ids", { mode: "json" }).$type<string[]>().notNull(),
  resourceConstraints: text("resource_constraints", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  policyVersion: text("policy_version").notNull(),
  startsAt: text("starts_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  revokedByUserId: text("revoked_by_user_id"),
  revocationReason: text("revocation_reason"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_agent_grants_status", sql`${table.status} in ('active', 'revoked')`),
  check("ck_agent_grants_window", sql`${table.expiresAt} > ${table.startsAt}`),
  check("ck_agent_grants_version", sql`${table.version} > 0`),
  check("ck_agent_grants_actions", sql`json_valid(${table.actionIds}) = 1 and length(${table.actionIds}) between 2 and 16384`),
  check("ck_agent_grants_resources", sql`json_valid(${table.resourceConstraints}) = 1 and length(${table.resourceConstraints}) between 2 and 65536`),
  index("idx_agent_grants_workspace_principal_status").on(table.workspaceId, table.principalId, table.status),
  index("idx_agent_grants_workspace_delegator").on(table.workspaceId, table.delegatorUserId),
  index("idx_agent_grants_workspace_expiry").on(table.workspaceId, table.expiresAt),
]);

export const agentRunStatuses = ["running", "succeeded", "failed", "cancelled"] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  principalId: text("principal_id").notNull().references(() => servicePrincipals.id, { onDelete: "cascade" }),
  grantId: text("grant_id").notNull().references(() => agentGrants.id),
  sponsorUserId: text("sponsor_user_id").notNull().references(() => users.id),
  purpose: text("purpose").notNull(),
  status: text("status").$type<AgentRunStatus>().notNull().default("running"),
  modelProvider: text("model_provider"),
  modelId: text("model_id"),
  toolVersion: text("tool_version").notNull(),
  promptSha256: text("prompt_sha256"),
  contextSha256: text("context_sha256"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  check("ck_agent_runs_status", sql`${table.status} in ('running', 'succeeded', 'failed', 'cancelled')`),
  check("ck_agent_runs_prompt_digest", sql`${table.promptSha256} is null or length(${table.promptSha256}) = 64`),
  check("ck_agent_runs_context_digest", sql`${table.contextSha256} is null or length(${table.contextSha256}) = 64`),
  index("idx_agent_runs_workspace_principal_started").on(table.workspaceId, table.principalId, table.startedAt),
  index("idx_agent_runs_workspace_status").on(table.workspaceId, table.status),
]);

export const agentPlanStatuses = [
  "draft",
  "pending_approval",
  "approved",
  "executing",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "superseded",
  "expired",
  "rejected",
  "cancelled",
] as const;
export type AgentPlanStatus = (typeof agentPlanStatuses)[number];

export const agentActionPlans = sqliteTable("agent_action_plans", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  principalId: text("principal_id").notNull().references(() => servicePrincipals.id, { onDelete: "cascade" }),
  grantId: text("grant_id").notNull().references(() => agentGrants.id),
  runId: text("run_id").references(() => agentRuns.id),
  actionId: text("action_id").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  agreementId: integer("agreement_id"),
  canonicalInput: text("canonical_input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  inputSha256: text("input_sha256").notNull(),
  planSha256: text("plan_sha256").notNull(),
  expectedVersion: integer("expected_version"),
  basisHash: text("basis_hash"),
  documentVersion: integer("document_version"),
  documentSha256: text("document_sha256"),
  policyVersion: text("policy_version").notNull(),
  riskTier: text("risk_tier").$type<"low" | "medium" | "high" | "critical">().notNull(),
  status: text("status").$type<AgentPlanStatus>().notNull().default("draft"),
  beforeSnapshot: text("before_snapshot", { mode: "json" }).$type<Record<string, unknown> | null>(),
  proposedDiff: text("proposed_diff", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  blockers: text("blockers", { mode: "json" }).$type<Array<Record<string, unknown>>>().notNull(),
  provenance: text("provenance", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdByUserId: text("created_by_user_id").references(() => users.id),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_agent_action_plans_status", sql`${table.status} in ('draft', 'pending_approval', 'approved', 'executing', 'succeeded', 'failed_retryable', 'failed_terminal', 'superseded', 'expired', 'rejected', 'cancelled')`),
  check("ck_agent_action_plans_risk", sql`${table.riskTier} in ('low', 'medium', 'high', 'critical')`),
  check("ck_agent_action_plans_input_digest", sql`length(${table.inputSha256}) = 64`),
  check("ck_agent_action_plans_plan_digest", sql`length(${table.planSha256}) = 64`),
  check("ck_agent_action_plans_basis", sql`${table.basisHash} is null or length(${table.basisHash}) = 64`),
  check("ck_agent_action_plans_document_digest", sql`${table.documentSha256} is null or length(${table.documentSha256}) = 64`),
  check("ck_agent_action_plans_input_json", sql`json_valid(${table.canonicalInput}) = 1 and length(${table.canonicalInput}) between 2 and 262144`),
  check("ck_agent_action_plans_diff_json", sql`json_valid(${table.proposedDiff}) = 1 and length(${table.proposedDiff}) between 2 and 262144`),
  check("ck_agent_action_plans_blockers_json", sql`json_valid(${table.blockers}) = 1 and length(${table.blockers}) between 2 and 65536`),
  check("ck_agent_action_plans_provenance_json", sql`json_valid(${table.provenance}) = 1 and length(${table.provenance}) between 2 and 65536`),
  index("idx_agent_action_plans_workspace_principal_status").on(table.workspaceId, table.principalId, table.status),
  index("idx_agent_action_plans_workspace_agreement").on(table.workspaceId, table.agreementId),
  index("idx_agent_action_plans_workspace_expires").on(table.workspaceId, table.expiresAt),
]);

export const agentPlanDecisions = sqliteTable("agent_plan_decisions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => agentActionPlans.id, { onDelete: "cascade" }),
  planSha256: text("plan_sha256").notNull(),
  decision: text("decision").$type<"approved" | "rejected">().notNull(),
  reason: text("reason").notNull(),
  decidedByUserId: text("decided_by_user_id").notNull().references(() => users.id),
  decidedAt: text("decided_at").notNull(),
}, (table) => [
  check("ck_agent_plan_decisions_digest", sql`length(${table.planSha256}) = 64`),
  check("ck_agent_plan_decisions_decision", sql`${table.decision} in ('approved', 'rejected')`),
  check("ck_agent_plan_decisions_reason", sql`length(trim(${table.reason})) between 3 and 4000`),
  uniqueIndex("uq_agent_plan_decisions_workspace_plan").on(table.workspaceId, table.planId),
  index("idx_agent_plan_decisions_workspace_decided").on(table.workspaceId, table.decidedAt),
]);

export const agentExecutionStatuses = ["executing", "succeeded", "failed_retryable", "failed_terminal"] as const;
export type AgentExecutionStatus = (typeof agentExecutionStatuses)[number];

export const agentActionExecutions = sqliteTable("agent_action_executions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => agentActionPlans.id),
  principalId: text("principal_id").notNull().references(() => servicePrincipals.id),
  grantId: text("grant_id").notNull().references(() => agentGrants.id),
  actionId: text("action_id").notNull(),
  planSha256: text("plan_sha256").notNull(),
  requestSha256: text("request_sha256").notNull(),
  idempotencyKeySha256: text("idempotency_key_sha256").notNull(),
  status: text("status").$type<AgentExecutionStatus>().notNull().default("executing"),
  result: text("result", { mode: "json" }).$type<Record<string, unknown> | null>(),
  agreementEventIds: text("agreement_event_ids", { mode: "json" }).$type<string[]>().notNull(),
  provenance: text("provenance", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  check("ck_agent_action_executions_status", sql`${table.status} in ('executing', 'succeeded', 'failed_retryable', 'failed_terminal')`),
  check("ck_agent_action_executions_plan_digest", sql`length(${table.planSha256}) = 64`),
  check("ck_agent_action_executions_request_digest", sql`length(${table.requestSha256}) = 64`),
  check("ck_agent_action_executions_key_digest", sql`length(${table.idempotencyKeySha256}) = 64`),
  check("ck_agent_action_executions_events_json", sql`json_valid(${table.agreementEventIds}) = 1 and length(${table.agreementEventIds}) between 2 and 65536`),
  check("ck_agent_action_executions_provenance_json", sql`json_valid(${table.provenance}) = 1 and length(${table.provenance}) between 2 and 65536`),
  uniqueIndex("uq_agent_action_executions_workspace_principal_key").on(table.workspaceId, table.principalId, table.idempotencyKeySha256),
  index("idx_agent_action_executions_workspace_plan").on(table.workspaceId, table.planId),
  index("idx_agent_action_executions_workspace_started").on(table.workspaceId, table.startedAt),
]);

export const clausePlaybookStatuses = ["draft", "published", "retired"] as const;
export type ClausePlaybookStatus = (typeof clausePlaybookStatuses)[number];

/** Governed playbook identity. Published language lives in immutable version
 * rows so a later draft can never rewrite the evidence used by a review. */
export const clausePlaybooks = sqliteTable("clause_playbooks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  scope: text("scope", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<ClausePlaybookStatus>().notNull().default("draft"),
  currentPublishedVersion: integer("current_published_version"),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => users.id),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_clause_playbooks_status", sql`${table.status} in ('draft', 'published', 'retired')`),
  check("ck_clause_playbooks_scope", sql`json_valid(${table.scope}) = 1 and json_type(${table.scope}) = 'object' and length(${table.scope}) between 2 and 32768`),
  check("ck_clause_playbooks_published_version", sql`${table.currentPublishedVersion} is null or ${table.currentPublishedVersion} > 0`),
  uniqueIndex("uq_clause_playbooks_workspace_name").on(table.workspaceId, table.name),
  index("idx_clause_playbooks_workspace_status_updated").on(table.workspaceId, table.status, table.updatedAt),
]);

export const clausePlaybookVersions = sqliteTable("clause_playbook_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  playbookId: text("playbook_id").notNull().references(() => clausePlaybooks.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: text("status").$type<"draft" | "published">().notNull().default("draft"),
  rules: text("rules", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  contentSha256: text("content_sha256").notNull(),
  changeSummary: text("change_summary").notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
  publishedByUserId: text("published_by_user_id").references(() => users.id),
  publishedAt: text("published_at"),
}, (table) => [
  check("ck_clause_playbook_versions_version", sql`${table.version} > 0`),
  check("ck_clause_playbook_versions_status", sql`${table.status} in ('draft', 'published')`),
  check("ck_clause_playbook_versions_rules", sql`json_valid(${table.rules}) = 1 and json_type(${table.rules}) = 'object' and length(${table.rules}) between 2 and 262144`),
  check("ck_clause_playbook_versions_digest", sql`length(${table.contentSha256}) = 64 and lower(${table.contentSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_clause_playbook_versions_publisher", sql`(${table.status} = 'draft' and ${table.publishedByUserId} is null and ${table.publishedAt} is null) or (${table.status} = 'published' and ${table.publishedByUserId} is not null and ${table.publishedAt} is not null and ${table.publishedByUserId} <> ${table.createdByUserId})`),
  uniqueIndex("uq_clause_playbook_versions_workspace_playbook_version").on(table.workspaceId, table.playbookId, table.version),
  index("idx_clause_playbook_versions_workspace_playbook_status").on(table.workspaceId, table.playbookId, table.status),
]);

/** Initial clause-playbook creation receipt; see governed-template receipts. */
export const clausePlaybookCreationReceipts = sqliteTable("clause_playbook_creation_receipts", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  idempotencyKeySha256: text("idempotency_key_sha256").notNull(),
  requestSha256: text("request_sha256").notNull(),
  playbookId: text("playbook_id").notNull().references(() => clausePlaybooks.id, { onDelete: "cascade" }),
  playbookVersionId: text("playbook_version_id").notNull().references(() => clausePlaybookVersions.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId, table.idempotencyKeySha256] }),
  check("ck_clause_playbook_creation_receipts_key_digest", sql`length(${table.idempotencyKeySha256}) = 64 and lower(${table.idempotencyKeySha256}) not glob '*[^0-9a-f]*'`),
  check("ck_clause_playbook_creation_receipts_request_digest", sql`length(${table.requestSha256}) = 64 and lower(${table.requestSha256}) not glob '*[^0-9a-f]*'`),
  uniqueIndex("uq_clause_playbook_creation_receipts_workspace_playbook").on(table.workspaceId, table.playbookId),
  uniqueIndex("uq_clause_playbook_creation_receipts_workspace_version").on(table.workspaceId, table.playbookVersionId),
  index("idx_clause_playbook_creation_receipts_workspace_created").on(table.workspaceId, table.createdAt),
]);

export const ingestionBatchStatuses = ["awaiting_upload", "review", "completed", "cancelled"] as const;
export type IngestionBatchStatus = (typeof ingestionBatchStatuses)[number];
export const ingestionItemStatuses = ["awaiting_upload", "duplicate", "pending_extraction", "review_required", "accepted", "rejected", "failed"] as const;
export type IngestionItemStatus = (typeof ingestionItemStatuses)[number];

export const ingestionBatches = sqliteTable("ingestion_batches", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  idempotencyKeySha256: text("idempotency_key_sha256").notNull(),
  requestSha256: text("request_sha256").notNull(),
  status: text("status").$type<IngestionBatchStatus>().notNull(),
  itemCount: integer("item_count").notNull(),
  acceptedCount: integer("accepted_count").notNull().default(0),
  rejectedCount: integer("rejected_count").notNull().default(0),
  blockerCode: text("blocker_code"),
  blockerMessage: text("blocker_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  check("ck_ingestion_batches_status", sql`${table.status} in ('awaiting_upload', 'review', 'completed', 'cancelled')`),
  check("ck_ingestion_batches_item_count", sql`${table.itemCount} between 1 and 50`),
  check("ck_ingestion_batches_counts", sql`${table.acceptedCount} >= 0 and ${table.rejectedCount} >= 0 and ${table.acceptedCount} + ${table.rejectedCount} <= ${table.itemCount}`),
  check("ck_ingestion_batches_key_digest", sql`length(${table.idempotencyKeySha256}) = 64 and lower(${table.idempotencyKeySha256}) not glob '*[^0-9a-f]*'`),
  check("ck_ingestion_batches_request_digest", sql`length(${table.requestSha256}) = 64 and lower(${table.requestSha256}) not glob '*[^0-9a-f]*'`),
  uniqueIndex("uq_ingestion_batches_workspace_user_key").on(table.workspaceId, table.createdByUserId, table.idempotencyKeySha256),
  index("idx_ingestion_batches_workspace_status_updated").on(table.workspaceId, table.status, table.updatedAt),
]);

export const ingestionItems = sqliteTable("ingestion_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  batchId: text("batch_id").notNull().references(() => ingestionBatches.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  dedupeSha256: text("dedupe_sha256").notNull(),
  documentId: text("document_id").references(() => documents.id, { onDelete: "set null" }),
  duplicateOfDocumentId: text("duplicate_of_document_id").references(() => documents.id, { onDelete: "set null" }),
  status: text("status").$type<IngestionItemStatus>().notNull(),
  blockerCode: text("blocker_code"),
  blockerMessage: text("blocker_message"),
  reviewedByUserId: text("reviewed_by_user_id").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  reviewReason: text("review_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_ingestion_items_ordinal", sql`${table.ordinal} between 0 and 49`),
  check("ck_ingestion_items_size", sql`${table.size} between 1 and 20971520`),
  check("ck_ingestion_items_source_digest", sql`length(${table.sourceSha256}) = 64 and lower(${table.sourceSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_ingestion_items_dedupe_digest", sql`length(${table.dedupeSha256}) = 64 and lower(${table.dedupeSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_ingestion_items_status", sql`${table.status} in ('awaiting_upload', 'duplicate', 'pending_extraction', 'review_required', 'accepted', 'rejected', 'failed')`),
  check("ck_ingestion_items_review", sql`(${table.status} in ('accepted', 'rejected') and ${table.reviewedByUserId} is not null and ${table.reviewedAt} is not null and length(trim(${table.reviewReason})) between 3 and 4000) or (${table.status} not in ('accepted', 'rejected') and ${table.reviewedByUserId} is null and ${table.reviewedAt} is null and ${table.reviewReason} is null)`),
  uniqueIndex("uq_ingestion_items_workspace_batch_ordinal").on(table.workspaceId, table.batchId, table.ordinal),
  index("idx_ingestion_items_workspace_batch_status").on(table.workspaceId, table.batchId, table.status),
  index("idx_ingestion_items_workspace_dedupe").on(table.workspaceId, table.dedupeSha256),
]);

/** Immutable extractor-registered text chunks. Citation offsets are Unicode
 * code-point offsets into the caller-asserted text identified by
 * sourceTextSha256; reviewers still compare citations with protected paper. */
export const repositoryFragments = sqliteTable("repository_fragments", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  documentVersionId: text("document_version_id").notNull().references(() => agreementDocumentVersions.id, { onDelete: "cascade" }),
  agreementId: integer("agreement_id").notNull().references(() => agreements.id, { onDelete: "cascade" }),
  documentVersion: integer("document_version").notNull(),
  documentSha256: text("document_sha256").notNull(),
  sourceTextSha256: text("source_text_sha256").notNull(),
  ordinal: integer("ordinal").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  content: text("content").notNull(),
  contentSha256: text("content_sha256").notNull(),
  extractor: text("extractor").notNull(),
  extractorVersion: text("extractor_version").notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("ck_repository_fragments_document_version", sql`${table.documentVersion} > 0`),
  check("ck_repository_fragments_document_digest", sql`length(${table.documentSha256}) = 64 and lower(${table.documentSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_repository_fragments_text_digest", sql`length(${table.sourceTextSha256}) = 64 and lower(${table.sourceTextSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_repository_fragments_content_digest", sql`length(${table.contentSha256}) = 64 and lower(${table.contentSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_repository_fragments_offsets", sql`${table.ordinal} >= 0 and ${table.startOffset} >= 0 and ${table.endOffset} > ${table.startOffset} and ${table.endOffset} - ${table.startOffset} <= 12000`),
  check("ck_repository_fragments_content", sql`length(${table.content}) between 1 and 12000`),
  uniqueIndex("uq_repository_fragments_workspace_source_ordinal").on(table.workspaceId, table.documentVersionId, table.sourceTextSha256, table.ordinal),
  index("idx_repository_fragments_workspace_document").on(table.workspaceId, table.documentVersionId, table.documentVersion),
  index("idx_repository_fragments_workspace_agreement").on(table.workspaceId, table.agreementId),
  index("idx_repository_fragments_workspace_created").on(table.workspaceId, table.createdAt, table.id),
]);

export const extractionProposalStatuses = ["pending_review", "accepted", "rejected", "superseded"] as const;
export type ExtractionProposalStatus = (typeof extractionProposalStatuses)[number];

export const extractionProposals = sqliteTable("extraction_proposals", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  documentVersionId: text("document_version_id").notNull().references(() => agreementDocumentVersions.id, { onDelete: "cascade" }),
  agreementId: integer("agreement_id").notNull().references(() => agreements.id, { onDelete: "cascade" }),
  ingestionItemId: text("ingestion_item_id").references(() => ingestionItems.id, { onDelete: "set null" }),
  documentVersion: integer("document_version").notNull(),
  documentSha256: text("document_sha256").notNull(),
  sourceTextSha256: text("source_text_sha256").notNull(),
  targetType: text("target_type").$type<"agreement_field" | "custom_field">().notNull(),
  targetField: text("target_field").notNull(),
  customFieldDefinitionId: text("custom_field_definition_id").references(() => customFieldDefinitions.id, { onDelete: "restrict" }),
  proposedValue: text("proposed_value", { mode: "json" }).$type<unknown>().notNull(),
  confidencePpm: integer("confidence_ppm").notNull(),
  extractor: text("extractor").notNull(),
  extractorVersion: text("extractor_version").notNull(),
  status: text("status").$type<ExtractionProposalStatus>().notNull().default("pending_review"),
  applicationStatus: text("application_status").$type<"not_reviewed" | "blocked">().notNull().default("not_reviewed"),
  blockerCode: text("blocker_code").notNull().default("human_review_required"),
  blockerMessage: text("blocker_message").notNull().default("A human reviewer must accept or reject this proposal."),
  reviewedByUserId: text("reviewed_by_user_id").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  reviewReason: text("review_reason"),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("ck_extraction_proposals_document_version", sql`${table.documentVersion} > 0`),
  check("ck_extraction_proposals_document_digest", sql`length(${table.documentSha256}) = 64 and lower(${table.documentSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_extraction_proposals_text_digest", sql`length(${table.sourceTextSha256}) = 64 and lower(${table.sourceTextSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_extraction_proposals_target", sql`(${table.targetType} = 'agreement_field' and ${table.customFieldDefinitionId} is null) or (${table.targetType} = 'custom_field' and ${table.customFieldDefinitionId} is not null)`),
  check("ck_extraction_proposals_value", sql`json_valid(${table.proposedValue}) = 1 and length(${table.proposedValue}) between 1 and 32768`),
  check("ck_extraction_proposals_confidence", sql`${table.confidencePpm} between 0 and 1000000`),
  check("ck_extraction_proposals_status", sql`${table.status} in ('pending_review', 'accepted', 'rejected', 'superseded')`),
  check("ck_extraction_proposals_application", sql`${table.applicationStatus} in ('not_reviewed', 'blocked')`),
  check("ck_extraction_proposals_review", sql`(${table.status} = 'pending_review' and ${table.reviewedByUserId} is null and ${table.reviewedAt} is null and ${table.reviewReason} is null and ${table.applicationStatus} = 'not_reviewed' and ${table.blockerCode} = 'human_review_required') or (${table.status} in ('accepted', 'rejected', 'superseded') and ${table.reviewedByUserId} is not null and ${table.reviewedAt} is not null and length(trim(${table.reviewReason})) between 3 and 4000 and ${table.applicationStatus} = 'blocked')`),
  index("idx_extraction_proposals_workspace_status_updated").on(table.workspaceId, table.status, table.updatedAt),
  index("idx_extraction_proposals_workspace_document").on(table.workspaceId, table.documentVersionId, table.documentVersion),
  index("idx_extraction_proposals_workspace_agreement").on(table.workspaceId, table.agreementId),
]);

export const extractionProposalCitations = sqliteTable("extraction_proposal_citations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  proposalId: text("proposal_id").notNull().references(() => extractionProposals.id, { onDelete: "cascade" }),
  fragmentId: text("fragment_id").notNull().references(() => repositoryFragments.id, { onDelete: "cascade" }),
  documentVersionId: text("document_version_id").notNull().references(() => agreementDocumentVersions.id, { onDelete: "cascade" }),
  documentVersion: integer("document_version").notNull(),
  documentSha256: text("document_sha256").notNull(),
  sourceTextSha256: text("source_text_sha256").notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
  quote: text("quote").notNull(),
  quoteSha256: text("quote_sha256").notNull(),
}, (table) => [
  check("ck_extraction_proposal_citations_version", sql`${table.documentVersion} > 0`),
  check("ck_extraction_proposal_citations_document_digest", sql`length(${table.documentSha256}) = 64 and lower(${table.documentSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_extraction_proposal_citations_text_digest", sql`length(${table.sourceTextSha256}) = 64 and lower(${table.sourceTextSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_extraction_proposal_citations_quote_digest", sql`length(${table.quoteSha256}) = 64 and lower(${table.quoteSha256}) not glob '*[^0-9a-f]*'`),
  check("ck_extraction_proposal_citations_offsets", sql`${table.startOffset} >= 0 and ${table.endOffset} > ${table.startOffset} and length(${table.quote}) between 1 and 12000`),
  uniqueIndex("uq_extraction_proposal_citations_workspace_proposal_fragment_offsets").on(table.workspaceId, table.proposalId, table.fragmentId, table.startOffset, table.endOffset),
  index("idx_extraction_proposal_citations_workspace_proposal").on(table.workspaceId, table.proposalId),
]);

import { CrmProviderError, type CanonicalCrmEvent, type CrmProvider } from "./types";

export const MAPPABLE_FIELDS = [
  "externalId",
  "workspaceId",
  "agreementId",
  "aggregateVersion",
  "mappingVersion",
  "deleted",
  "topic",
  "occurredAt",
  "party",
  "type",
  "value",
  "valueMinor",
  "currencyCode",
  "stage",
  "owner",
  "department",
  "risk",
  "approvalStatus",
  "signatureStatus",
  "effectiveDate",
  "expirationDate",
  "crm",
  "crmRecord",
  "updatedAt",
  "deletedAt",
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];
export type FieldMapping = Readonly<Record<MappableField, string>>;
export type MappedValue = string | number | boolean | null;
export type MappedRecord = Readonly<Record<string, MappedValue>>;

const FIELD_SET = new Set<string>(MAPPABLE_FIELDS);
const HUBSPOT_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const SALESFORCE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const CUSTOM_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;

const HUBSPOT_DEFAULTS: FieldMapping = {
  externalId: "notice_external_id",
  workspaceId: "notice_workspace_id",
  agreementId: "notice_agreement_id",
  aggregateVersion: "notice_aggregate_version",
  mappingVersion: "notice_mapping_version",
  deleted: "notice_deleted",
  topic: "notice_event_topic",
  occurredAt: "notice_event_occurred_at",
  party: "notice_party",
  type: "notice_agreement_type",
  value: "notice_contract_value",
  valueMinor: "notice_contract_value_minor",
  currencyCode: "notice_contract_currency",
  stage: "notice_stage",
  owner: "notice_owner",
  department: "notice_department",
  risk: "notice_risk",
  approvalStatus: "notice_approval_status",
  signatureStatus: "notice_signature_status",
  effectiveDate: "notice_effective_date",
  expirationDate: "notice_expiration_date",
  crm: "notice_crm_provider",
  crmRecord: "notice_crm_record",
  updatedAt: "notice_updated_at",
  deletedAt: "notice_deleted_at",
};

const SALESFORCE_DEFAULTS: FieldMapping = {
  externalId: "Notice_External_Id__c",
  workspaceId: "Notice_Workspace_Id__c",
  agreementId: "Notice_Agreement_Id__c",
  aggregateVersion: "Notice_Aggregate_Version__c",
  mappingVersion: "Notice_Mapping_Version__c",
  deleted: "Notice_Deleted__c",
  topic: "Notice_Event_Topic__c",
  occurredAt: "Notice_Event_Occurred_At__c",
  party: "Notice_Party__c",
  type: "Notice_Agreement_Type__c",
  value: "Notice_Contract_Value__c",
  valueMinor: "Notice_Contract_Value_Minor__c",
  currencyCode: "Notice_Contract_Currency__c",
  stage: "Notice_Stage__c",
  owner: "Notice_Owner__c",
  department: "Notice_Department__c",
  risk: "Notice_Risk__c",
  approvalStatus: "Notice_Approval_Status__c",
  signatureStatus: "Notice_Signature_Status__c",
  effectiveDate: "Notice_Effective_Date__c",
  expirationDate: "Notice_Expiration_Date__c",
  crm: "Notice_CRM_Provider__c",
  crmRecord: "Notice_CRM_Record__c",
  updatedAt: "Notice_Updated_At__c",
  deletedAt: "Notice_Deleted_At__c",
};

const CUSTOM_DEFAULTS = Object.fromEntries(MAPPABLE_FIELDS.map((key) => [key, key])) as Record<MappableField, string>;

function invalidMapping(): never {
  throw new CrmProviderError("CRM_MAPPING_INVALID", false);
}

export function buildFieldMapping(
  provider: CrmProvider,
  rawJson: unknown,
  externalIdField: string,
): FieldMapping {
  const defaults = provider === "hubspot"
    ? HUBSPOT_DEFAULTS
    : provider === "salesforce"
      ? SALESFORCE_DEFAULTS
      : CUSTOM_DEFAULTS;
  let overrides: Record<string, unknown> = {};
  if (rawJson !== undefined && rawJson !== null && rawJson !== "") {
    if (typeof rawJson !== "string" || rawJson.length > 8_192) invalidMapping();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      invalidMapping();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalidMapping();
    overrides = parsed as Record<string, unknown>;
  }

  if (Object.keys(overrides).some((key) => !FIELD_SET.has(key))) invalidMapping();
  const pattern = provider === "hubspot" ? HUBSPOT_FIELD : provider === "salesforce" ? SALESFORCE_FIELD : CUSTOM_FIELD;
  const result = { ...defaults, externalId: externalIdField } as Record<MappableField, string>;
  for (const [key, candidate] of Object.entries(overrides)) {
    if (typeof candidate !== "string" || !pattern.test(candidate)) invalidMapping();
    if (key === "externalId" && candidate !== externalIdField) invalidMapping();
    result[key as MappableField] = candidate;
  }
  const targetNames = Object.values(result);
  if (new Set(targetNames).size !== targetNames.length) invalidMapping();
  return result;
}

function canonicalValues(event: CanonicalCrmEvent): Record<MappableField, MappedValue> {
  const projection = event.projection;
  return {
    externalId: event.externalKey,
    workspaceId: event.workspaceId,
    agreementId: event.agreementId,
    aggregateVersion: event.aggregateVersion,
    mappingVersion: event.mappingVersion,
    deleted: event.deleted,
    topic: event.topic,
    occurredAt: event.occurredAt,
    party: projection?.party ?? null,
    type: projection?.type ?? null,
    value: projection?.value ?? null,
    valueMinor: projection?.valueMinor ?? null,
    currencyCode: projection?.currencyCode ?? null,
    stage: projection?.stage ?? null,
    owner: projection?.owner ?? null,
    department: projection?.department ?? null,
    risk: projection?.risk ?? null,
    approvalStatus: projection?.approvalStatus ?? null,
    signatureStatus: projection?.signatureStatus ?? null,
    effectiveDate: projection?.effectiveDate ?? null,
    expirationDate: projection?.expirationDate ?? null,
    crm: projection?.crm ?? event.tombstone?.crm ?? null,
    crmRecord: projection?.crmRecord ?? event.tombstone?.crmRecord ?? null,
    updatedAt: projection?.updatedAt ?? null,
    deletedAt: event.tombstone?.deletedAt ?? null,
  };
}

export function mapCanonicalEvent(event: CanonicalCrmEvent, mapping: FieldMapping): MappedRecord {
  const canonical = canonicalValues(event);
  const mapped: Record<string, MappedValue> = {};
  for (const field of MAPPABLE_FIELDS) mapped[mapping[field]] = canonical[field];
  return mapped;
}

export type CrmProvider = "hubspot" | "salesforce" | "custom";

/**
 * The bounded, provider-neutral projection accepted by every CRM adapter.
 * Optional business dates and CRM links use an empty string when Notice has
 * no value so adapters can deliberately clear stale provider fields.
 */
export type AgreementProjection = Readonly<{
  externalKey: string;
  workspaceId: string;
  agreementId: number;
  version: number;
  party: string;
  type: string;
  value: number;
  /** Present on v18+ Notice projections; legacy replay defaults are applied by
   * the gateway validator before provider mapping. */
  valueMinor?: number;
  currencyCode?: string;
  stage: string;
  owner: string;
  department: string;
  risk: string;
  approvalStatus: string;
  signatureStatus: string;
  effectiveDate: string;
  expirationDate: string;
  crm: string;
  crmRecord: string;
  updatedAt: string;
}>;

export type AgreementTombstone = Readonly<{
  externalKey: string;
  workspaceId: string;
  agreementId: number;
  version: number;
  deletedAt: string;
  crm: string;
  crmRecord: string;
}>;

export type CanonicalCrmEvent = Readonly<{
  eventId: string;
  workspaceId: string;
  topic: string;
  occurredAt: string;
  agreementId: number;
  externalKey: string;
  aggregateVersion: number;
  mappingVersion: string;
  deleted: boolean;
  projection: AgreementProjection | null;
  tombstone: AgreementTombstone | null;
}>;

export type CrmUpsertResult = Readonly<{
  providerRecordId: string | null;
}>;

export interface CrmAdapter {
  readonly provider: CrmProvider;
  upsert(event: CanonicalCrmEvent): Promise<CrmUpsertResult>;
  testConnection(): Promise<void>;
}

export type CrmProviderErrorCode =
  | "CRM_CONFIG_INVALID"
  | "CRM_EVENT_INVALID"
  | "CRM_MAPPING_INVALID"
  | "CRM_PROVIDER_AUTH_FAILED"
  | "CRM_PROVIDER_NETWORK_ERROR"
  | "CRM_PROVIDER_RATE_LIMITED"
  | "CRM_PROVIDER_REDIRECT_REJECTED"
  | "CRM_PROVIDER_REJECTED"
  | "CRM_PROVIDER_RESPONSE_INVALID"
  | "CRM_PROVIDER_SCHEMA_INCOMPATIBLE"
  | "CRM_PROVIDER_TIMEOUT"
  | "CRM_PROVIDER_UNAVAILABLE";

/** A deliberately redacted provider error safe to persist or return. */
export class CrmProviderError extends Error {
  readonly code: CrmProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    code: CrmProviderErrorCode,
    retryable: boolean,
    retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "CrmProviderError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

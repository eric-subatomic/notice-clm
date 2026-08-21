import { z } from "zod";
import type { DeliveryGatewayEvent } from "./delivery";
import { MAX_MONEY_MINOR, wholeUnitProjection } from "./money";

export const INTEGRATION_ENVELOPE_VERSION = "1.0" as const;
export const INTEGRATION_TOPIC_VERSION = "1.0" as const;
export const MAX_INTEGRATION_EVENT_PAYLOAD_BYTES = 64 * 1_024;

const boundedString = (max: number) => z.string().min(1).max(max);
const boundedOptionalString = (max: number) => z.string().max(max);
const opaqueId = boundedString(256);
const workspaceId = boundedString(128);
const agreementId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoTimestamp = z.string().min(20).max(64).refine(
  (value) => value.includes("T") && Number.isFinite(Date.parse(value)),
  "Timestamp must be ISO-8601",
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i);
const crmProvider = z.enum(["Salesforce", "HubSpot", "Custom CRM", "None"]);
const LEGACY_WHOLE_UNIT_MAX = 9_000_000_000_000;
export type AgreementCrmSelection = z.infer<typeof crmProvider>;
export type CrmIntegrationProvider = "salesforce" | "hubspot" | "custom";

const eventMetadata = {
  // The default keeps schemaVersion 1.0 events emitted before topicVersion was
  // added readable. Every new emitter uses prepareIntegrationOutboxEvent,
  // which writes the version explicitly.
  topicVersion: z.literal(INTEGRATION_TOPIC_VERSION).default(INTEGRATION_TOPIC_VERSION),
  aggregateVersion: version.optional(),
  causationId: opaqueId.optional(),
};

function payloadSchema<T extends Record<string, z.ZodType>>(shape: T) {
  // Topic payloads are additive within a version. Known fields are validated
  // and bounded, while future additive fields remain available to consumers.
  return z.object({ ...eventMetadata, ...shape }).passthrough();
}

const recipientSchema = z.object({
  userId: opaqueId,
  email: z.email().max(320),
  displayName: boundedString(200),
}).strict();

const externalRecipientSchema = z.object({
  email: z.email().max(320),
  displayName: boundedString(200),
}).strict();

const crmAgreementProjectionInputSchema = z.object({
  externalKey: boundedString(256),
  workspaceId,
  agreementId,
  version,
  party: boundedString(200),
  type: boundedString(200),
  value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // schemaVersion 1.0 events persisted before the canonical-money migration
  // have only `value`. Parsing upgrades those events without changing their
  // envelope or topic version; every current producer supplies both fields.
  valueMinor: z.number().int().nonnegative().max(MAX_MONEY_MINOR).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  stage: boundedString(64),
  owner: boundedString(200),
  department: boundedString(100),
  risk: boundedString(64),
  approvalStatus: boundedString(64),
  signatureStatus: boundedString(64),
  effectiveDate: boundedOptionalString(100),
  expirationDate: boundedOptionalString(100),
  crm: crmProvider,
  crmRecord: boundedOptionalString(500),
  updatedAt: isoTimestamp,
}).strict().superRefine((projection, context) => {
  if ((projection.valueMinor === undefined) !== (projection.currencyCode === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Canonical monetary fields must be supplied together",
    });
  }
  if (projection.valueMinor === undefined || projection.currencyCode === undefined) {
    if (projection.value > LEGACY_WHOLE_UNIT_MAX) {
      context.addIssue({
        code: "custom",
        message: "Legacy whole-unit value exceeds the supported range",
      });
    }
  } else if (projection.value !== wholeUnitProjection(projection.valueMinor, projection.currencyCode)) {
    context.addIssue({
      code: "custom",
      message: "Whole-unit compatibility value must match canonical monetary fields",
    });
  }
});

export const crmAgreementProjectionSchema = crmAgreementProjectionInputSchema.transform((projection) => ({
  ...projection,
  valueMinor: projection.valueMinor ?? projection.value * 100,
  currencyCode: projection.currencyCode ?? "USD",
}));

export type CrmAgreementProjection = z.infer<typeof crmAgreementProjectionSchema>;

export type CrmAgreementProjectionSource = Readonly<{
  workspaceId: string;
  id: number;
  version: number;
  party: string;
  type: string;
  value: number;
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

export function crmAgreementExternalKey(candidateWorkspaceId: string, candidateAgreementId: number): string {
  const parsedWorkspaceId = workspaceId.parse(candidateWorkspaceId);
  const parsedAgreementId = agreementId.parse(candidateAgreementId);
  return `notice:${parsedWorkspaceId}:agreement:${parsedAgreementId}`;
}

/** A bounded, provider-neutral CRM view produced only from authoritative Notice state. */
export function crmAgreementProjection(source: CrmAgreementProjectionSource): CrmAgreementProjection {
  if ((source.valueMinor === undefined) !== (source.currencyCode === undefined)) {
    throw new TypeError("Canonical monetary fields must be supplied together");
  }
  return crmAgreementProjectionSchema.parse({
    externalKey: crmAgreementExternalKey(source.workspaceId, source.id),
    workspaceId: source.workspaceId,
    agreementId: source.id,
    version: source.version,
    party: source.party,
    type: source.type,
    value: source.value,
    valueMinor: source.valueMinor ?? source.value * 100,
    currencyCode: source.currencyCode ?? "USD",
    stage: source.stage,
    owner: source.owner,
    department: source.department,
    risk: source.risk,
    approvalStatus: source.approvalStatus,
    signatureStatus: source.signatureStatus,
    effectiveDate: source.effectiveDate,
    expirationDate: source.expirationDate,
    crm: source.crm,
    crmRecord: source.crmRecord,
    updatedAt: source.updatedAt,
  });
}

const workspaceAccessPayload = payloadSchema({
  workspaceId,
  role: z.enum(["admin", "legal", "approver", "requester", "viewer"]),
  recipient: recipientSchema,
});
const approvalReminderPayload = payloadSchema({
  approvalId: opaqueId,
  agreementId,
  role: boundedString(100),
  due: boundedString(100),
  recipient: recipientSchema,
});
const obligationReminderPayload = payloadSchema({
  obligationId: opaqueId,
  agreementId,
  title: boundedString(200),
  dueDate: boundedString(100),
  recipient: recipientSchema,
});
const negotiationRoundRequestedPayload = payloadSchema({
  roundId: opaqueId,
  agreementId,
  roundNumber: version,
  party: boundedString(200),
  agreementType: boundedString(200),
  subject: boundedString(300),
  message: boundedOptionalString(4_000),
  recipient: externalRecipientSchema,
  replyTo: z.email().max(320).optional(),
  portalUrl: boundedString(2_048),
  outboundDocument: z.object({
    id: opaqueId,
    fileName: boundedString(200),
    sha256,
  }).strict(),
  sentBy: recipientSchema,
});
const agreementCreatedPayload = payloadSchema({
  agreementId,
  version,
  documentVersion: version.optional(),
  crmAgreement: crmAgreementProjectionSchema,
});
const agreementUpdatedPayload = payloadSchema({
  agreementId,
  version,
  changedFields: z.array(boundedString(100)).min(1).max(40),
  crmAgreement: crmAgreementProjectionSchema,
});
const agreementStageChangedPayload = payloadSchema({
  agreementId,
  from: boundedString(64),
  to: boundedString(64),
  version,
  crmAgreement: crmAgreementProjectionSchema,
});
const agreementDeletedPayload = payloadSchema({
  agreementId,
  version,
  externalKey: boundedString(256),
  tombstone: z.literal(true),
  deletedAt: isoTimestamp,
  crm: crmProvider,
  crmRecord: boundedOptionalString(500),
});
const approvalRequestedPayload = payloadSchema({
  approvalId: opaqueId,
  agreementId,
  requestedByUserId: opaqueId,
  approverUserId: opaqueId.nullable(),
  documentVersion: version,
  documentSha256: sha256,
  basisHash: sha256,
});
const approvalAssignedPayload = payloadSchema({
  approvalId: opaqueId,
  agreementId,
  approverUserId: opaqueId,
});
const approvalDecidedPayload = payloadSchema({
  approvalId: opaqueId,
  agreementId,
  status: z.enum(["Approved", "Changes requested"]),
  decidedByUserId: opaqueId,
});
const obligationCreatedPayload = payloadSchema({
  obligationId: opaqueId,
  agreementId,
  ownerUserId: opaqueId.nullable(),
  dueDate: boundedString(100),
});
const obligationCompletedPayload = payloadSchema({
  obligationId: opaqueId,
  agreementId,
});
const languageCreatedPayload = payloadSchema({ languageBlockId: agreementId, version });
const languageUpdatedPayload = payloadSchema({ languageBlockId: agreementId, version });
const signaturePacketCreatedPayload = payloadSchema({
  packetId: opaqueId,
  agreementId,
  provider: z.literal("docuseal"),
  submissionId: opaqueId,
  documentVersion: version,
  documentSha256: sha256,
  basisHash: sha256,
  status: boundedString(64).optional(),
  actionable: z.boolean().optional(),
  recovered: z.boolean().optional(),
});
const signaturePacketAbandonedPayload = payloadSchema({
  packetId: opaqueId,
  agreementId,
  provider: z.literal("docuseal"),
  reason: z.literal("provider_mapping_absent"),
  verifiedAt: isoTimestamp,
});
const signaturePacketArchivedPayload = payloadSchema({
  packetId: opaqueId,
  agreementId,
  provider: z.literal("docuseal"),
  submissionId: opaqueId,
  documentVersion: version,
  documentSha256: sha256,
  basisHash: sha256,
  status: z.literal("archived"),
  actionable: z.literal(false),
  recovered: z.literal(true),
});
const signaturePacketSupersededPayload = payloadSchema({
  packetId: opaqueId,
  agreementId,
  provider: z.literal("docuseal"),
  submissionId: opaqueId,
  documentVersion: version,
  documentSha256: sha256,
  basisHash: sha256,
  status: z.literal("superseded"),
  actionable: z.literal(false),
  recovered: z.boolean(),
  reason: z.literal("administrator_released_archived_packet").optional(),
});
const signatureCompletedPayload = payloadSchema({
  packetId: opaqueId,
  agreementId,
  provider: z.literal("docuseal"),
  submissionId: opaqueId,
  status: z.enum(["completed", "completed_superseded"]),
  activated: z.boolean(),
  documentVersion: version,
  documentSha256: sha256,
  evidenceDocumentId: opaqueId,
  crmAgreement: crmAgreementProjectionSchema,
});
const retentionPurgedPayload = payloadSchema({
  resourceType: z.enum(["agreement", "document"]),
  resourceId: opaqueId,
  d1PurgedAt: isoTimestamp,
  storageStatus: z.literal("storage_pending"),
  purgeJobId: opaqueId,
});
const deliveryConnectionTestPayload = payloadSchema({
  dryRun: z.literal(true),
  channel: z.literal("delivery"),
});
const crmConnectionTestPayload = payloadSchema({
  dryRun: z.literal(true),
  channel: z.literal("crm"),
});

export const integrationEventPayloadSchemas = Object.freeze({
  "notification.workspace_access": workspaceAccessPayload,
  "notification.approval_reminder": approvalReminderPayload,
  "notification.obligation_reminder": obligationReminderPayload,
  "negotiation.round_requested": negotiationRoundRequestedPayload,
  "agreement.created": agreementCreatedPayload,
  "agreement.updated": agreementUpdatedPayload,
  "agreement.stage_changed": agreementStageChangedPayload,
  "agreement.deleted": agreementDeletedPayload,
  "approval.requested": approvalRequestedPayload,
  "approval.assigned": approvalAssignedPayload,
  "approval.decided": approvalDecidedPayload,
  "obligation.created": obligationCreatedPayload,
  "obligation.completed": obligationCompletedPayload,
  "language.created": languageCreatedPayload,
  "language.updated": languageUpdatedPayload,
  "signature.packet_created": signaturePacketCreatedPayload,
  "signature.packet_abandoned": signaturePacketAbandonedPayload,
  "signature.packet_archived": signaturePacketArchivedPayload,
  "signature.packet_superseded": signaturePacketSupersededPayload,
  "signature.completed": signatureCompletedPayload,
  "retention.d1_purged": retentionPurgedPayload,
  "integration.delivery.connection_test": deliveryConnectionTestPayload,
  "integration.crm.connection_test": crmConnectionTestPayload,
} as const);

export type IntegrationTopic = keyof typeof integrationEventPayloadSchemas;

const commonEventShape = {
  id: opaqueId,
  workspaceId,
  aggregateId: opaqueId,
  createdAt: isoTimestamp,
};
const commonOutboxShape = {
  workspaceId,
  aggregateId: opaqueId,
};

function eventVariant<const T extends IntegrationTopic, const A extends string>(topic: T, aggregateType: A) {
  return z.object({
    ...commonEventShape,
    topic: z.literal(topic),
    aggregateType: z.literal(aggregateType),
    payload: integrationEventPayloadSchemas[topic],
  }).passthrough();
}

function outboxVariant<const T extends IntegrationTopic, const A extends string>(topic: T, aggregateType: A) {
  return z.object({
    ...commonOutboxShape,
    topic: z.literal(topic),
    aggregateType: z.literal(aggregateType),
    payload: integrationEventPayloadSchemas[topic],
  }).strict();
}

// Keep these explicitly discriminated by topic so consumers cannot route an
// unknown topic to a generic/default provider action.
export const integrationEventSchema = z.discriminatedUnion("topic", [
  eventVariant("notification.workspace_access", "workspace_membership"),
  eventVariant("notification.approval_reminder", "approval"),
  eventVariant("notification.obligation_reminder", "obligation"),
  eventVariant("negotiation.round_requested", "negotiation_round"),
  eventVariant("agreement.created", "agreement"),
  eventVariant("agreement.updated", "agreement"),
  eventVariant("agreement.stage_changed", "agreement"),
  eventVariant("agreement.deleted", "agreement"),
  eventVariant("approval.requested", "approval"),
  eventVariant("approval.assigned", "approval"),
  eventVariant("approval.decided", "approval"),
  eventVariant("obligation.created", "obligation"),
  eventVariant("obligation.completed", "obligation"),
  eventVariant("language.created", "language_block"),
  eventVariant("language.updated", "language_block"),
  eventVariant("signature.packet_created", "signature_packet"),
  eventVariant("signature.packet_abandoned", "signature_packet"),
  eventVariant("signature.packet_archived", "signature_packet"),
  eventVariant("signature.packet_superseded", "signature_packet"),
  eventVariant("signature.completed", "signature"),
  eventVariant("retention.d1_purged", "records-policy"),
  eventVariant("integration.delivery.connection_test", "system"),
  eventVariant("integration.crm.connection_test", "system"),
]);
const integrationOutboxEventSchema = z.discriminatedUnion("topic", [
  outboxVariant("notification.workspace_access", "workspace_membership"),
  outboxVariant("notification.approval_reminder", "approval"),
  outboxVariant("notification.obligation_reminder", "obligation"),
  outboxVariant("negotiation.round_requested", "negotiation_round"),
  outboxVariant("agreement.created", "agreement"),
  outboxVariant("agreement.updated", "agreement"),
  outboxVariant("agreement.stage_changed", "agreement"),
  outboxVariant("agreement.deleted", "agreement"),
  outboxVariant("approval.requested", "approval"),
  outboxVariant("approval.assigned", "approval"),
  outboxVariant("approval.decided", "approval"),
  outboxVariant("obligation.created", "obligation"),
  outboxVariant("obligation.completed", "obligation"),
  outboxVariant("language.created", "language_block"),
  outboxVariant("language.updated", "language_block"),
  outboxVariant("signature.packet_created", "signature_packet"),
  outboxVariant("signature.packet_abandoned", "signature_packet"),
  outboxVariant("signature.packet_archived", "signature_packet"),
  outboxVariant("signature.packet_superseded", "signature_packet"),
  outboxVariant("signature.completed", "signature"),
  outboxVariant("retention.d1_purged", "records-policy"),
  outboxVariant("integration.delivery.connection_test", "system"),
  outboxVariant("integration.crm.connection_test", "system"),
]);

export type IntegrationEvent = z.infer<typeof integrationEventSchema> & DeliveryGatewayEvent;
export type IntegrationOutboxEvent = z.infer<typeof integrationOutboxEventSchema>;
export type AgreementUpdatedIntegrationOutboxEvent = Extract<IntegrationOutboxEvent, { topic: "agreement.updated" }>;
export type AgreementDeletedIntegrationOutboxEvent = Extract<IntegrationOutboxEvent, { topic: "agreement.deleted" }>;

function payloadFromCandidate(candidate: unknown): unknown {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return candidate;
  return (candidate as Record<string, unknown>).payload;
}

function assertBoundedPayload(payload: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new TypeError("Integration event payload must be JSON serializable");
  }
  if (serialized === undefined) throw new TypeError("Integration event payload must be JSON serializable");
  if (new TextEncoder().encode(serialized).byteLength > MAX_INTEGRATION_EVENT_PAYLOAD_BYTES) {
    throw new RangeError(`Integration event payload exceeds ${MAX_INTEGRATION_EVENT_PAYLOAD_BYTES} bytes`);
  }
}

/** Parse a complete persisted event; the result is assignable to DeliveryGatewayEvent. */
export function parseIntegrationEvent(event: unknown): IntegrationEvent {
  assertBoundedPayload(payloadFromCandidate(event));
  return integrationEventSchema.parse(event) as IntegrationEvent;
}

/** Validate an event before persistence and add the current topic version. */
export function prepareIntegrationOutboxEvent(event: unknown): IntegrationOutboxEvent {
  const candidate = z.object({ payload: z.record(z.string(), z.unknown()) }).passthrough().parse(event);
  const versioned = {
    ...(event as Record<string, unknown>),
    payload: { ...candidate.payload, topicVersion: INTEGRATION_TOPIC_VERSION },
  };
  assertBoundedPayload(versioned.payload);
  return integrationOutboxEventSchema.parse(versioned);
}

/**
 * Build the canonical CRM-eligible event for a committed agreement mutation.
 * Callers still wrap this with prepareOutboxEvent and persist it in the same D1
 * batch as the guarded aggregate update.
 */
export function prepareAgreementUpdatedIntegrationEvent(input: Readonly<{
  agreement: CrmAgreementProjectionSource;
  changedFields: readonly string[];
  causationId?: string;
}>): AgreementUpdatedIntegrationOutboxEvent {
  return prepareIntegrationOutboxEvent({
    workspaceId: input.agreement.workspaceId,
    topic: "agreement.updated",
    aggregateType: "agreement",
    aggregateId: String(input.agreement.id),
    payload: {
      agreementId: input.agreement.id,
      version: input.agreement.version,
      changedFields: [...new Set(input.changedFields)].sort(),
      aggregateVersion: input.agreement.version,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      crmAgreement: crmAgreementProjection(input.agreement),
    },
  }) as AgreementUpdatedIntegrationOutboxEvent;
}

export type CrmAgreementLifecycleField = "approvalStatus" | "signatureStatus" | "stage";

/**
 * Emit only when a CRM-visible lifecycle field actually changed. This keeps
 * repeated provider observations and multi-step approval decisions from
 * creating duplicate projections while still versioning every real change.
 */
export function prepareAgreementLifecycleUpdatedIntegrationEvent(input: Readonly<{
  before: CrmAgreementProjectionSource;
  agreement: CrmAgreementProjectionSource;
  candidateFields: readonly CrmAgreementLifecycleField[];
  causationId?: string;
}>): AgreementUpdatedIntegrationOutboxEvent | null {
  const changedFields = [...new Set(input.candidateFields)]
    .filter((field) => input.before[field] !== input.agreement[field]);
  if (changedFields.length === 0) return null;
  return prepareAgreementUpdatedIntegrationEvent({
    agreement: input.agreement,
    changedFields,
    causationId: input.causationId,
  });
}

/** Build the canonical CRM tombstone for either interactive or retention deletion. */
export function prepareAgreementDeletedIntegrationEvent(input: Readonly<{
  agreement: Pick<CrmAgreementProjectionSource, "workspaceId" | "id" | "version" | "crm" | "crmRecord">;
  deletedAt: string;
  causationId?: string;
}>): AgreementDeletedIntegrationOutboxEvent {
  return prepareIntegrationOutboxEvent({
    workspaceId: input.agreement.workspaceId,
    topic: "agreement.deleted",
    aggregateType: "agreement",
    aggregateId: String(input.agreement.id),
    payload: {
      agreementId: input.agreement.id,
      version: input.agreement.version,
      aggregateVersion: input.agreement.version,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      externalKey: crmAgreementExternalKey(input.agreement.workspaceId, input.agreement.id),
      tombstone: true,
      deletedAt: input.deletedAt,
      crm: input.agreement.crm,
      crmRecord: input.agreement.crmRecord,
    },
  }) as AgreementDeletedIntegrationOutboxEvent;
}

export const CRM_INTEGRATION_TOPICS = Object.freeze([
  "agreement.created",
  "agreement.updated",
  "agreement.stage_changed",
  "agreement.deleted",
  "signature.completed",
  "integration.crm.connection_test",
] as const);

const crmIntegrationTopicSet = new Set<string>(CRM_INTEGRATION_TOPICS);

export function isCrmIntegrationTopic(topic: string): topic is (typeof CRM_INTEGRATION_TOPICS)[number] {
  return crmIntegrationTopicSet.has(topic);
}

export function crmProviderForAgreementSelection(candidate: unknown): CrmIntegrationProvider | null {
  switch (candidate) {
    case "Salesforce": return "salesforce";
    case "HubSpot": return "hubspot";
    case "Custom CRM": return "custom";
    case "None": return null;
    default: return null;
  }
}

export function agreementSelectionForCrmProvider(provider: CrmIntegrationProvider): Exclude<AgreementCrmSelection, "None"> {
  switch (provider) {
    case "salesforce": return "Salesforce";
    case "hubspot": return "HubSpot";
    case "custom": return "Custom CRM";
  }
}

/** Resolve the authoritative per-agreement CRM target without trusting topic alone. */
export function crmTargetForIntegrationEvent(event: Readonly<{
  topic: string;
  payload: Record<string, unknown>;
}>): CrmIntegrationProvider | null {
  if (!isCrmIntegrationTopic(event.topic) || event.topic === "integration.crm.connection_test") return null;
  if (event.topic === "agreement.deleted") {
    return crmProviderForAgreementSelection(event.payload.crm);
  }
  const projection = event.payload.crmAgreement;
  if (typeof projection !== "object" || projection === null || Array.isArray(projection)) return null;
  return crmProviderForAgreementSelection((projection as Record<string, unknown>).crm);
}

import {
  crmAgreementExternalKey,
  crmAgreementProjectionSchema,
  isCrmIntegrationTopic,
  parseIntegrationEvent,
  type CrmAgreementProjection,
  type IntegrationEvent,
} from "../../../app/lib/integration-events";
import { z } from "zod";

export const CRM_UPSERT_TOPICS = [
  "agreement.created",
  "agreement.updated",
  "agreement.stage_changed",
  "signature.completed",
] as const;

export const CRM_MUTATION_TOPICS = [...CRM_UPSERT_TOPICS, "agreement.deleted"] as const;

export type CrmUpsertTopic = (typeof CRM_UPSERT_TOPICS)[number];
export type CrmMutationTopic = (typeof CRM_MUTATION_TOPICS)[number];

type CanonicalEventBase<T extends CrmMutationTopic> = Readonly<{
  schemaVersion: "1.0";
  eventId: string;
  topic: T;
  workspaceId: string;
  agreementId: number;
  externalKey: string;
  aggregateVersion: number;
  occurredAt: string;
}>;

export type CanonicalCrmUpsert = CanonicalEventBase<CrmUpsertTopic> & Readonly<{
  operation: "upsert";
  agreement: CrmAgreementProjection;
}>;

export type CanonicalCrmTombstone = Readonly<{
  externalKey: string;
  workspaceId: string;
  agreementId: number;
  version: number;
  deletedAt: string;
  crm: "Salesforce" | "HubSpot" | "Custom CRM" | "None";
  crmRecord: string;
}>;

export type CanonicalCrmDelete = CanonicalEventBase<"agreement.deleted"> & Readonly<{
  operation: "delete";
  tombstone: CanonicalCrmTombstone;
}>;

export type CanonicalCrmEvent = CanonicalCrmUpsert | CanonicalCrmDelete;

const canonicalBaseSchema = {
  schemaVersion: z.literal("1.0"),
  eventId: z.string().min(1).max(256),
  topic: z.enum(CRM_UPSERT_TOPICS),
  workspaceId: z.string().min(1).max(128),
  agreementId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  externalKey: z.string().min(1).max(256),
  aggregateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.string().min(20).max(64).refine((value) => Number.isFinite(Date.parse(value))),
};

const canonicalTombstoneSchema = z.object({
  externalKey: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(128),
  agreementId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  deletedAt: z.string().min(20).max(64).refine((value) => Number.isFinite(Date.parse(value))),
  crm: z.enum(["Salesforce", "HubSpot", "Custom CRM", "None"]),
  crmRecord: z.string().max(500),
}).strict();

export const canonicalCrmEventSchema = z.discriminatedUnion("operation", [
  z.object({
    ...canonicalBaseSchema,
    operation: z.literal("upsert"),
    agreement: crmAgreementProjectionSchema,
  }).strict(),
  z.object({
    ...canonicalBaseSchema,
    topic: z.literal("agreement.deleted"),
    operation: z.literal("delete"),
    tombstone: canonicalTombstoneSchema,
  }).strict(),
]);

export function parseCanonicalCrmEvent(candidate: unknown): CanonicalCrmEvent {
  const event = canonicalCrmEventSchema.parse(candidate) as CanonicalCrmEvent;
  if (event.operation === "upsert") {
    assertProjectionIdentity(event.workspaceId, event.agreementId, event.agreement);
    if (event.externalKey !== event.agreement.externalKey || event.aggregateVersion !== event.agreement.version) {
      throw new CanonicalCrmEventError("projection_identity_mismatch");
    }
  } else if (
    event.externalKey !== event.tombstone.externalKey
    || event.workspaceId !== event.tombstone.workspaceId
    || event.agreementId !== event.tombstone.agreementId
    || event.aggregateVersion !== event.tombstone.version
  ) {
    throw new CanonicalCrmEventError("tombstone_identity_mismatch");
  }
  return event;
}

export type CanonicalCrmInput = Readonly<{
  kind: "mutation";
  event: CanonicalCrmEvent;
}> | Readonly<{
  kind: "connection_test";
  eventId: string;
}>;

export class CanonicalCrmEventError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("CRM event is not eligible for provider delivery.");
    this.name = "CanonicalCrmEventError";
    this.code = code;
  }
}

/**
 * Converts the shared Notice event contract into the deliberately smaller CRM
 * provider contract. Additive source fields are not forwarded accidentally.
 */
export function normalizeCrmIntegrationEvent(candidate: unknown): CanonicalCrmInput {
  const parsed = parseIntegrationEvent(candidate);
  if (!isCrmIntegrationTopic(parsed.topic)) throw new CanonicalCrmEventError("topic_not_allowed");
  if (parsed.topic === "integration.crm.connection_test") {
    return Object.freeze({ kind: "connection_test", eventId: parsed.id });
  }

  switch (parsed.topic) {
    case "agreement.created":
    case "agreement.updated":
    case "agreement.stage_changed":
    case "signature.completed":
      return normalizeUpsert(parsed);
    case "agreement.deleted":
      return normalizeDelete(parsed);
    default:
      throw new CanonicalCrmEventError("topic_not_allowed");
  }
}

function normalizeUpsert(
  event: Extract<IntegrationEvent, { topic: Exclude<CrmMutationTopic, "agreement.deleted"> }>,
): CanonicalCrmInput {
  const agreement = event.payload.crmAgreement;
  assertProjectionIdentity(event.workspaceId, event.payload.agreementId, agreement);

  if (
    event.topic !== "signature.completed"
    && "version" in event.payload
    && event.payload.version !== agreement.version
  ) {
    throw new CanonicalCrmEventError("projection_version_mismatch");
  }

  return Object.freeze({
    kind: "mutation",
    event: Object.freeze({
      schemaVersion: "1.0",
      eventId: event.id,
      topic: event.topic,
      workspaceId: event.workspaceId,
      agreementId: agreement.agreementId,
      externalKey: agreement.externalKey,
      // Fencing follows the authoritative agreement projection. Signature
      // events have their own packet version in payload.aggregateVersion.
      aggregateVersion: agreement.version,
      occurredAt: event.createdAt,
      operation: "upsert",
      agreement: Object.freeze({ ...agreement }),
    }),
  });
}

function normalizeDelete(
  event: Extract<IntegrationEvent, { topic: "agreement.deleted" }>,
): CanonicalCrmInput {
  const expectedExternalKey = crmAgreementExternalKey(event.workspaceId, event.payload.agreementId);
  if (event.payload.externalKey !== expectedExternalKey) {
    throw new CanonicalCrmEventError("external_key_mismatch");
  }
  if (event.payload.aggregateVersion !== undefined && event.payload.aggregateVersion !== event.payload.version) {
    throw new CanonicalCrmEventError("projection_version_mismatch");
  }
  const tombstone: CanonicalCrmTombstone = Object.freeze({
    externalKey: event.payload.externalKey,
    workspaceId: event.workspaceId,
    agreementId: event.payload.agreementId,
    version: event.payload.version,
    deletedAt: event.payload.deletedAt,
    crm: event.payload.crm,
    crmRecord: event.payload.crmRecord,
  });
  return Object.freeze({
    kind: "mutation",
    event: Object.freeze({
      schemaVersion: "1.0",
      eventId: event.id,
      topic: event.topic,
      workspaceId: event.workspaceId,
      agreementId: event.payload.agreementId,
      externalKey: event.payload.externalKey,
      aggregateVersion: event.payload.version,
      occurredAt: event.createdAt,
      operation: "delete",
      tombstone,
    }),
  });
}

function assertProjectionIdentity(
  eventWorkspaceId: string,
  payloadAgreementId: number,
  agreement: CrmAgreementProjection,
): void {
  if (agreement.workspaceId !== eventWorkspaceId || agreement.agreementId !== payloadAgreementId) {
    throw new CanonicalCrmEventError("projection_identity_mismatch");
  }
  if (agreement.externalKey !== crmAgreementExternalKey(eventWorkspaceId, payloadAgreementId)) {
    throw new CanonicalCrmEventError("external_key_mismatch");
  }
}

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import {
  agreementEvents,
  agreements,
  agreementVersions,
  outboxEvents,
  workspaceEvents,
} from "../../db/schema";
import { computeAgreementEventHash } from "./audit-chain";
import { sha256Hex } from "./document-security";
import { computeWorkspaceEventHash } from "./workspace-audit";

export { verifyAgreementEventChain } from "./audit-chain";
export type { AgreementEventChainRow } from "./audit-chain";

type Database = ReturnType<typeof getDb>;

export type EventActor =
  | { id: string; email: string; displayName: string }
  | { userId: string; email: string; displayName: string };

function actorId(actor: EventActor): string {
  return "userId" in actor ? actor.userId : actor.id;
}

export async function findActiveAgreement(db: Database, workspaceId: string, agreementId: number) {
  const [agreement] = await db
    .select()
    .from(agreements)
    .where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, agreementId),
      isNull(agreements.deletedAt),
    ))
    .limit(1);
  return agreement ?? null;
}

export async function appendAgreementEvent(
  db: Database,
  input: AgreementEventInput,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const event = await prepareAgreementEvent(db, input);
    try {
      await db.insert(agreementEvents).values(event);
      return event;
    } catch (error) {
      if (attempt === 3 || !isAgreementEventSequenceConflict(error)) throw error;
    }
  }
  throw new Error("Agreement audit event could not be sequenced");
}

export type AgreementEventInput = {
  workspaceId: string;
  agreementId: number;
  type: string;
  detail: string;
  actor: EventActor;
  createdAt?: string;
};

/**
 * Build a hash-linked event without writing it. Routes that mutate an audited
 * aggregate should insert this record in the same D1 batch as the mutation.
 */
export async function prepareAgreementEvent(db: Database, input: AgreementEventInput) {
  const [previous] = await db
    .select({ sequence: agreementEvents.sequence, eventHash: agreementEvents.eventHash })
    .from(agreementEvents)
    .where(and(
      eq(agreementEvents.workspaceId, input.workspaceId),
      eq(agreementEvents.agreementId, input.agreementId),
    ))
    .orderBy(desc(agreementEvents.sequence))
    .limit(1);

  const id = crypto.randomUUID();
  const sequence = (previous?.sequence ?? 0) + 1;
  const previousHash = previous?.eventHash ?? null;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const eventData = {
    id,
    workspaceId: input.workspaceId,
    agreementId: input.agreementId,
    sequence,
    type: input.type.slice(0, 100),
    actorUserId: actorId(input.actor),
    actorEmail: input.actor.email,
    actor: input.actor.displayName.slice(0, 200),
    detail: input.detail.slice(0, 4_000),
    createdAt,
    previousHash,
  };
  const eventHash = await computeAgreementEventHash(eventData);
  const event = {
    ...eventData,
    eventHash,
  };
  return event;
}

export async function appendWorkspaceEvent(
  db: Database,
  input: WorkspaceEventInput,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const event = await prepareWorkspaceEvent(db, input);
    try {
      await db.insert(workspaceEvents).values(event);
      return event;
    } catch (error) {
      if (attempt === 3 || !isWorkspaceEventSequenceConflict(error)) throw error;
    }
  }
  throw new Error("Workspace audit event could not be sequenced");
}

export type WorkspaceEventInput = {
  workspaceId: string;
  type: string;
  detail: string;
  actor: EventActor;
  subjectUserId?: string | null;
  subjectEmail?: string | null;
  createdAt?: string;
};

/** See {@link prepareAgreementEvent}. */
export async function prepareWorkspaceEvent(db: Database, input: WorkspaceEventInput) {
  const [previous] = await db.select({ sequence: workspaceEvents.sequence, eventHash: workspaceEvents.eventHash })
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, input.workspaceId))
    .orderBy(desc(workspaceEvents.sequence))
    .limit(1);
  const eventData = {
    id: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    sequence: (previous?.sequence ?? 0) + 1,
    type: input.type.slice(0, 100),
    actorUserId: actorId(input.actor),
    actorEmail: input.actor.email,
    actor: input.actor.displayName.slice(0, 200),
    subjectUserId: input.subjectUserId ?? null,
    subjectEmail: input.subjectEmail?.slice(0, 320) ?? null,
    detail: input.detail.slice(0, 4_000),
    previousHash: previous?.eventHash ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const event = { ...eventData, eventHash: await computeWorkspaceEventHash(eventData) };
  return event;
}

export async function prepareAgreementSnapshot(
  agreement: typeof agreements.$inferSelect,
  actorUserId: string,
  sourceEventId?: string,
) {
  const snapshot = JSON.parse(JSON.stringify(agreement)) as Record<string, unknown>;
  const checksumSha256 = await sha256Hex(JSON.stringify(snapshot));
  const record = {
    id: crypto.randomUUID(),
    workspaceId: agreement.workspaceId,
    agreementId: agreement.id,
    version: agreement.version,
    snapshot,
    sourceEventId: sourceEventId ?? null,
    checksumSha256,
    createdByUserId: actorUserId,
    createdAt: new Date().toISOString(),
  };
  return record;
}

export async function snapshotAgreement(
  db: Database,
  agreement: typeof agreements.$inferSelect,
  actorUserId: string,
  sourceEventId?: string,
) {
  const record = await prepareAgreementSnapshot(agreement, actorUserId, sourceEventId);
  await db.insert(agreementVersions).values(record).onConflictDoNothing();
  return record;
}

export type OutboxEventInput = {
  workspaceId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  availableAt?: string;
};

export function prepareOutboxEvent(input: OutboxEventInput) {
  const now = new Date().toISOString();
  const event = {
    id: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    topic: input.topic,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    availableAt: input.availableAt ?? now,
    lockedAt: null,
    processedAt: null,
    lastError: null,
    createdAt: now,
  };
  return event;
}

export async function enqueueOutbox(db: Database, input: OutboxEventInput) {
  const event = prepareOutboxEvent(input);
  await db.insert(outboxEvents).values(event);
  return event;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAgreementEventSequenceConflict(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("uq_agreement_events_workspace_agreement_sequence")
    || (message.includes("unique constraint failed")
      && message.includes("agreement_events.workspace_id")
      && message.includes("agreement_events.agreement_id")
      && message.includes("agreement_events.sequence"));
}

export function isWorkspaceEventSequenceConflict(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("uq_workspace_events_workspace_sequence")
    || (message.includes("unique constraint failed")
      && message.includes("workspace_events.workspace_id")
      && message.includes("workspace_events.sequence"));
}

export function isMutationGuardConflict(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("ck_mutation_guards_changes")
    || (message.includes("check constraint failed")
      && message.includes("mutation_guards")
      && message.includes("guard_changes"));
}

export function isOptimisticConcurrencyConflict(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return isAgreementEventSequenceConflict(error)
    || isWorkspaceEventSequenceConflict(error)
    || isMutationGuardConflict(error)
    || message.includes("uq_agreement_versions_workspace_agreement_version")
    || message.includes("uq_agreement_document_versions_workspace_agreement_version")
    || message.includes("uq_signature_packets_workspace_active_key")
    || (message.includes("unique constraint failed") && (
      (message.includes("agreement_versions.workspace_id") && message.includes("agreement_versions.agreement_id") && message.includes("agreement_versions.version"))
      || (message.includes("agreement_document_versions.workspace_id") && message.includes("agreement_document_versions.agreement_id") && message.includes("agreement_document_versions.version"))
      || (message.includes("signature_packets.workspace_id") && message.includes("signature_packets.active_key"))
    ));
}

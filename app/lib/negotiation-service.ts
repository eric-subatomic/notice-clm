import { env } from "cloudflare:workers";
import { and, desc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  agreementDocumentVersions,
  agreementEvents,
  agreements,
  agreementVersions,
  approvalRequests,
  documentComparisons,
  documents,
  mutationGuards,
  negotiationRounds,
  negotiationSubmissions,
  outboxEvents,
  signaturePackets,
  webhookReceipts,
  type NegotiationSubmissionSource,
} from "../../db/schema";
import { getNoticeConfig } from "./config";
import {
  DocumentSecurityError,
  inspectDocument,
  normalizedDocumentName,
  scanDocument,
  sha256Hex,
} from "./document-security";
import {
  buildNegotiationAliasAddress,
  decideNegotiationSubmissionStatus,
  generateNegotiationAliasCode,
  generateNegotiationToken,
  hashNegotiationToken,
  negotiationPortalExpiresAt,
  normalizeNegotiationEmail,
} from "./negotiation-exchange";
import {
  NEGOTIATION_BASE_SOURCE_ROLES,
  negotiationBaselineReference,
  type NegotiationBaseline,
} from "./negotiation-baseline";
import {
  prepareAgreementLifecycleUpdatedIntegrationEvent,
  prepareIntegrationOutboxEvent,
} from "./integration-events";
import {
  findActiveAgreement,
  isMutationGuardConflict,
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
} from "./persistence";
import {
  getCounterpartyExchangeConfiguration,
  getNegotiationDeliveryConfiguration,
  getScannerConfiguration,
  isDeliveryGatewayConfigured,
  isNegotiationMailAccepted,
} from "./providers";
import { canMarkNegotiationSubmissionReady } from "./negotiation-review-policy";
import { roundAcceptsNegotiationIngress } from "./negotiation-ingress-policy";
import {
  deriveNegotiationRoundAction,
  negotiationDeliveryState,
  type NegotiationDeliveryState,
} from "./negotiation-round-state";
import {
  NEGOTIATION_PORTAL_TRANSFER_POLICY,
  claimNegotiationPortalDownload,
  claimNegotiationPortalUpload,
  negotiationPortalUploadCompletionPatch,
  negotiationPortalUploadReservationPredicate,
  rejectNegotiationPortalUpload,
  type NegotiationPortalBudgetFailure,
  type NegotiationPortalUploadReservation,
} from "./negotiation-portal-budget";
import {
  cleanupStagedDocumentObject,
  cleanupStagedReviewTextObject,
  cleanupStagedWorkingVersionObject,
} from "./staged-object-cleanup";

type NegotiationEnv = { DOCUMENTS: R2Bucket };
type Database = ReturnType<typeof getDb>;
type UserActor = Readonly<{ id: string; email: string; displayName: string }>;

const ACTIVE_SIGNATURE_STATUSES = ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"] as const;
const ACTIVE_ROUND_STATUSES = ["prepared", "outbound", "returned", "review"] as const;
const EMAIL_RECEIPT_PROVIDERS = new Set(["inbound-email-gateway", "inbound-email-message"]);
const MAX_REVIEW_TEXT_BYTES = 2_000_000;
const MAX_ATTACHMENTS = 5;

export class NegotiationServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = "NegotiationServiceError";
  }
}

function negotiationPortalBudgetError(
  direction: "upload" | "download",
  reason: NegotiationPortalBudgetFailure,
): NegotiationServiceError {
  if (reason === "not_found") {
    return new NegotiationServiceError("exchange_not_found", "This exchange link is unavailable.", 404);
  }
  if (reason === "expired") {
    return new NegotiationServiceError("exchange_expired", "This exchange link has expired or was revoked.", 410);
  }
  if (reason === "busy") {
    return new NegotiationServiceError(
      "exchange_upload_busy",
      "Another upload is already being inspected for this exchange. Retry after it finishes.",
      429,
    );
  }
  if (reason === "changed") {
    return new NegotiationServiceError("exchange_changed", "The exchange changed before the transfer could start.", 409);
  }
  return new NegotiationServiceError(
    direction === "upload" ? "exchange_upload_limit_reached" : "exchange_download_limit_reached",
    `This exchange round has reached its ${direction} limit. Ask the contract sender to start a new exchange round and send its secure link.`,
    429,
  );
}

type SafeSubmission = Omit<typeof negotiationSubmissions.$inferSelect, "reviewTextObjectKey"> & {
  reviewTextAvailable: boolean;
};

type NegotiationOutboxStatus = "pending" | "processing" | "processed" | "dead";

function negotiationOutboxStatus(value: string | null | undefined): NegotiationOutboxStatus | null {
  switch (value) {
    case "pending":
    case "processing":
    case "processed":
    case "dead":
      return value;
    default:
      return null;
  }
}

function safeSubmission(row: typeof negotiationSubmissions.$inferSelect): SafeSubmission {
  const { reviewTextObjectKey, ...safe } = row;
  return { ...safe, reviewTextAvailable: Boolean(reviewTextObjectKey) };
}

function safeRound(
  row: typeof negotiationRounds.$inferSelect,
  emailDomain: string | null,
  deliveryState: NegotiationDeliveryState = negotiationDeliveryState({ deliveryMethod: row.deliveryMethod }),
) {
  const {
    aliasCode,
    portalTokenHash,
    portalUploadAttempts,
    portalUploadAccepted,
    portalUploadRejected,
    portalUploadBytes,
    portalUploadReservationId,
    portalUploadReservationExpiresAt,
    portalUploadReservationBytes,
    portalDownloadAttempts,
    portalDownloadBytes,
    activeKey,
    ...safe
  } = row;
  void aliasCode;
  void portalTokenHash;
  void portalUploadAttempts;
  void portalUploadAccepted;
  void portalUploadRejected;
  void portalUploadBytes;
  void portalUploadReservationId;
  void portalUploadReservationExpiresAt;
  void portalUploadReservationBytes;
  void portalDownloadAttempts;
  void portalDownloadBytes;
  void activeKey;
  return {
    ...safe,
    emailAddress: emailDomain ? buildNegotiationAliasAddress(row.aliasCode, emailDomain) : null,
    portalEnabled: Boolean(row.portalTokenHash && row.portalExpiresAt),
    deliveryState,
  };
}

function portalUrl(publicOrigin: string, token: string): string {
  return new URL(`/api/exchange/${encodeURIComponent(token)}`, publicOrigin).toString();
}

function ttlMilliseconds(hours: number): number {
  return hours * 60 * 60 * 1_000;
}

function providerHeaderText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new NegotiationServiceError(
      "invalid_header_text",
      `${label} must be non-empty, bounded, and contain no control characters.`,
      400,
    );
  }
  return normalized;
}

function bindings(): NegotiationEnv {
  return env as unknown as NegotiationEnv;
}

function ensureAgreementMutable(agreement: typeof agreements.$inferSelect): void {
  if (agreement.stage === "Active" || agreement.signatureStatus === "Completed") {
    throw new NegotiationServiceError(
      "executed_agreement_immutable",
      "Executed agreements cannot enter a negotiation round. Create an amendment or replacement agreement instead.",
    );
  }
}

async function ensureNoActiveSignature(db: Database, workspaceId: string, agreementId: number): Promise<void> {
  const [packet] = await db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
    eq(signaturePackets.workspaceId, workspaceId),
    eq(signaturePackets.agreementId, agreementId),
    inArray(signaturePackets.status, ACTIVE_SIGNATURE_STATUSES),
  )).limit(1);
  if (packet) {
    throw new NegotiationServiceError(
      "signature_packet_active",
      "Cancel or resolve the active signature packet before exchanging another draft.",
    );
  }
}

async function readVerifiedObject(
  objectKey: string,
  expectedSize: number,
  expectedSha256: string,
  errorPrefix: string,
): Promise<Uint8Array> {
  const object = await bindings().DOCUMENTS.get(objectKey);
  if (!object) throw new NegotiationServiceError(`${errorPrefix}_missing`, "The immutable document bytes are unavailable.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const actualSha256 = await sha256Hex(bytes);
  if (bytes.byteLength !== expectedSize || actualSha256 !== expectedSha256) {
    throw new NegotiationServiceError(`${errorPrefix}_integrity_failure`, "The immutable document failed its size or SHA-256 integrity check.");
  }
  return bytes;
}

type StagedNegotiationObject = Readonly<{
  kind: "document" | "working_version" | "review_text";
  id?: string;
  objectKey: string;
  sha256: string;
}>;

/** Delete only after D1 positively proves the staged object did not commit. */
async function cleanupUncommittedObject(
  db: Database,
  workspaceId: string,
  candidate: StagedNegotiationObject,
): Promise<void> {
  const identity = {
    workspaceId,
    id: candidate.id ?? `review-${candidate.sha256.slice(0, 24)}`,
    objectKey: candidate.objectKey,
    sha256: candidate.sha256,
  };
  if (candidate.kind === "document") {
    await cleanupStagedDocumentObject(db, bindings().DOCUMENTS, identity);
  } else if (candidate.kind === "working_version") {
    await cleanupStagedWorkingVersionObject(db, bindings().DOCUMENTS, identity);
  } else {
    await cleanupStagedReviewTextObject(db, bindings().DOCUMENTS, identity);
  }
}

async function activeRoundForAgreement(db: Database, workspaceId: string, agreementId: number) {
  const [round] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, workspaceId),
    eq(negotiationRounds.agreementId, agreementId),
    isNotNull(negotiationRounds.activeKey),
  )).limit(1);
  return round ?? null;
}

async function roundById(db: Database, workspaceId: string, agreementId: number, roundId: string) {
  const [round] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, workspaceId),
    eq(negotiationRounds.agreementId, agreementId),
    eq(negotiationRounds.id, roundId),
  )).limit(1);
  return round ?? null;
}

export async function getNegotiationState(workspaceId: string, agreementId: number, canManage = false) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, workspaceId, agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  const [rounds, submissions, comparisons, documentRows] = await Promise.all([
    db.select().from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, workspaceId),
      eq(negotiationRounds.agreementId, agreementId),
    )).orderBy(desc(negotiationRounds.roundNumber)),
    db.select().from(negotiationSubmissions).where(and(
      eq(negotiationSubmissions.workspaceId, workspaceId),
      eq(negotiationSubmissions.agreementId, agreementId),
    )).orderBy(desc(negotiationSubmissions.createdAt)),
    db.select().from(documentComparisons).where(and(
      eq(documentComparisons.workspaceId, workspaceId),
      eq(documentComparisons.agreementId, agreementId),
    )).orderBy(desc(documentComparisons.createdAt)),
    db.select({
      id: documents.id,
      agreementId: documents.agreementId,
      role: documents.role,
      direction: documents.direction,
      negotiationRoundId: documents.negotiationRoundId,
      fileName: documents.fileName,
      contentType: documents.contentType,
      size: documents.size,
      sha256: documents.sha256,
      scanStatus: documents.scanStatus,
    }).from(documents).where(and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.agreementId, agreementId),
      isNull(documents.deletedAt),
    )),
  ]);
  const deliveryRows = rounds.length > 0
    ? await db.select({
      aggregateId: outboxEvents.aggregateId,
      status: outboxEvents.status,
      createdAt: outboxEvents.createdAt,
    }).from(outboxEvents).where(and(
      eq(outboxEvents.workspaceId, workspaceId),
      eq(outboxEvents.topic, "negotiation.round_requested"),
      eq(outboxEvents.aggregateType, "negotiation_round"),
      inArray(outboxEvents.aggregateId, rounds.map((round) => round.id)),
    )).orderBy(desc(outboxEvents.createdAt))
    : [];
  const configuration = getCounterpartyExchangeConfiguration();
  const latest = rounds[0] ?? null;
  const active = rounds.find((round) => round.activeKey !== null) ?? null;
  const activeEmailDomain = canManage ? configuration.inboundEmail?.domain ?? null : null;
  const documentById = new Map(documentRows.map((document) => [document.id, document]));
  const deliveryByRound = new Map<string, (typeof deliveryRows)[number]>();
  for (const delivery of deliveryRows) {
    if (!deliveryByRound.has(delivery.aggregateId)) deliveryByRound.set(delivery.aggregateId, delivery);
  }
  const safeDocument = (document: (typeof documentRows)[number]) => ({
    id: document.id,
    fileName: document.fileName,
    contentType: document.contentType,
    size: document.size,
    sha256: document.sha256,
    scanStatus: document.scanStatus,
  });
  const safeOutboundDocument = (document: (typeof documentRows)[number]) => ({
    id: document.id,
    fileName: document.fileName,
    contentType: document.contentType,
    size: document.size,
    sha256: document.sha256,
  });
  const serializeRound = (round: typeof negotiationRounds.$inferSelect) => {
    const outbound = documentById.get(round.outboundDocumentId);
    const outboundDocument = outbound
      && outbound.negotiationRoundId === round.id
      && outbound.role === "outbound_round"
      && outbound.direction === "outbound"
      && outbound.sha256 === round.outboundSha256
      ? safeOutboundDocument(outbound)
      : null;
    return {
      ...safeRound(
        round,
        round.id === active?.id ? activeEmailDomain : null,
        negotiationDeliveryState({
          deliveryMethod: round.deliveryMethod,
          outboxStatus: negotiationOutboxStatus(deliveryByRound.get(round.id)?.status),
        }),
      ),
      outboundDocument,
    };
  };
  const serializeSubmission = (submission: typeof negotiationSubmissions.$inferSelect) => {
    const document = submission.documentId ? documentById.get(submission.documentId) : null;
    const safeLinkedDocument = document
      && document.negotiationRoundId === submission.roundId
      && document.role === "counterparty_return"
      && document.direction === "inbound"
      && document.sha256 === submission.documentSha256
      ? safeDocument(document)
      : null;
    return { ...safeSubmission(submission), document: safeLinkedDocument };
  };
  return {
    agreementVersion: agreement.version,
    latestRound: latest ? serializeRound(latest) : null,
    activeRound: active ? serializeRound(active) : null,
    rounds: rounds.map(serializeRound),
    submissions: submissions.map(serializeSubmission),
    comparisons,
    deliveryConfigured: isDeliveryGatewayConfigured(),
    negotiationMailAccepted: isNegotiationMailAccepted(),
    inboundEmailConfigured: Boolean(configuration.inboundEmail),
    portalEnabled: configuration.portalEnabled,
  };
}

type BaseDocument = Readonly<{
  id: string;
  baseline: NegotiationBaseline;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  objectKey: string;
  bytes: Uint8Array;
}>;

async function selectBaseDocument(db: Database, workspaceId: string, agreementId: number): Promise<BaseDocument> {
  const [working] = await db.select().from(agreementDocumentVersions).where(and(
    eq(agreementDocumentVersions.workspaceId, workspaceId),
    eq(agreementDocumentVersions.agreementId, agreementId),
  )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
  if (working) {
    const bytes = await readVerifiedObject(working.objectKey, working.size, working.sha256, "base_document");
    const extension = working.contentType === "text/markdown" ? "md" : "txt";
    return {
      id: working.id,
      baseline: { kind: "working_version", version: working.version, documentId: null },
      fileName: `agreement-${agreementId}-v${working.version}.${extension}`,
      contentType: working.contentType,
      size: working.size,
      sha256: working.sha256,
      objectKey: working.objectKey,
      bytes,
    };
  }

  const readableStatuses = getNoticeConfig().mode === "evaluation" ? ["clean", "evaluation-bypassed"] : ["clean"];
  const [source] = await db.select().from(documents).where(and(
    eq(documents.workspaceId, workspaceId),
    eq(documents.agreementId, agreementId),
    inArray(documents.role, NEGOTIATION_BASE_SOURCE_ROLES),
    inArray(documents.scanStatus, readableStatuses),
    isNull(documents.deletedAt),
  )).orderBy(desc(documents.createdAt)).limit(1);
  if (!source) {
    throw new NegotiationServiceError(
      "base_document_required",
      "Create an immutable working version or link a clean source document before preparing a negotiation round.",
    );
  }
  const bytes = await readVerifiedObject(source.objectKey, source.size, source.sha256, "base_document");
  return {
    id: source.id,
    baseline: { kind: "source_document", version: null, documentId: source.id },
    fileName: source.fileName,
    contentType: source.contentType,
    size: source.size,
    sha256: source.sha256,
    objectKey: source.objectKey,
    bytes,
  };
}

export async function prepareNegotiationRound(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  expectedAgreementVersion: number;
  counterpartyEmail: string;
  counterpartyName: string;
  actor: UserActor;
  publicOrigin: string;
}>) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  if (agreement.version !== input.expectedAgreementVersion) {
    throw new NegotiationServiceError("version_conflict", "Reload the agreement before preparing a negotiation round.");
  }
  ensureAgreementMutable(agreement);
  await ensureNoActiveSignature(db, input.workspaceId, input.agreementId);
  if (await activeRoundForAgreement(db, input.workspaceId, input.agreementId)) {
    throw new NegotiationServiceError("negotiation_round_active", "Resolve or close the current negotiation round first.");
  }

  const counterpartyEmail = normalizeNegotiationEmail(input.counterpartyEmail);
  const counterpartyName = providerHeaderText(input.counterpartyName || agreement.party, "Counterparty display name", 200);
  const base = await selectBaseDocument(db, input.workspaceId, input.agreementId);
  const [last] = await db.select({ roundNumber: negotiationRounds.roundNumber }).from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, input.workspaceId),
    eq(negotiationRounds.agreementId, input.agreementId),
  )).orderBy(desc(negotiationRounds.roundNumber)).limit(1);
  const roundNumber = (last?.roundNumber ?? 0) + 1;
  const roundId = crypto.randomUUID();
  const outboundDocumentId = crypto.randomUUID();
  const outboundFileName = normalizedDocumentName(base.fileName);
  const outboundObjectKey = `workspaces/${input.workspaceId}/agreements/${input.agreementId}/negotiation/${roundId}/outbound/${outboundDocumentId}/${outboundFileName}`;
  await bindings().DOCUMENTS.put(outboundObjectKey, base.bytes, {
    httpMetadata: { contentType: base.contentType },
    customMetadata: {
      source: "negotiation-outbound",
      agreementId: String(input.agreementId),
      negotiationRoundId: roundId,
      sha256: base.sha256,
    },
  });

  try {
    const configuration = getCounterpartyExchangeConfiguration();
    const token = configuration.portalEnabled ? generateNegotiationToken() : null;
    const now = new Date().toISOString();
    const portalExpiresAt = token
      ? negotiationPortalExpiresAt(new Date(now), ttlMilliseconds(configuration.portalTtlHours))
      : null;
    const baselineReference = negotiationBaselineReference(base.baseline);
    const record: typeof negotiationRounds.$inferInsert = {
      id: roundId,
      workspaceId: input.workspaceId,
      agreementId: input.agreementId,
      roundNumber,
      status: "prepared",
      activeKey: `agreement:${input.agreementId}`,
      aliasCode: generateNegotiationAliasCode(),
      counterpartyEmail,
      counterpartyName,
      ...baselineReference,
      baseSha256: base.sha256,
      outboundDocumentId,
      outboundSha256: base.sha256,
      portalTokenHash: token ? await hashNegotiationToken(token) : null,
      portalExpiresAt,
      deliveryMethod: null,
      providerMessageId: null,
      resolvedDocumentVersion: null,
      resolvedSha256: null,
      createdByUserId: input.actor.id,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      resolvedAt: null,
      closedAt: null,
    };
    const outboundDocument: typeof documents.$inferInsert = {
      id: outboundDocumentId,
      workspaceId: input.workspaceId,
      version: 1,
      agreementId: input.agreementId,
      role: "outbound_round",
      direction: "outbound",
      negotiationRoundId: roundId,
      providerMessageId: null,
      parentSha256: base.sha256,
      originalSenderEmail: input.actor.email,
      fileName: outboundFileName,
      objectKey: outboundObjectKey,
      contentType: base.contentType,
      size: base.size,
      tags: [],
      extracted: {},
      extractionMode: "Immutable negotiation-round copy",
      sha256: base.sha256,
      scanStatus: "clean",
      scanProvider: "notice-verified-source",
      scannedAt: now,
      createdByUserId: input.actor.id,
      legalHold: agreement.legalHold,
      retentionUntil: agreement.retentionUntil,
      deletedAt: null,
      createdAt: now,
    };
    const agreementPatch = {
      stage: "Negotiation",
      signatureStatus: "Not sent",
      nextAction: `Send negotiation round ${roundNumber} to the counterparty`,
      version: agreement.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: input.actor.id,
    };
    const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
    const event = await prepareAgreementEvent(db, {
      workspaceId: input.workspaceId,
      agreementId: input.agreementId,
      type: "Negotiation",
      detail: `Prepared negotiation round ${roundNumber} from immutable document ${base.sha256.slice(0, 12)}….`,
      actor: input.actor,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, input.actor.id, event.id);
    const integration = prepareAgreementLifecycleUpdatedIntegrationEvent({
      before: agreement,
      agreement: saved,
      candidateFields: ["stage", "signatureStatus"],
    });
    const guardId = crypto.randomUUID();
    const statements = [
      db.update(agreements).set(agreementPatch).where(and(
        eq(agreements.workspaceId, input.workspaceId),
        eq(agreements.id, input.agreementId),
        eq(agreements.version, input.expectedAgreementVersion),
        eq(agreements.nextAction, agreement.nextAction),
        isNull(agreements.deletedAt),
        notExists(db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
          eq(signaturePackets.workspaceId, input.workspaceId),
          eq(signaturePackets.agreementId, input.agreementId),
          inArray(signaturePackets.status, ACTIVE_SIGNATURE_STATUSES),
        ))),
      )),
      db.insert(mutationGuards).values({
        id: guardId,
        workspaceId: input.workspaceId,
        operation: "negotiation.prepare",
        guardChanges: sql<number>`changes()`,
        createdAt: now,
      }),
      db.insert(documents).values(outboundDocument),
      db.insert(negotiationRounds).values(record),
      db.insert(agreementEvents).values(event),
      db.insert(agreementVersions).values(snapshot),
      ...(integration ? [db.insert(outboxEvents).values(prepareOutboxEvent(integration))] : []),
      db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, input.workspaceId), eq(mutationGuards.id, guardId))),
    ] as Parameters<typeof db.batch>[0];
    await db.batch(statements);
    return {
      agreement: saved,
      round: safeRound(record as typeof negotiationRounds.$inferSelect, configuration.inboundEmail?.domain ?? null),
      portalUrl: token ? portalUrl(input.publicOrigin, token) : null,
      portalTokenIssued: Boolean(token),
    };
  } catch (error) {
    await cleanupUncommittedObject(db, input.workspaceId, {
      kind: "document",
      id: outboundDocumentId,
      objectKey: outboundObjectKey,
      sha256: base.sha256,
    });
    throw error;
  }
}

export async function rotateNegotiationPortal(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  roundId: string;
  publicOrigin: string;
  actor: UserActor;
}>) {
  const configuration = getCounterpartyExchangeConfiguration();
  if (!configuration.portalEnabled) {
    throw new NegotiationServiceError("portal_disabled", "The scoped counterparty portal is not enabled.");
  }
  const db = getDb();
  const round = await roundById(db, input.workspaceId, input.agreementId, input.roundId);
  if (!round) throw new NegotiationServiceError("negotiation_round_not_found", "Negotiation round was not found.", 404);
  if (!round.activeKey || !ACTIVE_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_ROUND_STATUSES)[number])) {
    throw new NegotiationServiceError("negotiation_round_closed", "Closed or resolved negotiation rounds cannot receive a new portal link.");
  }
  const [undeliveredRequest] = await db.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
    eq(outboxEvents.workspaceId, input.workspaceId),
    eq(outboxEvents.topic, "negotiation.round_requested"),
    eq(outboxEvents.aggregateType, "negotiation_round"),
    eq(outboxEvents.aggregateId, round.id),
    inArray(outboxEvents.status, ["pending", "processing"]),
  )).limit(1);
  if (undeliveredRequest) {
    throw new NegotiationServiceError(
      "delivery_in_progress",
      "Wait for the queued email delivery to finish before rotating its portal link.",
    );
  }
  const token = generateNegotiationToken();
  const now = new Date().toISOString();
  const expiresAt = negotiationPortalExpiresAt(new Date(now), ttlMilliseconds(configuration.portalTtlHours));
  const event = await prepareAgreementEvent(db, {
    workspaceId: input.workspaceId,
    agreementId: input.agreementId,
    type: "Negotiation security",
    detail: `Revoked and rotated the scoped portal link for negotiation round ${round.roundNumber}; the replacement expires ${expiresAt}.`,
    actor: input.actor,
    createdAt: now,
  });
  const guardId = crypto.randomUUID();
  await db.batch([
    db.update(negotiationRounds).set({
      portalTokenHash: await hashNegotiationToken(token),
      portalExpiresAt: expiresAt,
      updatedAt: now,
    }).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.id, round.id),
      eq(negotiationRounds.updatedAt, round.updatedAt),
      isNotNull(negotiationRounds.activeKey),
      notExists(db.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
        eq(outboxEvents.workspaceId, input.workspaceId),
        eq(outboxEvents.topic, "negotiation.round_requested"),
        eq(outboxEvents.aggregateType, "negotiation_round"),
        eq(outboxEvents.aggregateId, round.id),
        inArray(outboxEvents.status, ["pending", "processing"]),
      ))),
    )),
    db.insert(mutationGuards).values({
      id: guardId,
      workspaceId: input.workspaceId,
      operation: "negotiation.rotate_portal",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
    db.insert(agreementEvents).values(event),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, input.workspaceId),
      eq(mutationGuards.id, guardId),
    )),
  ]);
  return { portalUrl: portalUrl(input.publicOrigin, token), expiresAt };
}

async function outboundDocumentRecord(db: Database, round: typeof negotiationRounds.$inferSelect) {
  const [document] = await db.select().from(documents).where(and(
    eq(documents.workspaceId, round.workspaceId),
    eq(documents.agreementId, round.agreementId),
    eq(documents.id, round.outboundDocumentId),
    eq(documents.negotiationRoundId, round.id),
    eq(documents.role, "outbound_round"),
    eq(documents.direction, "outbound"),
    isNull(documents.deletedAt),
  )).limit(1);
  if (!document || document.sha256 !== round.outboundSha256 || document.scanStatus !== "clean") {
    throw new NegotiationServiceError("outbound_document_invalid", "The immutable outbound negotiation document is unavailable or no longer trusted.");
  }
  return document;
}

async function verifiedOutboundDocument(db: Database, round: typeof negotiationRounds.$inferSelect) {
  const document = await outboundDocumentRecord(db, round);
  await readVerifiedObject(document.objectKey, document.size, document.sha256, "outbound_document");
  return document;
}

function noPendingRoundDeliveryPredicate(db: Database, workspaceId: string, roundId: string) {
  return notExists(db.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
    eq(outboxEvents.workspaceId, workspaceId),
    eq(outboxEvents.topic, "negotiation.round_requested"),
    eq(outboxEvents.aggregateType, "negotiation_round"),
    eq(outboxEvents.aggregateId, roundId),
    inArray(outboxEvents.status, ["pending", "processing"]),
  )));
}

async function ensureNoPendingRoundDelivery(db: Database, workspaceId: string, roundId: string) {
  const [delivery] = await db.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
    eq(outboxEvents.workspaceId, workspaceId),
    eq(outboxEvents.topic, "negotiation.round_requested"),
    eq(outboxEvents.aggregateType, "negotiation_round"),
    eq(outboxEvents.aggregateId, roundId),
    inArray(outboxEvents.status, ["pending", "processing"]),
  )).limit(1);
  if (delivery) {
    throw new NegotiationServiceError(
      "delivery_in_progress",
      "Wait for the queued email delivery to finish before revoking or resolving this round.",
    );
  }
}

export async function sendNegotiationRound(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  roundId: string;
  expectedAgreementVersion: number;
  recipientEmail: string;
  subject: string;
  message: string;
  actor: UserActor;
  publicOrigin: string;
}>) {
  const configuration = getCounterpartyExchangeConfiguration();
  if (!configuration.portalEnabled) {
    throw new NegotiationServiceError(
      "exchange_not_configured",
      "Sending requires the scoped counterparty portal.",
    );
  }
  // Fail before any state mutation unless the independently required outbound
  // delivery gateway and the counterparty-message path are independently
  // accepted, fully enabled, and credentialed.
  try {
    void getNegotiationDeliveryConfiguration();
  } catch {
    throw new NegotiationServiceError(
      "delivery_not_configured",
      "Sending requires the outbound gateway and its separate automated counterparty-delivery acceptance.",
      503,
    );
  }
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  if (agreement.version !== input.expectedAgreementVersion) {
    throw new NegotiationServiceError("version_conflict", "Reload the agreement before sending this negotiation round.");
  }
  ensureAgreementMutable(agreement);
  await ensureNoActiveSignature(db, input.workspaceId, input.agreementId);
  const round = await roundById(db, input.workspaceId, input.agreementId, input.roundId);
  if (!round) throw new NegotiationServiceError("negotiation_round_not_found", "Negotiation round was not found.", 404);
  if (!round.activeKey || round.status !== "prepared") {
    throw new NegotiationServiceError("negotiation_round_not_prepared", "Only the active prepared round can be sent.");
  }
  const recipientEmail = normalizeNegotiationEmail(input.recipientEmail);
  const subject = providerHeaderText(input.subject, "Email subject", 300);
  if (!round.counterpartyEmail || recipientEmail !== round.counterpartyEmail) {
    throw new NegotiationServiceError("recipient_mismatch", "The recipient must exactly match the address approved when this round was prepared.");
  }
  const outboundDocument = await verifiedOutboundDocument(db, round);
  const token = generateNegotiationToken();
  const now = new Date().toISOString();
  const expiresAt = negotiationPortalExpiresAt(new Date(now), ttlMilliseconds(configuration.portalTtlHours));
  const agreementPatch = {
    stage: "Negotiation",
    signatureStatus: "Not sent",
    nextAction: `Confirm gateway delivery for negotiation round ${round.roundNumber}`,
    version: agreement.version + 1,
    updated: now,
    updatedAt: now,
    updatedByUserId: input.actor.id,
  };
  const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
  const event = await prepareAgreementEvent(db, {
    workspaceId: input.workspaceId,
    agreementId: input.agreementId,
    type: "Negotiation",
    detail: `Queued negotiation round ${round.roundNumber} for authenticated gateway delivery from immutable document ${round.outboundSha256.slice(0, 12)}….`,
    actor: input.actor,
    createdAt: now,
  });
  const snapshot = await prepareAgreementSnapshot(saved, input.actor.id, event.id);
  const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
    workspaceId: input.workspaceId,
    topic: "negotiation.round_requested",
    aggregateType: "negotiation_round",
    aggregateId: round.id,
    payload: {
      roundId: round.id,
      agreementId: agreement.id,
      roundNumber: round.roundNumber,
      party: agreement.party,
      agreementType: agreement.type,
      subject,
      message: input.message.trim().slice(0, 4_000),
      recipient: { email: recipientEmail, displayName: round.counterpartyName ?? agreement.party },
      ...(configuration.inboundEmail
        ? { replyTo: buildNegotiationAliasAddress(round.aliasCode, configuration.inboundEmail.domain) }
        : {}),
      portalUrl: portalUrl(input.publicOrigin, token),
      outboundDocument: {
        id: outboundDocument.id,
        fileName: outboundDocument.fileName,
        sha256: outboundDocument.sha256,
      },
      sentBy: { userId: input.actor.id, email: input.actor.email, displayName: input.actor.displayName },
      aggregateVersion: agreementPatch.version,
    },
  }));
  const agreementGuardId = crypto.randomUUID();
  const roundGuardId = crypto.randomUUID();
  const statements = [
    db.update(agreements).set(agreementPatch).where(and(
      eq(agreements.workspaceId, input.workspaceId),
      eq(agreements.id, agreement.id),
      eq(agreements.version, input.expectedAgreementVersion),
      eq(agreements.nextAction, agreement.nextAction),
      isNull(agreements.deletedAt),
    )),
    db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId: input.workspaceId, operation: "negotiation.send.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.update(negotiationRounds).set({
      status: "outbound",
      deliveryMethod: "email_gateway",
      portalTokenHash: await hashNegotiationToken(token),
      portalExpiresAt: expiresAt,
      sentAt: now,
      updatedAt: now,
    }).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.id, round.id),
      eq(negotiationRounds.status, "prepared"),
      eq(negotiationRounds.updatedAt, round.updatedAt),
      isNotNull(negotiationRounds.activeKey),
    )),
    db.insert(mutationGuards).values({ id: roundGuardId, workspaceId: input.workspaceId, operation: "negotiation.send.round", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.insert(agreementEvents).values(event),
    db.insert(agreementVersions).values(snapshot),
    db.insert(outboxEvents).values(outbox),
    db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, input.workspaceId), inArray(mutationGuards.id, [agreementGuardId, roundGuardId]))),
  ] as Parameters<typeof db.batch>[0];
  await db.batch(statements);
  return {
    agreement: saved,
    roundId: round.id,
    status: "outbound" as const,
    queued: true,
    portalExpiresAt: expiresAt,
    portalUrl: portalUrl(input.publicOrigin, token),
  };
}

export async function attestManualNegotiationSend(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  roundId: string;
  expectedAgreementVersion: number;
  recipientEmail: string;
  providerMessageId: string;
  actor: UserActor;
}>) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  if (agreement.version !== input.expectedAgreementVersion) throw new NegotiationServiceError("version_conflict", "Reload the agreement before recording manual delivery.");
  ensureAgreementMutable(agreement);
  await ensureNoActiveSignature(db, input.workspaceId, input.agreementId);
  const round = await roundById(db, input.workspaceId, input.agreementId, input.roundId);
  if (!round || !round.activeKey || round.status !== "prepared") {
    throw new NegotiationServiceError("negotiation_round_not_prepared", "Only the active prepared round can be marked as manually sent.");
  }
  const recipientEmail = normalizeNegotiationEmail(input.recipientEmail);
  if (!round.counterpartyEmail || recipientEmail !== round.counterpartyEmail) {
    throw new NegotiationServiceError("recipient_mismatch", "The manual recipient must match the prepared counterparty address.");
  }
  await verifiedOutboundDocument(db, round);
  const providerMessageId = input.providerMessageId.trim().slice(0, 500);
  if (!providerMessageId) throw new NegotiationServiceError("message_reference_required", "Record a bounded manual delivery reference.", 400);
  const now = new Date().toISOString();
  const agreementPatch = {
    stage: "Negotiation",
    signatureStatus: "Not sent",
    nextAction: `Await counterparty response for negotiation round ${round.roundNumber}`,
    version: agreement.version + 1,
    updated: now,
    updatedAt: now,
    updatedByUserId: input.actor.id,
  };
  const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
  const event = await prepareAgreementEvent(db, {
    workspaceId: input.workspaceId,
    agreementId: agreement.id,
    type: "Negotiation",
    detail: `Recorded manual delivery of negotiation round ${round.roundNumber}; the supplied message reference is evidence, not provider verification.`,
    actor: input.actor,
    createdAt: now,
  });
  const snapshot = await prepareAgreementSnapshot(saved, input.actor.id, event.id);
  const agreementGuardId = crypto.randomUUID();
  const roundGuardId = crypto.randomUUID();
  await db.batch([
    db.update(agreements).set(agreementPatch).where(and(eq(agreements.workspaceId, input.workspaceId), eq(agreements.id, agreement.id), eq(agreements.version, input.expectedAgreementVersion), eq(agreements.nextAction, agreement.nextAction), isNull(agreements.deletedAt))),
    db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId: input.workspaceId, operation: "negotiation.attest.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.update(negotiationRounds).set({ status: "outbound", deliveryMethod: "manual", providerMessageId, sentAt: now, updatedAt: now }).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.id, round.id),
      eq(negotiationRounds.status, "prepared"),
      eq(negotiationRounds.updatedAt, round.updatedAt),
      isNotNull(negotiationRounds.activeKey),
    )),
    db.insert(mutationGuards).values({ id: roundGuardId, workspaceId: input.workspaceId, operation: "negotiation.attest.round", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.insert(agreementEvents).values(event),
    db.insert(agreementVersions).values(snapshot),
    db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, input.workspaceId), inArray(mutationGuards.id, [agreementGuardId, roundGuardId]))),
  ]);
  return { agreement: saved, roundId: round.id, status: "outbound" as const, deliveryMethod: "manual" as const };
}

export async function closeNegotiationRound(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  roundId: string;
  expectedAgreementVersion: number;
  note: string;
  actor: UserActor;
}>) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  if (agreement.version !== input.expectedAgreementVersion) throw new NegotiationServiceError("version_conflict", "Reload the agreement before closing this round.");
  const round = await roundById(db, input.workspaceId, input.agreementId, input.roundId);
  if (!round) throw new NegotiationServiceError("negotiation_round_not_found", "Negotiation round was not found.", 404);
  if (!round.activeKey || !ACTIVE_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_ROUND_STATUSES)[number])) {
    throw new NegotiationServiceError("negotiation_round_closed", "The negotiation round is already resolved or closed.");
  }
  await ensureNoPendingRoundDelivery(db, input.workspaceId, round.id);
  const note = input.note.trim().slice(0, 2_000);
  if (!note) throw new NegotiationServiceError("decision_note_required", "Explain why this negotiation round is being closed.", 400);
  const now = new Date().toISOString();
  const agreementPatch = {
    nextAction: "Review the current working paper and determine the next contract action",
    version: agreement.version + 1,
    updated: now,
    updatedAt: now,
    updatedByUserId: input.actor.id,
  };
  const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
  const event = await prepareAgreementEvent(db, {
    workspaceId: input.workspaceId,
    agreementId: agreement.id,
    type: "Negotiation",
    detail: `Closed negotiation round ${round.roundNumber}: ${note}`,
    actor: input.actor,
    createdAt: now,
  });
  const snapshot = await prepareAgreementSnapshot(saved, input.actor.id, event.id);
  const agreementGuardId = crypto.randomUUID();
  const roundGuardId = crypto.randomUUID();
  await db.batch([
    db.update(agreements).set(agreementPatch).where(and(eq(agreements.workspaceId, input.workspaceId), eq(agreements.id, agreement.id), eq(agreements.version, input.expectedAgreementVersion), eq(agreements.nextAction, agreement.nextAction), isNull(agreements.deletedAt))),
    db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId: input.workspaceId, operation: "negotiation.close.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.update(negotiationRounds).set({ status: "closed", activeKey: null, portalTokenHash: null, portalExpiresAt: now, closedAt: now, updatedAt: now }).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.id, round.id),
      eq(negotiationRounds.updatedAt, round.updatedAt),
      isNotNull(negotiationRounds.activeKey),
      noPendingRoundDeliveryPredicate(db, input.workspaceId, round.id),
    )),
    db.insert(mutationGuards).values({ id: roundGuardId, workspaceId: input.workspaceId, operation: "negotiation.close.round", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.insert(agreementEvents).values(event),
    db.insert(agreementVersions).values(snapshot),
    db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, input.workspaceId), inArray(mutationGuards.id, [agreementGuardId, roundGuardId]))),
  ]);
  return { agreement: saved, roundId: round.id, status: "closed" as const };
}

export async function rejectNegotiationSubmission(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  submissionId: string;
  note: string;
  actor: UserActor;
}>) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  const [submission] = await db.select().from(negotiationSubmissions).where(and(
    eq(negotiationSubmissions.workspaceId, input.workspaceId),
    eq(negotiationSubmissions.agreementId, input.agreementId),
    eq(negotiationSubmissions.id, input.submissionId),
  )).limit(1);
  if (!submission) throw new NegotiationServiceError("submission_not_found", "Negotiation submission was not found.", 404);
  if (submission.status === "promoted" || submission.status === "rejected") {
    throw new NegotiationServiceError("submission_already_decided", "A decided submission cannot be rejected again.");
  }
  const note = input.note.trim().slice(0, 2_000);
  if (!note) throw new NegotiationServiceError("decision_note_required", "Record a reason for rejecting this submission.", 400);
  const [round, latestRound, roundSubmissions] = await Promise.all([
    roundById(db, input.workspaceId, input.agreementId, submission.roundId),
    db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.agreementId, input.agreementId),
    )).orderBy(desc(negotiationRounds.roundNumber)).limit(1).then((rows) => rows[0] ?? null),
    db.select({
      id: negotiationSubmissions.id,
      status: negotiationSubmissions.status,
    }).from(negotiationSubmissions).where(and(
      eq(negotiationSubmissions.workspaceId, input.workspaceId),
      eq(negotiationSubmissions.agreementId, input.agreementId),
      eq(negotiationSubmissions.roundId, submission.roundId),
    )),
  ]);
  const activeRound = round
    && round.activeKey
    && latestRound?.id === round.id
    && ACTIVE_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_ROUND_STATUSES)[number])
    ? round
    : null;
  const roundAction = activeRound
    ? deriveNegotiationRoundAction({
      roundNumber: activeRound.roundNumber,
      currentStatus: activeRound.status,
      submissionStatuses: roundSubmissions.map((row) => row.id === submission.id ? "rejected" : row.status),
    })
    : null;
  const now = new Date().toISOString();
  const nextRoundUpdatedAt = activeRound
    ? new Date(Math.max(Date.now(), Date.parse(activeRound.updatedAt) + 1)).toISOString()
    : null;
  const agreementPatch = roundAction
    ? {
        nextAction: roundAction.nextAction,
        updated: now,
        updatedAt: now,
        updatedByUserId: input.actor.id,
      }
    : null;
  const savedAgreement: typeof agreements.$inferSelect = agreementPatch ? { ...agreement, ...agreementPatch } : agreement;
  const event = await prepareAgreementEvent(db, {
    workspaceId: input.workspaceId,
    agreementId: input.agreementId,
    type: "Redline",
    detail: `Rejected negotiation submission ${submission.id}: ${note}`,
    actor: input.actor,
    createdAt: now,
  });
  const agreementGuardId = crypto.randomUUID();
  const submissionGuardId = crypto.randomUUID();
  const roundGuardId = activeRound ? crypto.randomUUID() : null;
  await db.batch([
    db.update(agreements).set(agreementPatch ?? { updatedAt: sql`${agreements.updatedAt}` }).where(and(
      eq(agreements.workspaceId, input.workspaceId),
      eq(agreements.id, input.agreementId),
      eq(agreements.version, agreement.version),
      eq(agreements.nextAction, agreement.nextAction),
      isNull(agreements.deletedAt),
    )),
    db.insert(mutationGuards).values({
      id: agreementGuardId,
      workspaceId: input.workspaceId,
      operation: "negotiation.reject_submission.agreement",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
    ...(activeRound && roundAction && nextRoundUpdatedAt && roundGuardId ? [
      db.update(negotiationRounds).set({
        status: roundAction.roundStatus,
        updatedAt: nextRoundUpdatedAt,
      }).where(and(
        eq(negotiationRounds.workspaceId, input.workspaceId),
        eq(negotiationRounds.agreementId, input.agreementId),
        eq(negotiationRounds.id, activeRound.id),
        eq(negotiationRounds.status, activeRound.status),
        eq(negotiationRounds.updatedAt, activeRound.updatedAt),
        eq(negotiationRounds.activeKey, activeRound.activeKey!),
        notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, input.workspaceId),
          eq(negotiationRounds.agreementId, input.agreementId),
          gt(negotiationRounds.roundNumber, activeRound.roundNumber),
        ))),
      )),
      db.insert(mutationGuards).values({
        id: roundGuardId,
        workspaceId: input.workspaceId,
        operation: "negotiation.reject_submission.round",
        guardChanges: sql<number>`changes()`,
        createdAt: now,
      }),
    ] : []),
    db.update(negotiationSubmissions).set({
      status: "rejected",
      decisionNote: note,
      reviewedByUserId: input.actor.id,
      reviewedAt: now,
    }).where(and(
      eq(negotiationSubmissions.workspaceId, input.workspaceId),
      eq(negotiationSubmissions.id, submission.id),
      eq(negotiationSubmissions.status, submission.status),
    )),
    db.insert(mutationGuards).values({
      id: submissionGuardId,
      workspaceId: input.workspaceId,
      operation: "negotiation.reject_submission",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
    db.update(documentComparisons).set({
      status: "rejected",
      decisionNote: note,
      decidedByUserId: input.actor.id,
      decidedAt: now,
      updatedAt: now,
    }).where(and(
      eq(documentComparisons.workspaceId, input.workspaceId),
      eq(documentComparisons.submissionId, submission.id),
    )),
    db.insert(agreementEvents).values(event),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, input.workspaceId),
      inArray(mutationGuards.id, [agreementGuardId, submissionGuardId, ...(roundGuardId ? [roundGuardId] : [])]),
    )),
  ]);
  return { agreement: savedAgreement, submissionId: submission.id, status: "rejected" as const, event };
}

export async function markNegotiationSubmissionReady(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  submissionId: string;
  note: string;
  actor: UserActor;
}>) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  const [submission] = await db.select().from(negotiationSubmissions).where(and(
    eq(negotiationSubmissions.workspaceId, input.workspaceId),
    eq(negotiationSubmissions.agreementId, input.agreementId),
    eq(negotiationSubmissions.id, input.submissionId),
  )).limit(1);
  if (!submission || !submission.documentId || !submission.documentSha256) {
    throw new NegotiationServiceError("submission_not_found", "Negotiation submission was not found.", 404);
  }
  const [round, document, latestRound] = await Promise.all([
    roundById(db, input.workspaceId, input.agreementId, submission.roundId),
    db.select().from(documents).where(and(
      eq(documents.workspaceId, input.workspaceId),
      eq(documents.agreementId, input.agreementId),
      eq(documents.id, submission.documentId),
      isNull(documents.deletedAt),
    )).limit(1).then((rows) => rows[0] ?? null),
    db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.agreementId, input.agreementId),
    )).orderBy(desc(negotiationRounds.roundNumber)).limit(1).then((rows) => rows[0] ?? null),
  ]);
  const roundIsCurrentAndActive = Boolean(
    round
    && round.activeKey
    && latestRound?.id === round.id
    && ACTIVE_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_ROUND_STATUSES)[number]),
  );
  if (!document || document.sha256 !== submission.documentSha256 || !canMarkNegotiationSubmissionReady({
    submissionStatus: submission.status,
    documentScanStatus: document?.scanStatus ?? "missing",
    roundIsCurrentAndActive,
  })) {
    throw new NegotiationServiceError(
      "submission_not_eligible",
      "Only a clean sender-review or rescanned quarantine submission from the latest active round can be marked ready.",
    );
  }
  await readVerifiedObject(document.objectKey, document.size, document.sha256, "submission_document");
  const note = input.note.trim().slice(0, 2_000);
  if (!note) throw new NegotiationServiceError("decision_note_required", "Record how the sender or clean rescan was verified.", 400);
  const now = new Date().toISOString();
  const nextRoundUpdatedAt = new Date(Math.max(Date.now(), Date.parse(round!.updatedAt) + 1)).toISOString();
  const agreementPatch = {
    nextAction: `Review returned counterparty file for negotiation round ${round!.roundNumber}`,
    updated: now,
    updatedAt: now,
    updatedByUserId: input.actor.id,
  };
  const savedAgreement: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
  const event = await prepareAgreementEvent(db, {
    workspaceId: input.workspaceId,
    agreementId: input.agreementId,
    type: "Redline",
    detail: `Marked negotiation submission ${submission.id} (${document.sha256}) ready after staff verification of ${document.scanProvider ?? "the recorded scanner"} result ${document.scannedAt ?? "at an unrecorded time"}: ${note}`,
    actor: input.actor,
    createdAt: now,
  });
  const agreementGuardId = crypto.randomUUID();
  const documentGuardId = crypto.randomUUID();
  const submissionGuardId = crypto.randomUUID();
  const roundGuardId = crypto.randomUUID();
  await db.batch([
    db.update(agreements).set(agreementPatch).where(and(
      eq(agreements.workspaceId, input.workspaceId),
      eq(agreements.id, input.agreementId),
      eq(agreements.version, agreement.version),
      eq(agreements.nextAction, agreement.nextAction),
      isNull(agreements.deletedAt),
    )),
    db.insert(mutationGuards).values({
      id: agreementGuardId,
      workspaceId: input.workspaceId,
      operation: "negotiation.mark_ready.agreement",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
    db.update(documents).set({ version: sql`${documents.version}` }).where(and(
      eq(documents.workspaceId, input.workspaceId),
      eq(documents.id, document.id),
      eq(documents.version, document.version),
      eq(documents.agreementId, input.agreementId),
      eq(documents.negotiationRoundId, round!.id),
      eq(documents.role, "counterparty_return"),
      eq(documents.direction, "inbound"),
      eq(documents.sha256, submission.documentSha256),
      eq(documents.scanStatus, "clean"),
      isNull(documents.deletedAt),
    )),
    db.insert(mutationGuards).values({
      id: documentGuardId,
      workspaceId: input.workspaceId,
      operation: "negotiation.mark_ready.document",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
    db.update(negotiationSubmissions).set({
      status: "ready",
      decisionNote: note,
      reviewedByUserId: input.actor.id,
      reviewedAt: now,
    }).where(and(
      eq(negotiationSubmissions.workspaceId, input.workspaceId),
      eq(negotiationSubmissions.id, submission.id),
      eq(negotiationSubmissions.status, submission.status),
      inArray(negotiationSubmissions.status, ["sender_review", "quarantined"]),
    )),
    db.insert(mutationGuards).values({
      id: submissionGuardId,
      workspaceId: input.workspaceId,
      operation: "negotiation.mark_ready",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
    db.update(negotiationRounds).set({ status: "returned", updatedAt: nextRoundUpdatedAt }).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.id, round!.id),
      eq(negotiationRounds.status, round!.status),
      eq(negotiationRounds.updatedAt, round!.updatedAt),
      isNotNull(negotiationRounds.activeKey),
      inArray(negotiationRounds.status, ACTIVE_ROUND_STATUSES),
      notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
        eq(negotiationRounds.workspaceId, input.workspaceId),
        eq(negotiationRounds.agreementId, input.agreementId),
        gt(negotiationRounds.roundNumber, round!.roundNumber),
      ))),
    )),
    db.insert(mutationGuards).values({
      id: roundGuardId,
      workspaceId: input.workspaceId,
      operation: "negotiation.mark_ready.round",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
    db.insert(agreementEvents).values(event),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, input.workspaceId),
      inArray(mutationGuards.id, [agreementGuardId, documentGuardId, submissionGuardId, roundGuardId]),
    )),
  ]);
  return { agreement: savedAgreement, submissionId: submission.id, status: "ready" as const, event };
}

async function baseTextForRound(db: Database, round: typeof negotiationRounds.$inferSelect): Promise<{
  bytes: Uint8Array;
  sha256: string;
} | null> {
  if (!round.baseDocumentVersion || round.baseDocumentId !== null) return null;
  const [version] = await db.select().from(agreementDocumentVersions).where(and(
    eq(agreementDocumentVersions.workspaceId, round.workspaceId),
    eq(agreementDocumentVersions.agreementId, round.agreementId),
    eq(agreementDocumentVersions.version, round.baseDocumentVersion),
  )).limit(1);
  if (!version || version.sha256 !== round.baseSha256 || !["text/plain", "text/markdown"].includes(version.contentType)) return null;
  const bytes = await readVerifiedObject(version.objectKey, version.size, version.sha256, "base_text");
  return { bytes, sha256: version.sha256 };
}

function cleanReviewedText(content: string): { text: string; bytes: Uint8Array } {
  if (content.trim().length === 0) throw new NegotiationServiceError("reviewed_text_required", "Reviewed working text cannot be blank.", 400);
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_REVIEW_TEXT_BYTES) {
    throw new NegotiationServiceError("reviewed_text_too_large", "Reviewed working text exceeds the 2 MB limit.", 413);
  }
  return { text: content, bytes };
}

export async function promoteNegotiationSubmission(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  roundId: string;
  submissionId: string;
  expectedAgreementVersion: number;
  reviewedText: string;
  contentType: "text/plain" | "text/markdown";
  label: string;
  note: string;
  actor: UserActor;
}>) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  if (agreement.version !== input.expectedAgreementVersion) throw new NegotiationServiceError("version_conflict", "Reload the agreement before promoting this submission.");
  ensureAgreementMutable(agreement);
  await ensureNoActiveSignature(db, input.workspaceId, input.agreementId);
  const [round, latestRound] = await Promise.all([
    roundById(db, input.workspaceId, input.agreementId, input.roundId),
    db.select().from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, input.workspaceId),
      eq(negotiationRounds.agreementId, input.agreementId),
    )).orderBy(desc(negotiationRounds.roundNumber)).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!round || !round.activeKey || round.id !== latestRound?.id || !ACTIVE_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_ROUND_STATUSES)[number])) {
    throw new NegotiationServiceError("negotiation_round_not_current", "Only a submission from the exact latest active negotiation round can be promoted.");
  }
  await ensureNoPendingRoundDelivery(db, input.workspaceId, round.id);
  const [submission] = await db.select().from(negotiationSubmissions).where(and(
    eq(negotiationSubmissions.workspaceId, input.workspaceId),
    eq(negotiationSubmissions.agreementId, input.agreementId),
    eq(negotiationSubmissions.roundId, round.id),
    eq(negotiationSubmissions.id, input.submissionId),
  )).limit(1);
  if (!submission || submission.status !== "ready" || !submission.documentId || !submission.documentSha256) {
    throw new NegotiationServiceError("submission_not_ready", "Only a clean, authorized, ready submission can be promoted.");
  }
  const [sourceDocument] = await db.select().from(documents).where(and(
    eq(documents.workspaceId, input.workspaceId),
    eq(documents.agreementId, input.agreementId),
    eq(documents.id, submission.documentId),
    eq(documents.negotiationRoundId, round.id),
    eq(documents.scanStatus, "clean"),
    isNull(documents.deletedAt),
  )).limit(1);
  if (!sourceDocument || sourceDocument.sha256 !== submission.documentSha256) {
    throw new NegotiationServiceError("submission_document_untrusted", "The returned source document is missing or no longer has a clean matching hash.");
  }
  await readVerifiedObject(sourceDocument.objectKey, sourceDocument.size, sourceDocument.sha256, "submission_document");
  const note = input.note.trim().slice(0, 2_000);
  if (!note) throw new NegotiationServiceError("decision_note_required", "Record the human review performed before promotion.", 400);
  const reviewed = cleanReviewedText(input.reviewedText);
  const reviewedSha256 = await sha256Hex(reviewed.bytes);
  const [lastVersion] = await db.select({ version: agreementDocumentVersions.version }).from(agreementDocumentVersions).where(and(
    eq(agreementDocumentVersions.workspaceId, input.workspaceId),
    eq(agreementDocumentVersions.agreementId, input.agreementId),
  )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
  const versionNumber = (lastVersion?.version ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const extension = input.contentType === "text/markdown" ? "md" : "txt";
  const objectKey = `workspaces/${input.workspaceId}/agreements/${input.agreementId}/versions/${versionNumber}/${versionId}.${extension}`;
  await bindings().DOCUMENTS.put(objectKey, reviewed.bytes, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: {
      agreementId: String(input.agreementId),
      version: String(versionNumber),
      sha256: reviewedSha256,
      sourceDocumentId: sourceDocument.id,
      negotiationRoundId: round.id,
      negotiationSubmissionId: submission.id,
    },
  });

  try {
    const now = new Date().toISOString();
    const baseText = await baseTextForRound(db, round);
    const comparisonStatus = baseText ? "accepted" as const : "manual_required" as const;
    const comparisonProvenance = baseText
      ? "Exact pinned text basis and human-reviewed proposed text; no automated legal verdict."
      : "Pinned source was not an exact readable text working version; human review supplied the promoted text and no comparison result is claimed.";
    const [existingComparison] = await db.select().from(documentComparisons).where(and(
      eq(documentComparisons.workspaceId, input.workspaceId),
      eq(documentComparisons.roundId, round.id),
      eq(documentComparisons.submissionId, submission.id),
    )).limit(1);
    const comparisonId = existingComparison?.id ?? crypto.randomUUID();
    const agreementPatch = {
      approvalStatus: "Required",
      signatureStatus: "Not sent",
      stage: "Negotiation",
      nextAction: "Assess risk for the promoted counterparty revision",
      risk: "Unassessed",
      riskDisposition: null,
      riskBasisHash: null,
      riskDocumentVersion: null,
      riskDocumentSha256: null,
      riskDecisionReason: null,
      riskDecidedByUserId: null,
      riskDecidedAt: null,
      version: agreement.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: input.actor.id,
    };
    const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
    const event = await prepareAgreementEvent(db, {
      workspaceId: input.workspaceId,
      agreementId: agreement.id,
      type: "Version",
      detail: `Promoted negotiation submission ${submission.id} as immutable working version ${versionNumber} after human review. Prior risk evidence, approvals, and signature readiness were invalidated.`,
      actor: input.actor,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, input.actor.id, event.id);
    const integration = prepareAgreementLifecycleUpdatedIntegrationEvent({
      before: agreement,
      agreement: saved,
      candidateFields: ["approvalStatus", "signatureStatus", "stage"],
    });
    const agreementGuardId = crypto.randomUUID();
    const roundGuardId = crypto.randomUUID();
    const submissionGuardId = crypto.randomUUID();
    const statements = [
      db.update(agreements).set(agreementPatch).where(and(eq(agreements.workspaceId, input.workspaceId), eq(agreements.id, agreement.id), eq(agreements.version, input.expectedAgreementVersion), eq(agreements.nextAction, agreement.nextAction), isNull(agreements.deletedAt))),
      db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId: input.workspaceId, operation: "negotiation.promote.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
      db.update(negotiationRounds).set({
        status: "resolved",
        activeKey: null,
        portalTokenHash: null,
        portalExpiresAt: now,
        resolvedDocumentVersion: versionNumber,
        resolvedSha256: reviewedSha256,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(
        eq(negotiationRounds.workspaceId, input.workspaceId),
        eq(negotiationRounds.id, round.id),
        eq(negotiationRounds.updatedAt, round.updatedAt),
        isNotNull(negotiationRounds.activeKey),
        noPendingRoundDeliveryPredicate(db, input.workspaceId, round.id),
      )),
      db.insert(mutationGuards).values({ id: roundGuardId, workspaceId: input.workspaceId, operation: "negotiation.promote.round", guardChanges: sql<number>`changes()`, createdAt: now }),
      db.insert(agreementDocumentVersions).values({
        id: versionId,
        workspaceId: input.workspaceId,
        agreementId: input.agreementId,
        version: versionNumber,
        label: input.label.trim().slice(0, 120) || `Counterparty revision round ${round.roundNumber}`,
        objectKey,
        contentType: input.contentType,
        size: reviewed.bytes.byteLength,
        sha256: reviewedSha256,
        sourceDocumentId: sourceDocument.id,
        createdByUserId: input.actor.id,
        createdAt: now,
      }),
      db.update(approvalRequests).set({ status: "Superseded", version: sql`${approvalRequests.version} + 1` }).where(and(
        eq(approvalRequests.workspaceId, input.workspaceId),
        eq(approvalRequests.agreementId, input.agreementId),
        inArray(approvalRequests.status, ["Pending", "Approved", "Changes requested"]),
      )),
      db.update(negotiationSubmissions).set({
        status: "promoted",
        ...(!submission.reviewTextObjectKey ? {
          reviewTextObjectKey: objectKey,
          reviewTextSha256: reviewedSha256,
          reviewTextSize: reviewed.bytes.byteLength,
          reviewTextProvenance: "Human-reviewed text promoted from the immutable returned source document.",
          reviewedByUserId: input.actor.id,
          reviewedAt: now,
        } : {}),
        decisionNote: note,
      }).where(and(
        eq(negotiationSubmissions.workspaceId, input.workspaceId),
        eq(negotiationSubmissions.id, submission.id),
        eq(negotiationSubmissions.status, "ready"),
      )),
      db.insert(mutationGuards).values({
        id: submissionGuardId,
        workspaceId: input.workspaceId,
        operation: "negotiation.promote.submission",
        guardChanges: sql<number>`changes()`,
        createdAt: now,
      }),
      ...(existingComparison ? [
        db.update(documentComparisons).set({
          baseSha256: round.baseSha256,
          proposedSha256: sourceDocument.sha256,
          baseTextSha256: baseText?.sha256 ?? null,
          proposedTextSha256: reviewedSha256,
          extractor: "human-reviewed-text",
          provenance: comparisonProvenance,
          status: comparisonStatus,
          decisionNote: note,
          decidedByUserId: input.actor.id,
          decidedAt: now,
          resultingDocumentVersion: versionNumber,
          resultingSha256: reviewedSha256,
          updatedAt: now,
        }).where(and(eq(documentComparisons.workspaceId, input.workspaceId), eq(documentComparisons.id, comparisonId))),
      ] : [
        db.insert(documentComparisons).values({
          id: comparisonId,
          workspaceId: input.workspaceId,
          agreementId: input.agreementId,
          roundId: round.id,
          submissionId: submission.id,
          baseSha256: round.baseSha256,
          proposedSha256: sourceDocument.sha256,
          baseTextSha256: baseText?.sha256 ?? null,
          proposedTextSha256: reviewedSha256,
          extractor: "human-reviewed-text",
          provenance: comparisonProvenance,
          status: comparisonStatus,
          decisionNote: note,
          decidedByUserId: input.actor.id,
          decidedAt: now,
          resultingDocumentVersion: versionNumber,
          resultingSha256: reviewedSha256,
          createdAt: now,
          updatedAt: now,
        }),
      ]),
      db.update(documentComparisons).set({ status: "superseded", updatedAt: now }).where(and(
        eq(documentComparisons.workspaceId, input.workspaceId),
        eq(documentComparisons.roundId, round.id),
        sql`${documentComparisons.submissionId} <> ${submission.id}`,
        inArray(documentComparisons.status, ["ready", "manual_required"]),
      )),
      db.insert(agreementEvents).values(event),
      db.insert(agreementVersions).values(snapshot),
      ...(integration ? [db.insert(outboxEvents).values(prepareOutboxEvent(integration))] : []),
      db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, input.workspaceId), inArray(mutationGuards.id, [agreementGuardId, roundGuardId, submissionGuardId]))),
    ] as Parameters<typeof db.batch>[0];
    await db.batch(statements);
    return {
      agreement: saved,
      roundId: round.id,
      submissionId: submission.id,
      comparisonId,
      comparisonStatus,
      documentVersion: {
        id: versionId,
        version: versionNumber,
        contentType: input.contentType,
        size: reviewed.bytes.byteLength,
        sha256: reviewedSha256,
        sourceDocumentId: sourceDocument.id,
      },
    };
  } catch (error) {
    await cleanupUncommittedObject(db, input.workspaceId, {
      kind: "working_version",
      id: versionId,
      objectKey,
      sha256: reviewedSha256,
    });
    throw error;
  }
}

export type NegotiationAttachment = Readonly<{
  fileName: string;
  bytes: Uint8Array;
  declaredContentType?: string | null;
  declaredSize?: number | null;
  declaredSha256?: string | null;
}>;

export type NegotiationEmailEvidence = Readonly<{
  internetMessageId?: string;
  inReplyTo?: string;
  aligned: boolean;
  spf?: "pass" | "fail" | "neutral" | "unknown";
  dkim?: "pass" | "fail" | "neutral" | "unknown";
  dmarc?: "pass" | "fail" | "neutral" | "unknown";
}>;

export type NegotiationReceiptClaim = Readonly<{
  id: string;
  provider: string;
  aggregateType: "negotiation_round";
  aggregateId: string;
  claimedAt: string;
}>;

type SubmissionReviewer = UserActor;

function normalizedOptionalEmail(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return normalizeNegotiationEmail(value);
}

function boundedMessageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().slice(0, 500) ?? "";
  return normalized || null;
}

export async function findNegotiationRoundByAlias(workspaceId: string, aliasCode: string) {
  const db = getDb();
  const [round] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, workspaceId),
    eq(negotiationRounds.aliasCode, aliasCode.toLowerCase()),
  )).limit(1);
  return round ?? null;
}

export async function resolveNegotiationPortal(token: string) {
  const exchangeConfiguration = getCounterpartyExchangeConfiguration();
  if (!exchangeConfiguration.portalEnabled) {
    throw new NegotiationServiceError("exchange_expired", "This exchange link has expired or was revoked.", 410);
  }
  const noticeConfiguration = getNoticeConfig();
  const tokenHash = await hashNegotiationToken(token);
  const db = getDb();
  const [round] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, noticeConfiguration.workspace.id),
    eq(negotiationRounds.portalTokenHash, tokenHash),
  )).limit(1);
  if (!round) throw new NegotiationServiceError("exchange_not_found", "This exchange link is unavailable.", 404);
  if (
    !round.activeKey
    || !ACTIVE_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_ROUND_STATUSES)[number])
    || !round.portalExpiresAt
    || Date.parse(round.portalExpiresAt) <= Date.now()
  ) {
    throw new NegotiationServiceError("exchange_expired", "This exchange link has expired or was revoked.", 410);
  }
  const agreement = await findActiveAgreement(db, round.workspaceId, round.agreementId);
  if (!agreement) throw new NegotiationServiceError("exchange_not_found", "This exchange link is unavailable.", 404);
  // Portal metadata is intentionally DB-only. Exact R2 bytes are read once,
  // after a durable download claim, by getNegotiationPortalDocument.
  const outboundDocument = await outboundDocumentRecord(db, round);
  return {
    scope: { workspaceId: round.workspaceId, agreementId: round.agreementId, roundId: round.id },
    metadata: {
      requestingOrganization: noticeConfiguration.workspace.name,
      party: agreement.party,
      agreementType: agreement.type,
      roundNumber: round.roundNumber,
      expiresAt: round.portalExpiresAt,
      outboundDocument: {
        fileName: outboundDocument.fileName,
        contentType: outboundDocument.contentType,
        size: outboundDocument.size,
        sha256: outboundDocument.sha256,
      },
      transferPolicy: NEGOTIATION_PORTAL_TRANSFER_POLICY,
    },
  };
}

export async function reserveNegotiationPortalUpload(token: string): Promise<NegotiationPortalUploadReservation> {
  const exchangeConfiguration = getCounterpartyExchangeConfiguration();
  if (!exchangeConfiguration.portalEnabled) {
    throw new NegotiationServiceError("exchange_expired", "This exchange link has expired or was revoked.", 410);
  }
  const noticeConfiguration = getNoticeConfig();
  const tokenHash = await hashNegotiationToken(token);
  const claim = await claimNegotiationPortalUpload(getDb(), {
    workspaceId: noticeConfiguration.workspace.id,
    tokenHash,
    reservationId: crypto.randomUUID(),
    now: new Date().toISOString(),
  });
  if (!claim.ok) throw negotiationPortalBudgetError("upload", claim.reason);
  return claim.reservation;
}

export async function recordNegotiationPortalUploadFailure(
  reservation: NegotiationPortalUploadReservation,
  consumedBytes: number,
): Promise<void> {
  await rejectNegotiationPortalUpload(getDb(), reservation, consumedBytes);
}

export async function getNegotiationPortalDocument(token: string) {
  const tokenHash = await hashNegotiationToken(token);
  const resolved = await resolveNegotiationPortal(token);
  const db = getDb();
  const round = await roundById(
    db,
    resolved.scope.workspaceId,
    resolved.scope.agreementId,
    resolved.scope.roundId,
  );
  if (!round) throw new NegotiationServiceError("exchange_not_found", "This exchange link is unavailable.", 404);
  const document = await outboundDocumentRecord(db, round);
  const claim = await claimNegotiationPortalDownload(db, {
    workspaceId: round.workspaceId,
    agreementId: round.agreementId,
    roundId: round.id,
    tokenHash,
    outboundDocumentId: document.id,
    outboundSha256: document.sha256,
    bytes: document.size,
    now: new Date().toISOString(),
  });
  if (!claim.ok) throw negotiationPortalBudgetError("download", claim.reason);
  const bytes = await readVerifiedObject(document.objectKey, document.size, document.sha256, "outbound_document");
  return { bytes, document: resolved.metadata.outboundDocument };
}

export async function getNegotiationReviewText(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  submissionId: string;
}>) {
  const db = getDb();
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  const [submission] = await db.select().from(negotiationSubmissions).where(and(
    eq(negotiationSubmissions.workspaceId, input.workspaceId),
    eq(negotiationSubmissions.agreementId, input.agreementId),
    eq(negotiationSubmissions.id, input.submissionId),
  )).limit(1);
  if (
    !submission
    || !submission.reviewTextObjectKey
    || !submission.reviewTextSha256
    || submission.reviewTextSize === null
  ) {
    throw new NegotiationServiceError("review_text_not_found", "Reviewed text was not found.", 404);
  }
  const bytes = await readVerifiedObject(
    submission.reviewTextObjectKey,
    submission.reviewTextSize,
    submission.reviewTextSha256,
    "review_text",
  );
  return { bytes, sha256: submission.reviewTextSha256 };
}

type PreparedAttachment = Readonly<{
  submission: typeof negotiationSubmissions.$inferInsert;
  document: typeof documents.$inferInsert;
  comparison: typeof documentComparisons.$inferInsert;
  objectKey: string;
  bytes: Uint8Array;
}>;

/**
 * One ingress implementation for signed email, possession-token portal, and
 * authenticated staff uploads. Each attachment becomes its own immutable
 * document/submission/comparison tuple so no attachment can be silently lost.
 */
export async function ingestNegotiationSubmissions(input: Readonly<{
  workspaceId: string;
  agreementId: number;
  roundId: string;
  source: NegotiationSubmissionSource;
  senderEmail?: string | null;
  senderName?: string | null;
  providerMessageId?: string | null;
  authenticationAligned?: boolean;
  portalTokenHash?: string;
  portalReservation?: NegotiationPortalUploadReservation;
  portalConsumedBytes?: number;
  emailEvidence?: NegotiationEmailEvidence;
  receiptClaims?: readonly NegotiationReceiptClaim[];
  attachments: readonly NegotiationAttachment[];
  reviewedText?: string | null;
  reviewer?: SubmissionReviewer | null;
}>) {
  if (input.source === "portal") {
    if (
      !input.portalReservation
      || input.portalTokenHash !== input.portalReservation.tokenHash
      || input.workspaceId !== input.portalReservation.workspaceId
      || input.agreementId !== input.portalReservation.agreementId
      || input.roundId !== input.portalReservation.roundId
      || !Number.isSafeInteger(input.portalConsumedBytes)
      || input.portalConsumedBytes! < 0
      || input.portalConsumedBytes! > input.portalReservation.reservedBytes
    ) {
      throw new NegotiationServiceError("exchange_reservation_invalid", "The upload has no valid durable exchange reservation.", 409);
    }
  } else if (input.portalReservation !== undefined || input.portalConsumedBytes !== undefined) {
    throw new NegotiationServiceError("exchange_reservation_invalid", "Portal reservations cannot authorize another ingress channel.", 400);
  }
  if (input.attachments.length > MAX_ATTACHMENTS) {
    throw new NegotiationServiceError("too_many_attachments", `At most ${MAX_ATTACHMENTS} attachments are accepted per submission.`, 413);
  }
  if (input.reviewedText !== undefined && input.reviewedText !== null && (input.source !== "manual" || !input.reviewer)) {
    throw new NegotiationServiceError("untrusted_review_text", "Only an authenticated manual review may supply trusted comparison text.", 400);
  }
  if (input.reviewedText && input.attachments.length !== 1) {
    throw new NegotiationServiceError("ambiguous_review_text", "Reviewed text must correspond to exactly one returned attachment.", 400);
  }
  const receiptProviders = new Set(input.receiptClaims?.map((claim) => claim.provider) ?? []);
  if (input.source === "email" && (
    input.receiptClaims?.length !== 2
    || receiptProviders.size !== EMAIL_RECEIPT_PROVIDERS.size
    || [...EMAIL_RECEIPT_PROVIDERS].some((provider) => !receiptProviders.has(provider))
    || input.receiptClaims.some((claim) => claim.aggregateType !== "negotiation_round" || claim.aggregateId !== input.roundId)
  )) {
    throw new NegotiationServiceError("receipt_claims_required", "Signed email ingestion requires exact event and provider-message receipt claims.", 500);
  }

  const db = getDb();
  const round = await roundById(db, input.workspaceId, input.agreementId, input.roundId);
  if (!round) throw new NegotiationServiceError("negotiation_round_not_found", "Negotiation round was not found.", 404);
  const agreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
  if (!agreement) throw new NegotiationServiceError("agreement_not_found", "Agreement was not found.", 404);
  const providerMessageId = boundedMessageId(input.providerMessageId);

  if (
    input.source !== "manual"
    && (!round.activeKey || !ACTIVE_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_ROUND_STATUSES)[number]))
  ) {
    throw new NegotiationServiceError(
      input.source === "portal" ? "exchange_expired" : "exchange_closed",
      "This negotiation exchange no longer accepts inbound messages.",
      410,
    );
  }

  const senderEmail = normalizedOptionalEmail(input.senderEmail);
  const senderName = input.senderName?.trim().slice(0, 200) || null;
  const emailEvidence: Record<string, string> = input.source === "email" && input.emailEvidence
    ? {
      ...(input.emailEvidence.internetMessageId ? { "ingress.email.internetMessageId": input.emailEvidence.internetMessageId.slice(0, 500) } : {}),
      ...(input.emailEvidence.inReplyTo ? { "ingress.email.inReplyTo": input.emailEvidence.inReplyTo.slice(0, 500) } : {}),
      "ingress.email.aligned": String(input.emailEvidence.aligned),
      "ingress.email.spf": input.emailEvidence.spf ?? "unknown",
      "ingress.email.dkim": input.emailEvidence.dkim ?? "unknown",
      "ingress.email.dmarc": input.emailEvidence.dmarc ?? "unknown",
    }
    : {};
  const emailEvidenceSummary = input.source === "email"
    ? `Gateway evidence: internetMessageId=${emailEvidence["ingress.email.internetMessageId"] ?? "not supplied"}; inReplyTo=${emailEvidence["ingress.email.inReplyTo"] ?? "not supplied"}; aligned=${emailEvidence["ingress.email.aligned"] ?? "false"}; SPF=${emailEvidence["ingress.email.spf"] ?? "unknown"}; DKIM=${emailEvidence["ingress.email.dkim"] ?? "unknown"}; DMARC=${emailEvidence["ingress.email.dmarc"] ?? "unknown"}.`
    : null;
  const senderMatchesExpected = Boolean(
    senderEmail
    && round.counterpartyEmail
    && senderEmail === round.counterpartyEmail
    && (input.source !== "email" || input.authenticationAligned === true),
  );
  if (input.source === "portal" && (
    !input.portalTokenHash
    || input.portalTokenHash !== round.portalTokenHash
    || input.portalReservation!.id !== round.portalUploadReservationId
    || input.portalReservation!.reservedBytes !== round.portalUploadReservationBytes
    || !round.portalUploadReservationExpiresAt
    || round.portalUploadReservationExpiresAt <= new Date().toISOString()
    || !round.portalExpiresAt
    || Date.parse(round.portalExpiresAt) <= Date.now()
  )) {
    throw new NegotiationServiceError("exchange_expired", "This exchange link has expired or was revoked.", 410);
  }
  const roundAcceptingSubmissions = roundAcceptsNegotiationIngress({
    source: input.source,
    roundStatus: round.status,
    active: Boolean(round.activeKey),
  });
  const [existingSubmissionRows, pendingEmailDelivery] = await Promise.all([
    db.select({ status: negotiationSubmissions.status }).from(negotiationSubmissions).where(and(
      eq(negotiationSubmissions.workspaceId, input.workspaceId),
      eq(negotiationSubmissions.agreementId, input.agreementId),
      eq(negotiationSubmissions.roundId, round.id),
    )),
    input.source === "email"
      ? db.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
        eq(outboxEvents.workspaceId, input.workspaceId),
        eq(outboxEvents.topic, "negotiation.round_requested"),
        eq(outboxEvents.aggregateType, "negotiation_round"),
        eq(outboxEvents.aggregateId, round.id),
        inArray(outboxEvents.status, ["pending", "processing"]),
      )).limit(1).then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  if (pendingEmailDelivery) {
    throw new NegotiationServiceError(
      "delivery_finalization_pending",
      "Signed email ingestion must retry after the outbound delivery event reaches a terminal state.",
      503,
    );
  }
  const existingSubmissionStatuses = existingSubmissionRows.map((row) => row.status);
  const now = new Date().toISOString();
  const receiptGuardIds = (input.receiptClaims ?? []).map(() => crypto.randomUUID());
  const receiptFinalizationStatements = (input.receiptClaims ?? []).flatMap((claim, index) => [
    db.update(webhookReceipts).set({ status: "processed", processedAt: now, error: null }).where(and(
      eq(webhookReceipts.id, claim.id),
      eq(webhookReceipts.workspaceId, input.workspaceId),
      eq(webhookReceipts.provider, claim.provider),
      eq(webhookReceipts.aggregateType, claim.aggregateType),
      eq(webhookReceipts.aggregateId, claim.aggregateId),
      eq(webhookReceipts.status, "processing"),
      eq(webhookReceipts.receivedAt, claim.claimedAt),
    )),
    db.insert(mutationGuards).values({
      id: receiptGuardIds[index]!,
      workspaceId: input.workspaceId,
      operation: "negotiation.ingest.receipt",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    }),
  ]);
  const storedObjects: StagedNegotiationObject[] = [];
  let reviewObjectKey: string | null = null;
  let reviewBytes: Uint8Array | null = null;
  let reviewSha256: string | null = null;
  let baseText: Awaited<ReturnType<typeof baseTextForRound>> = null;

  try {
    if (input.reviewedText !== undefined && input.reviewedText !== null) {
      const reviewed = cleanReviewedText(input.reviewedText);
      reviewBytes = reviewed.bytes;
      reviewSha256 = await sha256Hex(reviewBytes);
      reviewObjectKey = `workspaces/${input.workspaceId}/agreements/${input.agreementId}/negotiation/${round.id}/review/${crypto.randomUUID()}.txt`;
      storedObjects.push({ kind: "review_text", objectKey: reviewObjectKey, sha256: reviewSha256 });
      await bindings().DOCUMENTS.put(reviewObjectKey, reviewBytes, {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: { source: "authenticated-negotiation-review", sha256: reviewSha256, negotiationRoundId: round.id },
      });
      baseText = await baseTextForRound(db, round);
    }

    if (input.attachments.length === 0) {
      const id = crypto.randomUUID();
      const status = decideNegotiationSubmissionStatus({
        source: input.source,
        hasAttachment: false,
        roundAcceptingSubmissions,
        senderMatchesExpected,
      });
      const submission: typeof negotiationSubmissions.$inferInsert = {
        id,
        workspaceId: input.workspaceId,
        agreementId: input.agreementId,
        roundId: round.id,
        source: input.source,
        status,
        senderEmail,
        senderName,
        providerMessageId,
        documentId: null,
        documentSha256: null,
        reviewTextObjectKey: null,
        reviewTextSha256: null,
        reviewTextSize: null,
        reviewTextProvenance: null,
        reviewedByUserId: null,
        reviewedAt: null,
        decisionNote: ["Authenticated exchange message contained no attachment.", emailEvidenceSummary].filter(Boolean).join(" ").slice(0, 2_000),
        createdAt: now,
      };
      const event = await prepareAgreementEvent(db, {
        workspaceId: input.workspaceId,
        agreementId: input.agreementId,
        type: "Redline",
        detail: `Received ${input.source} response for negotiation round ${round.roundNumber} with no attachment.`,
        actor: input.reviewer ?? { id: "system:counterparty-exchange", email: senderEmail ?? "unknown@external.invalid", displayName: senderName ?? "External counterparty" },
        createdAt: now,
      });
      const commitCheckedAt = new Date().toISOString();
      const nextRoundUpdatedAt = new Date(Math.max(Date.now(), Date.parse(round.updatedAt) + 1)).toISOString();
      const roundAction = roundAcceptingSubmissions
        ? deriveNegotiationRoundAction({
          roundNumber: round.roundNumber,
          currentStatus: round.status,
          submissionStatuses: [...existingSubmissionStatuses, status],
        })
        : null;
      // Every accepted active-round ingress, including a manual upload whose
      // derived status is unchanged, advances updatedAt through this CAS. That
      // prevents two same-version operators from committing queue decisions
      // based on the same stale submission set.
      const requiresRoundGuard = Boolean(roundAction) || input.source === "portal";
      const roundGuardId = requiresRoundGuard ? crypto.randomUUID() : null;
      const agreementGuardId = crypto.randomUUID();
      // nextAction is a denormalized queue hint, not the agreement's governed
      // content. Keep it current under the aggregate-version guard without
      // advancing the aggregate solely because an external message arrived.
      const agreementPatch = roundAction
        ? {
            nextAction: roundAction.nextAction,
            updated: now,
            updatedAt: now,
            updatedByUserId: input.reviewer?.id ?? "system:counterparty-exchange",
          }
        : null;
      const savedAgreement: typeof agreements.$inferSelect = agreementPatch ? { ...agreement, ...agreementPatch } : agreement;
      const statements: Parameters<typeof db.batch>[0] = [
        db.update(agreements).set(agreementPatch ?? { updatedAt: sql`${agreements.updatedAt}` }).where(and(
          eq(agreements.workspaceId, input.workspaceId),
          eq(agreements.id, input.agreementId),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
          isNull(agreements.deletedAt),
        )),
        db.insert(mutationGuards).values({
          id: agreementGuardId,
          workspaceId: input.workspaceId,
          operation: "negotiation.ingest.agreement",
          guardChanges: sql<number>`changes()`,
          createdAt: commitCheckedAt,
        }),
        ...(roundGuardId ? [
          db.update(negotiationRounds).set({
            status: roundAction?.roundStatus ?? round.status,
            updatedAt: nextRoundUpdatedAt,
            ...(input.source === "portal" ? negotiationPortalUploadCompletionPatch(input.portalReservation!, {
              accepted: status !== "rejected",
              consumedBytes: input.portalConsumedBytes!,
            }) : {}),
          }).where(and(
            eq(negotiationRounds.workspaceId, input.workspaceId),
            eq(negotiationRounds.agreementId, input.agreementId),
            eq(negotiationRounds.id, round.id),
            eq(negotiationRounds.status, round.status),
            eq(negotiationRounds.updatedAt, round.updatedAt),
            eq(negotiationRounds.activeKey, round.activeKey!),
            ...(input.source === "portal" ? [
              eq(negotiationRounds.portalTokenHash, input.portalTokenHash!),
              gt(negotiationRounds.portalExpiresAt, commitCheckedAt),
              negotiationPortalUploadReservationPredicate(input.portalReservation!, commitCheckedAt),
            ] : []),
          )),
          db.insert(mutationGuards).values({
            id: roundGuardId,
            workspaceId: input.workspaceId,
            operation: "negotiation.ingest.round",
            guardChanges: sql<number>`changes()`,
            createdAt: commitCheckedAt,
          }),
        ] : []),
        db.insert(negotiationSubmissions).values(submission),
        db.insert(agreementEvents).values(event),
        ...receiptFinalizationStatements,
        ...(receiptGuardIds.length ? [db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, input.workspaceId),
          inArray(mutationGuards.id, receiptGuardIds),
        ))] : []),
        ...(roundGuardId ? [db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, input.workspaceId),
          eq(mutationGuards.id, roundGuardId),
        ))] : []),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, input.workspaceId),
          eq(mutationGuards.id, agreementGuardId),
        )),
      ];
      await db.batch(statements);
      return { replay: false, submissions: [safeSubmission(submission as typeof negotiationSubmissions.$inferSelect)], roundId: round.id, agreement: savedAgreement };
    }

    const prepared: PreparedAttachment[] = [];
    for (const attachment of input.attachments) {
      if (attachment.bytes.byteLength === 0 || attachment.bytes.byteLength > 20 * 1_024 * 1_024) {
        throw new NegotiationServiceError("attachment_size_invalid", "Each attachment must contain between 1 byte and 20 MiB.", 413);
      }
      if (attachment.declaredSize !== undefined && attachment.declaredSize !== null && attachment.declaredSize !== attachment.bytes.byteLength) {
        throw new NegotiationServiceError("attachment_size_mismatch", "A signed attachment size does not match the received bytes.", 400);
      }
      const actualSha256 = await sha256Hex(attachment.bytes);
      if (attachment.declaredSha256 && attachment.declaredSha256 !== actualSha256) {
        throw new NegotiationServiceError("attachment_hash_mismatch", "A signed attachment hash does not match the received bytes.", 400);
      }
      const documentId = crypto.randomUUID();
      const submissionId = crypto.randomUUID();
      const comparisonId = crypto.randomUUID();
      const fileName = normalizedDocumentName(attachment.fileName);
      let contentType = "application/octet-stream";
      let scan: { status: "clean" | "malicious" | "unavailable" | "rejected"; provider: string; detail: string; scannedAt: string | null };
      try {
        const inspected = inspectDocument(attachment.bytes, fileName);
        contentType = inspected.contentType;
        scan = getNoticeConfig().mode === "evaluation"
          ? { status: "clean", provider: "evaluation-bypass", detail: "Synthetic evaluation file bypass", scannedAt: now }
          : await scanDocument(attachment.bytes, { id: documentId, fileName, contentType, sha256: actualSha256 }, getScannerConfiguration());
      } catch (error) {
        if (!(error instanceof DocumentSecurityError)) throw error;
        scan = { status: "rejected", provider: "notice-content-validation", detail: error.code, scannedAt: now };
      }
      const documentScanStatus = scan.status === "clean"
        ? getNoticeConfig().mode === "evaluation" ? "evaluation-bypassed" : "clean"
        : scan.status === "malicious" || scan.status === "rejected" ? "rejected" : "quarantined";
      // Evaluation still records its synthetic provenance as evaluation-bypassed
      // on the document, but the submission decision consumes the underlying
      // clean verdict so the explicitly selected local harness can exercise the
      // review workflow. Production never enters this branch.
      const decisionScanStatus = scan.status === "unavailable" ? "scanner-unavailable" as const : scan.status;
      const status = decideNegotiationSubmissionStatus({
        source: input.source,
        hasAttachment: true,
        scanStatus: decisionScanStatus,
        roundAcceptingSubmissions,
        senderMatchesExpected,
      });
      const quarantined = status === "quarantined" || status === "rejected";
      const objectKey = `workspaces/${input.workspaceId}/${quarantined ? "quarantine" : "documents"}/${documentId}/${fileName}`;
      storedObjects.push({ kind: "document", id: documentId, objectKey, sha256: actualSha256 });
      await bindings().DOCUMENTS.put(objectKey, attachment.bytes, {
        httpMetadata: { contentType },
        customMetadata: {
          source: `negotiation-${input.source}`,
          documentId,
          sha256: actualSha256,
          scanStatus: documentScanStatus,
          negotiationRoundId: round.id,
        },
      });
      const comparisonReady = status === "ready" && Boolean(baseText && reviewBytes && reviewSha256);
      const document: typeof documents.$inferInsert = {
        id: documentId,
        workspaceId: input.workspaceId,
        version: 1,
        agreementId: input.agreementId,
        role: "counterparty_return",
        direction: "inbound",
        negotiationRoundId: round.id,
        providerMessageId,
        parentSha256: round.outboundSha256,
        originalSenderEmail: senderEmail,
        fileName,
        objectKey,
        contentType,
        size: attachment.bytes.byteLength,
        tags: [],
        extracted: emailEvidence,
        extractionMode: quarantined ? "Quarantined; no extraction" : "Immutable counterparty return; human review required",
        sha256: actualSha256,
        scanStatus: documentScanStatus,
        scanProvider: scan.provider,
        scannedAt: scan.scannedAt,
        createdByUserId: input.reviewer?.id ?? null,
        legalHold: agreement.legalHold,
        retentionUntil: agreement.retentionUntil,
        deletedAt: null,
        createdAt: now,
      };
      const submission: typeof negotiationSubmissions.$inferInsert = {
        id: submissionId,
        workspaceId: input.workspaceId,
        agreementId: input.agreementId,
        roundId: round.id,
        source: input.source,
        status,
        senderEmail,
        senderName,
        providerMessageId,
        documentId,
        documentSha256: actualSha256,
        reviewTextObjectKey: reviewObjectKey,
        reviewTextSha256: reviewSha256,
        reviewTextSize: reviewBytes?.byteLength ?? null,
        reviewTextProvenance: reviewBytes ? "Authenticated staff-supplied review text; exact bytes retained and SHA-256 verified." : null,
        reviewedByUserId: input.reviewer?.id ?? null,
        reviewedAt: reviewBytes ? now : null,
        decisionNote: [status === "sender_review"
          ? "Sender address or gateway authentication did not exactly match the prepared counterparty."
          : status === "late" ? "Received against an inactive, resolved, or closed negotiation round."
            : status === "quarantined" ? "Security scanning did not return a trusted clean verdict."
              : status === "rejected" ? "Document validation or malware scanning rejected the attachment."
                : null, emailEvidenceSummary].filter(Boolean).join(" ").slice(0, 2_000) || null,
        createdAt: now,
      };
      const comparison: typeof documentComparisons.$inferInsert = {
        id: comparisonId,
        workspaceId: input.workspaceId,
        agreementId: input.agreementId,
        roundId: round.id,
        submissionId,
        baseSha256: round.baseSha256,
        proposedSha256: actualSha256,
        baseTextSha256: comparisonReady ? baseText!.sha256 : null,
        proposedTextSha256: comparisonReady ? reviewSha256 : null,
        extractor: comparisonReady ? "authenticated-human-review" : null,
        provenance: comparisonReady
          ? "Exact pinned base text and authenticated human-supplied proposed review text; no automated legal conclusion."
          : "Comparison unavailable until both the exact pinned base text and trusted proposed review text are available.",
        status: comparisonReady ? "ready" : "manual_required",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        resultingDocumentVersion: null,
        resultingSha256: null,
        createdAt: now,
        updatedAt: now,
      };
      prepared.push({ submission, document, comparison, objectKey, bytes: attachment.bytes });
    }

    const event = await prepareAgreementEvent(db, {
      workspaceId: input.workspaceId,
      agreementId: input.agreementId,
      type: "Redline",
      detail: `Captured ${prepared.length} immutable ${input.source} attachment${prepared.length === 1 ? "" : "s"} for negotiation round ${round.roundNumber}; evidence ${prepared.map((item) => `${item.submission.id}:${item.document.sha256}:${item.submission.status}:${item.document.scanProvider ?? "scanner-unrecorded"}:${item.document.scannedAt ?? "time-unrecorded"}`).join(", ")}. Each remains subject to explicit human promotion.`.slice(0, 2_000),
      actor: input.reviewer ?? { id: "system:counterparty-exchange", email: senderEmail ?? "unknown@external.invalid", displayName: senderName ?? "External counterparty" },
      createdAt: now,
    });
    const roundAction = roundAcceptingSubmissions
      ? deriveNegotiationRoundAction({
        roundNumber: round.roundNumber,
        currentStatus: round.status,
        submissionStatuses: [
          ...existingSubmissionStatuses,
          ...prepared.map((item) => item.submission.status),
        ],
      })
      : null;
    const nextRoundStatus = roundAction?.roundStatus ?? round.status;
    const commitCheckedAt = new Date().toISOString();
    const nextRoundUpdatedAt = new Date(Math.max(Date.now(), Date.parse(round.updatedAt) + 1)).toISOString();
    const requiresRoundGuard = Boolean(roundAction) || input.source === "portal";
    const roundGuardId = crypto.randomUUID();
    const agreementGuardId = crypto.randomUUID();
    // The round, submission, document, and audit event are the authoritative
    // evidence. This derived queue hint may change under the current aggregate
    // guard without invalidating an unrelated staff edit session.
    const agreementPatch = roundAction
      ? {
          nextAction: roundAction.nextAction,
          updated: now,
          updatedAt: now,
          updatedByUserId: input.reviewer?.id ?? "system:counterparty-exchange",
        }
      : null;
    const savedAgreement: typeof agreements.$inferSelect = agreementPatch ? { ...agreement, ...agreementPatch } : agreement;
    const statements: Parameters<typeof db.batch>[0] = [
      db.update(agreements).set(agreementPatch ?? { updatedAt: sql`${agreements.updatedAt}` }).where(and(
        eq(agreements.workspaceId, input.workspaceId),
        eq(agreements.id, input.agreementId),
        eq(agreements.version, agreement.version),
        eq(agreements.nextAction, agreement.nextAction),
        isNull(agreements.deletedAt),
      )),
      db.insert(mutationGuards).values({
        id: agreementGuardId,
        workspaceId: input.workspaceId,
        operation: "negotiation.ingest.agreement",
        guardChanges: sql<number>`changes()`,
        createdAt: commitCheckedAt,
      }),
      ...(requiresRoundGuard ? [
        db.update(negotiationRounds).set({
          status: nextRoundStatus,
          updatedAt: nextRoundUpdatedAt,
          ...(input.source === "portal" ? negotiationPortalUploadCompletionPatch(input.portalReservation!, {
            accepted: !prepared.some((item) => item.submission.status === "rejected"),
            consumedBytes: input.portalConsumedBytes!,
          }) : {}),
        }).where(and(
          eq(negotiationRounds.workspaceId, input.workspaceId),
          eq(negotiationRounds.agreementId, input.agreementId),
          eq(negotiationRounds.id, round.id),
          eq(negotiationRounds.status, round.status),
          eq(negotiationRounds.updatedAt, round.updatedAt),
          eq(negotiationRounds.activeKey, round.activeKey!),
          ...(input.source === "portal" ? [
            eq(negotiationRounds.portalTokenHash, input.portalTokenHash!),
            gt(negotiationRounds.portalExpiresAt, commitCheckedAt),
            negotiationPortalUploadReservationPredicate(input.portalReservation!, commitCheckedAt),
          ] : []),
        )),
        db.insert(mutationGuards).values({
          id: roundGuardId,
          workspaceId: input.workspaceId,
          operation: "negotiation.ingest.round",
          guardChanges: sql<number>`changes()`,
          createdAt: commitCheckedAt,
        }),
      ] : []),
      db.insert(agreementEvents).values(event),
      ...prepared.flatMap((item) => [
        db.insert(documents).values(item.document),
        db.insert(negotiationSubmissions).values(item.submission),
        db.insert(documentComparisons).values(item.comparison),
      ]),
      ...(requiresRoundGuard ? [db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, input.workspaceId),
        eq(mutationGuards.id, roundGuardId),
      ))] : []),
      ...receiptFinalizationStatements,
      ...(receiptGuardIds.length ? [db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, input.workspaceId),
        inArray(mutationGuards.id, receiptGuardIds),
      ))] : []),
      db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, input.workspaceId),
        eq(mutationGuards.id, agreementGuardId),
      )),
    ];
    await db.batch(statements);
    return {
      replay: false,
      submissions: prepared.map((item) => safeSubmission(item.submission as typeof negotiationSubmissions.$inferSelect)),
      roundId: round.id,
      roundStatus: nextRoundStatus,
      agreement: savedAgreement,
    };
  } catch (error) {
    for (const candidate of storedObjects) await cleanupUncommittedObject(db, input.workspaceId, candidate);
    if (isMutationGuardConflict(error)) {
      const currentAgreement = await findActiveAgreement(db, input.workspaceId, input.agreementId);
      if (!currentAgreement) {
        throw new NegotiationServiceError(
          input.source === "portal" ? "exchange_not_found" : "agreement_not_found",
          input.source === "portal" ? "This exchange link is unavailable." : "Agreement was not found.",
          404,
        );
      }
    }
    if (isMutationGuardConflict(error) && input.source === "portal") {
      const current = await roundById(db, input.workspaceId, input.agreementId, input.roundId);
      if (
        !current
        || !current.activeKey
        || !ACTIVE_ROUND_STATUSES.includes(current.status as (typeof ACTIVE_ROUND_STATUSES)[number])
        || current.portalTokenHash !== input.portalTokenHash
        || !current.portalExpiresAt
        || Date.parse(current.portalExpiresAt) <= Date.now()
      ) {
        throw new NegotiationServiceError("exchange_expired", "This exchange link has expired or was revoked.", 410);
      }
      throw new NegotiationServiceError("exchange_changed", "The exchange changed while the upload was processed. Reload and try again.", 409);
    }
    if (isMutationGuardConflict(error) && input.source === "email") {
      throw new Error("Negotiation exchange changed before signed email ingestion committed");
    }
    if (isMutationGuardConflict(error) && input.source === "manual") {
      throw new NegotiationServiceError("version_conflict", "The agreement changed while the returned file was processed. Reload and try again.");
    }
    throw error;
  }
}

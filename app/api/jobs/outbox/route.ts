import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import {
  crmLegacyCleanupAttestations,
  agreements,
  mutationGuards,
  negotiationRounds,
  negotiationSubmissions,
  negotiationSubmissionStatuses,
  obligations,
  outboxDeliveries,
  outboxEvents,
  users,
  workspaceMemberships,
  type NegotiationSubmissionStatus,
  type OutboxDeliverySink,
} from "../../../../db/schema";
import { handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import {
  isLegacyCrmDeliveryProfileIncomplete,
  legacyAttestationResolvesCrmDelivery,
} from "../../../lib/crm-resync-policy";
import { crmDestinationFingerprint, deliverOutboxEvent, GatewayDeliveryError } from "../../../lib/delivery";
import { sha256Hex } from "../../../lib/document-security";
import { hashNegotiationToken } from "../../../lib/negotiation-exchange";
import { apiError, apiJson, checkBestEffortRateLimit, createRequestId, rateLimitExceeded } from "../../../lib/http";
import { crmTargetForIntegrationEvent } from "../../../lib/integration-events";
import { deriveNegotiationRoundAction } from "../../../lib/negotiation-round-state";
import { isMutationGuardConflict } from "../../../lib/persistence";
import {
  getCrmConfiguration,
  getDeliveryConfiguration,
  getJobRunnerSecret,
  getNegotiationDeliveryConfiguration,
  isCrmDeliveryEnabled,
} from "../../../lib/providers";
import { constantTimeSecretEqual } from "../../../lib/records-governance";

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;
const TERMINAL_RECONCILIATION_ATTEMPTS = 3;
const ACTIVE_NEGOTIATION_ROUND_STATUSES = ["prepared", "outbound", "returned", "review"] as const;
type Database = ReturnType<typeof getDb>;

function legacyAttestationAbsent(db: Database, workspaceId: string, eventId: string | typeof outboxEvents.id) {
  return notExists(db.select({ eventId: crmLegacyCleanupAttestations.eventId })
    .from(crmLegacyCleanupAttestations).where(and(
      eq(crmLegacyCleanupAttestations.workspaceId, workspaceId),
      eq(crmLegacyCleanupAttestations.eventId, eventId),
    )));
}

async function legacyAttestationExists(db: Database, workspaceId: string, eventId: string): Promise<boolean> {
  const [row] = await db.select({ eventId: crmLegacyCleanupAttestations.eventId })
    .from(crmLegacyCleanupAttestations).where(and(
      eq(crmLegacyCleanupAttestations.workspaceId, workspaceId),
      eq(crmLegacyCleanupAttestations.eventId, eventId),
    )).limit(1);
  return Boolean(row);
}

function failureCode(error: unknown): { code: string; retryAfterMs: number | null; retryable: boolean } {
  if (error instanceof GatewayDeliveryError) return { code: error.code, retryAfterMs: error.retryAfterMs, retryable: error.retryable };
  return { code: "gateway_configuration_error", retryAfterMs: null, retryable: true };
}

function nextAttemptAt(attempts: number, retryAfterMs: number | null): string {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, 2 ** attempts * 60_000);
  return new Date(Date.now() + Math.max(exponential, retryAfterMs ?? 0)).toISOString();
}

async function payloadAfterTerminalDelivery(
  row: typeof outboxEvents.$inferSelect,
  outcome: "accepted" | "dead",
): Promise<Record<string, unknown>> {
  if (row.topic !== "negotiation.round_requested") return row.payload;
  const portalUrl = row.payload.portalUrl;
  if (typeof portalUrl !== "string" || !portalUrl) return row.payload;
  return {
    ...row.payload,
    // The gateway needs the scoped bearer while delivery is pending. Once
    // every required sink has accepted the event, retain only tamper-evident
    // delivery evidence so D1 backups do not extend bearer exposure.
    portalUrl: `[redacted after ${outcome} delivery state]`,
    portalUrlSha256: await sha256Hex(portalUrl),
  };
}

async function negotiationDeliveryIsCurrent(
  db: Database,
  workspaceId: string,
  row: typeof outboxEvents.$inferSelect,
  now: string,
  expectedPublicOrigin: string | null,
): Promise<boolean> {
  if (row.topic !== "negotiation.round_requested") return true;
  const portalUrl = row.payload.portalUrl;
  const roundId = row.payload.roundId;
  const agreementId = row.payload.agreementId;
  const outboundDocument = row.payload.outboundDocument;
  if (
    row.aggregateType !== "negotiation_round"
    || typeof portalUrl !== "string"
    || typeof roundId !== "string"
    || roundId !== row.aggregateId
    || typeof agreementId !== "number"
    || !outboundDocument
    || typeof outboundDocument !== "object"
    || Array.isArray(outboundDocument)
    || typeof (outboundDocument as Record<string, unknown>).sha256 !== "string"
  ) return false;
  let tokenHash: string;
  try {
    const url = new URL(portalUrl);
    const match = /^\/api\/exchange\/([0-9a-f]{64})$/.exec(url.pathname);
    if (!expectedPublicOrigin || url.origin !== expectedPublicOrigin || !match || url.search || url.hash) return false;
    tokenHash = await hashNegotiationToken(match[1]);
  } catch {
    return false;
  }
  const [current] = await db.select({ id: negotiationRounds.id })
    .from(negotiationRounds)
    .innerJoin(agreements, and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, agreementId),
      isNull(agreements.deletedAt),
    )).where(and(
      eq(negotiationRounds.workspaceId, workspaceId),
      eq(negotiationRounds.id, roundId),
      eq(negotiationRounds.agreementId, agreementId),
      eq(negotiationRounds.status, "outbound"),
      isNotNull(negotiationRounds.activeKey),
      eq(negotiationRounds.portalTokenHash, tokenHash),
      eq(negotiationRounds.outboundSha256, (outboundDocument as Record<string, unknown>).sha256 as string),
      sql`${negotiationRounds.portalExpiresAt} > ${now}`,
    )).limit(1);
  return Boolean(current);
}

async function obligationReminderDeliveryIsCurrent(
  db: Database,
  workspaceId: string,
  row: typeof outboxEvents.$inferSelect,
): Promise<boolean> {
  if (row.topic !== "notification.obligation_reminder") return true;
  const obligationId = row.payload.obligationId;
  const agreementId = row.payload.agreementId;
  const dueDate = row.payload.dueDate;
  const aggregateVersion = row.payload.aggregateVersion;
  const recipient = row.payload.recipient;
  const recipientUserId = recipient && typeof recipient === "object" && !Array.isArray(recipient)
    ? (recipient as Record<string, unknown>).userId
    : null;
  const recipientEmail = recipient && typeof recipient === "object" && !Array.isArray(recipient)
    ? (recipient as Record<string, unknown>).email
    : null;
  if (
    row.aggregateType !== "obligation"
    || typeof obligationId !== "string"
    || obligationId !== row.aggregateId
    || typeof agreementId !== "number"
    || !Number.isSafeInteger(agreementId)
    || typeof dueDate !== "string"
    || typeof aggregateVersion !== "number"
    || !Number.isSafeInteger(aggregateVersion)
    || typeof recipientUserId !== "string"
    || typeof recipientEmail !== "string"
  ) return false;
  const [current] = await db.select({ id: obligations.id }).from(obligations)
    .innerJoin(agreements, and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, obligations.agreementId),
      isNull(agreements.deletedAt),
    ))
    .innerJoin(workspaceMemberships, and(
      eq(workspaceMemberships.workspaceId, obligations.workspaceId),
      eq(workspaceMemberships.userId, obligations.ownerUserId),
      eq(workspaceMemberships.status, "active"),
      inArray(workspaceMemberships.role, ["admin", "legal", "approver", "requester"]),
    ))
    .innerJoin(users, and(
      eq(users.id, workspaceMemberships.userId),
      eq(users.status, "active"),
      eq(users.email, recipientEmail),
    )).where(and(
    eq(obligations.workspaceId, workspaceId),
    eq(obligations.id, obligationId),
    eq(obligations.agreementId, agreementId),
    eq(obligations.status, "Open"),
    eq(obligations.version, aggregateVersion),
    eq(obligations.ownerUserId, recipientUserId),
    eq(obligations.dueDate, dueDate),
  )).limit(1);
  return Boolean(current);
}

async function externalDeliveryIsCurrent(
  db: Database,
  workspaceId: string,
  row: typeof outboxEvents.$inferSelect,
  now: string,
  expectedPublicOrigin: string | null,
): Promise<boolean> {
  return await negotiationDeliveryIsCurrent(db, workspaceId, row, now, expectedPublicOrigin)
    && await obligationReminderDeliveryIsCurrent(db, workspaceId, row);
}

type NegotiationTerminalOutcome = "accepted" | "dead";

async function currentNegotiationDeliverySnapshot(
  db: Database,
  workspaceId: string,
  row: typeof outboxEvents.$inferSelect,
) {
  if (row.topic !== "negotiation.round_requested" || row.aggregateType !== "negotiation_round") return null;
  const agreementId = row.payload.agreementId;
  const roundId = row.payload.roundId;
  if (
    typeof agreementId !== "number"
    || !Number.isSafeInteger(agreementId)
    || agreementId <= 0
    || typeof roundId !== "string"
    || !roundId
    || roundId !== row.aggregateId
  ) return null;

  const [round] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, workspaceId),
    eq(negotiationRounds.id, roundId),
    eq(negotiationRounds.agreementId, agreementId),
    eq(negotiationRounds.deliveryMethod, "email_gateway"),
    isNotNull(negotiationRounds.activeKey),
    inArray(negotiationRounds.status, ACTIVE_NEGOTIATION_ROUND_STATUSES),
  )).limit(1);
  if (!round) return null;

  const [[agreement], submissionRows, [latestRound]] = await Promise.all([
    db.select().from(agreements).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, agreementId),
      isNull(agreements.deletedAt),
    )).limit(1),
    db.select({ status: negotiationSubmissions.status }).from(negotiationSubmissions).where(and(
      eq(negotiationSubmissions.workspaceId, workspaceId),
      eq(negotiationSubmissions.agreementId, agreementId),
      eq(negotiationSubmissions.roundId, roundId),
    )),
    db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, workspaceId),
      eq(negotiationRounds.agreementId, agreementId),
    )).orderBy(desc(negotiationRounds.roundNumber)).limit(1),
  ]);
  if (!agreement || latestRound?.id !== round.id) return null;
  const submissionStatusCounts = Object.fromEntries(
    negotiationSubmissionStatuses.map((status) => [
      status,
      submissionRows.filter((submission) => submission.status === status).length,
    ]),
  ) as Record<NegotiationSubmissionStatus, number>;
  return {
    agreement,
    round,
    submissionStatuses: submissionRows.map((submission) => submission.status),
    submissionStatusCounts,
  };
}

function timestampAfter(reference: string, candidate: string): string {
  const referenceMs = Date.parse(reference);
  const candidateMs = Date.parse(candidate);
  return new Date(Math.max(Number.isFinite(referenceMs) ? referenceMs + 1 : 0, candidateMs)).toISOString();
}

/**
 * Commit the parent outbox terminal state and its denormalized negotiation
 * queue projection together. Individual accepted sink rows are deliberately
 * committed before this point: if the projection CAS loses a race, the next
 * job run can finalize the parent without ever calling an accepted sink again.
 */
async function finalizeTerminalOutboxEvent(input: Readonly<{
  db: Database;
  workspaceId: string;
  row: typeof outboxEvents.$inferSelect;
  lockTime: string;
  outcome: NegotiationTerminalOutcome;
  terminalPayload: Record<string, unknown>;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  pendingDeliveryFailure?: string;
}>): Promise<boolean> {
  for (let reconciliationAttempt = 0; reconciliationAttempt < TERMINAL_RECONCILIATION_ATTEMPTS; reconciliationAttempt += 1) {
    const finalizedAt = new Date().toISOString();
    const snapshot = await currentNegotiationDeliverySnapshot(input.db, input.workspaceId, input.row);
    const action = snapshot
      ? deriveNegotiationRoundAction({
          roundNumber: snapshot.round.roundNumber,
          currentStatus: snapshot.round.status,
          submissionStatuses: snapshot.submissionStatuses,
          deliveryState: input.outcome,
        })
      : null;
    const nextAgreementUpdatedAt = snapshot ? timestampAfter(snapshot.agreement.updatedAt, finalizedAt) : finalizedAt;
    const nextRoundUpdatedAt = snapshot ? timestampAfter(snapshot.round.updatedAt, finalizedAt) : finalizedAt;
    const outboxGuardId = crypto.randomUUID();
    const agreementGuardId = snapshot ? crypto.randomUUID() : null;
    const roundGuardId = snapshot ? crypto.randomUUID() : null;
    const guardIds = [outboxGuardId, agreementGuardId, roundGuardId].filter((id): id is string => Boolean(id));
    const terminalOutboxUpdate = input.outcome === "accepted"
      ? input.db.update(outboxEvents).set({
          payload: input.terminalPayload,
          status: "processed",
          lockedAt: null,
          processedAt: finalizedAt,
          lastError: null,
        }).where(and(
          eq(outboxEvents.workspaceId, input.workspaceId),
          eq(outboxEvents.id, input.row.id),
          eq(outboxEvents.status, "processing"),
          eq(outboxEvents.lockedAt, input.lockTime),
        ))
      : input.db.update(outboxEvents).set({
          payload: input.terminalPayload,
          status: "dead",
          attempts: input.attempts,
          availableAt: input.availableAt,
          lockedAt: null,
          processedAt: null,
          lastError: input.lastError,
        }).where(and(
          eq(outboxEvents.workspaceId, input.workspaceId),
          eq(outboxEvents.id, input.row.id),
          eq(outboxEvents.status, "processing"),
          eq(outboxEvents.lockedAt, input.lockTime),
        ));

    const statements: Parameters<typeof input.db.batch>[0] = [
      terminalOutboxUpdate,
      input.db.insert(mutationGuards).values({
        id: outboxGuardId,
        workspaceId: input.workspaceId,
        operation: `outbox.negotiation.${input.outcome}`,
        guardChanges: sql<number>`changes()`,
        createdAt: finalizedAt,
      }),
      ...(input.pendingDeliveryFailure ? [input.db.update(outboxDeliveries).set({
        status: "dead",
        attempts: sql`${outboxDeliveries.attempts} + 1`,
        acceptedAt: null,
        lastError: input.pendingDeliveryFailure,
        updatedAt: finalizedAt,
      }).where(and(
        eq(outboxDeliveries.workspaceId, input.workspaceId),
        eq(outboxDeliveries.eventId, input.row.id),
        eq(outboxDeliveries.status, "pending"),
      ))] : []),
      ...(snapshot && action && agreementGuardId && roundGuardId ? [
        input.db.update(agreements).set({
          nextAction: action.nextAction,
          updated: nextAgreementUpdatedAt,
          updatedAt: nextAgreementUpdatedAt,
          updatedByUserId: "system:outbox-delivery",
        }).where(and(
          eq(agreements.workspaceId, input.workspaceId),
          eq(agreements.id, snapshot.agreement.id),
          eq(agreements.version, snapshot.agreement.version),
          eq(agreements.nextAction, snapshot.agreement.nextAction),
          eq(agreements.updatedAt, snapshot.agreement.updatedAt),
          isNull(agreements.deletedAt),
        )),
        input.db.insert(mutationGuards).values({
          id: agreementGuardId,
          workspaceId: input.workspaceId,
          operation: `outbox.negotiation.${input.outcome}.agreement`,
          guardChanges: sql<number>`changes()`,
          createdAt: finalizedAt,
        }),
        input.db.update(negotiationRounds).set({
          status: action.roundStatus,
          updatedAt: nextRoundUpdatedAt,
        }).where(and(
          eq(negotiationRounds.workspaceId, input.workspaceId),
          eq(negotiationRounds.id, snapshot.round.id),
          eq(negotiationRounds.agreementId, snapshot.agreement.id),
          eq(negotiationRounds.deliveryMethod, "email_gateway"),
          eq(negotiationRounds.status, snapshot.round.status),
          eq(negotiationRounds.updatedAt, snapshot.round.updatedAt),
          eq(negotiationRounds.activeKey, snapshot.round.activeKey!),
          inArray(negotiationRounds.status, ACTIVE_NEGOTIATION_ROUND_STATUSES),
          notExists(input.db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
            eq(negotiationRounds.workspaceId, input.workspaceId),
            eq(negotiationRounds.agreementId, snapshot.agreement.id),
            gt(negotiationRounds.roundNumber, snapshot.round.roundNumber),
          ))),
          // Some staff actions can change a same-priority submission without
          // changing the round status. Per-status cardinality fences ensure
          // the derived action is still based on the exact status multiset.
          ...negotiationSubmissionStatuses.map((status) => sql`(
            select count(*) from ${negotiationSubmissions} as "terminal_submission"
            where "terminal_submission"."workspace_id" = ${input.workspaceId}
              and "terminal_submission"."agreement_id" = ${snapshot.agreement.id}
              and "terminal_submission"."round_id" = ${snapshot.round.id}
              and "terminal_submission"."status" = ${status}
          ) = ${snapshot.submissionStatusCounts[status]}`),
        )),
        input.db.insert(mutationGuards).values({
          id: roundGuardId,
          workspaceId: input.workspaceId,
          operation: `outbox.negotiation.${input.outcome}.round`,
          guardChanges: sql<number>`changes()`,
          createdAt: finalizedAt,
        }),
      ] : []),
      input.db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, input.workspaceId),
        inArray(mutationGuards.id, guardIds),
      )),
    ];
    try {
      await input.db.batch(statements);
      return true;
    } catch (error) {
      if (!isMutationGuardConflict(error)) throw error;
    }
  }

  // Accepted delivery rows remain accepted, so releasing the parent for a
  // later reconciliation attempt cannot resend them. A superseded delivery's
  // pending sink update was rolled back with the failed batch and is rechecked.
  await input.db.update(outboxEvents).set({
    status: "pending",
    lockedAt: null,
    availableAt: new Date().toISOString(),
    lastError: "negotiation_state_reconciliation_conflict",
  }).where(and(
    eq(outboxEvents.workspaceId, input.workspaceId),
    eq(outboxEvents.id, input.row.id),
    eq(outboxEvents.status, "processing"),
    eq(outboxEvents.lockedAt, input.lockTime),
  ));
  return false;
}

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const expected = getJobRunnerSecret();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!constantTimeSecretEqual(expected, supplied)) return apiError("authentication_required", "Job runner authentication failed.", { status: 401, requestId });
    const rate = checkBestEffortRateLimit("job:outbox", { limit: 12, windowMs: 60_000 });
    if (!rate.allowed) return rateLimitExceeded(rate, requestId);
    const noticeConfig = getNoticeConfig();
    const workspaceId = noticeConfig.workspace.id;
    await ensureStorageSchema();
    const db = getDb();
    const now = new Date().toISOString();
    const staleLock = new Date(Date.now() - 10 * 60_000).toISOString();
    await db.update(outboxEvents).set({ status: "pending", lockedAt: null, lastError: "Recovered stale delivery lock" }).where(and(
      eq(outboxEvents.workspaceId, workspaceId),
      eq(outboxEvents.status, "processing"),
      lte(outboxEvents.lockedAt, staleLock),
    ));
    const rows = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.workspaceId, workspaceId),
      eq(outboxEvents.status, "pending"),
      lte(outboxEvents.availableAt, now),
    )).orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.createdAt)).limit(BATCH_SIZE);
    let delivered = 0;
    let retried = 0;
    let dead = 0;
    const acceptedBySink: Record<OutboxDeliverySink, number> = { delivery: 0, crm: 0 };
    for (const row of rows) {
      const lockTime = new Date().toISOString();
      const locked = await db.update(outboxEvents).set({ status: "processing", lockedAt: lockTime }).where(and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.id, row.id),
        eq(outboxEvents.status, "pending"),
      ));
      if (!locked.meta.changes) continue;
      let deliveries = await db.select().from(outboxDeliveries).where(and(
        eq(outboxDeliveries.workspaceId, workspaceId),
        eq(outboxDeliveries.eventId, row.id),
      ));
      const initializedAt = new Date().toISOString();
      let initializedMissingSink = false;
      if (!deliveries.some((delivery) => delivery.sink === "delivery")) {
        await db.insert(outboxDeliveries).values({
          eventId: row.id,
          sink: "delivery",
          workspaceId,
          status: "pending",
          attempts: 0,
          availableAt: now,
          acceptedAt: null,
          lastError: null,
          crmProvider: null,
          crmMappingVersion: null,
          crmDestinationFingerprint: null,
          createdAt: initializedAt,
          updatedAt: initializedAt,
        }).onConflictDoNothing();
        initializedMissingSink = true;
      }
      const crmTarget = crmTargetForIntegrationEvent(row);
      if (crmTarget !== null && !deliveries.some((delivery) => delivery.sink === "crm")) {
        let crmMappingVersion: string | null = null;
        let crmFingerprint: string | null = null;
        if (isCrmDeliveryEnabled()) {
          try {
            const configuration = getCrmConfiguration();
            if (configuration?.provider === crmTarget) {
              crmMappingVersion = configuration.mappingVersion;
              crmFingerprint = await crmDestinationFingerprint(configuration);
            }
          } catch {
            // Persist the intended provider even while configuration is
            // unavailable. The pending row is visible and can be bound only
            // before its first actual gateway call; it is never sent to a
            // different provider as an implicit fallback.
          }
        }
        // The conditional INSERT is the no-row race fence. If an admin's
        // legacy-cleanup transaction commits first, this event can never
        // acquire or call a CRM destination afterward.
        await db.insert(outboxDeliveries).select(db.select({
          eventId: outboxEvents.id,
          sink: sql<"crm">`'crm'`.as("sink"),
          workspaceId: outboxEvents.workspaceId,
          status: sql<"pending">`'pending'`.as("status"),
          attempts: sql<number>`0`.as("attempts"),
          availableAt: sql<string>`${now}`.as("available_at"),
          acceptedAt: sql<string | null>`${null}`.as("accepted_at"),
          lastError: sql<string | null>`${null}`.as("last_error"),
          crmProvider: sql<typeof crmTarget>`${crmTarget}`.as("crm_provider"),
          crmMappingVersion: sql<string | null>`${crmMappingVersion}`.as("crm_mapping_version"),
          crmDestinationFingerprint: sql<string | null>`${crmFingerprint}`.as("crm_destination_fingerprint"),
          createdAt: sql<string>`${initializedAt}`.as("created_at"),
          updatedAt: sql<string>`${initializedAt}`.as("updated_at"),
        }).from(outboxEvents).where(and(
          eq(outboxEvents.workspaceId, workspaceId),
          eq(outboxEvents.id, row.id),
          legacyAttestationAbsent(db, workspaceId, outboxEvents.id),
        ))).onConflictDoNothing();
        initializedMissingSink = true;
      }
      if (initializedMissingSink) {
        deliveries = await db.select().from(outboxDeliveries).where(and(
          eq(outboxDeliveries.workspaceId, workspaceId),
          eq(outboxDeliveries.eventId, row.id),
        ));
      }
      if (
        crmTarget !== null
        && !deliveries.some((delivery) => delivery.sink === "crm")
        && !await legacyAttestationExists(db, workspaceId, row.id)
      ) {
        await db.update(outboxEvents).set({
          status: "pending",
          lockedAt: null,
          lastError: "crm_delivery_initialization_conflict",
        }).where(and(
          eq(outboxEvents.workspaceId, workspaceId),
          eq(outboxEvents.id, row.id),
          eq(outboxEvents.status, "processing"),
          eq(outboxEvents.lockedAt, lockTime),
        ));
        retried += 1;
        continue;
      }
      // Once initialized, persisted delivery rows are the immutable sink set.
      // A later configuration change cannot silently drop a pending/dead sink.
      const requiredSinks = deliveries.map((delivery) => delivery.sink);
      if (
        deliveries.some((delivery) => delivery.status === "pending")
        && !await externalDeliveryIsCurrent(db, workspaceId, row, now, noticeConfig.publicBaseUrl)
      ) {
        const supersededCode = row.topic === "negotiation.round_requested"
          ? "negotiation_delivery_superseded"
          : "obligation_reminder_superseded";
        const terminalPayload = await payloadAfterTerminalDelivery(row, "dead");
        const finalized = await finalizeTerminalOutboxEvent({
          db,
          workspaceId,
          row,
          lockTime,
          outcome: "dead",
          terminalPayload,
          attempts: row.attempts + 1,
          availableAt: row.availableAt,
          lastError: `delivery:${supersededCode}`,
          pendingDeliveryFailure: supersededCode,
        });
        if (!finalized) {
          retried += 1;
          continue;
        }
        dead += 1;
        continue;
      }
      const failures: Array<{ sink: OutboxDeliverySink; code: string }> = [];
      for (const destination of deliveries) {
        if (destination.status !== "pending" || destination.availableAt > now) continue;
        if (
          destination.sink === "crm"
          && isLegacyCrmDeliveryProfileIncomplete(destination)
          && await legacyAttestationExists(db, workspaceId, row.id)
        ) continue;
        try {
          let configuration;
          if (destination.sink === "delivery") {
            // The general notification attestation is insufficient for an
            // external counterparty message. Recheck the separately accepted
            // negotiation path at delivery time so revoking that acceptance
            // stops already-queued work before any gateway side effect.
            configuration = row.topic === "negotiation.round_requested"
              ? getNegotiationDeliveryConfiguration()
              : getDeliveryConfiguration();
          } else {
            configuration = getCrmConfiguration();
            if (!configuration) {
              throw new GatewayDeliveryError("crm_delivery_disabled", "CRM synchronization is disabled", null, true);
            }
            const currentFingerprint = await crmDestinationFingerprint(configuration);
            const eventTarget = crmTargetForIntegrationEvent(row);
            if (eventTarget !== configuration.provider || destination.crmProvider !== eventTarget) {
              throw new GatewayDeliveryError("crm_event_target_mismatch", "The CRM event target does not match the configured destination", null, true);
            }
            if (
              destination.crmProvider
              && destination.crmMappingVersion === null
              && destination.crmDestinationFingerprint === null
            ) {
              const boundAt = new Date().toISOString();
              const bound = await db.update(outboxDeliveries).set({
                crmMappingVersion: configuration.mappingVersion,
                crmDestinationFingerprint: currentFingerprint,
                updatedAt: boundAt,
              }).where(and(
                eq(outboxDeliveries.workspaceId, workspaceId),
                eq(outboxDeliveries.eventId, row.id),
                eq(outboxDeliveries.sink, "crm"),
                eq(outboxDeliveries.status, "pending"),
                eq(outboxDeliveries.crmProvider, configuration.provider),
                isNull(outboxDeliveries.crmMappingVersion),
                isNull(outboxDeliveries.crmDestinationFingerprint),
                legacyAttestationAbsent(db, workspaceId, row.id),
              ));
              if (!bound.meta.changes) {
                if (legacyAttestationResolvesCrmDelivery(
                  await legacyAttestationExists(db, workspaceId, row.id),
                  destination,
                )) continue;
                throw new GatewayDeliveryError("crm_delivery_profile_bind_conflict", "The CRM destination profile changed while it was being bound", null, true);
              }
              destination.crmMappingVersion = configuration.mappingVersion;
              destination.crmDestinationFingerprint = currentFingerprint;
            }
            if (
              !destination.crmProvider
              || !destination.crmMappingVersion
              || !destination.crmDestinationFingerprint
            ) {
              throw new GatewayDeliveryError("crm_delivery_profile_unknown", "The persisted CRM destination profile is incomplete", null, true);
            }
            if (
              destination.crmProvider !== configuration.provider
              || destination.crmMappingVersion !== configuration.mappingVersion
              || destination.crmDestinationFingerprint !== currentFingerprint
            ) {
              throw new GatewayDeliveryError("crm_delivery_profile_changed", "The current CRM destination differs from the persisted delivery profile", null, true);
            }
          }
          await deliverOutboxEvent(configuration, row);
          const acceptedAt = new Date().toISOString();
          await db.update(outboxDeliveries).set({
            status: "accepted",
            acceptedAt,
            lastError: null,
            updatedAt: acceptedAt,
          }).where(and(
            eq(outboxDeliveries.workspaceId, workspaceId),
            eq(outboxDeliveries.eventId, row.id),
            eq(outboxDeliveries.sink, destination.sink),
            eq(outboxDeliveries.status, "pending"),
            ...(destination.sink === "crm" ? [legacyAttestationAbsent(db, workspaceId, row.id)] : []),
          ));
          acceptedBySink[destination.sink] += 1;
        } catch (error) {
          const attempts = destination.attempts + 1;
          const failure = failureCode(error);
          const terminal = !failure.retryable || attempts >= MAX_ATTEMPTS;
          const failedAt = new Date().toISOString();
          await db.update(outboxDeliveries).set({
            status: terminal ? "dead" : "pending",
            attempts,
            availableAt: nextAttemptAt(attempts, failure.retryAfterMs),
            acceptedAt: null,
            lastError: failure.code,
            updatedAt: failedAt,
          }).where(and(
            eq(outboxDeliveries.workspaceId, workspaceId),
            eq(outboxDeliveries.eventId, row.id),
            eq(outboxDeliveries.sink, destination.sink),
            eq(outboxDeliveries.status, "pending"),
            ...(destination.sink === "crm" ? [legacyAttestationAbsent(db, workspaceId, row.id)] : []),
          ));
          failures.push({ sink: destination.sink, code: failure.code });
        }
      }

      const finalDeliveries = await db.select().from(outboxDeliveries).where(and(
        eq(outboxDeliveries.workspaceId, workspaceId),
        eq(outboxDeliveries.eventId, row.id),
      ));
      const finalCrmDelivery = finalDeliveries.find((destination) => destination.sink === "crm") ?? null;
      const legacyCrmResolved = isLegacyCrmDeliveryProfileIncomplete(finalCrmDelivery)
        && legacyAttestationResolvesCrmDelivery(
          await legacyAttestationExists(db, workspaceId, row.id),
          finalCrmDelivery,
        );
      const allAccepted = finalDeliveries.length === requiredSinks.length
        && finalDeliveries.every((destination) => destination.status === "accepted"
          || (destination.sink === "crm" && legacyCrmResolved));
      const anyDead = finalDeliveries.some((destination) => destination.status === "dead"
        && !(destination.sink === "crm" && legacyCrmResolved));
      if (allAccepted) {
        const processedPayload = await payloadAfterTerminalDelivery(row, "accepted");
        const finalized = await finalizeTerminalOutboxEvent({
          db,
          workspaceId,
          row,
          lockTime,
          outcome: "accepted",
          terminalPayload: processedPayload,
          attempts: row.attempts,
          availableAt: row.availableAt,
          lastError: null,
        });
        if (!finalized) {
          retried += 1;
          continue;
        }
        delivered += 1;
      } else {
        const pendingTimes = finalDeliveries
          .filter((destination) => destination.status === "pending"
            && !(destination.sink === "crm" && legacyCrmResolved))
          .map((destination) => destination.availableAt)
          .sort();
        const nextAvailableAt = pendingTimes[0] ?? now;
        const lastError = failures.length > 0
          ? failures.map((failure) => `${failure.sink}:${failure.code}`).join(",")
          : "destination_retry_pending";
        const terminalPayload = anyDead
          ? await payloadAfterTerminalDelivery(row, "dead")
          : row.payload;
        if (anyDead) {
          const finalized = await finalizeTerminalOutboxEvent({
            db,
            workspaceId,
            row,
            lockTime,
            outcome: "dead",
            terminalPayload,
            attempts: row.attempts + (failures.length > 0 ? 1 : 0),
            availableAt: nextAvailableAt,
            lastError,
          });
          if (!finalized) {
            retried += 1;
            continue;
          }
          dead += 1;
        } else {
          await db.update(outboxEvents).set({
            payload: terminalPayload,
            status: "pending",
            attempts: row.attempts + (failures.length > 0 ? 1 : 0),
            availableAt: nextAvailableAt,
            lockedAt: null,
            lastError,
          }).where(and(
            eq(outboxEvents.workspaceId, workspaceId),
            eq(outboxEvents.id, row.id),
            eq(outboxEvents.status, "processing"),
            eq(outboxEvents.lockedAt, lockTime),
          ));
          retried += 1;
        }
      }
    }
    return apiJson({ processed: rows.length, delivered, retried, dead, acceptedBySink, requestId }, { requestId });
  } catch (error) {
    return handleRouteError(error, requestId, "Outbox processing is unavailable.");
  }
}

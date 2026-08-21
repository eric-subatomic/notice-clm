import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { negotiationRounds } from "../../db/schema";

type Database = ReturnType<typeof getDb>;

const ACTIVE_PORTAL_ROUND_STATUSES = ["prepared", "outbound", "returned", "review"] as const;

export const NEGOTIATION_PORTAL_MAX_UPLOAD_ATTEMPTS = 10;
export const NEGOTIATION_PORTAL_MAX_ACCEPTED_UPLOADS = 4;
export const NEGOTIATION_PORTAL_MAX_REJECTED_UPLOADS = 6;
export const NEGOTIATION_PORTAL_MAX_UPLOAD_BYTES = 96 * 1_024 * 1_024;
export const NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES = 21 * 1_024 * 1_024;
export const NEGOTIATION_PORTAL_UPLOAD_LEASE_MS = 5 * 60 * 1_000;
export const NEGOTIATION_PORTAL_MAX_DOWNLOAD_ATTEMPTS = 20;
export const NEGOTIATION_PORTAL_MAX_DOWNLOAD_BYTES = 256 * 1_024 * 1_024;

export const NEGOTIATION_PORTAL_TRANSFER_POLICY = Object.freeze({
  budgetScope: "exchange_round",
  tokenRotationResetsBudget: false,
  maximumUploadAttempts: NEGOTIATION_PORTAL_MAX_UPLOAD_ATTEMPTS,
  maximumAcceptedUploads: NEGOTIATION_PORTAL_MAX_ACCEPTED_UPLOADS,
  maximumRejectedUploads: NEGOTIATION_PORTAL_MAX_REJECTED_UPLOADS,
  maximumCumulativeUploadBytes: NEGOTIATION_PORTAL_MAX_UPLOAD_BYTES,
  maximumConcurrentUploadWork: 1,
  busyRetryAfterSeconds: 5,
  maximumDownloadAttempts: NEGOTIATION_PORTAL_MAX_DOWNLOAD_ATTEMPTS,
  maximumCumulativeDownloadBytes: NEGOTIATION_PORTAL_MAX_DOWNLOAD_BYTES,
});

export type NegotiationPortalUploadReservation = Readonly<{
  id: string;
  workspaceId: string;
  agreementId: number;
  roundId: string;
  tokenHash: string;
  reservedBytes: number;
  expiresAt: string;
}>;

export type NegotiationPortalBudgetFailure = "not_found" | "expired" | "busy" | "exhausted" | "changed";

export type NegotiationPortalUploadClaim =
  | Readonly<{ ok: true; reservation: NegotiationPortalUploadReservation }>
  | Readonly<{ ok: false; reason: NegotiationPortalBudgetFailure }>;

export type NegotiationPortalDownloadClaim =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: NegotiationPortalBudgetFailure }>;

function requireIsoInstant(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO-8601 instant.`);
  }
  return timestamp;
}

function requireSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError("Portal token hash must be a lowercase SHA-256 digest.");
}

function uploadFailure(
  round: typeof negotiationRounds.$inferSelect | null,
  tokenHash: string,
  now: string,
): NegotiationPortalBudgetFailure {
  if (!round || round.portalTokenHash !== tokenHash) return "not_found";
  if (
    !round.activeKey
    || !ACTIVE_PORTAL_ROUND_STATUSES.includes(round.status as (typeof ACTIVE_PORTAL_ROUND_STATUSES)[number])
    || !round.portalExpiresAt
    || round.portalExpiresAt <= now
  ) return "expired";
  if (round.portalUploadReservationId && round.portalUploadReservationExpiresAt && round.portalUploadReservationExpiresAt > now) {
    return "busy";
  }
  const staleReservationPenalty = round.portalUploadReservationId ? 1 : 0;
  if (
    round.portalUploadAttempts >= NEGOTIATION_PORTAL_MAX_UPLOAD_ATTEMPTS
    || round.portalUploadAccepted >= NEGOTIATION_PORTAL_MAX_ACCEPTED_UPLOADS
    || round.portalUploadRejected + staleReservationPenalty >= NEGOTIATION_PORTAL_MAX_REJECTED_UPLOADS
    || round.portalUploadBytes > NEGOTIATION_PORTAL_MAX_UPLOAD_BYTES - NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES
  ) return "exhausted";
  // The row changed between the failed atomic claim and this diagnostic read.
  // The caller may retry, but no costly work was admitted without a lease.
  return "changed";
}

export async function claimNegotiationPortalUpload(
  db: Database,
  input: Readonly<{
    workspaceId: string;
    tokenHash: string;
    reservationId: string;
    now: string;
  }>,
): Promise<NegotiationPortalUploadClaim> {
  const nowMs = requireIsoInstant(input.now, "Portal upload claim time");
  requireSha256(input.tokenHash);
  if (!input.reservationId) throw new TypeError("Portal upload reservation ID is required.");

  const [candidate] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, input.workspaceId),
    eq(negotiationRounds.portalTokenHash, input.tokenHash),
  )).limit(1);
  if (!candidate) return { ok: false, reason: "not_found" };

  const expiresAt = new Date(nowMs + NEGOTIATION_PORTAL_UPLOAD_LEASE_MS).toISOString();
  const staleReservationPenalty = sql<number>`case when ${negotiationRounds.portalUploadReservationId} is null then 0 else 1 end`;
  const claimed = await db.update(negotiationRounds).set({
    portalUploadAttempts: sql`${negotiationRounds.portalUploadAttempts} + 1`,
    portalUploadRejected: sql`${negotiationRounds.portalUploadRejected} + ${staleReservationPenalty}`,
    portalUploadBytes: sql`${negotiationRounds.portalUploadBytes} + ${NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES}`,
    portalUploadReservationId: input.reservationId,
    portalUploadReservationExpiresAt: expiresAt,
    portalUploadReservationBytes: NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES,
  }).where(and(
    eq(negotiationRounds.workspaceId, input.workspaceId),
    eq(negotiationRounds.id, candidate.id),
    eq(negotiationRounds.portalTokenHash, input.tokenHash),
    isNotNull(negotiationRounds.activeKey),
    inArray(negotiationRounds.status, ACTIVE_PORTAL_ROUND_STATUSES),
    gt(negotiationRounds.portalExpiresAt, input.now),
    or(
      isNull(negotiationRounds.portalUploadReservationId),
      lte(negotiationRounds.portalUploadReservationExpiresAt, input.now),
    ),
    lt(negotiationRounds.portalUploadAttempts, NEGOTIATION_PORTAL_MAX_UPLOAD_ATTEMPTS),
    lt(negotiationRounds.portalUploadAccepted, NEGOTIATION_PORTAL_MAX_ACCEPTED_UPLOADS),
    sql`${negotiationRounds.portalUploadRejected} + ${staleReservationPenalty} < ${NEGOTIATION_PORTAL_MAX_REJECTED_UPLOADS}`,
    lte(
      negotiationRounds.portalUploadBytes,
      NEGOTIATION_PORTAL_MAX_UPLOAD_BYTES - NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES,
    ),
  ));

  if (claimed.meta.changes) {
    return {
      ok: true,
      reservation: {
        id: input.reservationId,
        workspaceId: candidate.workspaceId,
        agreementId: candidate.agreementId,
        roundId: candidate.id,
        tokenHash: input.tokenHash,
        reservedBytes: NEGOTIATION_PORTAL_UPLOAD_RESERVATION_BYTES,
        expiresAt,
      },
    };
  }

  const [current] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, input.workspaceId),
    eq(negotiationRounds.id, candidate.id),
  )).limit(1);
  return { ok: false, reason: uploadFailure(current ?? null, input.tokenHash, input.now) };
}

export function negotiationPortalUploadCompletionPatch(
  reservation: NegotiationPortalUploadReservation,
  input: Readonly<{ accepted: boolean; consumedBytes: number }>,
) {
  if (
    !Number.isSafeInteger(input.consumedBytes)
    || input.consumedBytes < 0
    || input.consumedBytes > reservation.reservedBytes
  ) throw new RangeError("Consumed portal upload bytes must fit within the durable reservation.");
  return {
    portalUploadAccepted: input.accepted
      ? sql`${negotiationRounds.portalUploadAccepted} + 1`
      : sql`${negotiationRounds.portalUploadAccepted}`,
    portalUploadRejected: input.accepted
      ? sql`${negotiationRounds.portalUploadRejected}`
      : sql`${negotiationRounds.portalUploadRejected} + 1`,
    portalUploadBytes: sql`${negotiationRounds.portalUploadBytes} - ${negotiationRounds.portalUploadReservationBytes} + ${input.consumedBytes}`,
    portalUploadReservationId: null,
    portalUploadReservationExpiresAt: null,
    portalUploadReservationBytes: null,
  };
}

export function negotiationPortalUploadReservationPredicate(
  reservation: NegotiationPortalUploadReservation,
  freshAt?: string,
) {
  if (freshAt !== undefined) requireIsoInstant(freshAt, "Portal upload commit time");
  return and(
    eq(negotiationRounds.workspaceId, reservation.workspaceId),
    eq(negotiationRounds.id, reservation.roundId),
    eq(negotiationRounds.portalUploadReservationId, reservation.id),
    eq(negotiationRounds.portalUploadReservationBytes, reservation.reservedBytes),
    ...(freshAt === undefined ? [] : [gt(negotiationRounds.portalUploadReservationExpiresAt, freshAt)]),
  );
}

export async function rejectNegotiationPortalUpload(
  db: Database,
  reservation: NegotiationPortalUploadReservation,
  consumedBytes: number,
): Promise<boolean> {
  return completeNegotiationPortalUpload(db, reservation, { accepted: false, consumedBytes });
}

export async function completeNegotiationPortalUpload(
  db: Database,
  reservation: NegotiationPortalUploadReservation,
  input: Readonly<{ accepted: boolean; consumedBytes: number }>,
): Promise<boolean> {
  const released = await db.update(negotiationRounds).set(
    negotiationPortalUploadCompletionPatch(reservation, input),
  ).where(negotiationPortalUploadReservationPredicate(reservation));
  return Boolean(released.meta.changes);
}

export async function claimNegotiationPortalDownload(
  db: Database,
  input: Readonly<{
    workspaceId: string;
    agreementId: number;
    roundId: string;
    tokenHash: string;
    outboundDocumentId: string;
    outboundSha256: string;
    bytes: number;
    now: string;
  }>,
): Promise<NegotiationPortalDownloadClaim> {
  requireIsoInstant(input.now, "Portal download claim time");
  requireSha256(input.tokenHash);
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > NEGOTIATION_PORTAL_MAX_DOWNLOAD_BYTES) {
    throw new RangeError("Portal download byte claim is invalid.");
  }

  const claimed = await db.update(negotiationRounds).set({
    portalDownloadAttempts: sql`${negotiationRounds.portalDownloadAttempts} + 1`,
    portalDownloadBytes: sql`${negotiationRounds.portalDownloadBytes} + ${input.bytes}`,
  }).where(and(
    eq(negotiationRounds.workspaceId, input.workspaceId),
    eq(negotiationRounds.agreementId, input.agreementId),
    eq(negotiationRounds.id, input.roundId),
    eq(negotiationRounds.portalTokenHash, input.tokenHash),
    eq(negotiationRounds.outboundDocumentId, input.outboundDocumentId),
    eq(negotiationRounds.outboundSha256, input.outboundSha256),
    isNotNull(negotiationRounds.activeKey),
    inArray(negotiationRounds.status, ACTIVE_PORTAL_ROUND_STATUSES),
    gt(negotiationRounds.portalExpiresAt, input.now),
    lt(negotiationRounds.portalDownloadAttempts, NEGOTIATION_PORTAL_MAX_DOWNLOAD_ATTEMPTS),
    lte(negotiationRounds.portalDownloadBytes, NEGOTIATION_PORTAL_MAX_DOWNLOAD_BYTES - input.bytes),
  ));
  if (claimed.meta.changes) return { ok: true };

  const [current] = await db.select().from(negotiationRounds).where(and(
    eq(negotiationRounds.workspaceId, input.workspaceId),
    eq(negotiationRounds.id, input.roundId),
  )).limit(1);
  if (!current || current.portalTokenHash !== input.tokenHash) return { ok: false, reason: "not_found" };
  if (
    !current.activeKey
    || !ACTIVE_PORTAL_ROUND_STATUSES.includes(current.status as (typeof ACTIVE_PORTAL_ROUND_STATUSES)[number])
    || !current.portalExpiresAt
    || current.portalExpiresAt <= input.now
  ) return { ok: false, reason: "expired" };
  if (current.outboundDocumentId !== input.outboundDocumentId || current.outboundSha256 !== input.outboundSha256) {
    return { ok: false, reason: "changed" };
  }
  return { ok: false, reason: "exhausted" };
}

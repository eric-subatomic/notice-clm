import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { and, desc, eq, exists, gt, inArray, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agreementCreationReceipts, agreementDocumentVersions, agreementEvents, agreements, agreementVersions, approvalRequests, documentComparisons, documents, documentUploadReceipts, mutationGuards, negotiationRounds, negotiationSubmissions, purgeJobs, signaturePackets, workspaceEvents } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import { canRescanDocument, isDocumentReadable } from "../../../lib/document-access";
import {
  CustomerHostedOcrError,
  extractDocumentTextWithCustomerHostedOcr,
  inspectDocument,
  MAX_DOCUMENT_BYTES,
  normalizedDocumentName,
  scanDocument,
  sha256Hex,
  supportsCustomerHostedOcr,
  type CustomerHostedOcrProfile,
  type CustomerHostedOcrResult,
  type ScanVerdict,
  type ScannerConfiguration,
  type SupportedDocument,
} from "../../../lib/document-security";
import { apiError, apiJson } from "../../../lib/http";
import { findActiveAgreement, isMutationGuardConflict, isOptimisticConcurrencyConflict, prepareAgreementEvent, prepareAgreementSnapshot, prepareWorkspaceEvent } from "../../../lib/persistence";
import { getScannerConfiguration } from "../../../lib/providers";
import { deriveNegotiationRoundAction } from "../../../lib/negotiation-round-state";
import { cleanupStagedDocumentObject, cleanupStagedWorkingVersionObject, type StagedObjectIdentity } from "../../../lib/staged-object-cleanup";
import { verifyStoredDocumentSource } from "../../../lib/stored-document-integrity";
import { documentLinkSchema, parseJson, readBoundedBody } from "../../../lib/validation";
import { extractDocumentMetadata } from "../../../lib/document-extraction";
import {
  canonicalDocumentUploadIdempotencyKey,
  documentUploadExpiresAt,
  documentUploadKeyDigest,
  documentUploadLinkReceiptState,
  documentUploadRequestDigest,
} from "../../../lib/document-upload-idempotency";

type ImportEnv = {
  DOCUMENTS: R2Bucket;
};

const retryScanSchema = z.object({ documentId: z.string().uuid() });
const MAX_MULTIPART_BODY_BYTES = MAX_DOCUMENT_BYTES + 1024 * 1024;
const ACTIVE_RESCAN_ROUND_STATUSES = ["prepared", "outbound", "returned", "review"] as const;
const ACTIVE_OCR_CLAIM_MAX_AGE_MS = 5 * 60_000;
const RESCAN_CLAIM_PROVIDER = "scan-gateway-rescan-pending";
const ACTIVE_RESCAN_CLAIM_MAX_AGE_MS = 5 * 60_000;

const documentUploadResponseSchema = z.object({
  document: z.object({
    id: z.string().uuid(),
    fileName: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    scanStatus: z.string().min(1).max(64),
    extractionMode: z.string().min(1).max(500),
    tags: z.array(z.string()),
    riskFlags: z.array(z.string()),
    extracted: z.record(z.string(), z.string()),
  }).strict(),
}).strict();
type DocumentUploadResponse = z.infer<typeof documentUploadResponseSchema>;

type Database = ReturnType<typeof getDb>;

async function findDocumentUploadReceipt(
  db: Database,
  workspaceId: string,
  userId: string,
  keyDigest: string,
) {
  const [receipt] = await db.select({
    requestDigest: documentUploadReceipts.requestDigest,
    responseJson: documentUploadReceipts.responseJson,
    responseStatus: documentUploadReceipts.responseStatus,
    expiresAt: documentUploadReceipts.expiresAt,
    linkedAt: documentUploadReceipts.linkedAt,
    agreementId: documents.agreementId,
    documentDeletedAt: documents.deletedAt,
  }).from(documentUploadReceipts).innerJoin(documents, and(
    eq(documents.workspaceId, documentUploadReceipts.workspaceId),
    eq(documents.id, documentUploadReceipts.documentId),
  )).where(and(
    eq(documentUploadReceipts.workspaceId, workspaceId),
    eq(documentUploadReceipts.userId, userId),
    eq(documentUploadReceipts.keyDigest, keyDigest),
  )).limit(1);
  return receipt ?? null;
}

async function replayDocumentUpload(input: Readonly<{
  db: Database;
  workspaceId: string;
  userId: string;
  keyDigest: string;
  requestDigest?: string;
  requestId: string;
  headers: Headers;
}>): Promise<Response | null> {
  const receipt = await findDocumentUploadReceipt(
    input.db,
    input.workspaceId,
    input.userId,
    input.keyDigest,
  );
  if (!receipt) return null;
  if (input.requestDigest !== undefined && receipt.requestDigest !== input.requestDigest) {
    return apiError(
      "idempotency_key_conflict",
      "This upload retry key is already bound to a different normalized file.",
      { status: 409, requestId: input.requestId, headers: input.headers },
    );
  }
  const isLinked = receipt.linkedAt !== null || receipt.agreementId !== null;
  if (receipt.documentDeletedAt !== null || (!isLinked && receipt.expiresAt <= new Date().toISOString())) {
    return apiError(
      "document_upload_expired",
      "This unlinked upload is no longer recoverable. Start a new import with a new retry key.",
      { status: 410, requestId: input.requestId, headers: input.headers },
    );
  }
  const parsed = documentUploadResponseSchema.safeParse(JSON.parse(receipt.responseJson));
  if (!parsed.success || (receipt.responseStatus !== 201 && receipt.responseStatus !== 202)) {
    throw new Error("Document upload receipt is invalid");
  }
  const headers = new Headers(input.headers);
  headers.set("Idempotency-Replayed", "true");
  return apiJson({ ...parsed.data, replay: true, requestId: input.requestId }, {
    status: 200,
    requestId: input.requestId,
    headers,
  });
}
type RescanEvidenceInput = Readonly<{
  workspaceId: string;
  agreementId: number | null;
  documentId: string;
  submissionId: string | null;
  roundId: string | null;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  verdict: "clean" | "malicious" | "unavailable";
  provider: string;
  scannerDetail: string;
  scannerProtocol: "1" | "2.0";
  scannerRequestId: string | null;
  ocrModelId: string | null;
  ocrProfileId: string | null;
  scannerReportedAt: string | null;
  recordedAt: string;
  effect: string;
  actor: { id: string; email: string; displayName: string };
}>;

function rescanEvidenceDetail(input: RescanEvidenceInput): string {
  return JSON.stringify({
    schema: "notice.document_security.rescan.v1",
    documentId: input.documentId,
    submissionId: input.submissionId,
    negotiationRoundId: input.roundId,
    agreementId: input.agreementId,
    fileName: input.fileName,
    contentType: input.contentType,
    size: input.size,
    sha256: input.sha256,
    verdict: input.verdict,
    provider: input.provider,
    scannerDetail: input.scannerDetail,
    scannerProtocol: input.scannerProtocol,
    scannerRequestId: input.scannerRequestId,
    ocrModelId: input.ocrModelId,
    ocrProfileId: input.ocrProfileId,
    scannerReportedAt: input.scannerReportedAt,
    recordedAt: input.recordedAt,
    effect: input.effect,
    actorUserId: input.actor.id,
    actorEmail: input.actor.email,
  });
}

async function prepareRescanEvidence(db: Database, input: RescanEvidenceInput) {
  const detail = rescanEvidenceDetail(input);
  const [workspaceEvent, agreementEvent] = await Promise.all([
    prepareWorkspaceEvent(db, {
      workspaceId: input.workspaceId,
      type: "Document security",
      detail,
      actor: input.actor,
      createdAt: input.recordedAt,
    }),
    input.agreementId === null ? Promise.resolve(null) : prepareAgreementEvent(db, {
      workspaceId: input.workspaceId,
      agreementId: input.agreementId,
      type: "Document security",
      detail,
      actor: input.actor,
      createdAt: input.recordedAt,
    }),
  ]);
  return { workspaceEvent, agreementEvent };
}

class RescanClaimConflict extends Error {}

function hasActiveDocumentClaim(
  document: Pick<typeof documents.$inferSelect, "scanProvider" | "scannedAt">,
  provider: string,
  maximumAgeMs: number,
  now = Date.now(),
): boolean {
  if (document.scanProvider !== provider) return false;
  if (document.scannedAt === null) return true;
  const claimedAt = Date.parse(document.scannedAt);
  if (!Number.isFinite(claimedAt) || claimedAt > now) return true;
  return now - claimedAt <= maximumAgeMs;
}

async function claimDocumentForRescan(db: Database, input: Readonly<{
  workspaceId: string;
  document: typeof documents.$inferSelect;
  actor: { id: string; email: string; displayName: string };
}>): Promise<typeof documents.$inferSelect> {
  const claimedAt = new Date().toISOString();
  const [workspaceEvent, agreementEvent] = await Promise.all([
    prepareWorkspaceEvent(db, {
      workspaceId: input.workspaceId,
      type: "Document security",
      detail: JSON.stringify({
        schema: "notice.document_security.rescan_claim.v1",
        documentId: input.document.id,
        agreementId: input.document.agreementId,
        negotiationRoundId: input.document.negotiationRoundId,
        objectKey: input.document.objectKey,
        size: input.document.size,
        sha256: input.document.sha256,
        previousStatus: input.document.scanStatus,
        previousProvider: input.document.scanProvider,
        claimedAt,
        expiresAfterMilliseconds: ACTIVE_RESCAN_CLAIM_MAX_AGE_MS,
        effect: "The exact quarantined source was claimed before scanner protocol 1; only this claim may promote it clean, while any correlated malicious verdict remains authoritative.",
        actorUserId: input.actor.id,
        actorEmail: input.actor.email,
      }),
      actor: input.actor,
      createdAt: claimedAt,
    }),
    input.document.agreementId === null ? Promise.resolve(null) : prepareAgreementEvent(db, {
      workspaceId: input.workspaceId,
      agreementId: input.document.agreementId,
      type: "Document security",
      detail: `Claimed quarantined source ${input.document.id} (${input.document.sha256}) for one bounded scanner protocol 1 call; agreement and negotiation lineage remain unchanged.`,
      actor: input.actor,
      createdAt: claimedAt,
    }),
  ]);
  const guardId = crypto.randomUUID();
  try {
    const [updated] = await db.batch([
      db.update(documents).set({
        version: input.document.version + 1,
        scanStatus: "quarantined",
        scanProvider: RESCAN_CLAIM_PROVIDER,
        scannedAt: claimedAt,
      }).where(and(
        eq(documents.workspaceId, input.workspaceId),
        eq(documents.id, input.document.id),
        eq(documents.version, input.document.version),
        eq(documents.objectKey, input.document.objectKey),
        eq(documents.fileName, input.document.fileName),
        eq(documents.contentType, input.document.contentType),
        eq(documents.size, input.document.size),
        eq(documents.sha256, input.document.sha256),
        eq(documents.scanStatus, input.document.scanStatus),
        input.document.scanProvider === null ? isNull(documents.scanProvider) : eq(documents.scanProvider, input.document.scanProvider),
        input.document.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, input.document.scannedAt),
        input.document.agreementId === null ? isNull(documents.agreementId) : eq(documents.agreementId, input.document.agreementId),
        eq(documents.role, input.document.role),
        eq(documents.direction, input.document.direction),
        input.document.negotiationRoundId === null ? isNull(documents.negotiationRoundId) : eq(documents.negotiationRoundId, input.document.negotiationRoundId),
        eq(documents.legalHold, input.document.legalHold),
        isNull(documents.deletedAt),
      )),
      db.insert(mutationGuards).values({
        id: guardId,
        workspaceId: input.workspaceId,
        operation: "document.claim_rescan",
        guardChanges: sql<number>`changes()`,
        createdAt: claimedAt,
      }),
      db.insert(workspaceEvents).values(workspaceEvent),
      ...(agreementEvent ? [db.insert(agreementEvents).values(agreementEvent)] : []),
      db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, input.workspaceId),
        eq(mutationGuards.id, guardId),
      )),
    ]);
    if (!updated.meta.changes) throw new RescanClaimConflict();
  } catch (error) {
    if (error instanceof RescanClaimConflict || isMutationGuardConflict(error)) throw new RescanClaimConflict();
    throw error;
  }
  return {
    ...input.document,
    version: input.document.version + 1,
    scanStatus: "quarantined",
    scanProvider: RESCAN_CLAIM_PROVIDER,
    scannedAt: claimedAt,
  };
}

type CorrelatedMaliciousRescan = Readonly<{
  workspaceId: string;
  documentId: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  scan: ScanVerdict & { status: "malicious" };
  submissionId: string | null;
  roundId: string | null;
  actor: { id: string; email: string; displayName: string };
}>;

/**
 * A clean/stale claimant may never erase a correlated malicious verdict. If
 * the rich negotiation-policy batch loses a race, this narrow retry records
 * the byte-bound rejection against the latest row version before returning.
 */
async function reconcileCorrelatedMaliciousRescan(
  db: Database,
  input: CorrelatedMaliciousRescan,
): Promise<boolean> {
  const fencedAt = new Date().toISOString();
  const latestScanAt = input.scan.scannedAt ?? fencedAt;
  // Put the exact object behind the D1 read gate before preparing hash-chain
  // evidence or richer lineage changes. This single-statement monotonic fence
  // cannot be rolled back by a clean claimant and makes a stale malicious
  // result fail closed even if later audit/cleanup reconciliation is impaired.
  await db.update(documents).set({
    version: sql`${documents.version} + 1`,
    scanStatus: "rejected",
    scanProvider: input.scan.provider,
    scannedAt: latestScanAt,
    deletedAt: sql`coalesce(${documents.deletedAt}, ${fencedAt})`,
  }).where(and(
    eq(documents.workspaceId, input.workspaceId),
    eq(documents.id, input.documentId),
    eq(documents.objectKey, input.objectKey),
    eq(documents.fileName, input.fileName),
    eq(documents.contentType, input.contentType),
    eq(documents.size, input.size),
    eq(documents.sha256, input.sha256),
    ne(documents.scanStatus, "rejected"),
    ne(documents.scanStatus, "malicious"),
  ));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [current] = await db.select().from(documents).where(and(
      eq(documents.workspaceId, input.workspaceId),
      eq(documents.id, input.documentId),
    )).limit(1);
    if (!current) return false;
    if (
      current.objectKey !== input.objectKey
      || current.fileName !== input.fileName
      || current.contentType !== input.contentType
      || current.size !== input.size
      || current.sha256 !== input.sha256
    ) return false;
    if (current.scanStatus !== "rejected" && current.scanStatus !== "malicious") return false;

    const [recordedVerdict] = await db.select({ id: workspaceEvents.id }).from(workspaceEvents).where(and(
      eq(workspaceEvents.workspaceId, input.workspaceId),
      eq(workspaceEvents.type, "Document security"),
      sql`json_valid(${workspaceEvents.detail}) = 1`,
      sql`json_extract(${workspaceEvents.detail}, '$.schema') = 'notice.document_security.rescan.v1'`,
      sql`json_extract(${workspaceEvents.detail}, '$.documentId') = ${input.documentId}`,
      sql`json_extract(${workspaceEvents.detail}, '$.sha256') = ${input.sha256}`,
      sql`json_extract(${workspaceEvents.detail}, '$.verdict') = 'malicious'`,
      sql`json_extract(${workspaceEvents.detail}, '$.provider') = ${input.scan.provider}`,
      input.scan.scannedAt === null
        ? sql`json_type(${workspaceEvents.detail}, '$.scannerReportedAt') = 'null'`
        : sql`json_extract(${workspaceEvents.detail}, '$.scannerReportedAt') = ${input.scan.scannedAt}`,
    )).limit(1);
    if (recordedVerdict) return true;

    const [currentAgreement] = current.agreementId === null ? [] : await db.select({
      id: agreements.id,
      legalHold: agreements.legalHold,
      deletedAt: agreements.deletedAt,
    }).from(agreements).where(and(
      eq(agreements.workspaceId, input.workspaceId),
      eq(agreements.id, current.agreementId),
    )).limit(1);
    // Missing or unreadable parent policy is treated as held. The retention
    // worker independently rechecks both lineages before any object deletion.
    const retainedForLegalHold = current.legalHold || (current.agreementId !== null && (!currentAgreement || currentAgreement.deletedAt !== null || currentAgreement.legalHold));
    const recordedAt = new Date().toISOString();
    const { workspaceEvent, agreementEvent } = await prepareRescanEvidence(db, {
      workspaceId: input.workspaceId,
      agreementId: current.agreementId,
      documentId: current.id,
      submissionId: input.submissionId,
      roundId: input.roundId,
      fileName: current.fileName,
      contentType: current.contentType,
      size: current.size,
      sha256: current.sha256,
      verdict: "malicious",
      provider: input.scan.provider,
      scannerDetail: input.scan.detail,
      scannerProtocol: "1",
      scannerRequestId: null,
      ocrModelId: null,
      ocrProfileId: null,
      scannerReportedAt: input.scan.scannedAt,
      recordedAt,
      effect: retainedForLegalHold
        ? "A correlated malicious verdict won reconciliation; the document is rejected and inaccessible, with bytes retained under conservative legal-hold policy."
        : "A correlated malicious verdict won reconciliation; the document is rejected and inaccessible, with object deletion queued durably.",
      actor: input.actor,
    });
    const guardId = crypto.randomUUID();
    const cleanupJobId = crypto.randomUUID();
    const [existingCleanup] = retainedForLegalHold ? [] : await db.select({ id: purgeJobs.id }).from(purgeJobs).where(and(
      eq(purgeJobs.workspaceId, input.workspaceId),
      eq(purgeJobs.resourceType, "document"),
      sql`${purgeJobs.resourceId} like ${`rejected:${current.id}:%`}`,
    )).limit(1);
    try {
      const [updated] = await db.batch([
        db.update(documents).set({ version: sql`${documents.version}` }).where(and(
          eq(documents.workspaceId, input.workspaceId),
          eq(documents.id, current.id),
          eq(documents.version, current.version),
          eq(documents.objectKey, current.objectKey),
          eq(documents.fileName, current.fileName),
          eq(documents.contentType, current.contentType),
          eq(documents.size, current.size),
          eq(documents.sha256, current.sha256),
          eq(documents.scanStatus, current.scanStatus),
          current.scanProvider === null ? isNull(documents.scanProvider) : eq(documents.scanProvider, current.scanProvider),
          current.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, current.scannedAt),
          current.agreementId === null ? isNull(documents.agreementId) : eq(documents.agreementId, current.agreementId),
          eq(documents.role, current.role),
          eq(documents.direction, current.direction),
          current.negotiationRoundId === null ? isNull(documents.negotiationRoundId) : eq(documents.negotiationRoundId, current.negotiationRoundId),
          eq(documents.legalHold, current.legalHold),
          current.deletedAt === null ? isNull(documents.deletedAt) : eq(documents.deletedAt, current.deletedAt),
        )),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId: input.workspaceId,
          operation: "document.reconcile_malicious_rescan",
          guardChanges: sql<number>`changes()`,
          createdAt: recordedAt,
        }),
        ...(!retainedForLegalHold && !existingCleanup ? [db.insert(purgeJobs).values({
          id: cleanupJobId,
          workspaceId: input.workspaceId,
          resourceType: "document",
          resourceId: `rejected:${current.id}:${cleanupJobId}`,
          objectKeys: [current.objectKey],
          status: "storage_pending",
          guardChanges: 1,
          attempts: 0,
          lastError: null,
          lastAttemptAt: null,
          createdAt: recordedAt,
          updatedAt: recordedAt,
          completedAt: null,
        })] : []),
        db.insert(workspaceEvents).values(workspaceEvent),
        ...(agreementEvent ? [db.insert(agreementEvents).values(agreementEvent)] : []),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, input.workspaceId),
          eq(mutationGuards.id, guardId),
        )),
      ]);
      if (updated.meta.changes) return true;
    } catch (error) {
      if (!isMutationGuardConflict(error) && !isOptimisticConcurrencyConflict(error)) throw error;
    }
  }
  const [latest] = await db.select({
    objectKey: documents.objectKey,
    sha256: documents.sha256,
    scanStatus: documents.scanStatus,
  }).from(documents).where(and(
    eq(documents.workspaceId, input.workspaceId),
    eq(documents.id, input.documentId),
  )).limit(1);
  if (!(
    latest
    && latest.objectKey === input.objectKey
    && latest.sha256 === input.sha256
    && (latest.scanStatus === "rejected" || latest.scanStatus === "malicious")
  )) return false;
  const [recordedVerdict] = await db.select({ id: workspaceEvents.id }).from(workspaceEvents).where(and(
    eq(workspaceEvents.workspaceId, input.workspaceId),
    eq(workspaceEvents.type, "Document security"),
    sql`json_valid(${workspaceEvents.detail}) = 1`,
    sql`json_extract(${workspaceEvents.detail}, '$.schema') = 'notice.document_security.rescan.v1'`,
    sql`json_extract(${workspaceEvents.detail}, '$.documentId') = ${input.documentId}`,
    sql`json_extract(${workspaceEvents.detail}, '$.sha256') = ${input.sha256}`,
    sql`json_extract(${workspaceEvents.detail}, '$.verdict') = 'malicious'`,
    sql`json_extract(${workspaceEvents.detail}, '$.provider') = ${input.scan.provider}`,
    input.scan.scannedAt === null
      ? sql`json_type(${workspaceEvents.detail}, '$.scannerReportedAt') = 'null'`
      : sql`json_extract(${workspaceEvents.detail}, '$.scannerReportedAt') = ${input.scan.scannedAt}`,
  )).limit(1);
  return Boolean(recordedVerdict);
}

class MaliciousOcrRejectionConflict extends Error {}

type CustomerHostedOcrClaimRecovery = Readonly<{
  workspaceId: string;
  agreementId: number;
  original: typeof documents.$inferSelect;
  claimed: typeof documents.$inferSelect;
  profile: CustomerHostedOcrProfile;
  actor: { id: string; email: string; displayName: string };
}>;

type CustomerHostedOcrCommitIdentity = Readonly<{
  id: string;
  objectKey: string;
  sha256: string;
  size: number;
  version: number;
}>;

async function inspectCustomerHostedOcrCommitState(
  db: Database,
  recovery: CustomerHostedOcrClaimRecovery,
  commit: CustomerHostedOcrCommitIdentity,
): Promise<"committed" | "pending" | "unknown"> {
  const [documentRows, versionRows] = await Promise.all([
    db.select().from(documents).where(and(
      eq(documents.workspaceId, recovery.workspaceId),
      eq(documents.id, recovery.claimed.id),
    )).limit(1),
    db.select().from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, recovery.workspaceId),
      eq(agreementDocumentVersions.agreementId, recovery.agreementId),
      eq(agreementDocumentVersions.sourceDocumentId, recovery.claimed.id),
    )).limit(2),
  ]);
  const current = documentRows[0];
  const committedVersion = versionRows.find((candidate) => (
    candidate.id === commit.id
    && candidate.objectKey === commit.objectKey
    && candidate.sha256 === commit.sha256
    && candidate.size === commit.size
    && candidate.version === commit.version
  ));
  if (
    current
    && current.agreementId === recovery.agreementId
    && current.scanStatus === "clean"
    && current.deletedAt === null
    && committedVersion
  ) return "committed";
  const exactPendingClaim = current
    && current.version === recovery.claimed.version
    && current.agreementId === null
    && current.objectKey === recovery.claimed.objectKey
    && current.size === recovery.claimed.size
    && current.sha256 === recovery.claimed.sha256
    && current.scanStatus === "quarantined"
    && current.scanProvider === "customer-hosted-ocr-pending"
    && current.scannedAt === recovery.claimed.scannedAt
    && current.legalHold === recovery.claimed.legalHold
    && current.deletedAt === null;
  return exactPendingClaim && versionRows.length === 0 ? "pending" : "unknown";
}

async function claimDocumentForCustomerHostedOcr(db: Database, input: Readonly<{
  workspaceId: string;
  agreement: typeof agreements.$inferSelect;
  document: typeof documents.$inferSelect;
  profile: CustomerHostedOcrProfile;
  actor: { id: string; email: string; displayName: string };
}>): Promise<typeof documents.$inferSelect> {
  const claimedAt = new Date().toISOString();
  const effectiveLegalHold = input.document.legalHold || input.agreement.legalHold;
  const [workspaceEvent, agreementEvent] = await Promise.all([
    prepareWorkspaceEvent(db, {
      workspaceId: input.workspaceId,
      type: "Document security",
      detail: JSON.stringify({
        schema: "notice.document_security.ocr_claim.v1",
        documentId: input.document.id,
        agreementId: input.agreement.id,
        sha256: input.document.sha256,
        scannerProtocol: "2.0",
        modelId: input.profile.modelId,
        profileId: input.profile.profileId,
        effect: "The exact clean source was made unreadable before external OCR; only this claim may link or reject it.",
        actorUserId: input.actor.id,
        actorEmail: input.actor.email,
        recordedAt: claimedAt,
      }),
      actor: input.actor,
      createdAt: claimedAt,
    }),
    prepareAgreementEvent(db, {
      workspaceId: input.workspaceId,
      agreementId: input.agreement.id,
      type: "Document security",
      detail: `Claimed source document ${input.document.id} (${input.document.sha256}) for signed OCR protocol 2.0 model ${input.profile.modelId} profile ${input.profile.profileId}; it is unreadable until the exact claim links or rejects it.`,
      actor: input.actor,
      createdAt: claimedAt,
    }),
  ]);
  const documentGuardId = crypto.randomUUID();
  const agreementGuardId = crypto.randomUUID();
  const [updated] = await db.batch([
    db.update(documents).set({
      version: input.document.version + 1,
      scanStatus: "quarantined",
      scanProvider: "customer-hosted-ocr-pending",
      scannedAt: claimedAt,
      legalHold: effectiveLegalHold,
    }).where(and(
      eq(documents.workspaceId, input.workspaceId),
      eq(documents.id, input.document.id),
      eq(documents.version, input.document.version),
      eq(documents.objectKey, input.document.objectKey),
      eq(documents.size, input.document.size),
      eq(documents.sha256, input.document.sha256),
      eq(documents.scanStatus, input.document.scanStatus),
      isNull(documents.agreementId),
      eq(documents.role, "initial_source"),
      eq(documents.direction, "inbound"),
      isNull(documents.negotiationRoundId),
      eq(documents.legalHold, input.document.legalHold),
      isNull(documents.deletedAt),
    )),
    db.insert(mutationGuards).values({
      id: documentGuardId,
      workspaceId: input.workspaceId,
      operation: "document.claim_customer_hosted_ocr",
      guardChanges: sql<number>`changes()`,
      createdAt: claimedAt,
    }),
    db.update(agreements).set({ updatedAt: sql`${agreements.updatedAt}` }).where(and(
      eq(agreements.workspaceId, input.workspaceId),
      eq(agreements.id, input.agreement.id),
      eq(agreements.version, input.agreement.version),
      eq(agreements.nextAction, input.agreement.nextAction),
      eq(agreements.updatedAt, input.agreement.updatedAt),
      eq(agreements.legalHold, input.agreement.legalHold),
      isNull(agreements.deletedAt),
    )),
    db.insert(mutationGuards).values({
      id: agreementGuardId,
      workspaceId: input.workspaceId,
      operation: "document.claim_customer_hosted_ocr.agreement_policy",
      guardChanges: sql<number>`changes()`,
      createdAt: claimedAt,
    }),
    db.insert(workspaceEvents).values(workspaceEvent),
    db.insert(agreementEvents).values(agreementEvent),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, input.workspaceId),
      inArray(mutationGuards.id, [documentGuardId, agreementGuardId]),
    )),
  ]);
  if (!updated.meta.changes) throw new MaliciousOcrRejectionConflict();
  return {
    ...input.document,
    version: input.document.version + 1,
    scanStatus: "quarantined",
    scanProvider: "customer-hosted-ocr-pending",
    scannedAt: claimedAt,
    legalHold: effectiveLegalHold,
  };
}

async function releaseCustomerHostedOcrClaim(db: Database, input: Readonly<{
  workspaceId: string;
  agreementId: number;
  original: typeof documents.$inferSelect;
  claimed: typeof documents.$inferSelect;
  profile: CustomerHostedOcrProfile;
  reason: string;
  actor: { id: string; email: string; displayName: string };
}>): Promise<void> {
  const recordedAt = new Date().toISOString();
  const [workspaceEvent, agreementEvent] = await Promise.all([
    prepareWorkspaceEvent(db, {
      workspaceId: input.workspaceId,
      type: "Document security",
      detail: JSON.stringify({
        schema: "notice.document_security.ocr_claim_release.v1",
        documentId: input.original.id,
        agreementId: input.agreementId,
        sha256: input.original.sha256,
        scannerProtocol: "2.0",
        modelId: input.profile.modelId,
        profileId: input.profile.profileId,
        reason: input.reason.slice(0, 500),
        effect: "The failed OCR claim was released without linking or creating a working version; the prior clean scanner state was restored.",
        actorUserId: input.actor.id,
        actorEmail: input.actor.email,
        recordedAt,
      }),
      actor: input.actor,
      createdAt: recordedAt,
    }),
    prepareAgreementEvent(db, {
      workspaceId: input.workspaceId,
      agreementId: input.agreementId,
      type: "Document security",
      detail: `Released failed signed OCR protocol 2.0 claim for source ${input.original.id}; nothing was linked or promoted.`,
      actor: input.actor,
      createdAt: recordedAt,
    }),
  ]);
  const guardId = crypto.randomUUID();
  const [updated] = await db.batch([
    db.update(documents).set({
      version: input.claimed.version + 1,
      scanStatus: input.original.scanStatus,
      scanProvider: input.original.scanProvider,
      scannedAt: input.original.scannedAt,
      legalHold: input.original.legalHold,
    }).where(and(
      eq(documents.workspaceId, input.workspaceId),
      eq(documents.id, input.claimed.id),
      eq(documents.version, input.claimed.version),
      eq(documents.objectKey, input.claimed.objectKey),
      eq(documents.size, input.claimed.size),
      eq(documents.sha256, input.claimed.sha256),
      eq(documents.scanStatus, "quarantined"),
      eq(documents.scanProvider, "customer-hosted-ocr-pending"),
      input.claimed.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, input.claimed.scannedAt),
      isNull(documents.agreementId),
      eq(documents.legalHold, input.claimed.legalHold),
      isNull(documents.deletedAt),
    )),
    db.insert(mutationGuards).values({
      id: guardId,
      workspaceId: input.workspaceId,
      operation: "document.release_customer_hosted_ocr",
      guardChanges: sql<number>`changes()`,
      createdAt: recordedAt,
    }),
    db.insert(workspaceEvents).values(workspaceEvent),
    db.insert(agreementEvents).values(agreementEvent),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, input.workspaceId),
      eq(mutationGuards.id, guardId),
    )),
  ]);
  if (!updated.meta.changes) throw new MaliciousOcrRejectionConflict();
}

async function rejectMaliciousOcrLinkSource(db: Database, input: Readonly<{
  workspaceId: string;
  agreementId: number;
  document: typeof documents.$inferSelect;
  verifiedSize: number;
  error: CustomerHostedOcrError;
  profile: CustomerHostedOcrProfile;
  actor: { id: string; email: string; displayName: string };
}>): Promise<{ retainedForLegalHold: boolean }> {
  const recordedAt = new Date().toISOString();
  const evidence = input.error.verdictEvidence;
  const latestScanAt = evidence?.scannedAt ?? recordedAt;
  // The claim already propagated the source/target hold snapshot onto the
  // document. Re-read the target without coupling rejection to its mutable
  // version so a hold activated during inference also wins, while an ordinary
  // agreement edit can never roll back a fresh malicious classification.
  let retainedForLegalHold = input.document.legalHold;
  try {
    const [currentTarget] = await db.select({ legalHold: agreements.legalHold }).from(agreements).where(and(
      eq(agreements.workspaceId, input.workspaceId),
      eq(agreements.id, input.agreementId),
    )).limit(1);
    retainedForLegalHold = retainedForLegalHold || !currentTarget || currentTarget.legalHold;
  } catch {
    // If current hold state cannot be proven, preserve the inaccessible bytes
    // and let an operator reconcile them rather than risk deleting held data.
    retainedForLegalHold = true;
  }
  const cleanupJobId = crypto.randomUUID();
  const { workspaceEvent, agreementEvent } = await prepareRescanEvidence(db, {
    workspaceId: input.workspaceId,
    agreementId: input.agreementId,
    documentId: input.document.id,
    submissionId: null,
    roundId: null,
    fileName: input.document.fileName,
    contentType: input.document.contentType,
    size: input.verifiedSize,
    sha256: input.document.sha256,
    verdict: "malicious",
    provider: evidence?.provider ?? "scan-gateway",
    scannerDetail: evidence?.detail ?? input.error.message,
    scannerProtocol: "2.0",
    scannerRequestId: evidence?.requestId ?? null,
    ocrModelId: input.profile.modelId,
    ocrProfileId: input.profile.profileId,
    scannerReportedAt: evidence?.scannedAt ?? null,
    recordedAt,
    effect: retainedForLegalHold
      ? "Customer-hosted OCR reclassified the source as malicious; it was policy-associated with the target agreement, rejected, and made inaccessible while bytes were retained because legal hold overrides deletion."
      : "Customer-hosted OCR reclassified the source as malicious; it was policy-associated with the target agreement, rejected, and made inaccessible, and object deletion was queued in the durable storage-cleanup ledger.",
    actor: input.actor,
  });
  const guardId = crypto.randomUUID();
  const [updated] = await db.batch([
    db.update(documents).set({
      // This association exists only so later agreement hold changes can
      // atomically fence storage cleanup. The rejected row remains deleted,
      // unreadable, and ineligible as agreement paper.
      agreementId: input.agreementId,
      scanStatus: "rejected",
      scanProvider: evidence?.provider ?? "scan-gateway",
      scannedAt: latestScanAt,
      deletedAt: recordedAt,
      version: input.document.version + 1,
    }).where(and(
      eq(documents.workspaceId, input.workspaceId),
      eq(documents.id, input.document.id),
      eq(documents.version, input.document.version),
      eq(documents.objectKey, input.document.objectKey),
      eq(documents.size, input.verifiedSize),
      eq(documents.sha256, input.document.sha256),
      eq(documents.scanStatus, input.document.scanStatus),
      eq(documents.scanProvider, "customer-hosted-ocr-pending"),
      input.document.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, input.document.scannedAt),
      isNull(documents.agreementId),
      eq(documents.role, "initial_source"),
      eq(documents.direction, "inbound"),
      isNull(documents.negotiationRoundId),
      eq(documents.legalHold, input.document.legalHold),
      isNull(documents.deletedAt),
    )),
    db.insert(mutationGuards).values({
      id: guardId,
      workspaceId: input.workspaceId,
      operation: "document.reject_malicious_ocr",
      guardChanges: sql<number>`changes()`,
      createdAt: recordedAt,
    }),
    ...(!retainedForLegalHold ? [db.insert(purgeJobs).values({
      id: cleanupJobId,
      workspaceId: input.workspaceId,
      resourceType: "document",
      resourceId: `rejected:${input.document.id}:${cleanupJobId}`,
      objectKeys: [input.document.objectKey],
      status: "storage_pending",
      guardChanges: 1,
      attempts: 0,
      lastError: null,
      lastAttemptAt: null,
      createdAt: recordedAt,
      updatedAt: recordedAt,
      completedAt: null,
    })] : []),
    db.insert(workspaceEvents).values(workspaceEvent),
    ...(agreementEvent ? [db.insert(agreementEvents).values(agreementEvent)] : []),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, input.workspaceId),
      eq(mutationGuards.id, guardId),
    )),
  ]);
  if (!updated.meta.changes) throw new MaliciousOcrRejectionConflict();
  return { retainedForLegalHold };
}
async function readDocumentText(
  bytes: Uint8Array,
  document: SupportedDocument,
  mode: "evaluation" | "production",
  customerHostedOcr?: Readonly<{
    document: { id: string; fileName: string; contentType: string; sha256: string };
    configuration: ScannerConfiguration;
  }>,
  deferredCustomerHostedOcr?: CustomerHostedOcrProfile | null,
): Promise<{ text: string; mode: string; ocr?: CustomerHostedOcrResult }> {
  if (mode === "production" && supportsCustomerHostedOcr(document)) {
    if (customerHostedOcr?.configuration.ocr) {
      const extraction = await extractDocumentTextWithCustomerHostedOcr(
        bytes,
        customerHostedOcr.document,
        customerHostedOcr.configuration,
      );
      return {
        text: extraction.text,
        mode: `Customer-hosted OCR via scanner gateway; model ${extraction.modelId}; profile ${extraction.profileId}`,
        ocr: extraction,
      };
    }
    if (deferredCustomerHostedOcr) {
      return {
        text: "",
        mode: `${document.extension.toUpperCase()} stored after scanning; customer-hosted OCR model ${deferredCustomerHostedOcr.modelId} with profile ${deferredCustomerHostedOcr.profileId} is selected and extraction is deferred until the first agreement link`,
      };
    }
    return {
      text: "",
      mode: `${document.extension.toUpperCase()} stored after scanning; customer-hosted OCR is disabled, so create a reviewed text working version`,
    };
  }
  if (new Set(["pdf", "docx"]).has(document.extension) && bytes.byteLength > 5 * 1024 * 1024) {
    return { text: "", mode: `${document.extension.toUpperCase()} exceeds the 5 MiB local extraction limit` };
  }
  if (document.extension === "pdf") {
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(bytes);
      const result = await extractText(pdf, { mergePages: true });
      const extractedText: unknown = result.text;
      const text = typeof extractedText === "string" ? extractedText : Array.isArray(extractedText) ? extractedText.map(String).join("\n\n") : "";
      return { text, mode: text.trim() ? "PDF text extraction" : "PDF requires OCR/manual review" };
    } catch {
      return { text: "", mode: "PDF requires OCR/manual review" };
    }
  }

  if (document.extension === "docx") {
    try {
      const mammothModule = await import("mammoth");
      const extractRawText = mammothModule.extractRawText ?? mammothModule.default?.extractRawText;
      if (!extractRawText) throw new Error("DOCX extractor unavailable");
      const result = await extractRawText({ buffer: Buffer.from(bytes) });
      return { text: result.value, mode: "DOCX text extraction" };
    } catch {
      return { text: "", mode: "DOCX requires manual review" };
    }
  }

  return { text: new TextDecoder().decode(bytes), mode: document.extension === "rtf" ? "RTF text extraction" : "Plain-text extraction" };
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "document:upload", { limit: 120 });
  if (!auth.ok) return auth.response;
  const rawIdempotencyKey = request.headers.get("idempotency-key");
  if (rawIdempotencyKey === null) {
    return apiError("idempotency_key_required", "A canonical UUID Idempotency-Key header is required.", { status: 400, requestId: auth.requestId, headers: auth.headers });
  }
  const idempotencyKey = canonicalDocumentUploadIdempotencyKey(rawIdempotencyKey);
  if (!idempotencyKey) {
    return apiError("invalid_idempotency_key", "Idempotency-Key must be a canonical lowercase UUID.", { status: 400, requestId: auth.requestId, headers: auth.headers });
  }
  try {
    await ensureStorageSchema();
    const keyDigest = await documentUploadKeyDigest({
      workspaceId: auth.context.workspace.id,
      userId: auth.context.user.id,
      idempotencyKey,
    });
    const replay = await replayDocumentUpload({
      db: getDb(),
      workspaceId: auth.context.workspace.id,
      userId: auth.context.user.id,
      keyDigest,
      requestId: auth.requestId,
      headers: auth.headers,
    });
    return replay ?? apiError("document_upload_not_found", "No committed upload was found for this retry key.", { status: 404, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Document upload recovery could not be completed.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "document:upload", { limit: 10, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  const rawIdempotencyKey = request.headers.get("idempotency-key");
  if (rawIdempotencyKey === null) {
    return apiError("idempotency_key_required", "A canonical UUID Idempotency-Key header is required.", { status: 400, requestId: auth.requestId, headers: auth.headers });
  }
  const idempotencyKey = canonicalDocumentUploadIdempotencyKey(rawIdempotencyKey);
  if (!idempotencyKey) {
    return apiError("invalid_idempotency_key", "Idempotency-Key must be a canonical lowercase UUID.", { status: 400, requestId: auth.requestId, headers: auth.headers });
  }
  let stagedDocument: StagedObjectIdentity | null = null;
  let keyDigest: string | null = null;
  let requestDigest: string | null = null;
  try {
    await ensureStorageSchema();
    const boundedBody = await readBoundedBody(request, MAX_MULTIPART_BODY_BYTES, `Maximum multipart body size is ${MAX_MULTIPART_BODY_BYTES} bytes`);
    const multipartHeaders = new Headers(request.headers);
    // The reconstructed body is authoritative. Do not forward a caller's
    // stale or deliberately inconsistent framing header to the form parser.
    multipartHeaders.delete("content-length");
    const boundedRequest = new Request(request.url, { method: request.method, headers: multipartHeaders, body: boundedBody.buffer as ArrayBuffer });
    let form: FormData;
    try {
      form = await boundedRequest.formData();
    } catch {
      return apiError("invalid_multipart", "Document uploads must use valid multipart form data.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    }
    const file = form.get("file");
    if (!(file instanceof File)) return apiError("document_required", "A document is required.", { status: 400, requestId: auth.requestId, headers: auth.headers });
    if (file.size > MAX_DOCUMENT_BYTES) return apiError("payload_too_large", "The document exceeds the 20 MiB upload limit.", { status: 413, requestId: auth.requestId, headers: auth.headers });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectDocument(bytes, file.name);
    const fileName = normalizedDocumentName(file.name);
    const sha256 = await sha256Hex(bytes);
    [keyDigest, requestDigest] = await Promise.all([
      documentUploadKeyDigest({
        workspaceId: auth.context.workspace.id,
        userId: auth.context.user.id,
        idempotencyKey,
      }),
      documentUploadRequestDigest({ fileName, size: bytes.byteLength, sha256 }),
    ]);
    const db = getDb();
    const prior = await replayDocumentUpload({
      db,
      workspaceId: auth.context.workspace.id,
      userId: auth.context.user.id,
      keyDigest,
      requestDigest,
      requestId: auth.requestId,
      headers: auth.headers,
    });
    if (prior) return prior;

    const id = crypto.randomUUID();
    const config = getNoticeConfig();
    const scannerConfiguration = config.mode === "production" ? getScannerConfiguration() : null;
    const ocrEligible = supportsCustomerHostedOcr(inspected);
    const deferredOcrProfile = ocrEligible ? scannerConfiguration?.ocr ?? null : null;
    const scan = config.mode === "evaluation"
      ? { status: "clean" as const, provider: "evaluation-bypass", detail: "Synthetic evaluation file bypass", scannedAt: new Date().toISOString() }
      : await scanDocument(bytes, { id, fileName, contentType: inspected.contentType, sha256 }, scannerConfiguration!);
    if (scan.status === "malicious") {
      return apiError("malware_detected", "The document was rejected by the security scanner.", { status: 422, requestId: auth.requestId, headers: auth.headers });
    }

    const workspacePrefix = `workspaces/${auth.context.workspace.id}`;
    const quarantined = scan.status !== "clean";
    const storedObjectKey = `${workspacePrefix}/${quarantined ? "quarantine" : "documents"}/${id}/${fileName}`;
    const bindings = env as unknown as ImportEnv;
    stagedDocument = { workspaceId: auth.context.workspace.id, id, objectKey: storedObjectKey, sha256 };
    await bindings.DOCUMENTS.put(storedObjectKey, bytes, {
      httpMetadata: { contentType: inspected.contentType },
      customMetadata: {
        source: "notice-import",
        documentId: id,
        sha256,
        scanStatus: quarantined ? "quarantined" : "clean",
        ...(deferredOcrProfile ? {
          ocrStatus: "selected-deferred",
          ocrModelId: deferredOcrProfile.modelId,
          ocrProfileId: deferredOcrProfile.profileId,
        } : ocrEligible ? { ocrStatus: "disabled" } : {}),
      },
    });

    const readable = quarantined
      ? { text: "", mode: deferredOcrProfile
          ? `Quarantined pending security scan; customer-hosted OCR model ${deferredOcrProfile.modelId} with profile ${deferredOcrProfile.profileId} remains selected and deferred`
          : ocrEligible
            ? "Quarantined pending security scan; customer-hosted OCR is explicitly disabled"
            : "Quarantined pending security scan" }
      : await readDocumentText(bytes, inspected, config.mode, undefined, deferredOcrProfile);
    const analysis = extractDocumentMetadata(readable.text.slice(0, 400_000), fileName);
    const committedAt = new Date();
    const now = committedAt.toISOString();
    const expiresAt = documentUploadExpiresAt(committedAt);
    const record = {
      id,
      workspaceId: auth.context.workspace.id,
      version: 1,
      agreementId: null,
      role: "initial_source" as const,
      direction: "inbound" as const,
      negotiationRoundId: null,
      providerMessageId: null,
      parentSha256: null,
      originalSenderEmail: null,
      fileName,
      objectKey: storedObjectKey,
      contentType: inspected.contentType,
      size: bytes.byteLength,
      tags: analysis.tags,
      extracted: analysis.extracted,
      extractionMode: readable.mode,
      sha256,
      scanStatus: quarantined ? "quarantined" : config.mode === "evaluation" ? "evaluation-bypassed" : "clean",
      scanProvider: scan.provider,
      scannedAt: scan.scannedAt,
      createdByUserId: auth.context.user.id,
      legalHold: false,
      // Unlinked intake is staging, not indefinite records storage. Linking
      // atomically replaces this with the agreement's records policy.
      retentionUntil: expiresAt,
      deletedAt: null,
      createdAt: now,
    };
    const responsePayload: DocumentUploadResponse = {
      document: {
        id,
        fileName,
        size: bytes.byteLength,
        contentType: inspected.contentType,
        sha256,
        scanStatus: record.scanStatus,
        extractionMode: readable.mode,
        tags: record.tags,
        riskFlags: analysis.riskFlags,
        extracted: record.extracted,
      },
    };
    const responseStatus = quarantined ? 202 : 201;
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "Document",
      detail: `Imported ${fileName}; security status ${record.scanStatus}; extraction status: ${readable.mode}.`,
      actor: auth.context.user,
      createdAt: now,
    });
    await db.batch([
      db.insert(documents).values(record),
      db.insert(workspaceEvents).values(event),
      db.insert(documentUploadReceipts).values({
        workspaceId: auth.context.workspace.id,
        userId: auth.context.user.id,
        keyDigest,
        requestDigest,
        documentId: id,
        responseJson: JSON.stringify(responsePayload),
        responseStatus,
        createdAt: now,
        expiresAt,
        linkedAt: null,
      }),
    ]);
    stagedDocument = null;
    const headers = new Headers(auth.headers);
    headers.set("Idempotency-Replayed", "false");
    return apiJson({ ...responsePayload, replay: false, requestId: auth.requestId }, {
      status: responseStatus,
      requestId: auth.requestId,
      headers,
    });
  } catch (error) {
    if (stagedDocument) {
      try {
        await cleanupStagedDocumentObject(getDb(), (env as unknown as ImportEnv).DOCUMENTS, stagedDocument);
      } catch {
        // An unavailable D1 binding is an unknown commit state. Retain R2 for reconciliation.
      }
    }
    // A concurrent winner can make the receipt insert lose after this request
    // staged different R2 bytes. Cleanup must finish before receipt replay so a
    // successful response never strands the losing object.
    if (keyDigest && requestDigest) {
      try {
        const reconciled = await replayDocumentUpload({
          db: getDb(),
          workspaceId: auth.context.workspace.id,
          userId: auth.context.user.id,
          keyDigest,
          requestDigest,
          requestId: auth.requestId,
          headers: auth.headers,
        });
        if (reconciled) return reconciled;
      } catch {
        // Preserve the original fail-closed error when reconciliation storage is unavailable.
      }
    }
    return handleRouteError(error, auth.requestId, "Document import could not be completed.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "document:upload", { limit: 40 });
  if (!auth.ok) return auth.response;
  const rawIdempotencyKey = request.headers.get("idempotency-key");
  const idempotencyKey = rawIdempotencyKey === null ? null : canonicalDocumentUploadIdempotencyKey(rawIdempotencyKey);
  if (rawIdempotencyKey !== null && !idempotencyKey) {
    return apiError("invalid_idempotency_key", "Idempotency-Key must be a canonical lowercase UUID.", { status: 400, requestId: auth.requestId, headers: auth.headers });
  }
  let workingVersionObjectKey: string | null = null;
  let stagedWorkingVersion: StagedObjectIdentity | null = null;
  let linkAgreementId: number | null = null;
  let linkDocumentId: string | null = null;
  let customerHostedOcrRecovery: CustomerHostedOcrClaimRecovery | null = null;
  let customerHostedOcrCommit: CustomerHostedOcrCommitIdentity | null = null;
  let customerHostedOcrFinalCommitAttempted = false;
  let customerHostedOcrSuccessPayload: Record<string, unknown> | null = null;
  let customerHostedOcrMaliciousObserved = false;
  try {
    const input = await parseJson(request, documentLinkSchema, 16_000);
    linkAgreementId = input.agreementId;
    linkDocumentId = input.documentId;
    await ensureStorageSchema();
    const db = getDb();
    const receiptsForDocument = await db.select({
      userId: documentUploadReceipts.userId,
      keyDigest: documentUploadReceipts.keyDigest,
      documentId: documentUploadReceipts.documentId,
      expiresAt: documentUploadReceipts.expiresAt,
      linkedAt: documentUploadReceipts.linkedAt,
    }).from(documentUploadReceipts).where(and(
      eq(documentUploadReceipts.workspaceId, auth.context.workspace.id),
      eq(documentUploadReceipts.documentId, input.documentId),
    )).limit(2);
    const [document] = await db.select().from(documents).where(and(
      eq(documents.workspaceId, auth.context.workspace.id),
      eq(documents.id, input.documentId),
      isNull(documents.deletedAt),
    )).limit(1);
    if (!document) return apiError("document_not_found", "Document was not found.", { status: 404, requestId: auth.requestId });
    const intakeReceipt = receiptsForDocument[0] ?? null;
    const canManageDocumentLinks = auth.context.permissions.has("agreement:update")
      && auth.context.permissions.has("document:manage");
    const intakeReceiptState = documentUploadLinkReceiptState(intakeReceipt, new Date().toISOString());
    let intakeKeyDigest: string | null = null;
    let intakeAgreementReservation = false;
    let reservationCreatedAt: string | null = null;
    // Requesters may complete only the exact imported-agreement saga that
    // reserved their upload. Privileged legal/admin operators retain the
    // bounded legacy/staging repair path, but may not redirect a source that is
    // already reserved to a different agreement.
    const reservationProofRequired = !canManageDocumentLinks
      || (intakeReceiptState === "reserved" && document.agreementId === null);
    if (reservationProofRequired) {
      if (!intakeReceipt) {
        return apiError("document_upload_receipt_required", "A protected upload receipt is required to link this source document.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
      if (!idempotencyKey) {
        return apiError("idempotency_key_required", "The import intake UUID is required to link its source document.", { status: 400, requestId: auth.requestId, headers: auth.headers });
      }
      intakeKeyDigest = await documentUploadKeyDigest({
        workspaceId: auth.context.workspace.id,
        userId: auth.context.user.id,
        idempotencyKey,
      });
      if (intakeReceipt.userId !== auth.context.user.id || intakeReceipt.keyDigest !== intakeKeyDigest) {
        return apiError("document_upload_receipt_mismatch", "The document does not belong to this authenticated import intake.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
      if (intakeReceiptState === "staging") {
        return apiError("document_upload_not_reserved", "Create the imported agreement with this intake UUID before linking its reserved source.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
      if (intakeReceiptState === "expired") {
        return apiError("document_upload_expired", "This unlinked upload expired before agreement creation reserved it. Start a new import.", { status: 410, requestId: auth.requestId, headers: auth.headers });
      }
    } else if (intakeReceiptState === "expired") {
      return apiError("document_upload_expired", "This unlinked upload is no longer eligible for privileged linking.", { status: 410, requestId: auth.requestId, headers: auth.headers });
    }
    if (!isDocumentReadable(document.scanStatus, getNoticeConfig().mode)) return apiError("document_quarantined", "The document cannot be linked until security scanning passes.", { status: 409, requestId: auth.requestId });
    const agreement = await findActiveAgreement(db, auth.context.workspace.id, input.agreementId);
    if (!agreement) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    if (agreement.stage === "Active" || agreement.signatureStatus === "Completed") {
      return apiError("agreement_execution_started", "Documents cannot be linked after agreement execution has completed.", { status: 409, requestId: auth.requestId });
    }
    const [activeSignaturePacket] = await db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
      eq(signaturePackets.workspaceId, auth.context.workspace.id),
      eq(signaturePackets.agreementId, agreement.id),
      isNotNull(signaturePackets.activeKey),
    )).limit(1);
    if (activeSignaturePacket) {
      return apiError("signature_packet_active", "Supersede or complete the active signature packet before linking another document.", { status: 409, requestId: auth.requestId });
    }
    if (intakeReceipt && intakeReceiptState === "reserved" && reservationProofRequired) {
      const [creationReceipt] = idempotencyKey ? await db.select({
        agreementId: agreementCreationReceipts.agreementId,
        createdAt: agreementCreationReceipts.createdAt,
      }).from(agreementCreationReceipts).where(and(
        eq(agreementCreationReceipts.workspaceId, auth.context.workspace.id),
        eq(agreementCreationReceipts.userId, auth.context.user.id),
        eq(agreementCreationReceipts.idempotencyKey, idempotencyKey),
        eq(agreementCreationReceipts.creationMode, "imported"),
        eq(agreementCreationReceipts.agreementId, agreement.id),
      )).limit(1) : [];
      intakeAgreementReservation = Boolean(
        creationReceipt
        && intakeReceipt.linkedAt !== null
        && creationReceipt.createdAt === intakeReceipt.linkedAt
        && creationReceipt.createdAt <= intakeReceipt.expiresAt
      );
      reservationCreatedAt = intakeAgreementReservation ? creationReceipt?.createdAt ?? null : null;
      if (!intakeAgreementReservation) {
        return apiError("document_upload_reservation_mismatch", "The protected intake is reserved for a different agreement creation.", { status: 409, requestId: auth.requestId, headers: auth.headers });
      }
    }
    if (document.agreementId && document.agreementId !== agreement.id) return apiError("document_already_linked", "The document is already linked to another agreement.", { status: 409, requestId: auth.requestId });
    if (document.agreementId === agreement.id) {
      await db.update(documentUploadReceipts).set({ linkedAt: sql`coalesce(${documentUploadReceipts.linkedAt}, ${new Date().toISOString()})` }).where(and(
        eq(documentUploadReceipts.workspaceId, auth.context.workspace.id),
        eq(documentUploadReceipts.documentId, document.id),
      ));
      return apiJson({ linked: true, alreadyLinked: true, documentId: document.id, agreementId: agreement.id, workingVersionCreated: false, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }
    const [activeNegotiationRound] = await db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, auth.context.workspace.id),
      eq(negotiationRounds.agreementId, agreement.id),
      isNotNull(negotiationRounds.activeKey),
    )).limit(1);
    if (activeNegotiationRound) {
      return apiError("negotiation_round_unresolved", "Resolve or close the current counterparty review round before linking another document.", { status: 409, requestId: auth.requestId });
    }

    const [latestWorkingVersion] = await db.select({ version: agreementDocumentVersions.version }).from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
      eq(agreementDocumentVersions.agreementId, agreement.id),
    )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
    if (!latestWorkingVersion && (
      document.agreementId !== null
      || document.role !== "initial_source"
      || document.direction !== "inbound"
      || document.negotiationRoundId !== null
    )) {
      return apiError(
        "working_version_source_ineligible",
        "Create the first working version only from a newly imported source document. Counterparty returns must use the negotiation review and promotion workflow.",
        { status: 409, requestId: auth.requestId },
      );
    }

    let workingVersion: typeof agreementDocumentVersions.$inferInsert | null = null;
    let workingVersionExtractionMode: string | null = null;
    let workingVersionOcr: CustomerHostedOcrResult | null = null;
    let linkDocumentState = document;
    let customerHostedOcrClaimed = false;
    if (!latestWorkingVersion) {
      const source = await (env as unknown as ImportEnv).DOCUMENTS.get(document.objectKey);
      if (!source) return apiError("document_bytes_missing", "The imported source document is unavailable.", { status: 409, requestId: auth.requestId });
      const verifiedSource = await verifyStoredDocumentSource(source, {
        fileName: document.fileName,
        size: document.size,
        contentType: document.contentType,
        sha256: document.sha256,
      });
      if (!verifiedSource.ok) {
        const mismatch = verifiedSource.reason === "metadata"
          ? "recorded size or content type"
          : verifiedSource.reason === "digest"
            ? "recorded size or SHA-256"
            : "recorded file type";
        return apiError(
          "document_integrity_failure",
          `The imported source no longer matches its ${mismatch}.`,
          { status: 409, requestId: auth.requestId },
        );
      }
      const { bytes: sourceBytes, inspected } = verifiedSource;
      const appMode = getNoticeConfig().mode;
      const ocrConfiguration = appMode === "production" && supportsCustomerHostedOcr(inspected)
        ? getScannerConfiguration()
        : null;
      if (ocrConfiguration?.ocr) {
        try {
          linkDocumentState = await claimDocumentForCustomerHostedOcr(db, {
            workspaceId: auth.context.workspace.id,
            agreement,
            document,
            profile: ocrConfiguration.ocr,
            actor: auth.context.user,
          });
          customerHostedOcrClaimed = true;
          customerHostedOcrRecovery = {
            workspaceId: auth.context.workspace.id,
            agreementId: agreement.id,
            original: document,
            claimed: linkDocumentState,
            profile: ocrConfiguration.ocr,
            actor: auth.context.user,
          };
        } catch (claimError) {
          if (claimError instanceof MaliciousOcrRejectionConflict || isMutationGuardConflict(claimError)) {
            return apiError(
              "document_link_conflict",
              "Another request or agreement update changed the source before customer-hosted OCR could claim it. Nothing was sent for OCR, linked, or promoted; reload and retry from the current state.",
              { status: 409, requestId: auth.requestId, headers: auth.headers },
            );
          }
          throw claimError;
        }
      }
      let readable: Awaited<ReturnType<typeof readDocumentText>>;
      try {
        readable = await readDocumentText(
          sourceBytes,
          inspected,
          appMode,
          ocrConfiguration
            ? {
                document: {
                  id: document.id,
                  fileName: document.fileName,
                  contentType: inspected.contentType,
                  sha256: document.sha256,
                },
                configuration: ocrConfiguration,
              }
            : undefined,
        );
      } catch (error) {
        if (!(error instanceof CustomerHostedOcrError)) throw error;
        if (error.code === "invalid_response") {
          // An uncorrelated or malformed gateway response cannot prove that
          // the source is still safe. Preserve the unreadable claim for
          // operator reconciliation instead of restoring a clean/downloadable
          // state from ambiguous evidence.
          throw error;
        }
        if (error.code !== "malicious_source") {
          await releaseCustomerHostedOcrClaim(db, {
            workspaceId: auth.context.workspace.id,
            agreementId: agreement.id,
            original: document,
            claimed: linkDocumentState,
            profile: ocrConfiguration!.ocr!,
            reason: error.message,
            actor: auth.context.user,
          });
          customerHostedOcrRecovery = null;
          throw error;
        }
        customerHostedOcrMaliciousObserved = true;
        try {
          const disposition = await rejectMaliciousOcrLinkSource(db, {
            workspaceId: auth.context.workspace.id,
            agreementId: agreement.id,
            document: linkDocumentState,
            verifiedSize: sourceBytes.byteLength,
            error,
            profile: ocrConfiguration!.ocr!,
            actor: auth.context.user,
          });
          customerHostedOcrRecovery = null;
          return apiError(
            "ocr_source_rejected",
            `${error.message} The source was policy-associated only for target-agreement retention controls, rejected, and made inaccessible; ${disposition.retainedForLegalHold ? "its bytes were retained under legal hold" : "its bytes are queued for guarded durable deletion"}. It was not promoted into the agreement's usable paper, and Notice did not create a working version, fall back to another model, or send it to another endpoint.`,
            { status: 422, requestId: auth.requestId, headers: auth.headers },
          );
        } catch (rejectionError) {
          if (rejectionError instanceof MaliciousOcrRejectionConflict || isMutationGuardConflict(rejectionError)) {
            return apiError(
              "document_link_conflict",
              "The source changed while Notice was recording the malicious OCR verdict. Nothing was linked or promoted; reload its current security state.",
              { status: 409, requestId: auth.requestId, headers: auth.headers },
            );
          }
          throw rejectionError;
        }
      }
      const workingText = readable.ocr ? readable.text : readable.text.trim();
      if (workingText) {
        workingVersionExtractionMode = readable.mode;
        workingVersionOcr = readable.ocr ?? null;
        const bytes = new TextEncoder().encode(workingText);
        const id = crypto.randomUUID();
        const version = 1;
        const sha256 = await sha256Hex(bytes);
        workingVersionObjectKey = `workspaces/${auth.context.workspace.id}/agreements/${agreement.id}/versions/${version}/${id}.txt`;
        stagedWorkingVersion = { workspaceId: auth.context.workspace.id, id, objectKey: workingVersionObjectKey, sha256 };
        await (env as unknown as ImportEnv).DOCUMENTS.put(workingVersionObjectKey, bytes, {
          httpMetadata: { contentType: "text/plain" },
          customMetadata: {
            agreementId: String(agreement.id),
            version: String(version),
            sha256,
            sourceDocumentId: document.id,
            extractionMode: readable.mode.slice(0, 500),
            ...(readable.ocr ? {
              ocrProtocol: "2.0",
              ocrRequestId: readable.ocr.requestId,
              ocrProvider: readable.ocr.provider,
              ocrModelId: readable.ocr.modelId,
              ocrProfileId: readable.ocr.profileId,
              ocrSourceSha256: readable.ocr.sourceSha256,
            } : {}),
          },
        });
        workingVersion = {
          id,
          workspaceId: auth.context.workspace.id,
          agreementId: agreement.id,
          version,
          label: `Imported source: ${document.fileName}`,
          objectKey: workingVersionObjectKey,
          contentType: "text/plain",
          size: bytes.byteLength,
          sha256,
          sourceDocumentId: document.id,
          createdByUserId: auth.context.user.id,
          createdAt: new Date().toISOString(),
        };
        if (readable.ocr) {
          customerHostedOcrCommit = {
            id: workingVersion.id,
            objectKey: workingVersion.objectKey,
            sha256: workingVersion.sha256,
            size: workingVersion.size,
            version: workingVersion.version,
          };
        }
      }
    }
    const linkedAt = new Date().toISOString();
    const firstPaperReset = !latestWorkingVersion ? {
      stage: agreement.stage === "Signature" ? "Review" : agreement.stage,
      nextAction: "Assess risk for the imported working paper",
      approvalStatus: "Required",
      signatureStatus: "Not sent",
      risk: "Unassessed",
      riskDisposition: null,
      riskBasisHash: null,
      riskDocumentVersion: null,
      riskDocumentSha256: null,
      riskDecisionReason: null,
      riskDecidedByUserId: null,
      riskDecidedAt: null,
    } : {};
    const savedAgreement: typeof agreements.$inferSelect = {
      ...agreement,
      ...firstPaperReset,
      version: agreement.version + 1,
      updated: linkedAt,
      updatedAt: linkedAt,
      updatedByUserId: auth.context.user.id,
    };
    const event = await prepareAgreementEvent(db, {
      workspaceId: auth.context.workspace.id,
      agreementId: agreement.id,
      type: workingVersion ? "Version" : "Document",
      detail: workingVersion
        ? `Linked document ${document.fileName} and created working version ${workingVersion.version} from ${workingVersionExtractionMode ?? "extracted text"}${workingVersionOcr ? `; signed OCR protocol 2.0 request ${workingVersionOcr.requestId} completed by ${workingVersionOcr.provider}` : ""} (${document.sha256.slice(0, 12)}…).`
        : `Linked document ${document.fileName} (${document.sha256.slice(0, 12)}…); no readable text version was available.`,
      actor: auth.context.user,
      createdAt: linkedAt,
    });
    const snapshot = await prepareAgreementSnapshot(savedAgreement, auth.context.user.id, event.id);
    const documentUpdate = db.update(documents).set({
      agreementId: agreement.id,
      version: linkDocumentState.version + 1,
      legalHold: agreement.legalHold,
      retentionUntil: agreement.retentionUntil,
      ...(customerHostedOcrClaimed && workingVersionOcr ? {
        scanStatus: "clean",
        scanProvider: workingVersionOcr.provider,
        scannedAt: linkedAt,
      } : {}),
    }).where(and(
      eq(documents.workspaceId, auth.context.workspace.id),
      eq(documents.id, document.id),
      eq(documents.version, linkDocumentState.version),
      eq(documents.objectKey, linkDocumentState.objectKey),
      eq(documents.size, linkDocumentState.size),
      eq(documents.sha256, linkDocumentState.sha256),
      eq(documents.scanStatus, linkDocumentState.scanStatus),
      linkDocumentState.scanProvider === null ? isNull(documents.scanProvider) : eq(documents.scanProvider, linkDocumentState.scanProvider),
      linkDocumentState.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, linkDocumentState.scannedAt),
      eq(documents.legalHold, linkDocumentState.legalHold),
      isNull(documents.agreementId),
      eq(documents.role, "initial_source"),
      eq(documents.direction, "inbound"),
      isNull(documents.negotiationRoundId),
      intakeReceipt && !intakeAgreementReservation ? eq(documents.retentionUntil, intakeReceipt.expiresAt) : undefined,
      intakeReceipt && !intakeAgreementReservation ? gt(documents.retentionUntil, linkedAt) : undefined,
      intakeReceipt && intakeAgreementReservation
        ? agreement.retentionUntil === null ? isNull(documents.retentionUntil) : eq(documents.retentionUntil, agreement.retentionUntil)
        : undefined,
      intakeAgreementReservation && idempotencyKey && intakeKeyDigest && reservationCreatedAt
        ? exists(db.select({ documentId: documentUploadReceipts.documentId }).from(documentUploadReceipts).where(and(
            eq(documentUploadReceipts.workspaceId, auth.context.workspace.id),
            eq(documentUploadReceipts.userId, auth.context.user.id),
            eq(documentUploadReceipts.keyDigest, intakeKeyDigest),
            eq(documentUploadReceipts.documentId, document.id),
            eq(documentUploadReceipts.expiresAt, intakeReceipt?.expiresAt ?? ""),
            eq(documentUploadReceipts.linkedAt, reservationCreatedAt),
          )))
        : undefined,
      intakeAgreementReservation && idempotencyKey && reservationCreatedAt
        ? exists(db.select({ agreementId: agreementCreationReceipts.agreementId }).from(agreementCreationReceipts).where(and(
            eq(agreementCreationReceipts.workspaceId, auth.context.workspace.id),
            eq(agreementCreationReceipts.userId, auth.context.user.id),
            eq(agreementCreationReceipts.idempotencyKey, idempotencyKey),
            eq(agreementCreationReceipts.creationMode, "imported"),
            eq(agreementCreationReceipts.agreementId, agreement.id),
            eq(agreementCreationReceipts.createdAt, reservationCreatedAt),
          )))
        : undefined,
      isNull(documents.deletedAt),
    ));
    const receiptLinkWrite = db.update(documentUploadReceipts).set({ linkedAt }).where(and(
      eq(documentUploadReceipts.workspaceId, auth.context.workspace.id),
      eq(documentUploadReceipts.documentId, document.id),
      isNull(documentUploadReceipts.linkedAt),
    ));
    const documentGuardId = crypto.randomUUID();
    if (customerHostedOcrClaimed && workingVersion) {
      customerHostedOcrSuccessPayload = {
        linked: true,
        documentId: document.id,
        agreementId: agreement.id,
        workingVersionCreated: true,
        workingVersion: { version: workingVersion.version, sha256: workingVersion.sha256, size: workingVersion.size },
        agreement: savedAgreement,
        event,
      };
      // From this point a thrown D1 error may be an acknowledged rollback or
      // a committed batch whose acknowledgement was lost. Catch recovery must
      // read back the exact document/version pair before touching the claim.
      customerHostedOcrFinalCommitAttempted = true;
    }
    if (workingVersion) {
      const agreementGuardId = crypto.randomUUID();
      const [documentResult, , agreementResult] = await db.batch([
        documentUpdate,
        db.insert(mutationGuards).values({
          id: documentGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.link",
          guardChanges: sql<number>`changes()`,
          createdAt: event.createdAt,
        }),
        db.update(agreements).set({
          ...firstPaperReset,
          version: savedAgreement.version,
          updated: savedAgreement.updated,
          updatedAt: savedAgreement.updatedAt,
          updatedByUserId: savedAgreement.updatedByUserId,
        }).where(and(
          eq(agreements.workspaceId, auth.context.workspace.id),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
          ne(agreements.stage, "Active"),
          ne(agreements.signatureStatus, "Completed"),
          eq(agreements.legalHold, agreement.legalHold),
          agreement.retentionUntil === null ? isNull(agreements.retentionUntil) : eq(agreements.retentionUntil, agreement.retentionUntil),
          isNull(agreements.deletedAt),
          notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
            eq(negotiationRounds.workspaceId, auth.context.workspace.id),
            eq(negotiationRounds.agreementId, agreement.id),
            isNotNull(negotiationRounds.activeKey),
          ))),
          notExists(db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
            eq(signaturePackets.workspaceId, auth.context.workspace.id),
            eq(signaturePackets.agreementId, agreement.id),
            isNotNull(signaturePackets.activeKey),
          ))),
        )),
        db.insert(mutationGuards).values({
          id: agreementGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "agreement.link_document",
          guardChanges: sql<number>`changes()`,
          createdAt: event.createdAt,
        }),
        db.insert(agreementDocumentVersions).values(workingVersion),
        db.update(approvalRequests).set({ status: "Superseded", version: sql`${approvalRequests.version} + 1` }).where(and(
          eq(approvalRequests.workspaceId, auth.context.workspace.id),
          eq(approvalRequests.agreementId, agreement.id),
          inArray(approvalRequests.status, ["Pending", "Approved", "Changes requested"]),
        )),
        receiptLinkWrite,
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, documentGuardId),
        )),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, agreementGuardId),
        )),
      ]);
      if (!documentResult.meta.changes || !agreementResult.meta.changes) throw new DocumentLinkConflict();
    } else {
      const agreementGuardId = crypto.randomUUID();
      const [documentResult, , agreementResult] = await db.batch([
        documentUpdate,
        db.insert(mutationGuards).values({
          id: documentGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.link",
          guardChanges: sql<number>`changes()`,
          createdAt: event.createdAt,
        }),
        db.update(agreements).set({
          ...firstPaperReset,
          version: savedAgreement.version,
          updated: savedAgreement.updated,
          updatedAt: savedAgreement.updatedAt,
          updatedByUserId: savedAgreement.updatedByUserId,
        }).where(and(
          eq(agreements.workspaceId, auth.context.workspace.id),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
          ne(agreements.stage, "Active"),
          ne(agreements.signatureStatus, "Completed"),
          eq(agreements.legalHold, agreement.legalHold),
          agreement.retentionUntil === null ? isNull(agreements.retentionUntil) : eq(agreements.retentionUntil, agreement.retentionUntil),
          isNull(agreements.deletedAt),
          notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
            eq(negotiationRounds.workspaceId, auth.context.workspace.id),
            eq(negotiationRounds.agreementId, agreement.id),
            isNotNull(negotiationRounds.activeKey),
          ))),
          notExists(db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
            eq(signaturePackets.workspaceId, auth.context.workspace.id),
            eq(signaturePackets.agreementId, agreement.id),
            isNotNull(signaturePackets.activeKey),
          ))),
        )),
        db.insert(mutationGuards).values({
          id: agreementGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "agreement.link_document",
          guardChanges: sql<number>`changes()`,
          createdAt: event.createdAt,
        }),
        receiptLinkWrite,
        ...(!latestWorkingVersion ? [db.update(approvalRequests).set({ status: "Superseded", version: sql`${approvalRequests.version} + 1` }).where(and(
          eq(approvalRequests.workspaceId, auth.context.workspace.id),
          eq(approvalRequests.agreementId, agreement.id),
          inArray(approvalRequests.status, ["Pending", "Approved", "Changes requested"]),
        ))] : []),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, documentGuardId),
        )),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, agreementGuardId),
        )),
      ]);
      if (!documentResult.meta.changes || !agreementResult.meta.changes) throw new DocumentLinkConflict();
    }
    stagedWorkingVersion = null;
    workingVersionObjectKey = null;
    customerHostedOcrRecovery = null;
    return apiJson({ linked: true, documentId: document.id, agreementId: agreement.id, workingVersionCreated: Boolean(workingVersion), workingVersion: workingVersion ? { version: workingVersion.version, sha256: workingVersion.sha256, size: workingVersion.size } : null, agreement: savedAgreement, event, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    let releasedCustomerHostedOcrClaim = false;
    const recovery = customerHostedOcrRecovery;
    const retainAmbiguousClaim = error instanceof CustomerHostedOcrError && error.code === "invalid_response";
    if (recovery && !retainAmbiguousClaim && !customerHostedOcrMaliciousObserved) {
      try {
        let releaseIsSafe = !customerHostedOcrFinalCommitAttempted;
        if (customerHostedOcrFinalCommitAttempted && customerHostedOcrCommit) {
          const state = await inspectCustomerHostedOcrCommitState(getDb(), recovery, customerHostedOcrCommit);
          if (state === "committed" && customerHostedOcrSuccessPayload) {
            stagedWorkingVersion = null;
            workingVersionObjectKey = null;
            customerHostedOcrRecovery = null;
            return apiJson(
              { ...customerHostedOcrSuccessPayload, alreadyLinked: true, requestId: auth.requestId },
              { requestId: auth.requestId, headers: auth.headers },
            );
          }
          releaseIsSafe = state === "pending";
        }
        if (releaseIsSafe) {
          if (stagedWorkingVersion) {
            const cleanupDisposition = await cleanupStagedWorkingVersionObject(
              getDb(),
              (env as unknown as ImportEnv).DOCUMENTS,
              stagedWorkingVersion,
            );
            if (cleanupDisposition !== "deleted-uncommitted") {
              releaseIsSafe = false;
            } else {
              stagedWorkingVersion = null;
              workingVersionObjectKey = null;
            }
          }
          if (releaseIsSafe) {
            await releaseCustomerHostedOcrClaim(getDb(), {
              ...recovery,
              reason: "A clean OCR result could not be committed to the immutable agreement version.",
            });
            customerHostedOcrRecovery = null;
            releasedCustomerHostedOcrClaim = true;
          }
        }
      } catch {
        // If D1 cannot prove rollback or the exact release loses its CAS, keep
        // the source unreadable for reconciliation. Never guess after an
        // ambiguous final-batch outcome.
      }
    }
    if (stagedWorkingVersion) {
      try {
        await cleanupStagedWorkingVersionObject(getDb(), (env as unknown as ImportEnv).DOCUMENTS, stagedWorkingVersion);
      } catch {
        // An unavailable D1 binding is an unknown commit state. Retain R2 for reconciliation.
      }
    }
    if (error instanceof CustomerHostedOcrError) {
      if (error.code === "malicious_source") throw error;
      if (error.code === "invalid_response") {
        return apiError(
          "customer_hosted_ocr_response_untrusted",
          `${error.message} The exact source remains quarantined, unreadable, and unlinked because Notice could not safely correlate a valid gateway result. No working version was created and no fallback was attempted; an administrator may reconcile or rescan after the active claim window.`,
          { status: error.status, requestId: auth.requestId, headers: auth.headers },
        );
      }
      return apiError(
        "customer_hosted_ocr_unavailable",
        `${error.message} The failed claim was released to its prior clean scan state, so the source remains unlinked and may be retried immediately. Notice did not create a working version, fall back to another model, or send it to another endpoint.`,
        { status: error.status, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (customerHostedOcrMaliciousObserved) {
      return apiError(
        "ocr_rejection_recording_unavailable",
        "The gateway returned a correlated malicious verdict, but Notice could not finish recording rejection. The source remains quarantined and unreadable; it was not linked or promoted and requires operator reconciliation.",
        { status: 503, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (releasedCustomerHostedOcrClaim) {
      return apiError(
        "customer_hosted_ocr_commit_failed",
        "The clean OCR result could not be committed. Notice removed any uncommitted working object and restored the source to its prior clean scan state without linking or creating a version; retry the link from the current agreement state.",
        { status: error instanceof DocumentLinkConflict || isMutationGuardConflict(error) ? 409 : 503, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if ((error instanceof DocumentLinkConflict || isMutationGuardConflict(error)) && linkAgreementId && linkDocumentId) {
      try {
        const reconciliationDb = getDb();
        const [[linkedDocument], [currentAgreement], [currentSignaturePacket]] = await Promise.all([
          reconciliationDb.select({ agreementId: documents.agreementId }).from(documents).where(and(
            eq(documents.workspaceId, auth.context.workspace.id),
            eq(documents.id, linkDocumentId),
            isNull(documents.deletedAt),
          )).limit(1),
          reconciliationDb.select({ stage: agreements.stage, signatureStatus: agreements.signatureStatus }).from(agreements).where(and(
            eq(agreements.workspaceId, auth.context.workspace.id),
            eq(agreements.id, linkAgreementId),
            isNull(agreements.deletedAt),
          )).limit(1),
          reconciliationDb.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
            eq(signaturePackets.workspaceId, auth.context.workspace.id),
            eq(signaturePackets.agreementId, linkAgreementId),
            isNotNull(signaturePackets.activeKey),
          )).limit(1),
        ]);
        if (currentAgreement?.stage === "Active" || currentAgreement?.signatureStatus === "Completed") {
          return apiError("agreement_execution_started", "Documents cannot be linked after agreement execution has completed.", { status: 409, requestId: auth.requestId });
        }
        if (currentSignaturePacket) {
          return apiError("signature_packet_active", "Supersede or complete the active signature packet before linking another document.", { status: 409, requestId: auth.requestId });
        }
        if (linkedDocument?.agreementId === linkAgreementId && currentAgreement) {
          return apiJson({ linked: true, alreadyLinked: true, documentId: linkDocumentId, agreementId: linkAgreementId, workingVersionCreated: false, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
        }
      } catch {
        // Continue to the fail-closed conflict response when reconciliation is unavailable.
      }
      try {
        const [activeNegotiationRound] = await getDb().select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, auth.context.workspace.id),
          eq(negotiationRounds.agreementId, linkAgreementId),
          isNotNull(negotiationRounds.activeKey),
        )).limit(1);
        if (activeNegotiationRound) {
          return apiError("negotiation_round_unresolved", "Resolve or close the current counterparty review round before linking another document.", { status: 409, requestId: auth.requestId });
        }
      } catch {
        // Preserve the generic fail-closed concurrency response below.
      }
    }
    if (error instanceof DocumentLinkConflict || isMutationGuardConflict(error)) return apiError("version_conflict", "Reload the agreement and source document before linking them.", { status: 409, requestId: auth.requestId });
    return handleRouteError(error, auth.requestId, "Document could not be linked.");
  }
}

class DocumentLinkConflict extends Error {}

export async function PUT(request: Request) {
  const auth = await authorizeApiRequest(request, "document:manage", { limit: 10 });
  if (!auth.ok) return auth.response;
  let requestedRescanDocumentId: string | null = null;
  let correlatedCleanRescan: Readonly<{ documentId: string; objectKey: string; sha256: string }> | null = null;
  let correlatedMaliciousRescan: CorrelatedMaliciousRescan | null = null;
  try {
    const input = await parseJson(request, retryScanSchema, 16_000);
    requestedRescanDocumentId = input.documentId;
    await ensureStorageSchema();
    const db = getDb();
    const [document] = await db.select().from(documents).where(and(
      eq(documents.workspaceId, auth.context.workspace.id),
      eq(documents.id, input.documentId),
      isNull(documents.deletedAt),
    )).limit(1);
    if (!document) return apiError("document_not_found", "Document was not found.", { status: 404, requestId: auth.requestId });
    if (!canRescanDocument(document.scanStatus, getNoticeConfig().mode)) return apiError("scan_not_required", "This document is not awaiting a production scan.", { status: 409, requestId: auth.requestId });
    if (hasActiveDocumentClaim(document, "customer-hosted-ocr-pending", ACTIVE_OCR_CLAIM_MAX_AGE_MS)) {
      return apiError("ocr_in_progress", "This source has an active customer-hosted OCR claim and cannot be rescanned concurrently.", { status: 409, requestId: auth.requestId });
    }
    if (hasActiveDocumentClaim(document, RESCAN_CLAIM_PROVIDER, ACTIVE_RESCAN_CLAIM_MAX_AGE_MS)) {
      return apiError("rescan_in_progress", "This source already has an active security-rescan claim.", { status: 409, requestId: auth.requestId });
    }
    const bindings = env as unknown as ImportEnv;
    const object = await bindings.DOCUMENTS.get(document.objectKey);
    if (!object) return apiError("document_bytes_missing", "The quarantined document is unavailable.", { status: 409, requestId: auth.requestId });
    const bytes = new Uint8Array(await object.arrayBuffer());
    const actualSha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== document.size || actualSha256 !== document.sha256) {
      return apiError("document_integrity_failure", "The quarantined document failed its recorded size or SHA-256 integrity check.", { status: 409, requestId: auth.requestId });
    }
    const inspected = inspectDocument(bytes, document.fileName);
    if (inspected.contentType !== document.contentType) {
      return apiError("document_integrity_failure", "The quarantined document no longer matches its recorded content type.", { status: 409, requestId: auth.requestId });
    }

    const [parentAgreement] = document.agreementId === null
      ? []
      : await db.select().from(agreements).where(and(
        eq(agreements.workspaceId, auth.context.workspace.id),
        eq(agreements.id, document.agreementId),
        isNull(agreements.deletedAt),
      )).limit(1);
    if (document.agreementId !== null && !parentAgreement) {
      return apiError("document_lineage_invalid", "The quarantined document is missing its live parent agreement.", { status: 409, requestId: auth.requestId });
    }

    let linkedSubmission: typeof negotiationSubmissions.$inferSelect | null = null;
    let linkedRound: typeof negotiationRounds.$inferSelect | null = null;
    let linkedComparison: typeof documentComparisons.$inferSelect | null = null;
    let latestRoundId: string | null = null;
    let linkedSubmissionStates: Array<{ id: string; status: (typeof negotiationSubmissions.$inferSelect)["status"] }> = [];
    if (document.role === "counterparty_return") {
      if (document.agreementId === null || document.negotiationRoundId === null || document.direction !== "inbound") {
        return apiError("document_lineage_invalid", "The quarantined return is missing its exact agreement or negotiation-round lineage.", { status: 409, requestId: auth.requestId });
      }
      const [submissionRows, roundRows, latestRows, submissionStates] = await Promise.all([
        db.select().from(negotiationSubmissions).where(and(
          eq(negotiationSubmissions.workspaceId, auth.context.workspace.id),
          eq(negotiationSubmissions.agreementId, document.agreementId),
          eq(negotiationSubmissions.roundId, document.negotiationRoundId),
          eq(negotiationSubmissions.documentId, document.id),
          eq(negotiationSubmissions.documentSha256, actualSha256),
          eq(negotiationSubmissions.status, "quarantined"),
        )).limit(1),
        db.select().from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, auth.context.workspace.id),
          eq(negotiationRounds.agreementId, document.agreementId),
          eq(negotiationRounds.id, document.negotiationRoundId),
        )).limit(1),
        db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, auth.context.workspace.id),
          eq(negotiationRounds.agreementId, document.agreementId),
        )).orderBy(desc(negotiationRounds.roundNumber)).limit(1),
        db.select({ id: negotiationSubmissions.id, status: negotiationSubmissions.status }).from(negotiationSubmissions).where(and(
          eq(negotiationSubmissions.workspaceId, auth.context.workspace.id),
          eq(negotiationSubmissions.agreementId, document.agreementId),
          eq(negotiationSubmissions.roundId, document.negotiationRoundId),
        )),
      ]);
      linkedSubmission = submissionRows[0] ?? null;
      linkedRound = roundRows[0] ?? null;
      latestRoundId = latestRows[0]?.id ?? null;
      linkedSubmissionStates = submissionStates;
      const comparisonRows = linkedSubmission
        ? await db.select().from(documentComparisons).where(and(
          eq(documentComparisons.workspaceId, auth.context.workspace.id),
          eq(documentComparisons.agreementId, document.agreementId),
          eq(documentComparisons.roundId, document.negotiationRoundId),
          eq(documentComparisons.submissionId, linkedSubmission.id),
          eq(documentComparisons.proposedSha256, actualSha256),
        )).limit(2)
        : [];
      linkedComparison = comparisonRows[0] ?? null;
      if (
        !linkedSubmission
        || !linkedRound
        || !linkedComparison
        || comparisonRows.length !== 1
        || linkedComparison.status !== "manual_required"
        || linkedComparison.submissionId !== linkedSubmission.id
        || linkedComparison.proposedSha256 !== actualSha256
      ) {
        return apiError("negotiation_submission_missing", "The quarantined return is missing its exact submission, comparison, or round record.", { status: 409, requestId: auth.requestId });
      }
    }

    // Own one exact expiring state before invoking the external scanner. A
    // second worker can recover an abandoned claim after its bounded window,
    // but cannot race a live call or commit clean against this version.
    const claimedDocument = await claimDocumentForRescan(db, {
      workspaceId: auth.context.workspace.id,
      document,
      actor: auth.context.user,
    });
    const scannerConfiguration = getScannerConfiguration();
    const scan = await scanDocument(bytes, { id: document.id, fileName: document.fileName, contentType: inspected.contentType, sha256: actualSha256 }, scannerConfiguration);
    // Audit chronology is always server-authored. The scanner's completion time
    // is separate evidence and may describe the latest verdict metadata, but it
    // never controls either hash-chain event's createdAt value.
    const recordedAt = new Date().toISOString();
    const latestScanAt = scan.scannedAt ?? recordedAt;
    const evidenceBase = {
      workspaceId: auth.context.workspace.id,
      agreementId: document.agreementId,
      documentId: document.id,
      submissionId: linkedSubmission?.id ?? null,
      roundId: linkedRound?.id ?? null,
      fileName: document.fileName,
      contentType: inspected.contentType,
      size: bytes.byteLength,
      sha256: actualSha256,
      provider: scan.provider,
      scannerDetail: scan.detail,
      scannerProtocol: "1",
      scannerRequestId: null,
      ocrModelId: null,
      ocrProfileId: null,
      scannerReportedAt: scan.scannedAt,
      recordedAt,
      actor: auth.context.user,
    } as const;

    if (scan.status === "malicious") {
      correlatedMaliciousRescan = {
        workspaceId: auth.context.workspace.id,
        documentId: document.id,
        objectKey: document.objectKey,
        fileName: document.fileName,
        contentType: document.contentType,
        size: bytes.byteLength,
        sha256: actualSha256,
        scan: { ...scan, status: "malicious" },
        submissionId: linkedSubmission?.id ?? null,
        roundId: linkedRound?.id ?? null,
        actor: auth.context.user,
      };
    } else if (scan.status === "clean") {
      correlatedCleanRescan = { documentId: document.id, objectKey: document.objectKey, sha256: actualSha256 };
    }

    if (correlatedMaliciousRescan) {
      const [currentAfterVerdict] = await db.select().from(documents).where(and(
        eq(documents.workspaceId, auth.context.workspace.id),
        eq(documents.id, document.id),
      )).limit(1);
      const stillOwnsExactClaim = Boolean(
        currentAfterVerdict
        && currentAfterVerdict.version === claimedDocument.version
        && currentAfterVerdict.objectKey === claimedDocument.objectKey
        && currentAfterVerdict.fileName === claimedDocument.fileName
        && currentAfterVerdict.contentType === claimedDocument.contentType
        && currentAfterVerdict.size === claimedDocument.size
        && currentAfterVerdict.sha256 === claimedDocument.sha256
        && currentAfterVerdict.scanStatus === "quarantined"
        && currentAfterVerdict.scanProvider === RESCAN_CLAIM_PROVIDER
        && currentAfterVerdict.scannedAt === claimedDocument.scannedAt
        && currentAfterVerdict.deletedAt === null
      );
      if (!stillOwnsExactClaim) {
        // A stale malicious result is security-authoritative for these exact
        // bytes. Fence a newer clean state before attempting any richer stale
        // lineage mutation, which would predictably conflict first and leave a
        // needless readability window.
        if (await reconcileCorrelatedMaliciousRescan(db, correlatedMaliciousRescan)) {
          return apiError("malware_detected", "The document was rejected by the security scanner.", { status: 422, requestId: auth.requestId, headers: auth.headers });
        }
        throw new ScanPromotionConflict();
      }
    }

    if (scan.status === "unavailable") {
      const { workspaceEvent, agreementEvent } = await prepareRescanEvidence(db, {
        ...evidenceBase,
        verdict: "unavailable",
        effect: "Document remains quarantined; no return was made reviewable and no ingress evidence was overwritten.",
      });
      const documentGuardId = crypto.randomUUID();
      const parentGuardId = parentAgreement ? crypto.randomUUID() : null;
      const roundGuardId = linkedRound ? crypto.randomUUID() : null;
      const submissionGuardId = linkedSubmission ? crypto.randomUUID() : null;
      const comparisonGuardId = linkedComparison ? crypto.randomUUID() : null;
      const guardIds = [documentGuardId, parentGuardId, roundGuardId, submissionGuardId, comparisonGuardId].filter((id): id is string => Boolean(id));
      const statements: Parameters<typeof db.batch>[0] = [
        db.update(documents).set({
          version: claimedDocument.version + 1,
          scanStatus: "quarantined",
          scanProvider: scan.provider,
          scannedAt: latestScanAt,
        }).where(and(
          eq(documents.workspaceId, auth.context.workspace.id),
          eq(documents.id, document.id),
          eq(documents.version, claimedDocument.version),
          eq(documents.objectKey, document.objectKey),
          eq(documents.size, bytes.byteLength),
          eq(documents.sha256, actualSha256),
          eq(documents.scanStatus, "quarantined"),
          eq(documents.scanProvider, RESCAN_CLAIM_PROVIDER),
          claimedDocument.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, claimedDocument.scannedAt),
          isNull(documents.deletedAt),
        )),
        db.insert(mutationGuards).values({
          id: documentGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.rescan_unavailable",
          guardChanges: sql<number>`changes()`,
          createdAt: recordedAt,
        }),
        ...(parentAgreement && parentGuardId ? [
          db.update(agreements).set({ updatedAt: sql`${agreements.updatedAt}` }).where(and(
            eq(agreements.workspaceId, auth.context.workspace.id),
            eq(agreements.id, parentAgreement.id),
            eq(agreements.version, parentAgreement.version),
            eq(agreements.nextAction, parentAgreement.nextAction),
            eq(agreements.updatedAt, parentAgreement.updatedAt),
            eq(agreements.legalHold, parentAgreement.legalHold),
            isNull(agreements.deletedAt),
          )),
          db.insert(mutationGuards).values({
            id: parentGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "document.rescan_unavailable.parent",
            guardChanges: sql<number>`changes()`,
            createdAt: recordedAt,
          }),
        ] : []),
        ...(linkedRound && roundGuardId ? [
          db.update(negotiationRounds).set({ updatedAt: sql`${negotiationRounds.updatedAt}` }).where(and(
            eq(negotiationRounds.workspaceId, auth.context.workspace.id),
            eq(negotiationRounds.agreementId, linkedRound.agreementId),
            eq(negotiationRounds.id, linkedRound.id),
            eq(negotiationRounds.status, linkedRound.status),
            eq(negotiationRounds.updatedAt, linkedRound.updatedAt),
            ...(linkedRound.activeKey ? [eq(negotiationRounds.activeKey, linkedRound.activeKey)] : [isNull(negotiationRounds.activeKey)]),
          )),
          db.insert(mutationGuards).values({
            id: roundGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "document.rescan_unavailable.round",
            guardChanges: sql<number>`changes()`,
            createdAt: recordedAt,
          }),
        ] : []),
        ...(linkedSubmission && submissionGuardId ? [
          db.update(negotiationSubmissions).set({ status: sql`${negotiationSubmissions.status}` }).where(and(
            eq(negotiationSubmissions.workspaceId, auth.context.workspace.id),
            eq(negotiationSubmissions.id, linkedSubmission.id),
            eq(negotiationSubmissions.roundId, linkedSubmission.roundId),
            eq(negotiationSubmissions.documentId, document.id),
            eq(negotiationSubmissions.documentSha256, actualSha256),
            eq(negotiationSubmissions.status, "quarantined"),
          )),
          db.insert(mutationGuards).values({
            id: submissionGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "document.rescan_unavailable.submission",
            guardChanges: sql<number>`changes()`,
            createdAt: recordedAt,
          }),
        ] : []),
        ...(linkedComparison && comparisonGuardId ? [
          db.update(documentComparisons).set({ updatedAt: sql`${documentComparisons.updatedAt}` }).where(and(
            eq(documentComparisons.workspaceId, auth.context.workspace.id),
            eq(documentComparisons.id, linkedComparison.id),
            eq(documentComparisons.submissionId, linkedComparison.submissionId),
            eq(documentComparisons.status, linkedComparison.status),
            eq(documentComparisons.updatedAt, linkedComparison.updatedAt),
            eq(documentComparisons.proposedSha256, actualSha256),
          )),
          db.insert(mutationGuards).values({
            id: comparisonGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "document.rescan_unavailable.comparison",
            guardChanges: sql<number>`changes()`,
            createdAt: recordedAt,
          }),
        ] : []),
        db.insert(workspaceEvents).values(workspaceEvent),
        ...(agreementEvent ? [db.insert(agreementEvents).values(agreementEvent)] : []),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          inArray(mutationGuards.id, guardIds),
        )),
      ];
      await db.batch(statements);
      return apiError("scanner_unavailable", "The document scanner is unavailable. The document remains quarantined.", { status: 503, requestId: auth.requestId });
    }
    if (scan.status === "malicious") {
      const now = new Date().toISOString();
      const effectiveLegalHold = document.legalHold || Boolean(parentAgreement?.legalHold);
      const cleanupJobId = crypto.randomUUID();
      const rejectionNote = "A fresh security scan classified the immutable returned file as malicious; it cannot be reviewed or promoted.";
      const { workspaceEvent, agreementEvent } = await prepareRescanEvidence(db, {
        ...evidenceBase,
        verdict: "malicious",
        effect: effectiveLegalHold
          ? "Document and linked negotiation evidence rejected; inaccessible bytes retained because legal hold overrides deletion."
          : "Document and linked negotiation evidence rejected; object deletion queued in the durable storage-cleanup ledger.",
      });
      const guardId = crypto.randomUUID();
      const parentGuardId = parentAgreement ? crypto.randomUUID() : null;
      const roundGuardId = linkedRound ? crypto.randomUUID() : null;
      const submissionGuardId = linkedSubmission ? crypto.randomUUID() : null;
      const comparisonGuardId = linkedComparison ? crypto.randomUUID() : null;
      const roundIsCurrentAndActive = Boolean(
        linkedRound
        && linkedRound.activeKey
        && latestRoundId === linkedRound.id
        && ACTIVE_RESCAN_ROUND_STATUSES.includes(linkedRound.status as (typeof ACTIVE_RESCAN_ROUND_STATUSES)[number]),
      );
      const roundAction = linkedRound && roundIsCurrentAndActive
        ? deriveNegotiationRoundAction({
          roundNumber: linkedRound.roundNumber,
          currentStatus: linkedRound.status,
          submissionStatuses: linkedSubmissionStates.map((item) => item.id === linkedSubmission?.id ? "rejected" : item.status),
        })
        : null;
      const nextRoundUpdatedAt = linkedRound
        ? new Date(Math.max(Date.now(), Date.parse(linkedRound.updatedAt) + 1)).toISOString()
        : null;
      const guardIds = [guardId, parentGuardId, roundGuardId, submissionGuardId, comparisonGuardId].filter((id): id is string => Boolean(id));
      const [updated] = await db.batch([
        db.update(documents).set({ scanStatus: "rejected", scanProvider: scan.provider, scannedAt: latestScanAt, legalHold: effectiveLegalHold, deletedAt: now, version: claimedDocument.version + 1 }).where(and(
          eq(documents.workspaceId, auth.context.workspace.id),
          eq(documents.id, document.id),
          eq(documents.version, claimedDocument.version),
          eq(documents.objectKey, document.objectKey),
          eq(documents.size, bytes.byteLength),
          eq(documents.sha256, actualSha256),
          eq(documents.scanStatus, "quarantined"),
          eq(documents.scanProvider, RESCAN_CLAIM_PROVIDER),
          claimedDocument.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, claimedDocument.scannedAt),
          isNull(documents.deletedAt),
        )),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.reject_malicious",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        ...(parentAgreement && parentGuardId ? [
          db.update(agreements).set(roundAction ? {
            nextAction: roundAction.nextAction,
            updated: now,
            updatedAt: now,
            updatedByUserId: auth.context.user.id,
          } : { updatedAt: sql`${agreements.updatedAt}` }).where(and(
            eq(agreements.workspaceId, auth.context.workspace.id),
            eq(agreements.id, parentAgreement.id),
            eq(agreements.version, parentAgreement.version),
            eq(agreements.nextAction, parentAgreement.nextAction),
            eq(agreements.updatedAt, parentAgreement.updatedAt),
            eq(agreements.legalHold, parentAgreement.legalHold),
            isNull(agreements.deletedAt),
          )),
          db.insert(mutationGuards).values({
            id: parentGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "document.reject_malicious.parent_policy",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
        ] : []),
        ...(linkedRound && roundGuardId ? [
          db.update(negotiationRounds).set(roundAction ? {
            status: roundAction.roundStatus,
            updatedAt: nextRoundUpdatedAt!,
          } : { updatedAt: sql`${negotiationRounds.updatedAt}` }).where(and(
            eq(negotiationRounds.workspaceId, auth.context.workspace.id),
            eq(negotiationRounds.agreementId, linkedRound.agreementId),
            eq(negotiationRounds.id, linkedRound.id),
            eq(negotiationRounds.status, linkedRound.status),
            eq(negotiationRounds.updatedAt, linkedRound.updatedAt),
            ...(linkedRound.activeKey ? [eq(negotiationRounds.activeKey, linkedRound.activeKey)] : [isNull(negotiationRounds.activeKey)]),
            ...(roundAction ? [notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
              eq(negotiationRounds.workspaceId, auth.context.workspace.id),
              eq(negotiationRounds.agreementId, linkedRound.agreementId),
              gt(negotiationRounds.roundNumber, linkedRound.roundNumber),
            )))] : []),
          )),
          db.insert(mutationGuards).values({
            id: roundGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "negotiation.rescan_reject.round",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
        ] : []),
        ...(linkedSubmission && submissionGuardId ? [
          db.update(negotiationSubmissions).set({
            status: "rejected",
            decisionNote: rejectionNote,
          }).where(and(
            eq(negotiationSubmissions.workspaceId, auth.context.workspace.id),
            eq(negotiationSubmissions.id, linkedSubmission.id),
            eq(negotiationSubmissions.roundId, linkedSubmission.roundId),
            eq(negotiationSubmissions.documentId, document.id),
            eq(negotiationSubmissions.documentSha256, actualSha256),
            eq(negotiationSubmissions.status, "quarantined"),
          )),
          db.insert(mutationGuards).values({
            id: submissionGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "negotiation.rescan_reject",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
        ] : []),
        ...(linkedComparison && comparisonGuardId ? [
          db.update(documentComparisons).set({
            status: "rejected",
            decisionNote: rejectionNote,
            decidedByUserId: auth.context.user.id,
            decidedAt: now,
            updatedAt: now,
          }).where(and(
            eq(documentComparisons.workspaceId, auth.context.workspace.id),
            eq(documentComparisons.id, linkedComparison.id),
            eq(documentComparisons.submissionId, linkedComparison.submissionId),
            eq(documentComparisons.status, linkedComparison.status),
            eq(documentComparisons.updatedAt, linkedComparison.updatedAt),
            eq(documentComparisons.proposedSha256, actualSha256),
          )),
          db.insert(mutationGuards).values({
            id: comparisonGuardId,
            workspaceId: auth.context.workspace.id,
            operation: "negotiation.rescan_reject.comparison",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
        ] : []),
        ...(!effectiveLegalHold ? [db.insert(purgeJobs).values({
          id: cleanupJobId,
          workspaceId: auth.context.workspace.id,
          resourceType: "document",
          resourceId: `rejected:${document.id}:${cleanupJobId}`,
          objectKeys: [document.objectKey],
          status: "storage_pending",
          guardChanges: 1,
          attempts: 0,
          lastError: null,
          lastAttemptAt: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        })] : []),
        db.insert(workspaceEvents).values(workspaceEvent),
        ...(agreementEvent ? [db.insert(agreementEvents).values(agreementEvent)] : []),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          inArray(mutationGuards.id, guardIds),
        )),
      ]);
      if (!updated.meta.changes) throw new ScanPromotionConflict();
      return apiError("malware_detected", "The document was rejected by the security scanner.", { status: 422, requestId: auth.requestId });
    }

    const readable = await readDocumentText(bytes, inspected, getNoticeConfig().mode, undefined, scannerConfiguration.ocr);
    const analysis = extractDocumentMetadata(readable.text.slice(0, 400_000), document.fileName);
    const ingressEvidence = Object.fromEntries(
      Object.entries(document.extracted).filter(([key]) => key.startsWith("ingress.")),
    );
    const initialScanEvidence = {
      "ingress.security.initialStatus": ingressEvidence["ingress.security.initialStatus"] ?? document.scanStatus,
      "ingress.security.initialProvider": ingressEvidence["ingress.security.initialProvider"] ?? document.scanProvider ?? "unrecorded",
      "ingress.security.initialScannedAt": ingressEvidence["ingress.security.initialScannedAt"] ?? document.scannedAt ?? "unrecorded",
    };
    const promotedExtracted = { ...analysis.extracted, ...initialScanEvidence, ...ingressEvidence };
    // The verified bytes are already stored under their immutable object key,
    // and D1 is the read-authority for scan state. Never rewrite those bytes
    // after an external verdict: a stale clean worker could otherwise recreate
    // an object after a newer malicious cleanup job had deleted it.
    const { workspaceEvent, agreementEvent } = await prepareRescanEvidence(db, {
      ...evidenceBase,
      verdict: "clean",
      effect: linkedSubmission
        ? "Scanner quarantine released; exact negotiation submission remains quarantined and direct download stays blocked until authenticated staff verification marks it ready."
        : "Scanner quarantine released; document became readable under its existing agreement and retention lineage.",
    });
    const guardId = crypto.randomUUID();
    const parentGuardId = parentAgreement ? crypto.randomUUID() : null;
    const roundGuardId = linkedRound ? crypto.randomUUID() : null;
    const submissionGuardId = linkedSubmission ? crypto.randomUUID() : null;
    const comparisonGuardId = linkedComparison ? crypto.randomUUID() : null;
    const guardIds = [guardId, parentGuardId, roundGuardId, submissionGuardId, comparisonGuardId].filter((id): id is string => Boolean(id));
    const [updated] = await db.batch([db.update(documents).set({
        tags: analysis.tags,
        extracted: promotedExtracted,
        extractionMode: readable.mode,
        scanStatus: "clean",
        scanProvider: scan.provider,
        scannedAt: latestScanAt,
        version: claimedDocument.version + 1,
      }).where(and(
        eq(documents.workspaceId, auth.context.workspace.id),
        eq(documents.id, document.id),
        eq(documents.version, claimedDocument.version),
        eq(documents.objectKey, document.objectKey),
        eq(documents.size, bytes.byteLength),
        eq(documents.sha256, actualSha256),
        eq(documents.scanStatus, "quarantined"),
        eq(documents.scanProvider, RESCAN_CLAIM_PROVIDER),
        claimedDocument.scannedAt === null ? isNull(documents.scannedAt) : eq(documents.scannedAt, claimedDocument.scannedAt),
        isNull(documents.deletedAt),
      )),
      db.insert(mutationGuards).values({
        id: guardId,
        workspaceId: auth.context.workspace.id,
        operation: "document.promote_clean",
        guardChanges: sql<number>`changes()`,
        createdAt: recordedAt,
      }),
      ...(parentAgreement && parentGuardId ? [
        db.update(agreements).set({ updatedAt: sql`${agreements.updatedAt}` }).where(and(
          eq(agreements.workspaceId, auth.context.workspace.id),
          eq(agreements.id, parentAgreement.id),
          eq(agreements.version, parentAgreement.version),
          eq(agreements.nextAction, parentAgreement.nextAction),
          eq(agreements.updatedAt, parentAgreement.updatedAt),
          eq(agreements.legalHold, parentAgreement.legalHold),
          isNull(agreements.deletedAt),
        )),
        db.insert(mutationGuards).values({
          id: parentGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.promote_clean.parent",
          guardChanges: sql<number>`changes()`,
          createdAt: recordedAt,
        }),
      ] : []),
      ...(linkedRound && roundGuardId ? [
        db.update(negotiationRounds).set({ updatedAt: sql`${negotiationRounds.updatedAt}` }).where(and(
          eq(negotiationRounds.workspaceId, auth.context.workspace.id),
          eq(negotiationRounds.agreementId, linkedRound.agreementId),
          eq(negotiationRounds.id, linkedRound.id),
          eq(negotiationRounds.status, linkedRound.status),
          eq(negotiationRounds.updatedAt, linkedRound.updatedAt),
          ...(linkedRound.activeKey ? [eq(negotiationRounds.activeKey, linkedRound.activeKey)] : [isNull(negotiationRounds.activeKey)]),
        )),
        db.insert(mutationGuards).values({
          id: roundGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.promote_clean.round",
          guardChanges: sql<number>`changes()`,
          createdAt: recordedAt,
        }),
      ] : []),
      ...(linkedSubmission && submissionGuardId ? [
        db.update(negotiationSubmissions).set({ status: sql`${negotiationSubmissions.status}` }).where(and(
          eq(negotiationSubmissions.workspaceId, auth.context.workspace.id),
          eq(negotiationSubmissions.id, linkedSubmission.id),
          eq(negotiationSubmissions.roundId, linkedSubmission.roundId),
          eq(negotiationSubmissions.documentId, document.id),
          eq(negotiationSubmissions.documentSha256, actualSha256),
          eq(negotiationSubmissions.status, "quarantined"),
        )),
        db.insert(mutationGuards).values({
          id: submissionGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.promote_clean.submission",
          guardChanges: sql<number>`changes()`,
          createdAt: recordedAt,
        }),
      ] : []),
      ...(linkedComparison && comparisonGuardId ? [
        db.update(documentComparisons).set({ updatedAt: sql`${documentComparisons.updatedAt}` }).where(and(
          eq(documentComparisons.workspaceId, auth.context.workspace.id),
          eq(documentComparisons.id, linkedComparison.id),
          eq(documentComparisons.submissionId, linkedComparison.submissionId),
          eq(documentComparisons.status, linkedComparison.status),
          eq(documentComparisons.updatedAt, linkedComparison.updatedAt),
          eq(documentComparisons.proposedSha256, actualSha256),
        )),
        db.insert(mutationGuards).values({
          id: comparisonGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "document.promote_clean.comparison",
          guardChanges: sql<number>`changes()`,
          createdAt: recordedAt,
        }),
      ] : []),
      db.insert(workspaceEvents).values(workspaceEvent),
      ...(agreementEvent ? [db.insert(agreementEvents).values(agreementEvent)] : []),
      db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, auth.context.workspace.id),
        inArray(mutationGuards.id, guardIds),
    ))]);
    if (!updated.meta.changes) throw new ScanPromotionConflict();
    return apiJson({ document: { id: document.id, scanStatus: "clean", extractionMode: readable.mode, tags: analysis.tags, riskFlags: analysis.riskFlags, extracted: promotedExtracted }, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    if (correlatedMaliciousRescan) {
      try {
        if (await reconcileCorrelatedMaliciousRescan(getDb(), correlatedMaliciousRescan)) {
          return apiError("malware_detected", "The document was rejected by the security scanner.", { status: 422, requestId: auth.requestId, headers: auth.headers });
        }
      } catch {
        // Preserve a fail-closed response below. The durable claim remains
        // quarantined and unreadable for operator or stale-claim recovery.
      }
      return apiError(
        "malware_rejection_recording_unavailable",
        "The scanner returned a correlated malicious verdict, but Notice could not finish recording rejection. The exact source remains quarantined and unreadable and requires operator reconciliation.",
        { status: 503, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (correlatedCleanRescan) {
      try {
        const [current] = await getDb().select().from(documents).where(and(
          eq(documents.workspaceId, auth.context.workspace.id),
          eq(documents.id, correlatedCleanRescan.documentId),
        )).limit(1);
        if (
          current
          && current.objectKey === correlatedCleanRescan.objectKey
          && current.sha256 === correlatedCleanRescan.sha256
          && (current.scanStatus === "rejected" || current.scanStatus === "malicious")
        ) {
          return apiError("malware_detected", "The document was rejected by a concurrent security scan.", { status: 422, requestId: auth.requestId, headers: auth.headers });
        }
        if (
          current
          && current.objectKey === correlatedCleanRescan.objectKey
          && current.sha256 === correlatedCleanRescan.sha256
          && current.scanStatus === "clean"
          && current.deletedAt === null
        ) {
          return apiJson({
            document: {
              id: current.id,
              scanStatus: current.scanStatus,
              extractionMode: current.extractionMode,
              tags: current.tags,
              riskFlags: [],
              extracted: current.extracted,
            },
            reconciled: true,
            requestId: auth.requestId,
          }, { requestId: auth.requestId, headers: auth.headers });
        }
      } catch {
        // Preserve the fail-closed error mapping below when readback is unavailable.
      }
    }
    if (error instanceof RescanClaimConflict) {
      return apiError("rescan_in_progress", "The document changed before this worker could acquire its security-rescan claim. Reload before retrying.", { status: 409, requestId: auth.requestId, headers: auth.headers });
    }
    if (error instanceof ScanPromotionConflict || isMutationGuardConflict(error) || isOptimisticConcurrencyConflict(error)) {
      try {
        const [current] = await getDb().select().from(documents).where(and(
          eq(documents.workspaceId, auth.context.workspace.id),
          eq(documents.id, requestedRescanDocumentId ?? ""),
        )).limit(1);
        if (current?.scanStatus === "rejected" || current?.scanStatus === "malicious") {
          return apiError("malware_detected", "The document was rejected by a concurrent security scan.", { status: 422, requestId: auth.requestId, headers: auth.headers });
        }
      } catch {
        // Preserve the ordinary fail-closed concurrency response.
      }
      return apiError("version_conflict", "The document changed while its security scan was applied. Reload before retrying.", { status: 409, requestId: auth.requestId });
    }
    return handleRouteError(error, auth.requestId, "Document scan could not be completed.");
  }
}

class ScanPromotionConflict extends Error {}

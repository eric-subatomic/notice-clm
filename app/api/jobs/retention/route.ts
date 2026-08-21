import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import {
  agreementDocumentVersions,
  agreementEvents,
  agreements,
  agreementVersions,
  approvalRequests,
  crmLegacyCleanupAttestations,
  customFieldValues,
  documentComparisons,
  documents,
  ingestionBatches,
  ingestionItems,
  intakeSubmissions,
  mutationGuards,
  negotiationRounds,
  negotiationSubmissions,
  obligationCreationReceipts,
  obligationEvidence,
  obligationSchedules,
  obligations,
  outboxDeliveries,
  outboxEvents,
  purgeJobs,
  signaturePackets,
  webhookReceipts,
  workspaceEvents,
} from "../../../../db/schema";
import { handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import { apiError, apiJson, checkBestEffortRateLimit, createRequestId, rateLimitExceeded } from "../../../lib/http";
import { prepareAgreementDeletedIntegrationEvent, prepareIntegrationOutboxEvent } from "../../../lib/integration-events";
import {
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
  prepareWorkspaceEvent,
} from "../../../lib/persistence";
import { getJobRunnerSecret } from "../../../lib/providers";
import {
  attemptPurgeStorage,
  type PurgeStorageJob,
} from "../../../lib/purge-storage";
import {
  assessRejectedObjectCleanupPolicy,
  claimRejectedObjectCleanup,
} from "../../../lib/rejected-object-cleanup";
import { evaluateDeletionDeliveryGate, unresolvedCrmDeliveryProfiles } from "../../../lib/retention-delivery-policy";
import {
  constantTimeSecretEqual,
  isHardPurgeEligible,
  isTerminalAgreementStage,
  isWorkspaceObjectKey,
  resolvePurgeGraceDays,
  retentionHasExpired,
} from "../../../lib/records-governance";

type RetentionEnv = {
  DOCUMENTS: R2Bucket;
  NOTICE_RETENTION_PURGE_GRACE_DAYS?: string;
};
type Database = ReturnType<typeof getDb>;

const BATCH_SIZE = 25;
const CRM_PROJECTION_TOPICS = [
  "agreement.created",
  "agreement.updated",
  "agreement.stage_changed",
  "signature.completed",
  "agreement.deleted",
] as const;
const ACTIVE_SIGNATURE_PACKET_STATUSES = [
  "creating",
  "pending",
  "partially_signed",
  "reconciling",
  "archived",
] as const;
const SYSTEM_ACTOR = Object.freeze({
  userId: "system:retention",
  email: "retention-job@notice.invalid",
  displayName: "Notice retention job",
});

type JobFailure = { resourceType: "agreement" | "document"; resourceId: string; phase: "soft-delete" | "hard-purge" | "storage-delete" };
type BlockedPurge = { resourceType: "agreement" | "document"; resourceId: string; reason: string };

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    const expected = getJobRunnerSecret();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!constantTimeSecretEqual(expected, supplied)) {
      return apiError("authentication_required", "Job runner authentication failed.", { status: 401, requestId });
    }
    const rate = checkBestEffortRateLimit("job:retention", { limit: 12, windowMs: 60_000 });
    if (!rate.allowed) return rateLimitExceeded(rate, requestId);

    const dryRunValue = new URL(request.url).searchParams.get("dryRun");
    if (dryRunValue && !new Set(["1", "true", "0", "false"]).has(dryRunValue)) {
      return apiError("dry_run_invalid", "dryRun must be true or false.", { status: 400, requestId });
    }
    const dryRun = dryRunValue === "1" || dryRunValue === "true";
    const bindings = env as unknown as RetentionEnv;
    const graceDays = resolvePurgeGraceDays(bindings.NOTICE_RETENTION_PURGE_GRACE_DAYS);
    const config = getNoticeConfig();
    const workspaceId = config.workspace.id;
    const now = new Date();
    const nowIso = now.toISOString();
    const purgeCutoff = new Date(now.getTime() - graceDays * 86_400_000);
    const purgeCutoffIso = purgeCutoff.toISOString();
    await ensureStorageSchema();
    const db = getDb();

    const softDeleted = { agreementIds: [] as number[], documentIds: [] as string[] };
    const hardPurged = { agreementIds: [] as number[], documentIds: [] as string[] };
    const d1Purged = { agreementIds: [] as number[], documentIds: [] as string[] };
    const lifecyclePurged = { intakeSubmissionIds: [] as string[], ingestionBatchIds: [] as string[] };
    const purgeStorage = {
      retriedJobIds: [] as string[],
      completedJobIds: [] as string[],
      pendingJobIds: [] as string[],
    };
    const blocked: BlockedPurge[] = [];
    const failures: JobFailure[] = [];

    // Rejected intake answers and abandoned/terminal ingestion ledgers use the
    // same customer-configured grace boundary as hard purge. Submitted intake
    // remains an active review item until Legal/Admin converts or rejects it.
    // Live linked document/agreement holds always override ledger cleanup.
    const staleRejectedIntake = await db.select({ id: intakeSubmissions.id }).from(intakeSubmissions).where(and(
      eq(intakeSubmissions.workspaceId, workspaceId),
      eq(intakeSubmissions.status, "rejected"),
      isNull(intakeSubmissions.agreementId),
      lte(intakeSubmissions.updatedAt, purgeCutoffIso),
    )).orderBy(asc(intakeSubmissions.updatedAt), asc(intakeSubmissions.id)).limit(BATCH_SIZE);
    const staleIngestion = await db.select({ id: ingestionBatches.id }).from(ingestionBatches).where(and(
      eq(ingestionBatches.workspaceId, workspaceId),
      lte(ingestionBatches.updatedAt, purgeCutoffIso),
      sql`(
        ${ingestionBatches.status} in ('completed', 'cancelled')
        or (
          ${ingestionBatches.status} = 'awaiting_upload'
          and not exists (
            select 1 from ingestion_items as retained_upload
            where retained_upload.workspace_id = ${workspaceId}
              and retained_upload.batch_id = ${ingestionBatches.id}
              and retained_upload.document_id is not null
          )
        )
      )`,
      sql`not exists (
        select 1
        from ingestion_items as held_ledger_item
        inner join documents as held_ledger_document
          on held_ledger_document.workspace_id = held_ledger_item.workspace_id
         and (held_ledger_document.id = held_ledger_item.document_id
           or held_ledger_document.id = held_ledger_item.duplicate_of_document_id)
        left join agreements as held_ledger_agreement
          on held_ledger_agreement.workspace_id = held_ledger_document.workspace_id
         and held_ledger_agreement.id = held_ledger_document.agreement_id
        where held_ledger_item.workspace_id = ${workspaceId}
          and held_ledger_item.batch_id = ${ingestionBatches.id}
          and (held_ledger_document.legal_hold = 1 or held_ledger_agreement.legal_hold = 1)
      )`,
    )).orderBy(asc(ingestionBatches.updatedAt), asc(ingestionBatches.id)).limit(BATCH_SIZE);
    if (dryRun) {
      lifecyclePurged.intakeSubmissionIds.push(...staleRejectedIntake.map(({ id }) => id));
      lifecyclePurged.ingestionBatchIds.push(...staleIngestion.map(({ id }) => id));
    } else {
      if (staleRejectedIntake.length > 0) {
        await db.delete(intakeSubmissions).where(and(
          eq(intakeSubmissions.workspaceId, workspaceId),
          inArray(intakeSubmissions.id, staleRejectedIntake.map(({ id }) => id)),
          eq(intakeSubmissions.status, "rejected"),
          isNull(intakeSubmissions.agreementId),
          lte(intakeSubmissions.updatedAt, purgeCutoffIso),
        ));
      }
      if (staleIngestion.length > 0) {
        await db.delete(ingestionBatches).where(and(
          eq(ingestionBatches.workspaceId, workspaceId),
          inArray(ingestionBatches.id, staleIngestion.map(({ id }) => id)),
          lte(ingestionBatches.updatedAt, purgeCutoffIso),
          sql`(
            ${ingestionBatches.status} in ('completed', 'cancelled')
            or (
              ${ingestionBatches.status} = 'awaiting_upload'
              and not exists (
                select 1 from ingestion_items as retained_upload
                where retained_upload.workspace_id = ${workspaceId}
                  and retained_upload.batch_id = ${ingestionBatches.id}
                  and retained_upload.document_id is not null
              )
            )
          )`,
          sql`not exists (
            select 1
            from ingestion_items as held_ledger_item
            inner join documents as held_ledger_document
              on held_ledger_document.workspace_id = held_ledger_item.workspace_id
             and (held_ledger_document.id = held_ledger_item.document_id
               or held_ledger_document.id = held_ledger_item.duplicate_of_document_id)
            left join agreements as held_ledger_agreement
              on held_ledger_agreement.workspace_id = held_ledger_document.workspace_id
             and held_ledger_agreement.id = held_ledger_document.agreement_id
            where held_ledger_item.workspace_id = ${workspaceId}
              and held_ledger_item.batch_id = ${ingestionBatches.id}
              and (held_ledger_document.legal_hold = 1 or held_ledger_agreement.legal_hold = 1)
          )`,
        ));
      }
      const [remainingIntake, remainingIngestion] = await Promise.all([
        staleRejectedIntake.length === 0 ? Promise.resolve([]) : db.select({ id: intakeSubmissions.id }).from(intakeSubmissions).where(and(
          eq(intakeSubmissions.workspaceId, workspaceId),
          inArray(intakeSubmissions.id, staleRejectedIntake.map(({ id }) => id)),
        )).limit(staleRejectedIntake.length),
        staleIngestion.length === 0 ? Promise.resolve([]) : db.select({ id: ingestionBatches.id }).from(ingestionBatches).where(and(
          eq(ingestionBatches.workspaceId, workspaceId),
          inArray(ingestionBatches.id, staleIngestion.map(({ id }) => id)),
        )).limit(staleIngestion.length),
      ]);
      const retainedIntakeIds = new Set(remainingIntake.map(({ id }) => id));
      const retainedIngestionIds = new Set(remainingIngestion.map(({ id }) => id));
      lifecyclePurged.intakeSubmissionIds.push(...staleRejectedIntake.map(({ id }) => id).filter((id) => !retainedIntakeIds.has(id)));
      lifecyclePurged.ingestionBatchIds.push(...staleIngestion.map(({ id }) => id).filter((id) => !retainedIngestionIds.has(id)));
    }

    const pendingPurgeJobs = await db.select().from(purgeJobs).where(and(
      eq(purgeJobs.workspaceId, workspaceId),
      eq(purgeJobs.status, "storage_pending"),
    )).orderBy(asc(purgeJobs.createdAt), asc(purgeJobs.id)).limit(BATCH_SIZE);

    for (const job of pendingPurgeJobs) {
      const cleanupPolicy = await assessStorageCleanupPolicy(db, job);
      if (dryRun) {
        purgeStorage.pendingJobIds.push(job.id);
        if (cleanupPolicy.action !== "allow") {
          blocked.push({
            resourceType: job.resourceType,
            resourceId: cleanupPolicy.resourceId,
            reason: cleanupPolicy.reason,
          });
        }
        continue;
      }
      if (cleanupPolicy.action === "cancel") {
        const cancelledAt = new Date().toISOString();
        await db.update(purgeJobs).set({
          status: "completed",
          objectKeys: [],
          lastError: null,
          updatedAt: cancelledAt,
          completedAt: cancelledAt,
        }).where(and(
          eq(purgeJobs.workspaceId, job.workspaceId),
          eq(purgeJobs.id, job.id),
          eq(purgeJobs.status, "storage_pending"),
        ));
        purgeStorage.completedJobIds.push(job.id);
        continue;
      }
      if (cleanupPolicy.action === "defer") {
        purgeStorage.pendingJobIds.push(job.id);
        blocked.push({
          resourceType: job.resourceType,
          resourceId: cleanupPolicy.resourceId,
          reason: cleanupPolicy.reason,
        });
        continue;
      }
      if (/^rejected:[^:]+:[^:]+$/.test(job.resourceId)) {
        const claimed = await claimRejectedObjectCleanup(db, job);
        if (!claimed) {
          const refreshedPolicy = await assessStorageCleanupPolicy(db, job);
          purgeStorage.pendingJobIds.push(job.id);
          blocked.push({
            resourceType: job.resourceType,
            resourceId: refreshedPolicy.resourceId,
            reason: refreshedPolicy.action === "allow"
              ? "rejected-object cleanup is already claimed by another worker"
              : refreshedPolicy.reason,
          });
          continue;
        }
      }
      purgeStorage.retriedJobIds.push(job.id);
      try {
        const result = await runPurgeStorageJob(db, bindings.DOCUMENTS, job);
        if (result.status === "completed") purgeStorage.completedJobIds.push(job.id);
        else {
          purgeStorage.pendingJobIds.push(job.id);
          failures.push({ resourceType: job.resourceType, resourceId: job.resourceId, phase: "storage-delete" });
        }
      } catch {
        purgeStorage.pendingJobIds.push(job.id);
        failures.push({ resourceType: job.resourceType, resourceId: job.resourceId, phase: "storage-delete" });
      }
    }

    const softAgreementCandidates = await db.select().from(agreements).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.legalHold, false),
      eq(agreements.stage, "Active"),
      isNotNull(agreements.retentionUntil),
      lte(agreements.retentionUntil, nowIso),
      isNull(agreements.deletedAt),
    )).orderBy(asc(agreements.retentionUntil), asc(agreements.id)).limit(BATCH_SIZE);

    for (const agreement of softAgreementCandidates) {
      if (!retentionHasExpired(agreement.retentionUntil, now) || !isTerminalAgreementStage(agreement.stage)) continue;
      if (dryRun) {
        softDeleted.agreementIds.push(agreement.id);
        continue;
      }
      try {
        const agreementPatch = {
          deletedAt: nowIso,
          version: agreement.version + 1,
          updated: nowIso,
          updatedAt: nowIso,
          updatedByUserId: SYSTEM_ACTOR.userId,
        };
        const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
        const event = await prepareAgreementEvent(db, {
          workspaceId,
          agreementId: agreement.id,
          type: "Retention",
          detail: `Retention boundary reached; agreement entered the ${graceDays}-day deletion grace period.`,
          actor: SYSTEM_ACTOR,
          createdAt: nowIso,
        });
        const snapshot = await prepareAgreementSnapshot(saved, SYSTEM_ACTOR.userId, event.id);
        const outbox = prepareOutboxEvent(prepareAgreementDeletedIntegrationEvent({
          agreement: saved,
          deletedAt: nowIso,
          causationId: requestId,
        }));
        const guardId = crypto.randomUUID();
        const [result] = await db.batch([
          db.update(agreements).set(agreementPatch).where(and(
            eq(agreements.workspaceId, workspaceId),
            eq(agreements.id, agreement.id),
            eq(agreements.version, agreement.version),
            eq(agreements.nextAction, agreement.nextAction),
            eq(agreements.legalHold, false),
            isNull(agreements.deletedAt),
          )),
          db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "retention.soft_delete.agreement", guardChanges: sql<number>`changes()`, createdAt: nowIso }),
          db.insert(agreementEvents).values(event),
          db.insert(agreementVersions).values(snapshot),
          db.insert(outboxEvents).values(outbox),
          db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
        ]);
        if (!result.meta.changes) continue;
        softDeleted.agreementIds.push(agreement.id);
      } catch {
        failures.push({ resourceType: "agreement", resourceId: String(agreement.id), phase: "soft-delete" });
      }
    }

    const softDocumentCandidates = await db.select().from(documents).where(and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.legalHold, false),
      isNotNull(documents.retentionUntil),
      lte(documents.retentionUntil, nowIso),
      isNull(documents.deletedAt),
      or(
        isNull(documents.agreementId),
        sql`exists (
          select 1 from agreements as retention_parent
          where retention_parent.workspace_id = ${workspaceId}
            and retention_parent.id = ${documents.agreementId}
            and retention_parent.legal_hold = 0
            and (retention_parent.stage = 'Active' or retention_parent.deleted_at is not null)
        )`,
      ),
    )).orderBy(asc(documents.retentionUntil), asc(documents.createdAt)).limit(BATCH_SIZE);

    for (const document of softDocumentCandidates) {
      if (!retentionHasExpired(document.retentionUntil, now)) continue;
      let parent: typeof agreements.$inferSelect | null = null;
      if (document.agreementId) {
        const parentRows = await db.select().from(agreements).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, document.agreementId),
        )).limit(1);
        parent = parentRows[0] ?? null;
        if (!parent) {
          blocked.push({ resourceType: "document", resourceId: document.id, reason: "linked agreement is unavailable" });
          continue;
        }
        if (parent.legalHold) {
          blocked.push({ resourceType: "document", resourceId: document.id, reason: "agreement legal hold is active" });
          continue;
        }
        if (!parent.deletedAt && !isTerminalAgreementStage(parent.stage)) {
          blocked.push({ resourceType: "document", resourceId: document.id, reason: "linked agreement is not in a terminal stage" });
          continue;
        }
      }
      if (dryRun) {
        softDeleted.documentIds.push(document.id);
        continue;
      }
      try {
        const documentWrite = db.update(documents).set({
          deletedAt: nowIso,
          version: document.version + 1,
        }).where(and(
          eq(documents.workspaceId, workspaceId),
          eq(documents.id, document.id),
          eq(documents.version, document.version),
          eq(documents.legalHold, false),
          isNull(documents.deletedAt),
        ));
        const guardId = crypto.randomUUID();
        if (document.agreementId) {
          const event = await prepareAgreementEvent(db, {
            workspaceId,
            agreementId: document.agreementId,
            type: "Retention",
            detail: `Document ${document.fileName} entered the ${graceDays}-day deletion grace period.`,
            actor: SYSTEM_ACTOR,
            createdAt: nowIso,
          });
          const [result] = await db.batch([
            documentWrite,
            db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "retention.soft_delete.document", guardChanges: sql<number>`changes()`, createdAt: nowIso }),
            db.insert(agreementEvents).values(event),
            db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
          ]);
          if (!result.meta.changes) continue;
        } else {
          const event = await prepareWorkspaceEvent(db, {
            workspaceId,
            type: "Retention",
            detail: `Standalone document ${document.fileName} entered the ${graceDays}-day deletion grace period.`,
            actor: SYSTEM_ACTOR,
            createdAt: nowIso,
          });
          const [result] = await db.batch([
            documentWrite,
            db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "retention.soft_delete.document", guardChanges: sql<number>`changes()`, createdAt: nowIso }),
            db.insert(workspaceEvents).values(event),
            db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
          ]);
          if (!result.meta.changes) continue;
        }
        softDeleted.documentIds.push(document.id);
      } catch {
        failures.push({ resourceType: "document", resourceId: document.id, phase: "soft-delete" });
      }
    }

    const hardAgreementCandidates = await db.select().from(agreements).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.legalHold, false),
      isNotNull(agreements.retentionUntil),
      lte(agreements.retentionUntil, nowIso),
      isNotNull(agreements.deletedAt),
      lte(agreements.deletedAt, purgeCutoffIso),
      sql`not exists (
        select 1 from documents as retention_child
        where retention_child.workspace_id = ${workspaceId}
          and retention_child.agreement_id = ${agreements.id}
          and (
            retention_child.legal_hold = 1
            or retention_child.retention_until is null
            or retention_child.retention_until > ${nowIso}
            or retention_child.deleted_at is null
            or retention_child.deleted_at > ${purgeCutoffIso}
          )
      )`,
    )).orderBy(asc(agreements.deletedAt), asc(agreements.id)).limit(BATCH_SIZE);

    for (const agreement of hardAgreementCandidates) {
      if (!isHardPurgeEligible(agreement, now, purgeCutoff)) continue;
      const [
        linkedDocuments,
        documentVersions,
        rounds,
        submissions,
        comparisons,
        inboundReceiptRows,
        signatureReceiptRows,
        activeSignatureRows,
        obligationScheduleRows,
        obligationOccurrenceRows,
        obligationEvidenceRows,
        obligationCreationReceiptRows,
      ] = await Promise.all([
        db.select().from(documents).where(and(
          eq(documents.workspaceId, workspaceId),
          eq(documents.agreementId, agreement.id),
        )),
        db.select().from(agreementDocumentVersions).where(and(
          eq(agreementDocumentVersions.workspaceId, workspaceId),
          eq(agreementDocumentVersions.agreementId, agreement.id),
        )),
        db.select().from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, workspaceId),
          eq(negotiationRounds.agreementId, agreement.id),
        )),
        db.select().from(negotiationSubmissions).where(and(
          eq(negotiationSubmissions.workspaceId, workspaceId),
          eq(negotiationSubmissions.agreementId, agreement.id),
        )),
        db.select().from(documentComparisons).where(and(
          eq(documentComparisons.workspaceId, workspaceId),
          eq(documentComparisons.agreementId, agreement.id),
        )),
        db.select({ id: webhookReceipts.id }).from(webhookReceipts).where(and(
          eq(webhookReceipts.workspaceId, workspaceId),
          eq(webhookReceipts.aggregateType, "negotiation_round"),
          sql`${webhookReceipts.aggregateId} in (
            select purge_receipt_round.id from negotiation_rounds as purge_receipt_round
            where purge_receipt_round.workspace_id = ${workspaceId}
              and purge_receipt_round.agreement_id = ${agreement.id}
          )`,
        )),
        db.select({ id: webhookReceipts.id }).from(webhookReceipts).where(and(
          eq(webhookReceipts.workspaceId, workspaceId),
          eq(webhookReceipts.aggregateType, "signature_packet"),
          sql`${webhookReceipts.aggregateId} in (
            select purge_receipt_packet.id from signature_packets as purge_receipt_packet
            where purge_receipt_packet.workspace_id = ${workspaceId}
              and purge_receipt_packet.agreement_id = ${agreement.id}
          )`,
        )),
        db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
          eq(signaturePackets.workspaceId, workspaceId),
          eq(signaturePackets.agreementId, agreement.id),
          inArray(signaturePackets.status, [...ACTIVE_SIGNATURE_PACKET_STATUSES]),
        )),
        db.select({ id: obligationSchedules.id }).from(obligationSchedules).where(and(
          eq(obligationSchedules.workspaceId, workspaceId),
          eq(obligationSchedules.agreementId, agreement.id),
        )),
        db.select({ id: obligations.id }).from(obligations).where(and(
          eq(obligations.workspaceId, workspaceId),
          eq(obligations.agreementId, agreement.id),
        )),
        db.select({ id: obligationEvidence.id }).from(obligationEvidence).where(and(
          eq(obligationEvidence.workspaceId, workspaceId),
          eq(obligationEvidence.agreementId, agreement.id),
        )),
        db.select({ scheduleId: obligationCreationReceipts.scheduleId }).from(obligationCreationReceipts).where(and(
          eq(obligationCreationReceipts.workspaceId, workspaceId),
          eq(obligationCreationReceipts.agreementId, agreement.id),
        )),
      ]);
      const ineligibleDocument = linkedDocuments.find((document) => !isHardPurgeEligible(document, now, purgeCutoff));
      if (ineligibleDocument) {
        blocked.push({
          resourceType: "agreement",
          resourceId: String(agreement.id),
          reason: ineligibleDocument.legalHold
            ? "a linked document legal hold is active"
            : "a linked document has not completed its retention grace period",
        });
        continue;
      }
      if (activeSignatureRows.length) {
        blocked.push({
          resourceType: "agreement",
          resourceId: String(agreement.id),
          reason: "an active signature packet still retains live signing authority",
        });
        continue;
      }
      const objectKeys = Array.from(new Set([
        ...linkedDocuments.map((document) => document.objectKey),
        ...documentVersions.map((version) => version.objectKey),
        ...submissions.flatMap((submission) => submission.reviewTextObjectKey ? [submission.reviewTextObjectKey] : []),
      ]));
      if (objectKeys.some((objectKey) => !isWorkspaceObjectKey(workspaceId, objectKey))) {
        blocked.push({ resourceType: "agreement", resourceId: String(agreement.id), reason: "a storage reference failed workspace validation" });
        continue;
      }
      const [deletionTombstone] = await db.select().from(outboxEvents).where(and(
        eq(outboxEvents.workspaceId, workspaceId),
        eq(outboxEvents.topic, "agreement.deleted"),
        eq(outboxEvents.aggregateType, "agreement"),
        eq(outboxEvents.aggregateId, String(agreement.id)),
        sql`json_extract(${outboxEvents.payload}, '$.tombstone') = 1`,
        sql`json_extract(${outboxEvents.payload}, '$.agreementId') = ${agreement.id}`,
        sql`json_extract(${outboxEvents.payload}, '$.version') = ${agreement.version}`,
        sql`json_extract(${outboxEvents.payload}, '$.aggregateVersion') = ${agreement.version}`,
        sql`json_extract(${outboxEvents.payload}, '$.deletedAt') = ${agreement.deletedAt!}`,
      )).orderBy(desc(outboxEvents.createdAt), desc(outboxEvents.id)).limit(1);
      const tombstoneDeliveries = deletionTombstone
        ? await db.select({ sink: outboxDeliveries.sink, status: outboxDeliveries.status })
          .from(outboxDeliveries).where(and(
            eq(outboxDeliveries.workspaceId, workspaceId),
            eq(outboxDeliveries.eventId, deletionTombstone.id),
          ))
        : [];
      const crmLedger = await db.select({
        eventId: outboxDeliveries.eventId,
        topic: outboxEvents.topic,
        payload: outboxEvents.payload,
        status: outboxDeliveries.status,
        crmProvider: outboxDeliveries.crmProvider,
        crmMappingVersion: outboxDeliveries.crmMappingVersion,
        crmDestinationFingerprint: outboxDeliveries.crmDestinationFingerprint,
      })
        .from(outboxDeliveries)
        .innerJoin(outboxEvents, and(
          eq(outboxEvents.workspaceId, outboxDeliveries.workspaceId),
          eq(outboxEvents.id, outboxDeliveries.eventId),
        )).where(and(
          eq(outboxDeliveries.workspaceId, workspaceId),
          eq(outboxDeliveries.sink, "crm"),
          inArray(outboxEvents.topic, CRM_PROJECTION_TOPICS),
          or(
            and(eq(outboxEvents.aggregateType, "agreement"), eq(outboxEvents.aggregateId, String(agreement.id))),
            sql`json_extract(${outboxEvents.payload}, '$.agreementId') = ${agreement.id}`,
          ),
        ));
      const legacyAttestations = await db.select({ eventId: crmLegacyCleanupAttestations.eventId })
        .from(crmLegacyCleanupAttestations).where(and(
          eq(crmLegacyCleanupAttestations.workspaceId, workspaceId),
          eq(crmLegacyCleanupAttestations.agreementId, agreement.id),
        ));
      const attestedLegacyEventIds = new Set(legacyAttestations.map((attestation) => attestation.eventId));
      const unprofiledCrmEvents = await db.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
        eq(outboxEvents.workspaceId, workspaceId),
        inArray(outboxEvents.topic, CRM_PROJECTION_TOPICS.filter((topic) => topic !== "agreement.deleted")),
        or(
          and(eq(outboxEvents.aggregateType, "agreement"), eq(outboxEvents.aggregateId, String(agreement.id))),
          sql`json_extract(${outboxEvents.payload}, '$.agreementId') = ${agreement.id}`,
        ),
        sql`json_valid(${outboxEvents.payload}) = 1`,
        sql`json_type(${outboxEvents.payload}, '$.crmAgreement.crm') = 'text'`,
        sql`json_extract(${outboxEvents.payload}, '$.crmAgreement.crm') <> 'None'`,
        sql`not exists (
          select 1 from outbox_deliveries as uninitialized_crm_delivery
          where uninitialized_crm_delivery.workspace_id = ${workspaceId}
            and uninitialized_crm_delivery.event_id = ${outboxEvents.id}
            and uninitialized_crm_delivery.sink = 'crm'
        )`,
        sql`not exists (
          select 1 from crm_legacy_cleanup_attestations as reconciled_legacy_event
          where reconciled_legacy_event.workspace_id = ${workspaceId}
            and reconciled_legacy_event.agreement_id = ${agreement.id}
            and reconciled_legacy_event.event_id = ${outboxEvents.id}
        )`,
      ));
      const unresolvedCrmProfiles = [
        ...unresolvedCrmDeliveryProfiles(crmLedger.filter((entry) => (
          entry.crmProvider !== null
          && entry.crmMappingVersion !== null
          && entry.crmDestinationFingerprint !== null
        ) || !attestedLegacyEventIds.has(entry.eventId))),
        ...unprofiledCrmEvents.map((event) => `unprofiled:${event.id}`),
      ];
      const deliveryGate = evaluateDeletionDeliveryGate({
        agreementId: agreement.id,
        version: agreement.version,
        deletedAt: agreement.deletedAt!,
        unresolvedCrmProfiles,
        event: deletionTombstone ?? null,
        deliveries: tombstoneDeliveries,
      });
      if (!deliveryGate.ready) {
        blocked.push({ resourceType: "agreement", resourceId: String(agreement.id), reason: deliveryGate.reason });
        continue;
      }
      if (dryRun) {
        hardPurged.agreementIds.push(agreement.id);
        hardPurged.documentIds.push(...linkedDocuments.map((document) => document.id));
        continue;
      }

      const purgeJobId = crypto.randomUUID();
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "retention.d1_purged",
        aggregateType: "records-policy",
        aggregateId: `agreement:${agreement.id}`,
        payload: { resourceType: "agreement", resourceId: String(agreement.id), d1PurgedAt: nowIso, storageStatus: "storage_pending", purgeJobId, causationId: requestId },
      }));
      const purgeEvent = await prepareWorkspaceEvent(db, {
        workspaceId,
        type: "Retention purge",
        detail: `Permanently purged agreement ${agreement.id} and its eligible linked records after the retention grace period; object storage cleanup is tracked durably.`,
        actor: SYSTEM_ACTOR,
        createdAt: nowIso,
      });
      const storageJob: PurgeStorageJob = {
        id: purgeJobId,
        workspaceId,
        resourceType: "agreement",
        resourceId: String(agreement.id),
        objectKeys,
        attempts: 0,
      };

      try {
        await db.batch([
          // Parent deletion is intentionally first. The immediately following
          // changes()-guarded manifest insert aborts this whole D1 batch unless
          // every current retention/hold/child precondition still matches.
          db.delete(agreements).where(and(
            eq(agreements.workspaceId, workspaceId),
            eq(agreements.id, agreement.id),
            eq(agreements.version, agreement.version),
            eq(agreements.legalHold, false),
            isNotNull(agreements.retentionUntil),
            lte(agreements.retentionUntil, nowIso),
            isNotNull(agreements.deletedAt),
            eq(agreements.deletedAt, agreement.deletedAt!),
            lte(agreements.deletedAt, purgeCutoffIso),
            sql`(select count(*) from documents as purge_counted_child
              where purge_counted_child.workspace_id = ${workspaceId}
                and purge_counted_child.agreement_id = ${agreements.id}) = ${linkedDocuments.length}`,
            sql`(select count(*) from agreement_document_versions as purge_counted_version
              where purge_counted_version.workspace_id = ${workspaceId}
                and purge_counted_version.agreement_id = ${agreements.id}) = ${documentVersions.length}`,
            sql`(select count(*) from negotiation_rounds as purge_counted_round
              where purge_counted_round.workspace_id = ${workspaceId}
                and purge_counted_round.agreement_id = ${agreements.id}) = ${rounds.length}`,
            sql`(select count(*) from negotiation_submissions as purge_counted_submission
              where purge_counted_submission.workspace_id = ${workspaceId}
                and purge_counted_submission.agreement_id = ${agreements.id}) = ${submissions.length}`,
            sql`(select count(*) from document_comparisons as purge_counted_comparison
              where purge_counted_comparison.workspace_id = ${workspaceId}
                and purge_counted_comparison.agreement_id = ${agreements.id}) = ${comparisons.length}`,
            sql`(select count(*) from obligation_schedules as purge_counted_obligation_schedule
              where purge_counted_obligation_schedule.workspace_id = ${workspaceId}
                and purge_counted_obligation_schedule.agreement_id = ${agreements.id}) = ${obligationScheduleRows.length}`,
            sql`(select count(*) from obligations as purge_counted_obligation_occurrence
              where purge_counted_obligation_occurrence.workspace_id = ${workspaceId}
                and purge_counted_obligation_occurrence.agreement_id = ${agreements.id}) = ${obligationOccurrenceRows.length}`,
            sql`(select count(*) from obligation_evidence as purge_counted_obligation_evidence
              where purge_counted_obligation_evidence.workspace_id = ${workspaceId}
                and purge_counted_obligation_evidence.agreement_id = ${agreements.id}) = ${obligationEvidenceRows.length}`,
            sql`(select count(*) from obligation_creation_receipts as purge_counted_obligation_receipt
              where purge_counted_obligation_receipt.workspace_id = ${workspaceId}
                and purge_counted_obligation_receipt.agreement_id = ${agreements.id}) = ${obligationCreationReceiptRows.length}`,
            sql`(select count(*) from webhook_receipts as purge_counted_receipt
              where purge_counted_receipt.workspace_id = ${workspaceId}
                and purge_counted_receipt.aggregate_type = 'negotiation_round'
                and purge_counted_receipt.aggregate_id in (
                  select purge_counted_receipt_round.id
                  from negotiation_rounds as purge_counted_receipt_round
                  where purge_counted_receipt_round.workspace_id = ${workspaceId}
                    and purge_counted_receipt_round.agreement_id = ${agreements.id}
                )) = ${inboundReceiptRows.length}`,
            sql`(select count(*) from webhook_receipts as purge_counted_signature_receipt
              where purge_counted_signature_receipt.workspace_id = ${workspaceId}
                and purge_counted_signature_receipt.aggregate_type = 'signature_packet'
                and purge_counted_signature_receipt.aggregate_id in (
                  select purge_counted_receipt_packet.id
                  from signature_packets as purge_counted_receipt_packet
                  where purge_counted_receipt_packet.workspace_id = ${workspaceId}
                    and purge_counted_receipt_packet.agreement_id = ${agreements.id}
                )) = ${signatureReceiptRows.length}`,
            sql`not exists (
              select 1 from documents as purge_child
              where purge_child.workspace_id = ${workspaceId}
                and purge_child.agreement_id = ${agreements.id}
                and (
                  purge_child.legal_hold = 1
                  or purge_child.retention_until is null
                  or purge_child.retention_until > ${nowIso}
                  or purge_child.deleted_at is null
                  or purge_child.deleted_at > ${purgeCutoffIso}
                )
            )`,
            sql`not exists (
              select 1 from signature_packets as purge_active_signature
              where purge_active_signature.workspace_id = ${workspaceId}
                and purge_active_signature.agreement_id = ${agreements.id}
                and purge_active_signature.status in (
                  'creating',
                  'pending',
                  'partially_signed',
                  'reconciling',
                  'archived'
                )
            )`,
            // Re-check the exact deletion epoch and every immutable sink inside
            // the guarded purge batch. A pre-read alone is not authorization
            // to erase pending/dead delivery evidence.
            sql`exists (
              select 1 from outbox_events as purge_tombstone
              where purge_tombstone.workspace_id = ${workspaceId}
                and purge_tombstone.topic = 'agreement.deleted'
                and purge_tombstone.aggregate_type = 'agreement'
                and purge_tombstone.aggregate_id = ${String(agreement.id)}
                and purge_tombstone.status = 'processed'
                and json_extract(purge_tombstone.payload, '$.tombstone') = 1
                and json_extract(purge_tombstone.payload, '$.agreementId') = ${agreement.id}
                and json_extract(purge_tombstone.payload, '$.version') = ${agreement.version}
                and json_extract(purge_tombstone.payload, '$.aggregateVersion') = ${agreement.version}
                and json_extract(purge_tombstone.payload, '$.deletedAt') = ${agreement.deletedAt!}
                and exists (
                  select 1 from outbox_deliveries as purge_delivery_sink
                  where purge_delivery_sink.workspace_id = ${workspaceId}
                    and purge_delivery_sink.event_id = purge_tombstone.id
                    and purge_delivery_sink.sink = 'delivery'
                    and purge_delivery_sink.status = 'accepted'
                )
                and not exists (
                  select 1 from outbox_deliveries as purge_incomplete_sink
                  where purge_incomplete_sink.workspace_id = ${workspaceId}
                    and purge_incomplete_sink.event_id = purge_tombstone.id
                    and purge_incomplete_sink.status <> 'accepted'
                )
            )`,
            // Every projection delivery, including pending/dead work that may
            // have produced an ambiguous provider side effect, must be fenced
            // by an accepted same-profile tombstone. Legacy profile gaps block.
            sql`not exists (
              select 1
              from outbox_deliveries as purge_projection_delivery
              inner join outbox_events as purge_projection_event
                on purge_projection_event.workspace_id = purge_projection_delivery.workspace_id
               and purge_projection_event.id = purge_projection_delivery.event_id
              where purge_projection_delivery.workspace_id = ${workspaceId}
                and purge_projection_delivery.sink = 'crm'
                and purge_projection_event.topic in (
                  'agreement.created',
                  'agreement.updated',
                  'agreement.stage_changed',
                  'signature.completed'
                )
                and (
                  (purge_projection_event.aggregate_type = 'agreement' and purge_projection_event.aggregate_id = ${String(agreement.id)})
                  or json_extract(purge_projection_event.payload, '$.agreementId') = ${agreement.id}
                )
                and (
                  (
                    (
                      purge_projection_delivery.crm_provider is null
                      or purge_projection_delivery.crm_mapping_version is null
                      or purge_projection_delivery.crm_destination_fingerprint is null
                    )
                    and not exists (
                      select 1 from crm_legacy_cleanup_attestations as purge_legacy_attestation
                      where purge_legacy_attestation.workspace_id = ${workspaceId}
                        and purge_legacy_attestation.agreement_id = ${agreement.id}
                        and purge_legacy_attestation.event_id = purge_projection_event.id
                    )
                  )
                  or (
                    purge_projection_delivery.crm_provider is not null
                    and purge_projection_delivery.crm_mapping_version is not null
                    and purge_projection_delivery.crm_destination_fingerprint is not null
                    and not exists (
                    select 1
                    from outbox_deliveries as purge_cleanup_delivery
                    inner join outbox_events as purge_cleanup_event
                      on purge_cleanup_event.workspace_id = purge_cleanup_delivery.workspace_id
                     and purge_cleanup_event.id = purge_cleanup_delivery.event_id
                    where purge_cleanup_delivery.workspace_id = ${workspaceId}
                      and purge_cleanup_delivery.sink = 'crm'
                      and purge_cleanup_delivery.status = 'accepted'
                      and purge_cleanup_delivery.crm_provider = purge_projection_delivery.crm_provider
                      and purge_cleanup_delivery.crm_mapping_version = purge_projection_delivery.crm_mapping_version
                      and purge_cleanup_delivery.crm_destination_fingerprint = purge_projection_delivery.crm_destination_fingerprint
                      and purge_cleanup_event.topic = 'agreement.deleted'
                      and purge_cleanup_event.aggregate_type = 'agreement'
                      and purge_cleanup_event.aggregate_id = ${String(agreement.id)}
                      and json_extract(purge_cleanup_event.payload, '$.tombstone') = 1
                      and json_extract(purge_cleanup_event.payload, '$.agreementId') = ${agreement.id}
                      and cast(json_extract(purge_cleanup_event.payload, '$.aggregateVersion') as integer)
                        >= cast(json_extract(purge_projection_event.payload, '$.crmAgreement.version') as integer)
                    )
                  )
                )
            )`,
            // A CRM projection with no delivery ledger may be in flight or may
            // predate the per-sink migration. Either case is an unknown remote
            // side effect, so every event status blocks conservatively.
            sql`not exists (
              select 1
              from outbox_events as purge_unprofiled_projection
              where purge_unprofiled_projection.workspace_id = ${workspaceId}
                and purge_unprofiled_projection.topic in (
                  'agreement.created',
                  'agreement.updated',
                  'agreement.stage_changed',
                  'signature.completed'
                )
                and (
                  (purge_unprofiled_projection.aggregate_type = 'agreement' and purge_unprofiled_projection.aggregate_id = ${String(agreement.id)})
                  or json_extract(purge_unprofiled_projection.payload, '$.agreementId') = ${agreement.id}
                )
                and json_valid(purge_unprofiled_projection.payload) = 1
                and json_type(purge_unprofiled_projection.payload, '$.crmAgreement.crm') = 'text'
                and json_extract(purge_unprofiled_projection.payload, '$.crmAgreement.crm') <> 'None'
                and not exists (
                  select 1 from outbox_deliveries as purge_profiled_delivery
                  where purge_profiled_delivery.workspace_id = ${workspaceId}
                    and purge_profiled_delivery.event_id = purge_unprofiled_projection.id
                    and purge_profiled_delivery.sink = 'crm'
                )
                and not exists (
                  select 1 from crm_legacy_cleanup_attestations as purge_unprofiled_attestation
                  where purge_unprofiled_attestation.workspace_id = ${workspaceId}
                    and purge_unprofiled_attestation.agreement_id = ${agreement.id}
                    and purge_unprofiled_attestation.event_id = purge_unprofiled_projection.id
                )
            )`,
          )),
          db.insert(purgeJobs).values({
            ...storageJob,
            objectKeys,
            status: "storage_pending",
            guardChanges: sql<number>`changes()`,
            attempts: 0,
            lastError: null,
            lastAttemptAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
            completedAt: null,
          }),
          // Signature webhook receipt identities are retained only with their
          // packet. Delete them while packet rows still exist so the aggregate
          // subquery is exact; the parent count fence prevents a concurrent
          // INSERT ... SELECT claim from being stranded after this purge.
          db.delete(webhookReceipts).where(and(
            eq(webhookReceipts.workspaceId, workspaceId),
            eq(webhookReceipts.aggregateType, "signature_packet"),
            sql`${webhookReceipts.aggregateId} in (
              select purge_receipt_packet.id from signature_packets as purge_receipt_packet
              where purge_receipt_packet.workspace_id = ${workspaceId}
                and purge_receipt_packet.agreement_id = ${agreement.id}
            )`,
          )),
          db.delete(signaturePackets).where(and(eq(signaturePackets.workspaceId, workspaceId), eq(signaturePackets.agreementId, agreement.id))),
          db.delete(approvalRequests).where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.agreementId, agreement.id))),
          db.delete(customFieldValues).where(and(
            eq(customFieldValues.workspaceId, workspaceId),
            eq(customFieldValues.resourceType, "agreement"),
            eq(customFieldValues.resourceId, String(agreement.id)),
          )),
          db.delete(intakeSubmissions).where(and(
            eq(intakeSubmissions.workspaceId, workspaceId),
            eq(intakeSubmissions.agreementId, agreement.id),
          )),
          // The parent is already gone, so the v17 evidence-retention trigger
          // permits this exact hard-purge order. Occurrences must disappear
          // before their schedules; every count was fenced on the parent DELETE.
          db.delete(obligationCreationReceipts).where(and(eq(obligationCreationReceipts.workspaceId, workspaceId), eq(obligationCreationReceipts.agreementId, agreement.id))),
          db.delete(obligationEvidence).where(and(eq(obligationEvidence.workspaceId, workspaceId), eq(obligationEvidence.agreementId, agreement.id))),
          db.delete(obligations).where(and(eq(obligations.workspaceId, workspaceId), eq(obligations.agreementId, agreement.id))),
          db.delete(obligationSchedules).where(and(eq(obligationSchedules.workspaceId, workspaceId), eq(obligationSchedules.agreementId, agreement.id))),
          db.delete(documentComparisons).where(and(eq(documentComparisons.workspaceId, workspaceId), eq(documentComparisons.agreementId, agreement.id))),
          db.delete(negotiationSubmissions).where(and(eq(negotiationSubmissions.workspaceId, workspaceId), eq(negotiationSubmissions.agreementId, agreement.id))),
          db.delete(webhookReceipts).where(and(
            eq(webhookReceipts.workspaceId, workspaceId),
            eq(webhookReceipts.aggregateType, "negotiation_round"),
            sql`${webhookReceipts.aggregateId} in (
              select purge_receipt_round.id from negotiation_rounds as purge_receipt_round
              where purge_receipt_round.workspace_id = ${workspaceId}
                and purge_receipt_round.agreement_id = ${agreement.id}
            )`,
          )),
          db.delete(negotiationRounds).where(and(eq(negotiationRounds.workspaceId, workspaceId), eq(negotiationRounds.agreementId, agreement.id))),
          db.delete(ingestionItems).where(and(
            eq(ingestionItems.workspaceId, workspaceId),
            sql`exists (
              select 1 from documents as purge_ledger_document
              where purge_ledger_document.workspace_id = ${workspaceId}
                and purge_ledger_document.agreement_id = ${agreement.id}
                and (purge_ledger_document.id = ${ingestionItems.documentId}
                  or purge_ledger_document.id = ${ingestionItems.duplicateOfDocumentId})
            )`,
          )),
          db.delete(agreementDocumentVersions).where(and(eq(agreementDocumentVersions.workspaceId, workspaceId), eq(agreementDocumentVersions.agreementId, agreement.id))),
          db.delete(documents).where(and(eq(documents.workspaceId, workspaceId), eq(documents.agreementId, agreement.id))),
          db.delete(agreementVersions).where(and(eq(agreementVersions.workspaceId, workspaceId), eq(agreementVersions.agreementId, agreement.id))),
          db.delete(agreementEvents).where(and(eq(agreementEvents.workspaceId, workspaceId), eq(agreementEvents.agreementId, agreement.id))),
          db.delete(crmLegacyCleanupAttestations).where(and(
            eq(crmLegacyCleanupAttestations.workspaceId, workspaceId),
            eq(crmLegacyCleanupAttestations.agreementId, agreement.id),
          )),
          db.delete(outboxEvents).where(and(
            eq(outboxEvents.workspaceId, workspaceId),
            or(
              and(eq(outboxEvents.aggregateType, "agreement"), eq(outboxEvents.aggregateId, String(agreement.id))),
              sql`json_extract(${outboxEvents.payload}, '$.agreementId') = ${agreement.id}`,
            ),
          )),
          db.insert(outboxEvents).values(outbox),
          db.insert(workspaceEvents).values(purgeEvent),
        ]);
        d1Purged.agreementIds.push(agreement.id);
        d1Purged.documentIds.push(...linkedDocuments.map((document) => document.id));
      } catch {
        failures.push({ resourceType: "agreement", resourceId: String(agreement.id), phase: "hard-purge" });
        continue;
      }

      try {
        const result = await runPurgeStorageJob(db, bindings.DOCUMENTS, storageJob);
        if (result.status === "completed") {
          hardPurged.agreementIds.push(agreement.id);
          hardPurged.documentIds.push(...linkedDocuments.map((document) => document.id));
          purgeStorage.completedJobIds.push(purgeJobId);
        } else {
          purgeStorage.pendingJobIds.push(purgeJobId);
          failures.push({ resourceType: "agreement", resourceId: String(agreement.id), phase: "storage-delete" });
        }
      } catch {
        purgeStorage.pendingJobIds.push(purgeJobId);
        failures.push({ resourceType: "agreement", resourceId: String(agreement.id), phase: "storage-delete" });
      }
    }

    const hardStandaloneDocumentCandidates = await db.select().from(documents).where(and(
      eq(documents.workspaceId, workspaceId),
      isNull(documents.agreementId),
      eq(documents.legalHold, false),
      isNotNull(documents.retentionUntil),
      lte(documents.retentionUntil, nowIso),
      isNotNull(documents.deletedAt),
      lte(documents.deletedAt, purgeCutoffIso),
    )).orderBy(asc(documents.deletedAt), asc(documents.createdAt)).limit(BATCH_SIZE);

    for (const document of hardStandaloneDocumentCandidates) {
      if (!isHardPurgeEligible(document, now, purgeCutoff)) continue;
      if (!isWorkspaceObjectKey(workspaceId, document.objectKey)) {
        blocked.push({ resourceType: "document", resourceId: document.id, reason: "storage reference failed workspace validation" });
        continue;
      }
      if (dryRun) {
        hardPurged.documentIds.push(document.id);
        continue;
      }
      const purgeJobId = crypto.randomUUID();
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "retention.d1_purged",
        aggregateType: "records-policy",
        aggregateId: `document:${document.id}`,
        payload: { resourceType: "document", resourceId: document.id, d1PurgedAt: nowIso, storageStatus: "storage_pending", purgeJobId, causationId: requestId },
      }));
      const purgeEvent = await prepareWorkspaceEvent(db, {
        workspaceId,
        type: "Retention purge",
        detail: `Permanently purged standalone document ${document.id} after the retention grace period; object storage cleanup is tracked durably.`,
        actor: SYSTEM_ACTOR,
        createdAt: nowIso,
      });
      const storageJob: PurgeStorageJob = {
        id: purgeJobId,
        workspaceId,
        resourceType: "document",
        resourceId: document.id,
        objectKeys: [document.objectKey],
        attempts: 0,
      };

      try {
        await db.batch([
          db.delete(ingestionItems).where(and(
            eq(ingestionItems.workspaceId, workspaceId),
            or(eq(ingestionItems.documentId, document.id), eq(ingestionItems.duplicateOfDocumentId, document.id)),
          )),
          db.delete(documents).where(and(
            eq(documents.workspaceId, workspaceId),
            eq(documents.id, document.id),
            eq(documents.version, document.version),
            isNull(documents.agreementId),
            eq(documents.legalHold, false),
            isNotNull(documents.retentionUntil),
            lte(documents.retentionUntil, nowIso),
            isNotNull(documents.deletedAt),
            eq(documents.deletedAt, document.deletedAt!),
            lte(documents.deletedAt, purgeCutoffIso),
          )),
          db.insert(purgeJobs).values({
            ...storageJob,
            objectKeys: [document.objectKey],
            status: "storage_pending",
            guardChanges: sql<number>`changes()`,
            attempts: 0,
            lastError: null,
            lastAttemptAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
            completedAt: null,
          }),
          db.insert(outboxEvents).values(outbox),
          db.insert(workspaceEvents).values(purgeEvent),
        ]);
        d1Purged.documentIds.push(document.id);
      } catch {
        failures.push({ resourceType: "document", resourceId: document.id, phase: "hard-purge" });
        continue;
      }

      try {
        const result = await runPurgeStorageJob(db, bindings.DOCUMENTS, storageJob);
        if (result.status === "completed") {
          hardPurged.documentIds.push(document.id);
          purgeStorage.completedJobIds.push(purgeJobId);
        } else {
          purgeStorage.pendingJobIds.push(purgeJobId);
          failures.push({ resourceType: "document", resourceId: document.id, phase: "storage-delete" });
        }
      } catch {
        purgeStorage.pendingJobIds.push(purgeJobId);
        failures.push({ resourceType: "document", resourceId: document.id, phase: "storage-delete" });
      }
    }

    return apiJson({
      workspaceId,
      dryRun,
      evaluatedAt: nowIso,
      safeguards: {
        graceDays,
        hardPurgeCutoff: purgeCutoffIso,
        terminalAgreementStage: "Active",
        explicitRetentionDateRequired: true,
        legalHoldOverridesRetention: true,
        linkedDocumentEligibilityRequired: true,
        d1CommitBeforeStorageDeletion: true,
        durableStorageRetryManifest: true,
      },
      softDeleted,
      d1Purged,
      hardPurged,
      lifecyclePurged,
      purgeStorage,
      blocked,
      failures,
      requestId,
    }, { status: failures.length ? 207 : 200, requestId });
  } catch (error) {
    return handleRouteError(error, requestId, "Retention processing is unavailable.");
  }
}

async function runPurgeStorageJob(
  db: Database,
  bucket: R2Bucket,
  job: PurgeStorageJob,
) {
  return attemptPurgeStorage(job, {
    deleteObjects: async (objectKeys) => {
      // Cleanup manifests that precede D1 authority (staged writes and rejected
      // rescans) need a fresh policy read immediately before touching R2. This
      // prevents a later retry from deleting bytes that became authoritative or
      // were placed under a document/agreement legal hold after the job queued.
      const policy = await assessStorageCleanupPolicy(db, job);
      if (policy.action !== "allow") throw new Error(policy.reason);
      await deleteR2Objects(bucket, objectKeys);
    },
    markCompleted: async (update) => {
      await db.update(purgeJobs).set({
        status: "completed",
        // The manifest is needed only until deletion succeeds. Removing raw
        // object keys prevents completed jobs from becoming a durable filename
        // or storage-path inventory.
        objectKeys: [],
        attempts: update.attempts,
        lastError: update.lastError,
        lastAttemptAt: update.attemptedAt,
        updatedAt: update.attemptedAt,
        completedAt: update.completedAt,
      }).where(and(
        eq(purgeJobs.workspaceId, job.workspaceId),
        eq(purgeJobs.id, job.id),
        eq(purgeJobs.status, "storage_pending"),
      ));
    },
    markPending: async (update) => {
      await db.update(purgeJobs).set({
        status: "storage_pending",
        attempts: update.attempts,
        lastError: update.lastError,
        lastAttemptAt: update.attemptedAt,
        updatedAt: update.attemptedAt,
        completedAt: null,
      }).where(and(
        eq(purgeJobs.workspaceId, job.workspaceId),
        eq(purgeJobs.id, job.id),
        eq(purgeJobs.status, "storage_pending"),
      ));
    },
  });
}

type StorageCleanupPolicy =
  | { action: "allow"; resourceId: string; reason: "" }
  | { action: "cancel" | "defer"; resourceId: string; reason: string };

async function assessStorageCleanupPolicy(
  db: Database,
  job: PurgeStorageJob,
): Promise<StorageCleanupPolicy> {
  const stagedMatch = /^staged:([^:]+):[^:]+$/.exec(job.resourceId);
  if (stagedMatch) {
    const stagedId = stagedMatch[1];
    const objectKeys = Array.isArray(job.objectKeys)
      ? job.objectKeys.filter((value): value is string => typeof value === "string")
      : [];
    const [documentRows, versionRows, reviewRows] = await Promise.all([
      db.select({ objectKey: documents.objectKey }).from(documents).where(and(
        eq(documents.workspaceId, job.workspaceId),
        eq(documents.id, stagedId),
      )).limit(1),
      db.select({ objectKey: agreementDocumentVersions.objectKey }).from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, job.workspaceId),
        eq(agreementDocumentVersions.id, stagedId),
      )).limit(1),
      objectKeys.length
        ? db.select({ objectKey: negotiationSubmissions.reviewTextObjectKey }).from(negotiationSubmissions).where(and(
          eq(negotiationSubmissions.workspaceId, job.workspaceId),
          inArray(negotiationSubmissions.reviewTextObjectKey, objectKeys),
        )).limit(1)
        : Promise.resolve([]),
    ]);
    if ([...documentRows, ...versionRows, ...reviewRows].some((row) => row.objectKey && objectKeys.includes(row.objectKey))) {
      return {
        action: "cancel",
        resourceId: stagedId,
        reason: "staged object became authoritative before cleanup",
      };
    }
    return { action: "allow", resourceId: stagedId, reason: "" };
  }

  return await assessRejectedObjectCleanupPolicy(db, job)
    ?? { action: "allow", resourceId: job.resourceId, reason: "" };
}

async function deleteR2Objects(bucket: R2Bucket, objectKeys: readonly string[]) {
  for (let index = 0; index < objectKeys.length; index += 1_000) {
    await bucket.delete(objectKeys.slice(index, index + 1_000));
  }
}

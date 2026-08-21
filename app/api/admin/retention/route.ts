import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agreementEvents, agreements, agreementVersions, documents, mutationGuards, outboxEvents, workspaceEvents } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { apiError, apiJson } from "../../../lib/http";
import { prepareAgreementDeletedIntegrationEvent } from "../../../lib/integration-events";
import { isMutationGuardConflict, prepareAgreementEvent, prepareAgreementSnapshot, prepareOutboxEvent, prepareWorkspaceEvent } from "../../../lib/persistence";
import { REJECTED_OBJECT_DELETE_CLAIM } from "../../../lib/purge-storage";
import {
  DEFAULT_PURGE_GRACE_DAYS,
  normalizeRetentionUntil,
  RetentionPolicyError,
} from "../../../lib/records-governance";
import { parseJson } from "../../../lib/validation";

const commonPolicyFields = {
  expectedVersion: z.number().int().positive(),
  legalHold: z.boolean(),
  retentionUntil: z.string().trim().min(10).max(40).nullable(),
  reason: z.string().trim().min(3).max(500),
};

const policyMutationSchema = z.discriminatedUnion("targetType", [
  z.object({
    targetType: z.literal("agreement"),
    targetId: z.number().int().positive(),
    cascadeRetentionToDocuments: z.boolean().default(false),
    ...commonPolicyFields,
  }),
  z.object({
    targetType: z.literal("document"),
    targetId: z.string().uuid(),
    ...commonPolicyFields,
  }),
]);

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const url = new URL(request.url);
    const agreementIdParam = url.searchParams.get("agreementId");
    const agreementId = Number(agreementIdParam);
    const documentIdParam = url.searchParams.get("documentId");
    const documentId = documentIdParam?.trim();

    if (agreementIdParam !== null) {
      if (!Number.isSafeInteger(agreementId) || agreementId <= 0) return invalidTarget(auth.requestId);
      const [agreement] = await db.select({
        id: agreements.id,
        version: agreements.version,
        party: agreements.party,
        stage: agreements.stage,
        legalHold: agreements.legalHold,
        retentionUntil: agreements.retentionUntil,
        deletedAt: agreements.deletedAt,
        updatedAt: agreements.updatedAt,
      }).from(agreements).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, agreementId),
      )).limit(1);
      if (!agreement) return notFound("agreement", auth.requestId);
      const linkedDocuments = await db.select({
        id: documents.id,
        version: documents.version,
        fileName: documents.fileName,
        legalHold: documents.legalHold,
        retentionUntil: documents.retentionUntil,
        deletedAt: documents.deletedAt,
      }).from(documents).where(and(
        eq(documents.workspaceId, workspaceId),
        eq(documents.agreementId, agreementId),
      ));
      return apiJson({
        policy: agreement,
        linkedDocuments,
        safeguards: safeguards(),
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (documentIdParam !== null) {
      if (!documentId || !z.string().uuid().safeParse(documentId).success) return invalidTarget(auth.requestId);
      const [document] = await db.select({
        id: documents.id,
        agreementId: documents.agreementId,
        version: documents.version,
        fileName: documents.fileName,
        legalHold: documents.legalHold,
        retentionUntil: documents.retentionUntil,
        deletedAt: documents.deletedAt,
      }).from(documents).where(and(
        eq(documents.workspaceId, workspaceId),
        eq(documents.id, documentId),
      )).limit(1);
      if (!document) return notFound("document", auth.requestId);
      const [parentPolicy] = document.agreementId
        ? await db.select({
          id: agreements.id,
          legalHold: agreements.legalHold,
          retentionUntil: agreements.retentionUntil,
          deletedAt: agreements.deletedAt,
        }).from(agreements).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, document.agreementId),
        )).limit(1)
        : [];
      return apiJson({
        policy: { ...document, effectiveLegalHold: document.legalHold || Boolean(parentPolicy?.legalHold) },
        parentPolicy: parentPolicy ?? null,
        safeguards: safeguards(),
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    const [[agreementSummary], [documentSummary]] = await Promise.all([
      db.select({
        total: sql<number>`count(*)`,
        held: sql<number>`sum(case when ${agreements.legalHold} = 1 then 1 else 0 end)`,
        scheduled: sql<number>`sum(case when ${agreements.retentionUntil} is not null then 1 else 0 end)`,
        softDeleted: sql<number>`sum(case when ${agreements.deletedAt} is not null then 1 else 0 end)`,
      }).from(agreements).where(eq(agreements.workspaceId, workspaceId)),
      db.select({
        total: sql<number>`count(*)`,
        held: sql<number>`sum(case when ${documents.legalHold} = 1 then 1 else 0 end)`,
        scheduled: sql<number>`sum(case when ${documents.retentionUntil} is not null then 1 else 0 end)`,
        softDeleted: sql<number>`sum(case when ${documents.deletedAt} is not null then 1 else 0 end)`,
      }).from(documents).where(eq(documents.workspaceId, workspaceId)),
    ]);
    return apiJson({
      summary: {
        agreements: numericSummary(agreementSummary),
        documents: numericSummary(documentSummary),
      },
      safeguards: safeguards(),
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Retention policies could not be loaded.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, policyMutationSchema, 24_000);
    const retentionUntil = normalizeRetentionUntil(input.retentionUntil);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const now = new Date().toISOString();

    if (input.targetType === "agreement") {
      const [current] = await db.select().from(agreements).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, input.targetId),
      )).limit(1);
      if (!current) return notFound("agreement", auth.requestId);
      if (current.version !== input.expectedVersion) return versionConflict(auth.requestId);
      const agreementPatch = {
        legalHold: input.legalHold,
        retentionUntil,
        version: current.version + 1,
        updated: now,
        updatedAt: now,
        updatedByUserId: auth.context.user.id,
      };

      const cascade = input.legalHold || input.cascadeRetentionToDocuments;
      let affectedDocuments = 0;
      const saved: typeof agreements.$inferSelect = { ...current, ...agreementPatch };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: input.targetId,
        type: "Records policy",
        detail: policyEventDetail(input.legalHold, retentionUntil, input.reason, cascade),
        actor: {
          userId: auth.context.user.id,
          email: auth.context.user.email,
          displayName: auth.context.user.displayName,
        },
        createdAt: now,
      });
      const snapshot = await prepareAgreementSnapshot(saved, auth.context.user.id, event.id);
      const tombstone = current.deletedAt
        ? prepareOutboxEvent(prepareAgreementDeletedIntegrationEvent({
          agreement: saved,
          deletedAt: current.deletedAt,
          causationId: auth.requestId,
        }))
        : null;
      const tombstoneWrite = tombstone ? [db.insert(outboxEvents).values(tombstone)] : [];
      const agreementWrite = db.update(agreements).set(agreementPatch).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, input.targetId),
        eq(agreements.version, input.expectedVersion),
        eq(agreements.nextAction, current.nextAction),
        input.legalHold ? sql`not exists (
          select 1
          from purge_jobs as hold_cleanup_claim
          inner join documents as hold_cleanup_document
            on hold_cleanup_document.workspace_id = hold_cleanup_claim.workspace_id
           and hold_cleanup_claim.resource_id like 'rejected:' || hold_cleanup_document.id || ':%'
          where hold_cleanup_claim.workspace_id = ${workspaceId}
            and hold_cleanup_claim.resource_type = 'document'
            and hold_cleanup_claim.status = 'storage_pending'
            and hold_cleanup_claim.last_error = ${REJECTED_OBJECT_DELETE_CLAIM}
            and hold_cleanup_document.agreement_id = ${input.targetId}
        )` : undefined,
      ));
      const guardId = crypto.randomUUID();
      const agreementGuard = db.insert(mutationGuards).values({
        id: guardId,
        workspaceId,
        operation: "retention.policy.agreement",
        guardChanges: sql<number>`changes()`,
        createdAt: now,
      });
      const releaseGuard = db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, workspaceId),
        eq(mutationGuards.id, guardId),
      ));
      if (cascade) {
        const documentUpdate = input.cascadeRetentionToDocuments
          ? { legalHold: input.legalHold ? true : undefined, retentionUntil, version: sql`${documents.version} + 1` }
          : { legalHold: true, version: sql`${documents.version} + 1` };
        const [updated, , documentResult] = await db.batch([
          agreementWrite,
          agreementGuard,
          db.update(documents).set(documentUpdate).where(and(
            eq(documents.workspaceId, workspaceId),
            eq(documents.agreementId, input.targetId),
          )),
          db.insert(agreementEvents).values(event),
          db.insert(agreementVersions).values(snapshot),
          ...tombstoneWrite,
          releaseGuard,
        ]);
        if (!updated.meta.changes) return versionConflict(auth.requestId);
        affectedDocuments = documentResult.meta.changes;
      } else {
        const [updated] = await db.batch([
          agreementWrite,
          agreementGuard,
          db.insert(agreementEvents).values(event),
          db.insert(agreementVersions).values(snapshot),
          ...tombstoneWrite,
          releaseGuard,
        ]);
        if (!updated.meta.changes) return versionConflict(auth.requestId);
      }
      return apiJson({
        policy: presentAgreementPolicy(saved),
        affectedDocuments,
        documentHoldPropagation: input.legalHold ? "enforced" : "individual document holds preserved unless retention cascading was requested",
        event,
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    const [current] = await db.select().from(documents).where(and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.id, input.targetId),
    )).limit(1);
    if (!current) return notFound("document", auth.requestId);
    if (current.version !== input.expectedVersion) return versionConflict(auth.requestId);
    const documentPatch = {
      legalHold: input.legalHold,
      retentionUntil,
      version: current.version + 1,
    };
    const saved: typeof documents.$inferSelect = { ...current, ...documentPatch };

    let parentLegalHold = false;
    const documentWrite = db.update(documents).set(documentPatch).where(and(
      eq(documents.workspaceId, workspaceId),
      eq(documents.id, input.targetId),
      eq(documents.version, input.expectedVersion),
      input.legalHold ? sql`not exists (
        select 1 from purge_jobs as hold_cleanup_claim
        where hold_cleanup_claim.workspace_id = ${workspaceId}
          and hold_cleanup_claim.resource_type = 'document'
          and hold_cleanup_claim.resource_id like ${`rejected:${input.targetId}:%`}
          and hold_cleanup_claim.status = 'storage_pending'
          and hold_cleanup_claim.last_error = ${REJECTED_OBJECT_DELETE_CLAIM}
      )` : undefined,
    ));
    const guardId = crypto.randomUUID();
    const documentGuard = db.insert(mutationGuards).values({
      id: guardId,
      workspaceId,
      operation: "retention.policy.document",
      guardChanges: sql<number>`changes()`,
      createdAt: now,
    });
    const releaseGuard = db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, workspaceId),
      eq(mutationGuards.id, guardId),
    ));
    let event: Awaited<ReturnType<typeof prepareAgreementEvent>> | Awaited<ReturnType<typeof prepareWorkspaceEvent>>;
    if (saved.agreementId) {
      const [parent] = await db.select({ legalHold: agreements.legalHold }).from(agreements).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, saved.agreementId),
      )).limit(1);
      parentLegalHold = Boolean(parent?.legalHold);
      if (parent) {
        event = await prepareAgreementEvent(db, {
          workspaceId,
          agreementId: saved.agreementId,
          type: "Records policy",
          detail: `Document ${saved.fileName}: ${policyEventDetail(input.legalHold, retentionUntil, input.reason, false)}`,
          actor: {
            userId: auth.context.user.id,
            email: auth.context.user.email,
            displayName: auth.context.user.displayName,
          },
          createdAt: now,
        });
        const [updated] = await db.batch([documentWrite, documentGuard, db.insert(agreementEvents).values(event), releaseGuard]);
        if (!updated.meta.changes) return versionConflict(auth.requestId);
      } else {
        throw new Error("Document references an unavailable agreement");
      }
    } else {
      event = await prepareWorkspaceEvent(db, {
        workspaceId,
        type: "Records policy",
        detail: `Document ${saved.fileName}: ${policyEventDetail(input.legalHold, retentionUntil, input.reason, false)}`,
        actor: auth.context.user,
        createdAt: now,
      });
      const [updated] = await db.batch([documentWrite, documentGuard, db.insert(workspaceEvents).values(event), releaseGuard]);
      if (!updated.meta.changes) return versionConflict(auth.requestId);
    }
    return apiJson({
      policy: {
        id: saved.id,
        agreementId: saved.agreementId,
        version: saved.version,
        fileName: saved.fileName,
        legalHold: saved.legalHold,
        effectiveLegalHold: saved.legalHold || parentLegalHold,
        retentionUntil: saved.retentionUntil,
        deletedAt: saved.deletedAt,
      },
      event,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    if (isMutationGuardConflict(error)) return versionConflict(auth.requestId);
    if (error instanceof RetentionPolicyError) {
      return apiError("retention_policy_invalid", error.message, { status: 400, requestId: auth.requestId });
    }
    return handleRouteError(error, auth.requestId, "Retention policy could not be updated.");
  }
}

function policyEventDetail(legalHold: boolean, retentionUntil: string | null, reason: string, cascaded: boolean) {
  const cascade = cascaded ? " Applied to linked documents." : "";
  return `Legal hold ${legalHold ? "enabled" : "disabled"}; retention ${retentionUntil ? `set to ${retentionUntil}` : "set to indefinite"}. Reason: ${reason}.${cascade}`;
}

function presentAgreementPolicy(agreement: typeof agreements.$inferSelect) {
  return {
    id: agreement.id,
    version: agreement.version,
    party: agreement.party,
    stage: agreement.stage,
    legalHold: agreement.legalHold,
    retentionUntil: agreement.retentionUntil,
    deletedAt: agreement.deletedAt,
    updatedAt: agreement.updatedAt,
  };
}

function numericSummary(value: { total: number; held: number | null; scheduled: number | null; softDeleted: number | null } | undefined) {
  return {
    total: Number(value?.total ?? 0),
    held: Number(value?.held ?? 0),
    scheduled: Number(value?.scheduled ?? 0),
    softDeleted: Number(value?.softDeleted ?? 0),
  };
}

function safeguards() {
  return {
    defaultPurgeGraceDays: DEFAULT_PURGE_GRACE_DAYS,
    automaticAgreementDeletionStage: "Active",
    explicitRetentionDateRequired: true,
    legalHoldOverridesRetention: true,
  };
}

function invalidTarget(requestId: string) {
  return apiError("retention_target_invalid", "Provide a valid agreementId or documentId.", { status: 400, requestId });
}

function notFound(target: "agreement" | "document", requestId: string) {
  return apiError(`${target}_not_found`, `${target === "agreement" ? "Agreement" : "Document"} was not found.`, { status: 404, requestId });
}

function versionConflict(requestId: string) {
  return apiError("version_conflict", "Reload the record before changing its retention policy.", { status: 409, requestId });
}

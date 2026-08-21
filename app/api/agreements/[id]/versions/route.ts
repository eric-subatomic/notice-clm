import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { agreementDocumentVersions, agreementEvents, agreements, agreementVersions, approvalRequests, documents, mutationGuards, negotiationRounds, outboxEvents, signaturePackets } from "../../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../../lib/api";
import { computeAgreementBasisHash } from "../../../../lib/agreement-basis";
import { evaluateAgreementRiskReadiness } from "../../../../lib/agreement-risk";
import { sha256Hex } from "../../../../lib/document-security";
import { apiError, apiJson } from "../../../../lib/http";
import { prepareAgreementLifecycleUpdatedIntegrationEvent } from "../../../../lib/integration-events";
import { NEGOTIATION_BASE_SOURCE_ROLES } from "../../../../lib/negotiation-baseline";
import { findActiveAgreement, isMutationGuardConflict, prepareAgreementEvent, prepareAgreementSnapshot, prepareOutboxEvent } from "../../../../lib/persistence";
import { cleanupStagedWorkingVersionObject, type StagedObjectIdentity } from "../../../../lib/staged-object-cleanup";
import { documentVersionSchema, parseJson } from "../../../../lib/validation";

type VersionEnv = { DOCUMENTS: R2Bucket };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "document:read");
  if (!auth.ok) return auth.response;
  try {
    const agreementId = Number((await context.params).id);
    if (!Number.isSafeInteger(agreementId) || agreementId <= 0) return notFound(auth.requestId);
    await ensureStorageSchema();
    const db = getDb();
    const agreement = await findActiveAgreement(db, auth.context.workspace.id, agreementId);
    if (!agreement) return notFound(auth.requestId);
    const versionParameter = new URL(request.url).searchParams.get("version");
    if (versionParameter !== null && (!/^[1-9]\d*$/.test(versionParameter) || !Number.isSafeInteger(Number(versionParameter)))) {
      return apiError("invalid_version", "Document version must be a positive whole number.", { status: 400, requestId: auth.requestId });
    }
    const requestedVersion = Number(versionParameter ?? "0");
    if (requestedVersion > 0) {
      const [version] = await db.select().from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
        eq(agreementDocumentVersions.agreementId, agreementId),
        eq(agreementDocumentVersions.version, requestedVersion),
      )).limit(1);
      if (!version) return apiError("version_not_found", "Document version was not found.", { status: 404, requestId: auth.requestId });
      const object = await (env as unknown as VersionEnv).DOCUMENTS.get(version.objectKey);
      if (!object) return apiError("version_bytes_missing", "Document version content is unavailable.", { status: 410, requestId: auth.requestId });
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== version.size || await sha256Hex(bytes) !== version.sha256) {
        return apiError("version_integrity_failure", "Document version content failed its integrity check.", { status: 409, requestId: auth.requestId });
      }
      const headers = new Headers(auth.headers);
      headers.set("Cache-Control", "private, no-store, max-age=0");
      headers.set("Content-Type", version.contentType);
      headers.set("Content-Length", String(bytes.byteLength));
      headers.set("Content-Disposition", `attachment; filename="agreement-${agreementId}-v${version.version}.txt"`);
      headers.set("Content-Security-Policy", "sandbox");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Request-Id", auth.requestId);
      return new Response(bytes, { headers });
    }

    const [rows, sourceDocuments] = await Promise.all([
      db.select({
        id: agreementDocumentVersions.id,
        agreementId: agreementDocumentVersions.agreementId,
        version: agreementDocumentVersions.version,
        label: agreementDocumentVersions.label,
        contentType: agreementDocumentVersions.contentType,
        size: agreementDocumentVersions.size,
        sha256: agreementDocumentVersions.sha256,
        sourceDocumentId: agreementDocumentVersions.sourceDocumentId,
        createdByUserId: agreementDocumentVersions.createdByUserId,
        createdAt: agreementDocumentVersions.createdAt,
      }).from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
        eq(agreementDocumentVersions.agreementId, agreementId),
      )).orderBy(desc(agreementDocumentVersions.version)),
      db.select({
        id: documents.id,
        fileName: documents.fileName,
        contentType: documents.contentType,
        size: documents.size,
        sha256: documents.sha256,
        scanStatus: documents.scanStatus,
        createdAt: documents.createdAt,
      }).from(documents).where(and(
        eq(documents.workspaceId, auth.context.workspace.id),
        eq(documents.agreementId, agreementId),
        inArray(documents.role, NEGOTIATION_BASE_SOURCE_ROLES),
        eq(documents.direction, "inbound"),
        isNull(documents.negotiationRoundId),
        isNull(documents.deletedAt),
      )).orderBy(desc(documents.createdAt)),
    ]);
    const currentWorkingVersion = rows[0] ?? null;
    const riskReadiness = currentWorkingVersion
      ? await evaluateAgreementRiskReadiness(agreement, currentWorkingVersion)
      : null;
    const workflowBasis = currentWorkingVersion ? {
      agreementVersion: agreement.version,
      riskAssessment: {
        basisHash: riskReadiness!.basisHash,
        documentVersion: currentWorkingVersion.version,
        documentSha256: currentWorkingVersion.sha256,
      },
      approval: {
        basisHash: await computeAgreementBasisHash(agreement, currentWorkingVersion),
        documentVersion: currentWorkingVersion.version,
        documentSha256: currentWorkingVersion.sha256,
      },
    } : null;
    const riskEvaluation = riskReadiness?.evaluation ?? null;
    return apiJson({ versions: rows, sourceDocuments, workflowBasis, riskEvaluation, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Document versions could not be loaded.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "document:manage", { limit: 30 });
  if (!auth.ok) return auth.response;
  let stagedVersion: StagedObjectIdentity | null = null;
  let agreementId: number | null = null;
  try {
    agreementId = Number((await context.params).id);
    if (!Number.isSafeInteger(agreementId) || agreementId <= 0) return notFound(auth.requestId);
    const input = await parseJson(request, documentVersionSchema, 2_100_000);
    await ensureStorageSchema();
    const db = getDb();
    const agreement = await findActiveAgreement(db, auth.context.workspace.id, agreementId);
    if (!agreement) return notFound(auth.requestId);
    if (agreement.version !== input.expectedAgreementVersion) return apiError("version_conflict", "Reload the agreement before creating a document version.", { status: 409, requestId: auth.requestId });
    if (agreement.stage === "Active" || agreement.signatureStatus === "Completed") {
      return apiError("executed_agreement_immutable", "Executed agreements are immutable. Create an amendment or replacement agreement instead.", { status: 409, requestId: auth.requestId });
    }
    const [activePacket] = await db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
      eq(signaturePackets.workspaceId, auth.context.workspace.id),
      eq(signaturePackets.agreementId, agreementId),
      inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
    )).limit(1);
    if (activePacket) return apiError("signature_packet_active", "Cancel or resolve the active signature packet before changing the working paper.", { status: 409, requestId: auth.requestId });
    const [activeNegotiationRound] = await db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, auth.context.workspace.id),
      eq(negotiationRounds.agreementId, agreementId),
      isNotNull(negotiationRounds.activeKey),
    )).limit(1);
    if (activeNegotiationRound) {
      return apiError("negotiation_round_unresolved", "Resolve or close the current counterparty review round before changing the working paper.", { status: 409, requestId: auth.requestId });
    }
    const [last] = await db.select({ version: agreementDocumentVersions.version }).from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
      eq(agreementDocumentVersions.agreementId, agreementId),
    )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
    const versionNumber = (last?.version ?? 0) + 1;
    const bytes = new TextEncoder().encode(input.content);
    const sha256 = await sha256Hex(bytes);
    const versionId = crypto.randomUUID();
    const objectKey = `workspaces/${auth.context.workspace.id}/agreements/${agreementId}/versions/${versionNumber}/${versionId}.txt`;
    stagedVersion = { workspaceId: auth.context.workspace.id, id: versionId, objectKey, sha256 };
    await (env as unknown as VersionEnv).DOCUMENTS.put(objectKey, bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { agreementId: String(agreementId), version: String(versionNumber), sha256 },
    });
    const now = new Date().toISOString();
    const record = {
      id: versionId,
      workspaceId: auth.context.workspace.id,
      agreementId,
      version: versionNumber,
      label: input.label,
      objectKey,
      contentType: input.contentType,
      size: bytes.byteLength,
      sha256,
      sourceDocumentId: null,
      createdByUserId: auth.context.user.id,
      createdAt: now,
    };
    const nextAction = "Assess risk for the updated working paper";
    const agreementPatch = {
      version: agreement.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: auth.context.user.id,
      nextAction,
      approvalStatus: "Required",
      stage: agreement.stage === "Signature" ? "Negotiation" : agreement.stage,
      signatureStatus: "Not sent",
      risk: "Unassessed",
      riskDisposition: null,
      riskBasisHash: null,
      riskDocumentVersion: null,
      riskDocumentSha256: null,
      riskDecisionReason: null,
      riskDecidedByUserId: null,
      riskDecidedAt: null,
    };
    const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
    const event = await prepareAgreementEvent(db, {
      workspaceId: auth.context.workspace.id,
      agreementId,
      type: "Version",
      detail: `Created document version ${versionNumber}: ${input.label}. Prior risk evidence and approvals were superseded because the working paper changed.`,
      actor: auth.context.user,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, auth.context.user.id, event.id);
    const agreementIntegrationEvent = prepareAgreementLifecycleUpdatedIntegrationEvent({
      before: agreement,
      agreement: saved,
      candidateFields: ["approvalStatus", "signatureStatus", "stage"],
      causationId: auth.requestId,
    });
    const outbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
    const guardId = crypto.randomUUID();
    await db.batch([
      db.update(agreements).set(agreementPatch).where(and(
        eq(agreements.workspaceId, auth.context.workspace.id),
        eq(agreements.id, agreementId),
        eq(agreements.version, agreement.version),
        eq(agreements.nextAction, agreement.nextAction),
        isNull(agreements.deletedAt),
        notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
          eq(negotiationRounds.workspaceId, auth.context.workspace.id),
          eq(negotiationRounds.agreementId, agreementId),
          isNotNull(negotiationRounds.activeKey),
        ))),
        notExists(db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
          eq(signaturePackets.workspaceId, auth.context.workspace.id),
          eq(signaturePackets.agreementId, agreementId),
          inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
        ))),
      )),
      db.insert(mutationGuards).values({ id: guardId, workspaceId: auth.context.workspace.id, operation: "agreement.document_version", guardChanges: sql<number>`changes()`, createdAt: now }),
      db.insert(agreementDocumentVersions).values(record),
      db.update(approvalRequests).set({ status: "Superseded", version: sql`${approvalRequests.version} + 1` }).where(and(
        eq(approvalRequests.workspaceId, auth.context.workspace.id),
        eq(approvalRequests.agreementId, agreementId),
        inArray(approvalRequests.status, ["Pending", "Approved", "Changes requested"]),
      )),
      db.insert(agreementEvents).values(event),
      db.insert(agreementVersions).values(snapshot),
      ...(outbox ? [db.insert(outboxEvents).values(outbox)] : []),
      db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, auth.context.workspace.id), eq(mutationGuards.id, guardId))),
    ]);
    stagedVersion = null;
    return apiJson({ version: { ...record, objectKey: undefined }, agreement: saved, event, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    if (stagedVersion) {
      try {
        await cleanupStagedWorkingVersionObject(getDb(), (env as unknown as VersionEnv).DOCUMENTS, stagedVersion);
      } catch {
        // An unavailable D1 binding is an unknown commit state. Retain R2 for reconciliation.
      }
    }
    if (isMutationGuardConflict(error)) {
      if (agreementId) {
        try {
          const [[activeNegotiationRound], [activePacket]] = await Promise.all([
            getDb().select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
              eq(negotiationRounds.workspaceId, auth.context.workspace.id),
              eq(negotiationRounds.agreementId, agreementId),
              isNotNull(negotiationRounds.activeKey),
            )).limit(1),
            getDb().select({ id: signaturePackets.id }).from(signaturePackets).where(and(
              eq(signaturePackets.workspaceId, auth.context.workspace.id),
              eq(signaturePackets.agreementId, agreementId),
              inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
            )).limit(1),
          ]);
          if (activeNegotiationRound) {
            return apiError("negotiation_round_unresolved", "Resolve or close the current counterparty review round before changing the working paper.", { status: 409, requestId: auth.requestId });
          }
          if (activePacket) {
            return apiError("signature_packet_active", "Cancel or resolve the active signature packet before changing the working paper.", { status: 409, requestId: auth.requestId });
          }
        } catch { /* the generic concurrency response below remains fail-closed */ }
      }
      return apiError("version_conflict", "Reload the agreement before creating a document version.", { status: 409, requestId: auth.requestId });
    }
    return handleRouteError(error, auth.requestId, "Document version could not be created.");
  }
}

function notFound(requestId: string) {
  return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId });
}

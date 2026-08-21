import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import {
  agentActionExecutions,
  agentActionPlans,
  agentPlanDecisions,
  agreementDocumentVersions,
  agreementEvents,
  agreements,
  agreementVersions,
  approvalRequests,
  documentComparisons,
  documents,
  negotiationRounds,
  negotiationSubmissions,
  obligationEvidence,
  obligationSchedules,
  obligations,
  signaturePackets,
  webhookReceipts,
} from "../../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../../lib/api";
import { getNoticeConfig } from "../../../../lib/config";
import { hmacSha256Hex, sha256Hex } from "../../../../lib/document-security";
import { apiError } from "../../../../lib/http";
import {
  sanitizeAgentActionExecution,
  sanitizeAgentActionPlan,
  verifyAgentEvidenceClosure,
} from "../../../../lib/export-evidence";
import { verifyAgreementEventChain } from "../../../../lib/persistence";
import { getAuditSigningKey } from "../../../../lib/providers";
import { sanitizeSignaturePacket } from "../../../../lib/signature-evidence";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "audit:read", { limit: 20 });
  if (!auth.ok) return auth.response;
  try {
    const agreementId = Number((await context.params).id);
    if (!Number.isSafeInteger(agreementId) || agreementId <= 0) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    // D1 executes a batch as one transaction. Keep every row that contributes
    // to the signed envelope in this single read snapshot so a concurrent
    // agreement/provider/agent mutation cannot produce a torn attestation.
    const [
      agreementRows,
      events,
      versions,
      documentVersions,
      approvals,
      obligationScheduleRows,
      obligationRows,
      obligationEvidenceRows,
      documentRows,
      packets,
      roundRows,
      submissionRows,
      comparisonRows,
      receiptRows,
      candidateAgentPlans,
      candidateAgentDecisions,
      candidateAgentExecutions,
    ] = await db.batch([
      // Human audit readers retain access throughout the soft-delete grace
      // period. Machine/discovery routes continue to collapse tombstones.
      db.select().from(agreements).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, agreementId),
      )).limit(1),
      db.select().from(agreementEvents).where(and(eq(agreementEvents.workspaceId, workspaceId), eq(agreementEvents.agreementId, agreementId))).orderBy(agreementEvents.sequence),
      db.select().from(agreementVersions).where(and(eq(agreementVersions.workspaceId, workspaceId), eq(agreementVersions.agreementId, agreementId))).orderBy(agreementVersions.version),
      db.select({
        id: agreementDocumentVersions.id,
        version: agreementDocumentVersions.version,
        label: agreementDocumentVersions.label,
        contentType: agreementDocumentVersions.contentType,
        size: agreementDocumentVersions.size,
        sha256: agreementDocumentVersions.sha256,
        sourceDocumentId: agreementDocumentVersions.sourceDocumentId,
        createdByUserId: agreementDocumentVersions.createdByUserId,
        createdAt: agreementDocumentVersions.createdAt,
      }).from(agreementDocumentVersions).where(and(eq(agreementDocumentVersions.workspaceId, workspaceId), eq(agreementDocumentVersions.agreementId, agreementId))).orderBy(agreementDocumentVersions.version),
      db.select().from(approvalRequests).where(and(eq(approvalRequests.workspaceId, workspaceId), eq(approvalRequests.agreementId, agreementId))).orderBy(approvalRequests.createdAt),
      db.select().from(obligationSchedules).where(and(eq(obligationSchedules.workspaceId, workspaceId), eq(obligationSchedules.agreementId, agreementId))).orderBy(obligationSchedules.createdAt, obligationSchedules.id),
      db.select().from(obligations).where(and(eq(obligations.workspaceId, workspaceId), eq(obligations.agreementId, agreementId))).orderBy(obligations.dueDate, obligations.scheduleId, obligations.occurrenceNumber),
      db.select({
        id: obligationEvidence.id,
        workspaceId: obligationEvidence.workspaceId,
        agreementId: obligationEvidence.agreementId,
        obligationId: obligationEvidence.obligationId,
        evidenceText: obligationEvidence.evidenceText,
        evidenceSha256: obligationEvidence.evidenceSha256,
        submittedByUserId: obligationEvidence.submittedByUserId,
        overrideReason: obligationEvidence.overrideReason,
        provenance: obligationEvidence.provenance,
        createdAt: obligationEvidence.createdAt,
      }).from(obligationEvidence).where(and(eq(obligationEvidence.workspaceId, workspaceId), eq(obligationEvidence.agreementId, agreementId))).orderBy(obligationEvidence.createdAt, obligationEvidence.id),
      db.select({
        id: documents.id,
        version: documents.version,
        role: documents.role,
        direction: documents.direction,
        negotiationRoundId: documents.negotiationRoundId,
        providerMessageId: documents.providerMessageId,
        parentSha256: documents.parentSha256,
        originalSenderEmail: documents.originalSenderEmail,
        fileName: documents.fileName,
        contentType: documents.contentType,
        size: documents.size,
        sha256: documents.sha256,
        scanStatus: documents.scanStatus,
        scanProvider: documents.scanProvider,
        scannedAt: documents.scannedAt,
        createdAt: documents.createdAt,
        legalHold: documents.legalHold,
        retentionUntil: documents.retentionUntil,
      }).from(documents).where(and(eq(documents.workspaceId, workspaceId), eq(documents.agreementId, agreementId))),
      db.select().from(signaturePackets).where(and(eq(signaturePackets.workspaceId, workspaceId), eq(signaturePackets.agreementId, agreementId))).orderBy(signaturePackets.createdAt),
      db.select({
        id: negotiationRounds.id,
        roundNumber: negotiationRounds.roundNumber,
        status: negotiationRounds.status,
        counterpartyEmail: negotiationRounds.counterpartyEmail,
        counterpartyName: negotiationRounds.counterpartyName,
        baseDocumentVersion: negotiationRounds.baseDocumentVersion,
        baseDocumentId: negotiationRounds.baseDocumentId,
        baseSha256: negotiationRounds.baseSha256,
        outboundDocumentId: negotiationRounds.outboundDocumentId,
        outboundSha256: negotiationRounds.outboundSha256,
        portalExpiresAt: negotiationRounds.portalExpiresAt,
        deliveryMethod: negotiationRounds.deliveryMethod,
        providerMessageId: negotiationRounds.providerMessageId,
        resolvedDocumentVersion: negotiationRounds.resolvedDocumentVersion,
        resolvedSha256: negotiationRounds.resolvedSha256,
        createdByUserId: negotiationRounds.createdByUserId,
        createdAt: negotiationRounds.createdAt,
        updatedAt: negotiationRounds.updatedAt,
        sentAt: negotiationRounds.sentAt,
        resolvedAt: negotiationRounds.resolvedAt,
        closedAt: negotiationRounds.closedAt,
      }).from(negotiationRounds).where(and(eq(negotiationRounds.workspaceId, workspaceId), eq(negotiationRounds.agreementId, agreementId))).orderBy(negotiationRounds.roundNumber),
      db.select({
        id: negotiationSubmissions.id,
        roundId: negotiationSubmissions.roundId,
        source: negotiationSubmissions.source,
        status: negotiationSubmissions.status,
        senderEmail: negotiationSubmissions.senderEmail,
        senderName: negotiationSubmissions.senderName,
        providerMessageId: negotiationSubmissions.providerMessageId,
        documentId: negotiationSubmissions.documentId,
        documentSha256: negotiationSubmissions.documentSha256,
        reviewTextSha256: negotiationSubmissions.reviewTextSha256,
        reviewTextSize: negotiationSubmissions.reviewTextSize,
        reviewTextProvenance: negotiationSubmissions.reviewTextProvenance,
        reviewedByUserId: negotiationSubmissions.reviewedByUserId,
        reviewedAt: negotiationSubmissions.reviewedAt,
        decisionNote: negotiationSubmissions.decisionNote,
        createdAt: negotiationSubmissions.createdAt,
      }).from(negotiationSubmissions).where(and(eq(negotiationSubmissions.workspaceId, workspaceId), eq(negotiationSubmissions.agreementId, agreementId))).orderBy(negotiationSubmissions.createdAt),
      db.select().from(documentComparisons).where(and(eq(documentComparisons.workspaceId, workspaceId), eq(documentComparisons.agreementId, agreementId))).orderBy(documentComparisons.createdAt),
      db.select({
        provider: webhookReceipts.provider,
        providerEventId: webhookReceipts.providerEventId,
        payloadDigest: webhookReceipts.payloadDigest,
        aggregateId: webhookReceipts.aggregateId,
        status: webhookReceipts.status,
        receivedAt: webhookReceipts.receivedAt,
        processedAt: webhookReceipts.processedAt,
        error: webhookReceipts.error,
      }).from(webhookReceipts).innerJoin(negotiationRounds, and(
        eq(webhookReceipts.workspaceId, negotiationRounds.workspaceId),
        eq(webhookReceipts.aggregateType, "negotiation_round"),
        eq(webhookReceipts.aggregateId, negotiationRounds.id),
      )).where(and(
        eq(negotiationRounds.workspaceId, workspaceId),
        eq(negotiationRounds.agreementId, agreementId),
      )).orderBy(webhookReceipts.receivedAt),
      db.select().from(agentActionPlans).where(and(
        eq(agentActionPlans.workspaceId, workspaceId),
        eq(agentActionPlans.agreementId, agreementId),
      )).orderBy(agentActionPlans.createdAt, agentActionPlans.id),
      db.select({ decision: agentPlanDecisions }).from(agentPlanDecisions).innerJoin(agentActionPlans, and(
        eq(agentPlanDecisions.workspaceId, agentActionPlans.workspaceId),
        eq(agentPlanDecisions.planId, agentActionPlans.id),
      )).where(and(
        eq(agentActionPlans.workspaceId, workspaceId),
        eq(agentActionPlans.agreementId, agreementId),
      )).orderBy(agentPlanDecisions.decidedAt, agentPlanDecisions.id),
      db.select({ execution: agentActionExecutions }).from(agentActionExecutions).innerJoin(agentActionPlans, and(
        eq(agentActionExecutions.workspaceId, agentActionPlans.workspaceId),
        eq(agentActionExecutions.planId, agentActionPlans.id),
      )).where(and(
        eq(agentActionPlans.workspaceId, workspaceId),
        eq(agentActionPlans.agreementId, agreementId),
      )).orderBy(agentActionExecutions.startedAt, agentActionExecutions.id),
    ]);
    const agreement = agreementRows[0];
    if (!agreement) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    const chain = await verifyAgreementEventChain(events);
    if (!chain.valid) return apiError("audit_integrity_failure", "Audit integrity verification failed. Export has been stopped.", { status: 409, requestId: auth.requestId });

    const sourceAgentPlanReferences = [
      ...approvals.flatMap((approval) => approval.sourceAgentPlanId
        ? [{ agreementId, planId: approval.sourceAgentPlanId }]
        : []),
      ...events.flatMap((event) => event.sourceAgentPlanId
        ? [{ agreementId, planId: event.sourceAgentPlanId }]
        : []),
    ];
    const referencedAgentPlanIds = new Set(sourceAgentPlanReferences.map((reference) => reference.planId));
    const agentPlanRows = candidateAgentPlans.filter((plan) => referencedAgentPlanIds.has(plan.id));
    const agentPlanDecisionRows = candidateAgentDecisions.map(({ decision }) => decision)
      .filter((decision) => referencedAgentPlanIds.has(decision.planId));
    const agentActionExecutionRows = candidateAgentExecutions.map(({ execution }) => execution)
      .filter((execution) => referencedAgentPlanIds.has(execution.planId));
    const agentEvidenceClosure = verifyAgentEvidenceClosure({
      workspaceId,
      servicePrincipals: [],
      grants: [],
      runs: [],
      plans: agentPlanRows,
      decisions: agentPlanDecisionRows,
      executions: agentActionExecutionRows,
      agreementEvents: events,
      sourcePlanReferences: sourceAgentPlanReferences,
      scopedAgreementId: agreementId,
    });
    if (!agentEvidenceClosure.valid) {
      return apiError("export_referential_integrity_failure", "Agreement audit export stopped because attributed agent evidence is not referentially complete.", {
        status: 409,
        requestId: auth.requestId,
      });
    }

    const generatedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: "1.0",
      generatedAt,
      generatedBy: { userId: auth.context.user.id, email: auth.context.user.email, displayName: auth.context.user.displayName },
      workspace: auth.context.workspace,
      agreement,
      versions,
      documentVersions,
      approvals,
      counts: {
        obligationSchedules: obligationScheduleRows.length,
        obligationOccurrences: obligationRows.length,
        obligationEvidence: obligationEvidenceRows.length,
        agentActionPlans: agentPlanRows.length,
        agentPlanDecisions: agentPlanDecisionRows.length,
        agentActionExecutions: agentActionExecutionRows.length,
      },
      obligationSchedules: obligationScheduleRows,
      // `obligations` is retained as the stable response key; under schema v17
      // each row is an immutable materialized occurrence.
      obligations: obligationRows,
      obligationEvidence: obligationEvidenceRows,
      documents: documentRows,
      negotiationRounds: roundRows,
      negotiationSubmissions: submissionRows,
      documentComparisons: comparisonRows,
      negotiationInboundReceipts: receiptRows,
      signaturePackets: packets.map(sanitizeSignaturePacket),
      agentActionPlans: agentPlanRows.map(sanitizeAgentActionPlan),
      agentPlanDecisions: agentPlanDecisionRows,
      agentActionExecutions: agentActionExecutionRows.map(sanitizeAgentActionExecution),
      audit: { chain, events, agentEvidenceClosure },
    };
    const evidenceJson = JSON.stringify(evidence);
    const payloadSha256 = await sha256Hex(evidenceJson);
    const signingKey = getAuditSigningKey(getNoticeConfig().mode === "production");
    const envelope = {
      evidence,
      integrity: {
        algorithm: "SHA-256",
        payloadSha256,
        signatureAlgorithm: signingKey ? "HMAC-SHA256" : null,
        signature: signingKey ? await hmacSha256Hex(signingKey, payloadSha256) : null,
        auditHeadHash: chain.headHash,
      },
    };
    const body = JSON.stringify(envelope, null, 2);
    const headers = new Headers(auth.headers);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="notice-agreement-${agreementId}-audit.json"`);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Request-Id", auth.requestId);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Audit evidence could not be exported.");
  }
}

import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import {
  agentActionExecutions,
  agentActionPlans,
  agentGrants,
  agentPlanDecisions,
  agentRuns,
  agreementDocumentVersions,
  agreementEvents,
  agreementParties,
  agreementRelationships,
  agreements,
  agreementVersions,
  approvalLaneAuthorities,
  approvalRequests,
  clausePlaybooks,
  clausePlaybookVersions,
  counterparties,
  crmLegacyCleanupAttestations,
  customFieldDefinitions,
  customFieldValues,
  documentComparisons,
  documents,
  extractionProposalCitations,
  extractionProposals,
  governedTemplates,
  governedTemplateVersions,
  ingestionBatches,
  ingestionItems,
  integrationDiagnostics,
  intakeForms,
  intakeSubmissions,
  languageBlocks,
  legalEntities,
  negotiationRounds,
  negotiationSubmissions,
  obligationCreationReceipts,
  obligationEvidence,
  obligationSchedules,
  obligations,
  outboxDeliveries,
  outboxEvents,
  purgeJobs,
  repositoryFragments,
  savedViews,
  servicePrincipals,
  signaturePackets,
  users,
  webhookReceipts,
  workflowDefinitions,
  workspaceEvents,
  workspaceGroupMembers,
  workspaceGroups,
  workspaceMemberships,
  workspaces,
} from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import { hmacSha256Hex, sha256Hex } from "../../../lib/document-security";
import { isDocumentReadable } from "../../../lib/document-access";
import { apiError } from "../../../lib/http";
import {
  sanitizeAgentActionExecution,
  sanitizeAgentActionPlan,
  sanitizeIngestionBatch,
  sanitizeIntegrationDiagnostic,
  sanitizePurgeJob,
  verifyAgentEvidenceClosure,
} from "../../../lib/export-evidence";
import { verifyAgreementEventChain } from "../../../lib/persistence";
import { getAuditSigningKey } from "../../../lib/providers";
import { isWorkspaceObjectKey } from "../../../lib/records-governance";
import { sanitizeSignaturePacket } from "../../../lib/signature-evidence";
import { verifyWorkspaceEventChain } from "../../../lib/workspace-audit";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 6, windowMs: 60_000 });
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    // D1 batches execute transactionally. Read the complete signed export in
    // one snapshot so concurrent application, provider, agent, or retention
    // writes cannot produce a valid HMAC over a torn cross-table view.
    const [
      workspaceRows,
      memberRows,
      workspaceEventRows,
      agreementRows,
      eventRows,
      versionRows,
      documentRows,
      documentVersionRows,
      approvalRows,
      obligationScheduleRows,
      obligationRows,
      obligationEvidenceRows,
      obligationCreationReceiptCountRows,
      languageRows,
      packetRows,
      webhookRows,
      outboxRows,
      outboxDeliveryRows,
      crmLegacyCleanupRows,
      negotiationRoundRows,
      negotiationSubmissionRows,
      comparisonRows,
      workspaceGroupRows,
      workspaceGroupMemberRows,
      legalEntityRows,
      counterpartyRows,
      customFieldDefinitionRows,
      customFieldValueRows,
      governedTemplateRows,
      governedTemplateVersionRows,
      workflowDefinitionRows,
      approvalAuthorityRows,
      intakeFormRows,
      intakeSubmissionRows,
      savedViewRows,
      agreementPartyRows,
      agreementRelationshipRows,
      clausePlaybookRows,
      clausePlaybookVersionRows,
      ingestionBatchRows,
      ingestionItemRows,
      repositoryFragmentRows,
      extractionProposalRows,
      extractionProposalCitationRows,
      purgeJobRows,
      integrationDiagnosticRows,
      servicePrincipalRows,
      agentGrantRows,
      agentRunRows,
      agentPlanRows,
      agentPlanDecisionRows,
      agentActionExecutionRows,
    ] = await db.batch([
      db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
      db.select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        userStatus: users.status,
        role: workspaceMemberships.role,
        membershipStatus: workspaceMemberships.status,
        memberSince: workspaceMemberships.createdAt,
        membershipUpdatedAt: workspaceMemberships.updatedAt,
        lastSeenAt: users.lastSeenAt,
      }).from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(
        eq(workspaceMemberships.workspaceId, workspaceId),
      ).orderBy(asc(users.email)),
      db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, workspaceId)).orderBy(asc(workspaceEvents.sequence)),
      db.select().from(agreements).where(eq(agreements.workspaceId, workspaceId)).orderBy(asc(agreements.id)),
      db.select().from(agreementEvents).where(eq(agreementEvents.workspaceId, workspaceId)).orderBy(
        asc(agreementEvents.agreementId),
        asc(agreementEvents.sequence),
      ),
      db.select().from(agreementVersions).where(eq(agreementVersions.workspaceId, workspaceId)).orderBy(
        asc(agreementVersions.agreementId),
        asc(agreementVersions.version),
      ),
      db.select().from(documents).where(eq(documents.workspaceId, workspaceId)).orderBy(asc(documents.createdAt), asc(documents.id)),
      db.select().from(agreementDocumentVersions).where(eq(agreementDocumentVersions.workspaceId, workspaceId)).orderBy(
        asc(agreementDocumentVersions.agreementId),
        asc(agreementDocumentVersions.version),
      ),
      db.select().from(approvalRequests).where(eq(approvalRequests.workspaceId, workspaceId)).orderBy(
        asc(approvalRequests.agreementId),
        asc(approvalRequests.createdAt),
      ),
      db.select().from(obligationSchedules).where(eq(obligationSchedules.workspaceId, workspaceId)).orderBy(
        asc(obligationSchedules.agreementId),
        asc(obligationSchedules.createdAt),
        asc(obligationSchedules.id),
      ),
      db.select().from(obligations).where(eq(obligations.workspaceId, workspaceId)).orderBy(
        asc(obligations.agreementId),
        asc(obligations.dueDate),
      ),
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
      }).from(obligationEvidence).where(eq(obligationEvidence.workspaceId, workspaceId)).orderBy(
        asc(obligationEvidence.agreementId),
        asc(obligationEvidence.createdAt),
        asc(obligationEvidence.id),
      ),
      db.select({ count: sql<number>`count(*)` }).from(obligationCreationReceipts).where(
        eq(obligationCreationReceipts.workspaceId, workspaceId),
      ),
      db.select().from(languageBlocks).where(eq(languageBlocks.workspaceId, workspaceId)).orderBy(asc(languageBlocks.id)),
      db.select().from(signaturePackets).where(eq(signaturePackets.workspaceId, workspaceId)).orderBy(
        asc(signaturePackets.agreementId),
        asc(signaturePackets.createdAt),
      ),
      db.select().from(webhookReceipts).where(eq(webhookReceipts.workspaceId, workspaceId)).orderBy(asc(webhookReceipts.receivedAt)),
      db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId)).orderBy(asc(outboxEvents.createdAt)),
      db.select().from(outboxDeliveries).where(eq(outboxDeliveries.workspaceId, workspaceId)).orderBy(asc(outboxDeliveries.createdAt), asc(outboxDeliveries.eventId)),
      db.select().from(crmLegacyCleanupAttestations).where(eq(crmLegacyCleanupAttestations.workspaceId, workspaceId)).orderBy(asc(crmLegacyCleanupAttestations.createdAt), asc(crmLegacyCleanupAttestations.eventId)),
      db.select().from(negotiationRounds).where(eq(negotiationRounds.workspaceId, workspaceId)).orderBy(asc(negotiationRounds.agreementId), asc(negotiationRounds.roundNumber)),
      db.select().from(negotiationSubmissions).where(eq(negotiationSubmissions.workspaceId, workspaceId)).orderBy(asc(negotiationSubmissions.agreementId), asc(negotiationSubmissions.createdAt)),
      db.select().from(documentComparisons).where(eq(documentComparisons.workspaceId, workspaceId)).orderBy(asc(documentComparisons.agreementId), asc(documentComparisons.createdAt)),
      db.select().from(workspaceGroups).where(eq(workspaceGroups.workspaceId, workspaceId)).orderBy(asc(workspaceGroups.id)),
      db.select().from(workspaceGroupMembers).where(eq(workspaceGroupMembers.workspaceId, workspaceId)).orderBy(asc(workspaceGroupMembers.groupId), asc(workspaceGroupMembers.userId)),
      db.select().from(legalEntities).where(eq(legalEntities.workspaceId, workspaceId)).orderBy(asc(legalEntities.id)),
      db.select().from(counterparties).where(eq(counterparties.workspaceId, workspaceId)).orderBy(asc(counterparties.id)),
      db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.workspaceId, workspaceId)).orderBy(asc(customFieldDefinitions.id)),
      db.select().from(customFieldValues).where(eq(customFieldValues.workspaceId, workspaceId)).orderBy(asc(customFieldValues.id)),
      db.select().from(governedTemplates).where(eq(governedTemplates.workspaceId, workspaceId)).orderBy(asc(governedTemplates.id)),
      db.select().from(governedTemplateVersions).where(eq(governedTemplateVersions.workspaceId, workspaceId)).orderBy(asc(governedTemplateVersions.templateId), asc(governedTemplateVersions.version)),
      db.select().from(workflowDefinitions).where(eq(workflowDefinitions.workspaceId, workspaceId)).orderBy(asc(workflowDefinitions.name), asc(workflowDefinitions.version)),
      db.select().from(approvalLaneAuthorities).where(eq(approvalLaneAuthorities.workspaceId, workspaceId)).orderBy(asc(approvalLaneAuthorities.lane), asc(approvalLaneAuthorities.id)),
      db.select().from(intakeForms).where(eq(intakeForms.workspaceId, workspaceId)).orderBy(asc(intakeForms.id)),
      db.select().from(intakeSubmissions).where(eq(intakeSubmissions.workspaceId, workspaceId)).orderBy(asc(intakeSubmissions.createdAt), asc(intakeSubmissions.id)),
      db.select().from(savedViews).where(eq(savedViews.workspaceId, workspaceId)).orderBy(asc(savedViews.ownerUserId), asc(savedViews.id)),
      db.select().from(agreementParties).where(eq(agreementParties.workspaceId, workspaceId)).orderBy(asc(agreementParties.agreementId), asc(agreementParties.id)),
      db.select().from(agreementRelationships).where(eq(agreementRelationships.workspaceId, workspaceId)).orderBy(asc(agreementRelationships.sourceAgreementId), asc(agreementRelationships.id)),
      db.select().from(clausePlaybooks).where(eq(clausePlaybooks.workspaceId, workspaceId)).orderBy(asc(clausePlaybooks.id)),
      db.select().from(clausePlaybookVersions).where(eq(clausePlaybookVersions.workspaceId, workspaceId)).orderBy(asc(clausePlaybookVersions.playbookId), asc(clausePlaybookVersions.version)),
      db.select().from(ingestionBatches).where(eq(ingestionBatches.workspaceId, workspaceId)).orderBy(asc(ingestionBatches.createdAt), asc(ingestionBatches.id)),
      db.select().from(ingestionItems).where(eq(ingestionItems.workspaceId, workspaceId)).orderBy(asc(ingestionItems.batchId), asc(ingestionItems.ordinal)),
      db.select().from(repositoryFragments).where(eq(repositoryFragments.workspaceId, workspaceId)).orderBy(asc(repositoryFragments.documentVersionId), asc(repositoryFragments.ordinal)),
      db.select().from(extractionProposals).where(eq(extractionProposals.workspaceId, workspaceId)).orderBy(asc(extractionProposals.createdAt), asc(extractionProposals.id)),
      db.select().from(extractionProposalCitations).where(eq(extractionProposalCitations.workspaceId, workspaceId)).orderBy(asc(extractionProposalCitations.proposalId), asc(extractionProposalCitations.id)),
      db.select().from(purgeJobs).where(eq(purgeJobs.workspaceId, workspaceId)).orderBy(asc(purgeJobs.createdAt), asc(purgeJobs.id)),
      db.select().from(integrationDiagnostics).where(eq(integrationDiagnostics.workspaceId, workspaceId)).orderBy(asc(integrationDiagnostics.integrationId)),
      db.select().from(servicePrincipals).where(eq(servicePrincipals.workspaceId, workspaceId)).orderBy(asc(servicePrincipals.createdAt), asc(servicePrincipals.id)),
      db.select().from(agentGrants).where(eq(agentGrants.workspaceId, workspaceId)).orderBy(asc(agentGrants.createdAt), asc(agentGrants.id)),
      db.select().from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId)).orderBy(asc(agentRuns.startedAt), asc(agentRuns.id)),
      db.select().from(agentActionPlans).where(eq(agentActionPlans.workspaceId, workspaceId)).orderBy(asc(agentActionPlans.createdAt), asc(agentActionPlans.id)),
      db.select().from(agentPlanDecisions).where(eq(agentPlanDecisions.workspaceId, workspaceId)).orderBy(asc(agentPlanDecisions.decidedAt), asc(agentPlanDecisions.id)),
      db.select().from(agentActionExecutions).where(eq(agentActionExecutions.workspaceId, workspaceId)).orderBy(asc(agentActionExecutions.startedAt), asc(agentActionExecutions.id)),
    ]);

    const invalidStorageReference = [
      ...documentRows.map((document) => document.objectKey),
      ...documentVersionRows.map((version) => version.objectKey),
      ...negotiationSubmissionRows.map((submission) => submission.reviewTextObjectKey).filter((objectKey): objectKey is string => Boolean(objectKey)),
    ].find((objectKey) => !isWorkspaceObjectKey(workspaceId, objectKey));
    if (invalidStorageReference) {
      return apiError("storage_integrity_failure", "Workspace export stopped because a storage reference failed tenant validation.", {
        status: 409,
        requestId: auth.requestId,
      });
    }

    const eventGroups = new Map<number, typeof eventRows>();
    for (const event of eventRows) {
      const group = eventGroups.get(event.agreementId) ?? [];
      group.push(event);
      eventGroups.set(event.agreementId, group);
    }
    const auditChains = [] as Array<{
      agreementId: number;
      valid: boolean;
      checked: number;
      firstInvalidSequence: number | null;
      headHash: string | null;
    }>;
    const agreementIds = new Set([...agreementRows.map((agreement) => agreement.id), ...eventRows.map((event) => event.agreementId)]);
    for (const agreementId of [...agreementIds].sort((left, right) => left - right)) {
      auditChains.push({ agreementId, ...await verifyAgreementEventChain(eventGroups.get(agreementId) ?? []) });
    }
    if (auditChains.some((chain) => !chain.valid)) {
      return apiError("audit_integrity_failure", "Workspace audit integrity verification failed. Export has been stopped.", {
        status: 409,
        requestId: auth.requestId,
      });
    }
    const workspaceAuditChain = await verifyWorkspaceEventChain(workspaceEventRows);
    if (!workspaceAuditChain.valid) {
      return apiError("workspace_audit_integrity_failure", "Workspace security audit integrity verification failed. Export has been stopped.", {
        status: 409,
        requestId: auth.requestId,
      });
    }

    const sourceAgentPlanReferences = [
      ...approvalRows.flatMap((approval) => approval.sourceAgentPlanId
        ? [{ agreementId: approval.agreementId, planId: approval.sourceAgentPlanId }]
        : []),
      ...eventRows.flatMap((event) => event.sourceAgentPlanId
        ? [{ agreementId: event.agreementId, planId: event.sourceAgentPlanId }]
        : []),
    ];
    const agentEvidenceClosure = verifyAgentEvidenceClosure({
      workspaceId,
      servicePrincipals: servicePrincipalRows,
      grants: agentGrantRows,
      runs: agentRunRows,
      plans: agentPlanRows,
      decisions: agentPlanDecisionRows,
      executions: agentActionExecutionRows,
      agreementEvents: eventRows,
      sourcePlanReferences: sourceAgentPlanReferences,
    });
    if (!agentEvidenceClosure.valid) {
      return apiError("export_referential_integrity_failure", "Workspace export stopped because agent-governance evidence is not referentially complete.", {
        status: 409,
        requestId: auth.requestId,
      });
    }

    const activeAgreementIds = new Set(agreementRows.filter((agreement) => !agreement.deletedAt).map((agreement) => agreement.id));
    const noticeMode = getNoticeConfig().mode;
    const artifactCandidates = [
      ...documentRows.map((document) => ({
        artifactType: "uploaded-document" as const,
        id: document.id,
        agreementId: document.agreementId,
        version: document.version,
        fileName: document.fileName,
        contentType: document.contentType,
        size: document.size,
        sha256: document.sha256,
        scanStatus: document.scanStatus,
        legalHold: document.legalHold,
        retentionUntil: document.retentionUntil,
        deletedAt: document.deletedAt,
        storageReference: document.objectKey,
        applicationDownloadPath: !document.deletedAt && isDocumentReadable(document.scanStatus, noticeMode)
          ? `/api/documents/${document.id}`
          : null,
      })),
      ...documentVersionRows.map((version) => ({
        artifactType: "agreement-document-version" as const,
        id: version.id,
        agreementId: version.agreementId,
        version: version.version,
        fileName: `agreement-${version.agreementId}-v${version.version}.txt`,
        label: version.label,
        contentType: version.contentType,
        size: version.size,
        sha256: version.sha256,
        sourceDocumentId: version.sourceDocumentId,
        storageReference: version.objectKey,
        applicationDownloadPath: activeAgreementIds.has(version.agreementId)
          ? `/api/agreements/${version.agreementId}/versions?version=${version.version}`
          : null,
      })),
      ...negotiationSubmissionRows.flatMap((submission) => submission.reviewTextObjectKey && submission.reviewTextSha256 && submission.reviewTextSize !== null ? [{
        artifactType: "negotiation-review-text" as const,
        id: submission.id,
        agreementId: submission.agreementId,
        roundId: submission.roundId,
        fileName: `agreement-${submission.agreementId}-review-${submission.id}.txt`,
        contentType: "text/plain",
        size: submission.reviewTextSize,
        sha256: submission.reviewTextSha256,
        provenance: submission.reviewTextProvenance,
        storageReference: submission.reviewTextObjectKey,
        applicationDownloadPath: activeAgreementIds.has(submission.agreementId)
          ? `/api/agreements/${submission.agreementId}/negotiation?submissionId=${submission.id}&view=review-text`
          : null,
      }] : []),
    ];
    // A promoted review may intentionally reuse the exact immutable working
    // version object. Count and export each storage artifact once while the
    // relational records retain every lineage edge.
    const seenStorageReferences = new Set<string>();
    const artifactManifest = artifactCandidates.filter((artifact) => {
      if (seenStorageReferences.has(artifact.storageReference)) return false;
      seenStorageReferences.add(artifact.storageReference);
      return true;
    });
    const exportedDocuments = documentRows.map(withoutStorageReference);
    const exportedDocumentVersions = documentVersionRows.map(withoutStorageReference);
    const exportedPurgeJobs = purgeJobRows.map(sanitizePurgeJob);
    const exportedIntegrationDiagnostics = integrationDiagnosticRows.map(sanitizeIntegrationDiagnostic);
    const exportedIngestionBatches = ingestionBatchRows.map(sanitizeIngestionBatch);
    const exportedAgentPlans = agentPlanRows.map(sanitizeAgentActionPlan);
    const exportedAgentExecutions = agentActionExecutionRows.map(sanitizeAgentActionExecution);
    const generatedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: "1.0",
      exportType: "notice.workspace.offboarding",
      generatedAt,
      generatedBy: {
        userId: auth.context.user.id,
        email: auth.context.user.email,
        displayName: auth.context.user.displayName,
      },
      workspace: workspaceRows[0] ?? auth.context.workspace,
      scope: {
        workspaceId,
        includesSoftDeletedRecords: true,
        includesBinaryContent: false,
        artifactRetrieval: "Use applicationDownloadPath when present or export the exact tenant-scoped storageReference from R2.",
      },
      counts: {
        members: memberRows.length,
        workspaceEvents: workspaceEventRows.length,
        agreements: agreementRows.length,
        agreementEvents: eventRows.length,
        agreementVersions: versionRows.length,
        documents: documentRows.length,
        agreementDocumentVersions: documentVersionRows.length,
        approvals: approvalRows.length,
        obligationSchedules: obligationScheduleRows.length,
        obligationOccurrences: obligationRows.length,
        obligations: obligationRows.length,
        obligationEvidence: obligationEvidenceRows.length,
        obligationCreationReceipts: Number(obligationCreationReceiptCountRows[0]?.count ?? 0),
        languageBlocks: languageRows.length,
        signaturePackets: packetRows.length,
        negotiationRounds: negotiationRoundRows.length,
        negotiationSubmissions: negotiationSubmissionRows.length,
        documentComparisons: comparisonRows.length,
        webhookReceipts: webhookRows.length,
        outboxEvents: outboxRows.length,
        outboxDeliveries: outboxDeliveryRows.length,
        crmLegacyCleanupAttestations: crmLegacyCleanupRows.length,
        workspaceGroups: workspaceGroupRows.length,
        workspaceGroupMembers: workspaceGroupMemberRows.length,
        legalEntities: legalEntityRows.length,
        counterparties: counterpartyRows.length,
        customFieldDefinitions: customFieldDefinitionRows.length,
        customFieldValues: customFieldValueRows.length,
        governedTemplates: governedTemplateRows.length,
        governedTemplateVersions: governedTemplateVersionRows.length,
        workflowDefinitions: workflowDefinitionRows.length,
        approvalLaneAuthorities: approvalAuthorityRows.length,
        intakeForms: intakeFormRows.length,
        intakeSubmissions: intakeSubmissionRows.length,
        savedViews: savedViewRows.length,
        agreementParties: agreementPartyRows.length,
        agreementRelationships: agreementRelationshipRows.length,
        clausePlaybooks: clausePlaybookRows.length,
        clausePlaybookVersions: clausePlaybookVersionRows.length,
        ingestionBatches: ingestionBatchRows.length,
        ingestionItems: ingestionItemRows.length,
        repositoryFragments: repositoryFragmentRows.length,
        extractionProposals: extractionProposalRows.length,
        extractionProposalCitations: extractionProposalCitationRows.length,
        purgeJobs: exportedPurgeJobs.length,
        integrationDiagnostics: exportedIntegrationDiagnostics.length,
        servicePrincipals: servicePrincipalRows.length,
        agentGrants: agentGrantRows.length,
        agentRuns: agentRunRows.length,
        agentActionPlans: exportedAgentPlans.length,
        agentPlanDecisions: agentPlanDecisionRows.length,
        agentActionExecutions: exportedAgentExecutions.length,
        artifacts: artifactManifest.length,
        artifactBytes: artifactManifest.reduce((total, artifact) => total + artifact.size, 0),
      },
      records: {
        members: memberRows,
        workspaceEvents: workspaceEventRows,
        agreements: agreementRows,
        agreementEvents: eventRows,
        agreementVersions: versionRows,
        documents: exportedDocuments,
        agreementDocumentVersions: exportedDocumentVersions,
        approvals: approvalRows,
        obligationSchedules: obligationScheduleRows,
        // Schema-v17 obligations are materialized occurrence records. Preserve
        // the existing key while exposing their schedules and evidence beside it.
        obligations: obligationRows,
        obligationEvidence: obligationEvidenceRows,
        languageBlocks: languageRows,
        signaturePackets: packetRows.map(sanitizeSignaturePacket),
        negotiationRounds: negotiationRoundRows.map(sanitizeNegotiationRound),
        negotiationSubmissions: negotiationSubmissionRows.map(withoutReviewTextStorageReference),
        documentComparisons: comparisonRows,
        webhookReceipts: webhookRows,
        outboxEvents: outboxRows.map(sanitizeOutboxEvent),
        outboxDeliveries: outboxDeliveryRows,
        crmLegacyCleanupAttestations: crmLegacyCleanupRows,
        workspaceGroups: workspaceGroupRows,
        workspaceGroupMembers: workspaceGroupMemberRows,
        legalEntities: legalEntityRows,
        counterparties: counterpartyRows,
        customFieldDefinitions: customFieldDefinitionRows,
        customFieldValues: customFieldValueRows,
        governedTemplates: governedTemplateRows,
        governedTemplateVersions: governedTemplateVersionRows,
        workflowDefinitions: workflowDefinitionRows,
        approvalLaneAuthorities: approvalAuthorityRows,
        intakeForms: intakeFormRows,
        intakeSubmissions: intakeSubmissionRows,
        savedViews: savedViewRows,
        agreementParties: agreementPartyRows,
        agreementRelationships: agreementRelationshipRows,
        clausePlaybooks: clausePlaybookRows,
        clausePlaybookVersions: clausePlaybookVersionRows,
        ingestionBatches: exportedIngestionBatches,
        ingestionItems: ingestionItemRows,
        repositoryFragments: repositoryFragmentRows,
        extractionProposals: extractionProposalRows,
        extractionProposalCitations: extractionProposalCitationRows,
        purgeJobs: exportedPurgeJobs,
        integrationDiagnostics: exportedIntegrationDiagnostics,
        servicePrincipals: servicePrincipalRows,
        agentGrants: agentGrantRows,
        agentRuns: agentRunRows,
        agentActionPlans: exportedAgentPlans,
        agentPlanDecisions: agentPlanDecisionRows,
        agentActionExecutions: exportedAgentExecutions,
      },
      artifacts: artifactManifest,
      audit: {
        allChainsValid: true,
        workspaceChain: workspaceAuditChain,
        chains: auditChains,
        agentEvidenceClosure,
      },
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
        auditChainsVerified: auditChains.length + 1,
      },
    };
    const body = JSON.stringify(envelope, null, 2);
    const fileSlug = auth.context.workspace.slug.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "workspace";
    const headers = new Headers(auth.headers);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="notice-${fileSlug}-workspace-export.json"`);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Request-Id", auth.requestId);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Workspace export could not be generated.");
  }
}

function withoutStorageReference<T extends { objectKey: string }>(record: T): Omit<T, "objectKey"> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "objectKey")) as Omit<T, "objectKey">;
}

function withoutReviewTextStorageReference<T extends { reviewTextObjectKey: string | null }>(record: T): Omit<T, "reviewTextObjectKey"> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "reviewTextObjectKey")) as Omit<T, "reviewTextObjectKey">;
}

function sanitizeNegotiationRound(record: typeof negotiationRounds.$inferSelect) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => ![
    "activeKey",
    "aliasCode",
    "portalTokenHash",
  ].includes(key)));
}

function sanitizeOutboxEvent(record: typeof outboxEvents.$inferSelect) {
  if (record.topic !== "negotiation.round_requested") return record;
  return {
    ...record,
    payload: {
      ...record.payload,
      // The delivery event must carry the one-time scoped URL, but an
      // offboarding export must never revive or disclose a still-live bearer.
      portalUrl: "[redacted scoped counterparty link]",
    },
  };
}

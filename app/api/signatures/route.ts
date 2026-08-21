import { env } from "cloudflare:workers";
import { and, desc, eq, exists, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../db";
import { ensureStorageSchema } from "../../../db/ensure";
import { agreementDocumentVersions, agreementEvents, agreements, agreementVersions, approvalRequests, documents, mutationGuards, negotiationRounds, outboxEvents, signaturePackets } from "../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../lib/api";
import { computeAgreementBasisHash } from "../../lib/agreement-basis";
import { evaluateAgreementRiskReadiness } from "../../lib/agreement-risk";
import { approvalsSatisfyPolicy } from "../../lib/approval-policy";
import { getNoticeConfig } from "../../lib/config";
import { createDocuSealSubmission, DOCUSEAL_ARTIFACT_MAX_BYTES, type DocuSealSubmission, findDocuSealSubmissionByPacketExternalId, getDocuSealSubmission, getDocuSealTemplateRoles, signerRolesMatchTemplate } from "../../lib/docuseal";
import { closeSubmission, completeSubmission, refreshNonterminalSubmission } from "../../lib/docuseal-reconciliation";
import { sha256Hex } from "../../lib/document-security";
import { apiError, apiJson } from "../../lib/http";
import { crmAgreementProjection, prepareAgreementLifecycleUpdatedIntegrationEvent, prepareIntegrationOutboxEvent } from "../../lib/integration-events";
import {
  findActiveAgreement,
  isOptimisticConcurrencyConflict,
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
} from "../../lib/persistence";
import { getDocuSealConfiguration } from "../../lib/providers";
import { completedSignatureReviewBindingMatches, FINAL_SIGNATURE_REVIEW_CONFIRMATION, reconcilePendingSignerEvidence, sanitizeSignaturePacket } from "../../lib/signature-evidence";
import { parseJson } from "../../lib/validation";

const createPacketSchema = z.object({
  agreementId: z.coerce.number().int().positive(),
  version: z.number().int().positive(),
  parties: z.array(z.object({
    role: z.string().trim().min(1).max(100),
    email: z.email().transform((value) => value.trim().toLowerCase()),
    name: z.string().trim().min(1).max(200).optional(),
  })).min(1).max(10),
}).superRefine((input, context) => {
  const seen = new Set<string>();
  input.parties.forEach((party, index) => {
    if (seen.has(party.email)) {
      context.addIssue({
        code: "custom",
        path: ["parties", index, "email"],
        message: "Each signer must use a unique email address.",
      });
    }
    seen.add(party.email);
  });
});

export { FINAL_SIGNATURE_REVIEW_CONFIRMATION } from "../../lib/signature-evidence";

const reviewCompletedPacketSchema = z.object({
  packetId: z.string().uuid(),
  version: z.number().int().positive(),
  action: z.literal("review_completed"),
  agreementVersion: z.number().int().positive(),
  basisHash: z.string().regex(/^[0-9a-f]{64}$/),
  documentVersion: z.number().int().positive(),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  evidenceDocumentId: z.string().uuid(),
  finalArtifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
  confirmation: z.literal(FINAL_SIGNATURE_REVIEW_CONFIRMATION),
  reason: z.string().trim().min(10).max(2_000).refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Review reason must not contain control characters.",
  ),
}).strict();

const providerReconcilePacketSchema = z.object({
  packetId: z.string().uuid(),
  version: z.number().int().positive(),
  action: z.enum(["reconcile", "abandon_unmapped", "supersede_archived"]).default("reconcile"),
}).strict();

const reconcilePacketSchema = z.union([reviewCompletedPacketSchema, providerReconcilePacketSchema]);

type SignatureEnv = { DOCUMENTS: R2Bucket };

async function reconcileTerminalProviderState(
  packet: typeof signaturePackets.$inferSelect,
  submission: DocuSealSubmission,
  configuration: ReturnType<typeof getDocuSealConfiguration>,
  workspaceId: string,
): Promise<"terminal" | "busy" | "none"> {
  if (submission.status === "completed") {
    const result = await completeSubmission(packet, configuration, workspaceId);
    return result === "busy" ? "busy" : "terminal";
  }
  if (submission.status === "declined" || submission.status === "expired") {
    const declinedSubmitter = submission.status === "declined"
      ? submission.submitters?.find((candidate) => candidate.status === "declined") ?? null
      : null;
    const result = await closeSubmission(packet, workspaceId, submission.status, declinedSubmitter as Record<string, unknown> | null);
    return result === "busy" ? "busy" : "terminal";
  }
  return "none";
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:read");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const db = getDb();
    const rows = await db.select().from(signaturePackets).where(
      eq(signaturePackets.workspaceId, auth.context.workspace.id),
    ).orderBy(desc(signaturePackets.createdAt)).limit(200);
    const evidenceDocumentIds = [...new Set(rows.flatMap((packet) =>
      packet.status === "completed_review_required" && packet.evidenceDocumentId
        ? [packet.evidenceDocumentId]
        : []
    ))];
    const reviewArtifacts = evidenceDocumentIds.length > 0
      ? await db.select({ id: documents.id, sha256: documents.sha256 }).from(documents).where(and(
          eq(documents.workspaceId, auth.context.workspace.id),
          inArray(documents.id, evidenceDocumentIds),
          eq(documents.role, "signed_artifact"),
          eq(documents.direction, "inbound"),
          eq(documents.scanStatus, "clean"),
          isNull(documents.deletedAt),
        ))
      : [];
    const reviewArtifactSha256ById = new Map(reviewArtifacts.map((artifact) => [artifact.id, artifact.sha256]));
    const includeProviderRoles = new URL(request.url).searchParams.get("include") === "provider_roles";
    const signerRoles = includeProviderRoles
      ? await getDocuSealTemplateRoles(getDocuSealConfiguration())
      : undefined;
    return apiJson({
      signaturePackets: rows.map((packet) => sanitizeSignaturePacket({
        ...packet,
        ...(packet.evidenceDocumentId && reviewArtifactSha256ById.has(packet.evidenceDocumentId)
          ? { finalArtifactSha256: reviewArtifactSha256ById.get(packet.evidenceDocumentId) }
          : {}),
      })),
      ...(signerRoles ? { signerRoles } : {}),
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Signature packets could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:update", { limit: 20 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, createPacketSchema, 32_000);
    await ensureStorageSchema();
    const db = getDb();
    const agreement = await findActiveAgreement(db, auth.context.workspace.id, input.agreementId);
    if (!agreement) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    if (agreement.version !== input.version) return apiError("version_conflict", "Reload the agreement before preparing signature.", { status: 409, requestId: auth.requestId });
    if (agreement.stage !== "Signature") return apiError("signature_stage_required", "Move the agreement to Signature before creating a packet.", { status: 409, requestId: auth.requestId });
    if (!new Set(["Approved", "Not required"]).has(agreement.approvalStatus)) return apiError("approval_required", "Required approvals must be complete before signature.", { status: 409, requestId: auth.requestId });
    const [unresolvedRound] = await db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, auth.context.workspace.id),
      eq(negotiationRounds.agreementId, agreement.id),
      isNotNull(negotiationRounds.activeKey),
    )).limit(1);
    if (unresolvedRound) return apiError("negotiation_round_unresolved", "Resolve or close the current counterparty review round before signature.", { status: 409, requestId: auth.requestId });
    const [documentVersion] = await db.select().from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
      eq(agreementDocumentVersions.agreementId, agreement.id),
    )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
    if (!documentVersion) return apiError("document_version_required", "Create and review an immutable working document version before preparing signature.", { status: 409, requestId: auth.requestId });
    const riskReadiness = await evaluateAgreementRiskReadiness(agreement, documentVersion);
    if (!riskReadiness.evaluation.cleared) {
      return apiError("risk_assessment_required", riskReadiness.evaluation.blockers[0]?.message ?? "A current risk decision is required before signature.", { status: 409, requestId: auth.requestId });
    }
    if (!new Set(["text/plain", "text/markdown"]).has(documentVersion.contentType)) {
      return apiError("document_version_unsupported", "The selected working version cannot be sent through the configured signing adapter.", { status: 409, requestId: auth.requestId });
    }
    const documentObject = await (env as unknown as SignatureEnv).DOCUMENTS.get(documentVersion.objectKey);
    if (!documentObject) return apiError("document_version_missing", "The selected working document bytes are unavailable.", { status: 409, requestId: auth.requestId });
    const documentBytes = new Uint8Array(await documentObject.arrayBuffer());
    const currentDocumentSha256 = await sha256Hex(documentBytes);
    if (documentBytes.byteLength !== documentVersion.size || currentDocumentSha256 !== documentVersion.sha256) {
      return apiError("document_integrity_failure", "The selected working document failed its integrity check.", { status: 409, requestId: auth.requestId });
    }
    const basisHash = await computeAgreementBasisHash(agreement, documentVersion);
    const approvals = agreement.approvalStatus === "Not required"
      ? []
      : await db.select().from(approvalRequests).where(and(
          eq(approvalRequests.workspaceId, auth.context.workspace.id),
          eq(approvalRequests.agreementId, agreement.id),
        ));
    if (!approvalsSatisfyPolicy(agreement, approvals, {
      hash: basisHash,
      documentVersion: documentVersion.version,
      documentSha256: documentVersion.sha256,
    })) return apiError("approval_basis_changed", "The current paper is not covered by every required approval role.", { status: 409, requestId: auth.requestId });
    const [existing] = await db.select().from(signaturePackets).where(and(
      eq(signaturePackets.workspaceId, auth.context.workspace.id),
      eq(signaturePackets.agreementId, agreement.id),
      inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
    )).orderBy(desc(signaturePackets.createdAt)).limit(1);
    if (existing) return apiError("signature_packet_exists", "A signature packet is already in progress.", { status: 409, requestId: auth.requestId });

    const configuration = getDocuSealConfiguration();
    const configuredSignerRoles = await getDocuSealTemplateRoles(configuration);
    const submittedSignerRoles = input.parties.map((party) => party.role);
    const roleSetMatches = signerRolesMatchTemplate(configuredSignerRoles, submittedSignerRoles);
    if (!roleSetMatches) {
      return apiError("signature_roles_mismatch", `Signer roles must exactly match the configured DocuSeal template roles: ${configuredSignerRoles.join(", ")}.`, { status: 409, requestId: auth.requestId });
    }
    const now = new Date().toISOString();
    const packetId = crypto.randomUUID();
    const externalId = `notice:${auth.context.workspace.id}:${agreement.id}:v${documentVersion.version}:${packetId}`;
    const pending = {
      id: packetId,
      workspaceId: auth.context.workspace.id,
      agreementId: agreement.id,
      basisHash,
      documentVersion: documentVersion.version,
      documentSha256: documentVersion.sha256,
      activeKey: `agreement:${agreement.id}`,
      provider: "docuseal",
      externalId,
      submissionId: null,
      status: "creating",
      signers: input.parties,
      evidenceDocumentId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const reservationGuardId = crypto.randomUUID();
    try {
      await db.batch([
        db.update(agreements).set({ updatedAt: sql`${agreements.updatedAt}` }).where(and(
          eq(agreements.workspaceId, auth.context.workspace.id),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
          isNull(agreements.deletedAt),
          notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
            eq(negotiationRounds.workspaceId, auth.context.workspace.id),
            eq(negotiationRounds.agreementId, agreement.id),
            isNotNull(negotiationRounds.activeKey),
          ))),
        )),
        db.insert(mutationGuards).values({
          id: reservationGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "signature.create.reservation",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(signaturePackets).values(pending),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, reservationGuardId),
        )),
      ]);
    } catch (error) {
      if (isOptimisticConcurrencyConflict(error)) {
        const [[currentRound], [currentPacket]] = await Promise.all([
          db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
            eq(negotiationRounds.workspaceId, auth.context.workspace.id),
            eq(negotiationRounds.agreementId, agreement.id),
            isNotNull(negotiationRounds.activeKey),
          )).limit(1),
          db.select({ id: signaturePackets.id }).from(signaturePackets).where(and(
            eq(signaturePackets.workspaceId, auth.context.workspace.id),
            eq(signaturePackets.agreementId, agreement.id),
            inArray(signaturePackets.status, ["creating", "pending", "partially_signed", "reconciling", "archived", "completed_review_required"]),
          )).limit(1),
        ]);
        if (currentRound) return apiError("negotiation_round_unresolved", "Resolve or close the current counterparty review round before signature.", { status: 409, requestId: auth.requestId });
        if (currentPacket) return apiError("signature_packet_exists", "A signature packet is already in progress.", { status: 409, requestId: auth.requestId });
        return apiError("version_conflict", "The agreement changed before its signature packet was reserved. Reload before retrying.", { status: 409, requestId: auth.requestId });
      }
      throw error;
    }

    let submission;
    try {
      submission = await createDocuSealSubmission(configuration, {
        agreementId: agreement.id,
        externalId,
        name: `${agreement.party} — ${agreement.type}`,
        parties: input.parties,
        document: {
          name: `${agreement.party} — ${agreement.type} — working version ${documentVersion.version}`,
          content: new TextDecoder().decode(documentBytes),
          contentType: documentVersion.contentType as "text/plain" | "text/markdown",
          version: documentVersion.version,
          sha256: documentVersion.sha256,
        },
        completedRedirectUrl: new URL("/", getNoticeConfig().publicBaseUrl ?? "https://notice.invalid").toString(),
      });
    } catch (error) {
      // Any non-success or transport failure is ambiguous: the provider may
      // have accepted the packet even when Notice did not receive its body.
      // Retain the active recovery key until an authorized reconciliation (or
      // a delayed, verified abandon action) proves no provider packet exists.
      await db.update(signaturePackets).set({ status: "creating", updatedAt: new Date().toISOString() }).where(and(
          eq(signaturePackets.workspaceId, auth.context.workspace.id),
          eq(signaturePackets.id, packetId),
          eq(signaturePackets.version, 1),
          eq(signaturePackets.status, "creating"),
        ));
      throw error;
    }
    const signers = reconcilePendingSignerEvidence(input.parties, submission.submitters);
    const mappedPacket = await db.update(signaturePackets).set({
      submissionId: String(submission.id),
      // Provider creation responses are not completion evidence. Completion is
      // accepted only through the verified webhook reconciliation path, after
      // the signed artifact has been downloaded and scanned.
      status: "pending",
      signers,
      updatedAt: new Date().toISOString(),
      version: 2,
    }).where(and(
      eq(signaturePackets.workspaceId, auth.context.workspace.id),
      eq(signaturePackets.id, packetId),
      eq(signaturePackets.version, 1),
      eq(signaturePackets.status, "creating"),
    ));
    if (!mappedPacket.meta.changes) throw new Error("DocuSeal submission response could not be mapped to its durable packet");
    const agreementPatch = {
      signatureStatus: "Sent",
      version: agreement.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: auth.context.user.id,
    };
    const saved: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
    const event = await prepareAgreementEvent(db, {
      workspaceId: auth.context.workspace.id,
      agreementId: agreement.id,
      type: "Signature",
      detail: `Created DocuSeal submission ${submission.id} for immutable working version ${documentVersion.version} (${documentVersion.sha256.slice(0, 12)}…) and ${input.parties.length} signer${input.parties.length === 1 ? "" : "s"}.`,
      actor: auth.context.user,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, auth.context.user.id, event.id);
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: auth.context.workspace.id,
      topic: "signature.packet_created",
      aggregateType: "signature_packet",
      aggregateId: packetId,
      payload: {
        packetId,
        agreementId: agreement.id,
        provider: "docuseal",
        submissionId: String(submission.id),
        documentVersion: documentVersion.version,
        documentSha256: documentVersion.sha256,
        basisHash,
        aggregateVersion: 2,
        causationId: auth.requestId,
      },
    }));
    const agreementIntegrationEvent = prepareAgreementLifecycleUpdatedIntegrationEvent({
      before: agreement,
      agreement: saved,
      candidateFields: ["signatureStatus"],
      causationId: auth.requestId,
    });
    const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
    const agreementGuardId = crypto.randomUUID();
    try {
      await db.batch([
        db.update(agreements).set(agreementPatch).where(and(
          eq(agreements.workspaceId, auth.context.workspace.id),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
        )),
        db.insert(mutationGuards).values({
          id: agreementGuardId,
          workspaceId: auth.context.workspace.id,
          operation: "signature.create.agreement",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.insert(outboxEvents).values(outbox),
        ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, agreementGuardId),
        )),
      ]);
    } catch (error) {
      if (isOptimisticConcurrencyConflict(error)) {
        return apiError("version_conflict", "The agreement changed while its provider packet was created. The retained packet must be reconciled before retrying.", { status: 409, requestId: auth.requestId });
      }
      throw error;
    }
    return apiJson({
      signaturePacket: sanitizeSignaturePacket({ ...pending, submissionId: String(submission.id), status: "pending", signers, version: 2 }),
      // Production uses provider delivery to the verified signer addresses.
      // Individual signer URLs are bearer capabilities and are never exposed
      // to the agreement creator, persisted, audited, or exported.
      embedSrc: null,
      agreement: saved,
      event,
      requestId: auth.requestId,
    }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Signature packet could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:update", { limit: 20 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, reconcilePacketSchema, 16_000);
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = auth.context.workspace.id;
    const [packet] = await db.select().from(signaturePackets).where(and(
      eq(signaturePackets.workspaceId, workspaceId),
      eq(signaturePackets.id, input.packetId),
    )).limit(1);
    if (!packet) return apiError("signature_packet_not_found", "Signature packet was not found.", { status: 404, requestId: auth.requestId });
    if (packet.version !== input.version) return apiError("version_conflict", "Reload the signature packet before reconciling it.", { status: 409, requestId: auth.requestId });
    const agreement = await findActiveAgreement(db, workspaceId, packet.agreementId);
    if (!agreement) return apiError("agreement_not_found", "The packet agreement is unavailable.", { status: 404, requestId: auth.requestId });

    if (input.action === "review_completed") {
      const isAuthorizedHumanReviewer = new Set(["legal", "admin"]).has(auth.context.role)
        && auth.context.permissions.has("document:manage");
      if (!isAuthorizedHumanReviewer) {
        return apiError("permission_denied", "Only a legal or administrator reviewer with document-management authority may activate retained signature evidence.", { status: 403, requestId: auth.requestId });
      }
      if (
        packet.status !== "completed_review_required"
        || !packet.activeKey
        || !packet.submissionId
        || !packet.completedAt
        || !packet.evidenceDocumentId
      ) {
        return apiError("signature_evidence_not_reviewable", "Only a current completed packet with retained evidence can be reviewed for activation.", { status: 409, requestId: auth.requestId });
      }
      if (agreement.version !== input.agreementVersion) {
        return apiError("version_conflict", "The agreement changed after this evidence review was opened. Reload and review the current basis.", { status: 409, requestId: auth.requestId });
      }
      if (
        agreement.stage !== "Signature"
        || agreement.signatureStatus !== "completed_review_required"
        || agreement.nextAction !== "Review completed signature evidence"
      ) {
        return apiError("signature_review_state_changed", "The agreement is no longer awaiting review of this completed signature evidence.", { status: 409, requestId: auth.requestId });
      }
      if (
        packet.basisHash !== input.basisHash
        || packet.documentVersion !== input.documentVersion
        || packet.documentSha256 !== input.documentSha256
        || packet.evidenceDocumentId !== input.evidenceDocumentId
      ) {
        return apiError("signature_review_evidence_changed", "The confirmation does not match the packet's exact retained basis and evidence.", { status: 409, requestId: auth.requestId });
      }
      if (
        !Array.isArray(packet.signers)
        || packet.signers.length === 0
        || packet.signers.some((signer) => signer.status !== "completed")
      ) {
        return apiError("signature_review_signers_incomplete", "Every registered signer must have verified completion evidence before review.", { status: 409, requestId: auth.requestId });
      }

      const [currentDocumentVersion] = await db.select().from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, workspaceId),
        eq(agreementDocumentVersions.agreementId, agreement.id),
      )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
      if (!currentDocumentVersion) {
        return apiError("signature_review_basis_changed", "The current immutable working-paper basis is unavailable.", { status: 409, requestId: auth.requestId });
      }
      const riskReadiness = await evaluateAgreementRiskReadiness(agreement, currentDocumentVersion);
      if (!riskReadiness.evaluation.cleared) {
        return apiError("risk_assessment_required", riskReadiness.evaluation.blockers[0]?.message ?? "Current risk evidence is required before activation.", { status: 409, requestId: auth.requestId });
      }
      const currentBasisHash = await computeAgreementBasisHash(agreement, currentDocumentVersion);
      const approvals = agreement.approvalStatus === "Not required"
        ? []
        : await db.select().from(approvalRequests).where(and(
            eq(approvalRequests.workspaceId, workspaceId),
            eq(approvalRequests.agreementId, agreement.id),
          ));
      if (
        currentBasisHash !== input.basisHash
        || currentDocumentVersion.version !== input.documentVersion
        || currentDocumentVersion.sha256 !== input.documentSha256
        || !approvalsSatisfyPolicy(agreement, approvals, {
          hash: currentBasisHash,
          documentVersion: currentDocumentVersion.version,
          documentSha256: currentDocumentVersion.sha256,
        })
      ) {
        return apiError("signature_review_basis_changed", "The approved working-paper basis changed after provider completion. This packet cannot activate the agreement.", { status: 409, requestId: auth.requestId });
      }

      const [evidenceDocument] = await db.select().from(documents).where(and(
        eq(documents.workspaceId, workspaceId),
        eq(documents.id, input.evidenceDocumentId),
        eq(documents.agreementId, agreement.id),
        eq(documents.role, "signed_artifact"),
        eq(documents.direction, "inbound"),
        eq(documents.providerMessageId, packet.submissionId),
        eq(documents.parentSha256, packet.documentSha256),
        eq(documents.scanStatus, "clean"),
        isNull(documents.deletedAt),
      )).limit(1);
      if (!evidenceDocument || evidenceDocument.sha256 !== input.finalArtifactSha256) {
        return apiError("signature_review_artifact_changed", "The confirmation does not match the retained final signed artifact.", { status: 409, requestId: auth.requestId });
      }
      if (!completedSignatureReviewBindingMatches({
        packet,
        agreement,
        currentBasis: {
          hash: currentBasisHash,
          documentVersion: currentDocumentVersion.version,
          documentSha256: currentDocumentVersion.sha256,
        },
        artifact: { id: evidenceDocument.id, sha256: evidenceDocument.sha256 },
        review: input,
      })) {
        return apiError("signature_review_evidence_changed", "The review no longer binds the exact current agreement basis and retained evidence.", { status: 409, requestId: auth.requestId });
      }
      if (evidenceDocument.size <= 0 || evidenceDocument.size > DOCUSEAL_ARTIFACT_MAX_BYTES) {
        return apiError("signature_review_artifact_invalid", "The retained final signed artifact has an invalid recorded size.", { status: 409, requestId: auth.requestId });
      }
      const evidenceObject = await (env as unknown as SignatureEnv).DOCUMENTS.get(evidenceDocument.objectKey);
      if (!evidenceObject || evidenceObject.size !== evidenceDocument.size) {
        return apiError("signature_review_artifact_unavailable", "The retained final signed artifact is unavailable or no longer matches its record.", { status: 409, requestId: auth.requestId });
      }
      const evidenceBytes = new Uint8Array(await evidenceObject.arrayBuffer());
      const actualArtifactSha256 = await sha256Hex(evidenceBytes);
      if (evidenceBytes.byteLength !== evidenceDocument.size || actualArtifactSha256 !== input.finalArtifactSha256) {
        return apiError("signature_review_artifact_changed", "The retained final signed artifact failed its exact SHA-256 integrity check.", { status: 409, requestId: auth.requestId });
      }

      const now = new Date().toISOString();
      const packetPatch = {
        status: "completed",
        activeKey: null,
        updatedAt: now,
        version: packet.version + 1,
      };
      const agreementPatch = {
        stage: "Active",
        signatureStatus: "Completed",
        nextAction: "Manage obligations",
        version: agreement.version + 1,
        updated: now,
        updatedAt: now,
        updatedByUserId: auth.context.user.id,
      };
      const savedAgreement: typeof agreements.$inferSelect = { ...agreement, ...agreementPatch };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Signature review",
        detail: `Authorized human review confirmed final artifact ${actualArtifactSha256} for approved basis ${currentBasisHash}. Reason: ${input.reason}`,
        actor: auth.context.user,
        createdAt: now,
      });
      const snapshot = await prepareAgreementSnapshot(savedAgreement, auth.context.user.id, event.id);
      const completionOutbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "signature.completed",
        aggregateType: "signature",
        aggregateId: packet.id,
        payload: {
          packetId: packet.id,
          agreementId: agreement.id,
          provider: "docuseal",
          submissionId: packet.submissionId,
          status: "completed",
          activated: true,
          documentVersion: packet.documentVersion,
          documentSha256: packet.documentSha256,
          evidenceDocumentId: input.evidenceDocumentId,
          aggregateVersion: packetPatch.version,
          causationId: auth.requestId,
          crmAgreement: crmAgreementProjection(savedAgreement),
        },
      }));
      const packetGuardId = crypto.randomUUID();
      const agreementGuardId = crypto.randomUUID();
      await db.batch([
        db.update(signaturePackets).set(packetPatch).where(and(
          eq(signaturePackets.workspaceId, workspaceId),
          eq(signaturePackets.id, packet.id),
          eq(signaturePackets.version, packet.version),
          eq(signaturePackets.status, "completed_review_required"),
          eq(signaturePackets.activeKey, packet.activeKey),
          eq(signaturePackets.basisHash, input.basisHash),
          eq(signaturePackets.documentVersion, input.documentVersion),
          eq(signaturePackets.documentSha256, input.documentSha256),
          eq(signaturePackets.evidenceDocumentId, input.evidenceDocumentId),
        )),
        db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: "signature.review_completed.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
        db.update(agreements).set(agreementPatch).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, agreement.id),
          eq(agreements.version, input.agreementVersion),
          eq(agreements.nextAction, "Review completed signature evidence"),
          eq(agreements.stage, "Signature"),
          eq(agreements.signatureStatus, "completed_review_required"),
          isNull(agreements.deletedAt),
          exists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
            eq(agreementDocumentVersions.workspaceId, workspaceId),
            eq(agreementDocumentVersions.agreementId, agreement.id),
            eq(agreementDocumentVersions.version, input.documentVersion),
            eq(agreementDocumentVersions.sha256, input.documentSha256),
          ))),
          notExists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
            eq(agreementDocumentVersions.workspaceId, workspaceId),
            eq(agreementDocumentVersions.agreementId, agreement.id),
            gt(agreementDocumentVersions.version, input.documentVersion),
          ))),
          exists(db.select({ id: documents.id }).from(documents).where(and(
            eq(documents.workspaceId, workspaceId),
            eq(documents.id, input.evidenceDocumentId),
            eq(documents.version, evidenceDocument.version),
            eq(documents.agreementId, agreement.id),
            eq(documents.role, "signed_artifact"),
            eq(documents.direction, "inbound"),
            eq(documents.providerMessageId, packet.submissionId),
            eq(documents.parentSha256, input.documentSha256),
            eq(documents.sha256, input.finalArtifactSha256),
            eq(documents.size, evidenceDocument.size),
            eq(documents.scanStatus, "clean"),
            isNull(documents.deletedAt),
          ))),
        )),
        db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "signature.review_completed.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
        db.insert(agreementEvents).values(event),
        db.insert(agreementVersions).values(snapshot),
        db.insert(outboxEvents).values(completionOutbox),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, workspaceId),
          inArray(mutationGuards.id, [packetGuardId, agreementGuardId]),
        )),
      ]);
      return apiJson({
        signaturePacket: sanitizeSignaturePacket({ ...packet, ...packetPatch }),
        agreement: savedAgreement,
        event,
        reviewed: true,
        activated: true,
        reconciled: true,
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    const configuration = getDocuSealConfiguration();

    if (input.action === "supersede_archived") {
      if (!auth.context.permissions.has("workspace:admin")) {
        return apiError("permission_denied", "Only a workspace administrator can supersede an archived provider packet.", { status: 403, requestId: auth.requestId });
      }
      if (packet.status !== "archived" || !packet.submissionId) {
        return apiError("signature_packet_not_supersedable", "Only a mapped archived packet can be superseded.", { status: 409, requestId: auth.requestId });
      }
      const providerSubmissionId = Number(packet.submissionId);
      if (!Number.isSafeInteger(providerSubmissionId) || providerSubmissionId <= 0) {
        return apiError("signature_packet_provider_id_invalid", "The packet has an invalid provider submission identifier and requires operator review.", { status: 409, requestId: auth.requestId });
      }
      const providerSubmission = await getDocuSealSubmission(configuration, providerSubmissionId);
      if (!providerSubmission.archived_at || providerSubmission.status !== "pending") {
        return apiError("provider_archive_changed", "DocuSeal no longer reports this packet as an archived pending submission. Refresh it before taking action.", { status: 409, requestId: auth.requestId });
      }
      const now = new Date().toISOString();
      const packetPatch = { status: "superseded", activeKey: null, updatedAt: now, version: packet.version + 1 };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Signature",
        detail: "A workspace administrator superseded a provider-confirmed archived submission and released its workflow reservation. Any later completion will remain nonactivating evidence.",
        actor: auth.context.user,
        createdAt: now,
      });
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "signature.packet_superseded",
        aggregateType: "signature_packet",
        aggregateId: packet.id,
        payload: {
          packetId: packet.id,
          agreementId: agreement.id,
          provider: "docuseal",
          submissionId: packet.submissionId,
          documentVersion: packet.documentVersion,
          documentSha256: packet.documentSha256,
          basisHash: packet.basisHash,
          status: "superseded",
          actionable: false,
          recovered: false,
          reason: "administrator_released_archived_packet",
          aggregateVersion: packetPatch.version,
          causationId: auth.requestId,
        },
      }));
      const guardId = crypto.randomUUID();
      await db.batch([
        db.update(signaturePackets).set(packetPatch).where(and(
          eq(signaturePackets.workspaceId, workspaceId),
          eq(signaturePackets.id, packet.id),
          eq(signaturePackets.version, packet.version),
          eq(signaturePackets.status, "archived"),
        )),
        db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "signature.supersede_archived.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
        db.insert(agreementEvents).values(event),
        db.insert(outboxEvents).values(outbox),
        db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
      ]);
      return apiJson({
        signaturePacket: sanitizeSignaturePacket({ ...packet, ...packetPatch }),
        agreement,
        event,
        superseded: true,
        reconciled: false,
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (input.action === "abandon_unmapped") {
      if (!auth.context.permissions.has("workspace:admin")) {
        return apiError("permission_denied", "Only a workspace administrator can abandon an unmapped provider packet.", { status: 403, requestId: auth.requestId });
      }
      if (packet.status !== "creating" || packet.submissionId) {
        return apiError("signature_packet_not_abandonable", "Only an unmapped creating packet can be abandoned.", { status: 409, requestId: auth.requestId });
      }
      const createdAt = Date.parse(packet.createdAt);
      const minimumAgeMs = 60 * 60_000;
      if (!Number.isFinite(createdAt) || Date.now() - createdAt < minimumAgeMs) {
        return apiError("signature_packet_abandonment_wait", "Wait at least one hour after creation before verifying and abandoning an unmapped packet.", { status: 409, requestId: auth.requestId });
      }
      const providerSubmission = await findDocuSealSubmissionByPacketExternalId(configuration, packet.externalId);
      if (providerSubmission) {
        return apiError("provider_submission_exists", "DocuSeal has a submission for this packet. Reconcile it instead of abandoning it.", { status: 409, requestId: auth.requestId });
      }
      const now = new Date().toISOString();
      const packetPatch = { status: "error", activeKey: null, updatedAt: now, version: packet.version + 1 };
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Signature",
        detail: "A workspace administrator verified that DocuSeal had no submission for the retained recovery key and released the unmapped packet.",
        actor: auth.context.user,
        createdAt: now,
      });
      const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "signature.packet_abandoned",
        aggregateType: "signature_packet",
        aggregateId: packet.id,
        payload: {
          packetId: packet.id,
          agreementId: agreement.id,
          provider: "docuseal",
          reason: "provider_mapping_absent",
          verifiedAt: now,
          aggregateVersion: packetPatch.version,
          causationId: auth.requestId,
        },
      }));
      const guardId = crypto.randomUUID();
      await db.batch([
        db.update(signaturePackets).set(packetPatch).where(and(
          eq(signaturePackets.workspaceId, workspaceId),
          eq(signaturePackets.id, packet.id),
          eq(signaturePackets.version, packet.version),
          eq(signaturePackets.status, "creating"),
        )),
        db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "signature.abandon_unmapped.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
        db.insert(agreementEvents).values(event),
        db.insert(outboxEvents).values(outbox),
        db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
      ]);
      return apiJson({
        signaturePacket: sanitizeSignaturePacket({ ...packet, ...packetPatch }),
        agreement,
        event,
        abandoned: true,
        reconciled: false,
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    if (!new Set(["creating", "pending", "partially_signed", "reconciling", "archived"]).has(packet.status)) {
      return apiError("signature_packet_not_recoverable", "Only a creating, pending, partially signed, reconciling, or archived provider packet can be refreshed.", { status: 409, requestId: auth.requestId });
    }
    const mappedSubmissionId = packet.submissionId ? Number(packet.submissionId) : null;
    if (mappedSubmissionId !== null && (!Number.isSafeInteger(mappedSubmissionId) || mappedSubmissionId <= 0)) {
      return apiError("signature_packet_provider_id_invalid", "The packet has an invalid provider submission identifier and requires operator review.", { status: 409, requestId: auth.requestId });
    }
    const submission = packet.submissionId
      ? await getDocuSealSubmission(configuration, mappedSubmissionId as number)
      : await findDocuSealSubmissionByPacketExternalId(configuration, packet.externalId);
    if (!submission) {
      return apiError("provider_mapping_pending", "DocuSeal has not returned a submission for this recovery key. Verify the provider account before retrying.", { status: 409, requestId: auth.requestId });
    }
    const alreadyMapped = Boolean(packet.submissionId) && (
      new Set(["partially_signed", "reconciling", "archived"]).has(packet.status) ||
      (packet.status === "pending" && new Set(["Sent", "Partially signed", "Completed"]).has(agreement.signatureStatus))
    );
    if (alreadyMapped) {
      const terminal = await reconcileTerminalProviderState(packet, submission, configuration, workspaceId);
      if (terminal === "busy") {
        return apiJson({ signaturePacket: sanitizeSignaturePacket(packet), agreement, reconciled: false, processing: true, providerStatus: submission.status, requestId: auth.requestId }, { status: 202, requestId: auth.requestId, headers: auth.headers });
      }
      if (terminal === "none" && packet.status === "reconciling") {
        const reconciliationStartedAt = Date.parse(packet.updatedAt);
        if (Number.isFinite(reconciliationStartedAt) && Date.now() - reconciliationStartedAt < 15 * 60_000) {
          return apiJson({ signaturePacket: sanitizeSignaturePacket(packet), agreement, reconciled: false, processing: true, providerStatus: submission.status, requestId: auth.requestId }, { status: 202, requestId: auth.requestId, headers: auth.headers });
        }
        const now = new Date().toISOString();
        const restoredStatus = packet.activeKey === null
          ? "superseded"
          : agreement.signatureStatus === "Partially signed"
            ? "partially_signed"
            : "pending";
        const packetPatch = { status: restoredStatus, updatedAt: now, version: packet.version + 1 };
        const guardId = crypto.randomUUID();
        await db.batch([
          db.update(signaturePackets).set(packetPatch).where(and(
            eq(signaturePackets.workspaceId, workspaceId),
            eq(signaturePackets.id, packet.id),
            eq(signaturePackets.version, packet.version),
            eq(signaturePackets.status, "reconciling"),
          )),
          db.insert(mutationGuards).values({ id: guardId, workspaceId, operation: "signature.reconcile.release_stale_lock", guardChanges: sql<number>`changes()`, createdAt: now }),
          db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), eq(mutationGuards.id, guardId))),
        ]);
        return apiJson({ signaturePacket: sanitizeSignaturePacket({ ...packet, ...packetPatch }), agreement, reconciled: true, providerStatus: submission.status, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
      }
      if (terminal === "none") {
        const refreshed = await refreshNonterminalSubmission(packet, submission, workspaceId);
        return apiJson({
          signaturePacket: sanitizeSignaturePacket(refreshed.packet),
          agreement: refreshed.agreement,
          ...(refreshed.event ? { event: refreshed.event } : {}),
          reconciled: refreshed.event !== null,
          providerStatus: submission.archived_at ? "archived" : submission.status,
          requestId: auth.requestId,
        }, { requestId: auth.requestId, headers: auth.headers });
      }
      const [[currentPacket], currentAgreement] = await Promise.all([
        db.select().from(signaturePackets).where(and(eq(signaturePackets.workspaceId, workspaceId), eq(signaturePackets.id, packet.id))).limit(1),
        findActiveAgreement(db, workspaceId, agreement.id),
      ]);
      return apiJson({ signaturePacket: sanitizeSignaturePacket(currentPacket ?? packet), agreement: currentAgreement ?? agreement, reconciled: true, providerStatus: submission.status, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }
    const now = new Date().toISOString();
    const signers = reconcilePendingSignerEvidence(packet.signers, submission.submitters);
    const [documentVersion] = await db.select().from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, workspaceId),
      eq(agreementDocumentVersions.agreementId, agreement.id),
    )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
    const basisHash = documentVersion ? await computeAgreementBasisHash(agreement, documentVersion) : null;
    const approvals = agreement.approvalStatus === "Not required"
      ? []
      : await db.select().from(approvalRequests).where(and(
          eq(approvalRequests.workspaceId, workspaceId),
          eq(approvalRequests.agreementId, agreement.id),
        ));
    const canFinalizeAgreement = Boolean(
      documentVersion &&
      basisHash &&
      packet.basisHash === basisHash &&
      packet.documentVersion === documentVersion.version &&
      packet.documentSha256 === documentVersion.sha256 &&
      agreement.stage === "Signature" &&
      approvalsSatisfyPolicy(agreement, approvals, {
        hash: basisHash,
        documentVersion: documentVersion.version,
        documentSha256: documentVersion.sha256,
      }),
    );
    const providerArchived = submission.status === "pending" && Boolean(submission.archived_at);
    const canAdvanceAgreement = canFinalizeAgreement && !providerArchived;
    const packetPatch = providerArchived ? {
      submissionId: String(submission.id),
      status: "archived",
      signers,
      updatedAt: now,
      version: packet.version + 1,
    } : canFinalizeAgreement ? {
      submissionId: String(submission.id),
      status: "pending",
      signers,
      updatedAt: now,
      version: packet.version + 1,
    } : {
      submissionId: String(submission.id),
      status: "superseded",
      activeKey: null,
      signers,
      updatedAt: now,
      version: packet.version + 1,
    };
    const agreementPatch = canAdvanceAgreement ? {
      signatureStatus: "Sent",
      version: agreement.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: auth.context.user.id,
    } : null;
    const savedAgreement: typeof agreements.$inferSelect = agreementPatch ? { ...agreement, ...agreementPatch } : agreement;
    const event = await prepareAgreementEvent(db, {
      workspaceId,
      agreementId: agreement.id,
      type: "Signature",
      detail: providerArchived
        ? `Recovered and durably mapped archived DocuSeal submission ${submission.id}; its reversible provider reservation remains active.`
        : canFinalizeAgreement
        ? `Recovered and durably mapped DocuSeal submission ${submission.id} to its immutable working-paper packet.`
        : `Recovered DocuSeal submission ${submission.id}, but did not advance the agreement because its approved working-paper basis or lifecycle state is no longer current.`,
      actor: auth.context.user,
      createdAt: now,
    });
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId,
      topic: providerArchived ? "signature.packet_archived" : canFinalizeAgreement ? "signature.packet_created" : "signature.packet_superseded",
      aggregateType: "signature_packet",
      aggregateId: packet.id,
      payload: {
        packetId: packet.id,
        agreementId: agreement.id,
        provider: "docuseal",
        submissionId: String(submission.id),
        documentVersion: packet.documentVersion,
        documentSha256: packet.documentSha256,
        basisHash: packet.basisHash,
        status: packetPatch.status,
        actionable: canAdvanceAgreement,
        recovered: true,
        aggregateVersion: packetPatch.version,
        causationId: auth.requestId,
      },
    }));
    const agreementIntegrationEvent = agreementPatch
      ? prepareAgreementLifecycleUpdatedIntegrationEvent({
          before: agreement,
          agreement: savedAgreement,
          candidateFields: ["signatureStatus"],
          causationId: auth.requestId,
        })
      : null;
    const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
    const packetGuardId = crypto.randomUUID();
    const agreementGuardId = crypto.randomUUID();
    const statements = [
      db.update(signaturePackets).set(packetPatch).where(and(
        eq(signaturePackets.workspaceId, workspaceId),
        eq(signaturePackets.id, packet.id),
        eq(signaturePackets.version, packet.version),
        eq(signaturePackets.status, packet.status),
      )),
      db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: "signature.recover.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
      ...(agreementPatch ? [
        db.update(agreements).set(agreementPatch).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
        )),
        db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "signature.recover.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
      ] : []),
      db.insert(agreementEvents).values(event),
      ...(agreementPatch ? [db.insert(agreementVersions).values(await prepareAgreementSnapshot(savedAgreement, auth.context.user.id, event.id))] : []),
      db.insert(outboxEvents).values(outbox),
      ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
      db.delete(mutationGuards).where(and(
        eq(mutationGuards.workspaceId, workspaceId),
        inArray(mutationGuards.id, agreementPatch ? [packetGuardId, agreementGuardId] : [packetGuardId]),
      )),
    ] as Parameters<typeof db.batch>[0];
    await db.batch(statements);
    const mappedPacket: typeof signaturePackets.$inferSelect = { ...packet, ...packetPatch };
    const terminal = await reconcileTerminalProviderState(mappedPacket, submission, configuration, workspaceId);
    if (terminal === "busy") {
      return apiJson({
        signaturePacket: sanitizeSignaturePacket(mappedPacket),
        agreement: savedAgreement,
        event,
        reconciled: true,
        processing: true,
        basisCurrent: canFinalizeAgreement,
        providerStatus: providerArchived ? "archived" : submission.status,
        requestId: auth.requestId,
      }, { status: 202, requestId: auth.requestId, headers: auth.headers });
    }
    if (terminal === "terminal") {
      const [[currentPacket], currentAgreement] = await Promise.all([
        db.select().from(signaturePackets).where(and(eq(signaturePackets.workspaceId, workspaceId), eq(signaturePackets.id, packet.id))).limit(1),
        findActiveAgreement(db, workspaceId, agreement.id),
      ]);
      return apiJson({
        signaturePacket: sanitizeSignaturePacket(currentPacket ?? mappedPacket),
        agreement: currentAgreement ?? savedAgreement,
        event,
        reconciled: true,
        basisCurrent: canFinalizeAgreement,
        providerStatus: providerArchived ? "archived" : submission.status,
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }
    return apiJson({
      signaturePacket: sanitizeSignaturePacket(mappedPacket),
      agreement: savedAgreement,
      event,
      reconciled: true,
      basisCurrent: canFinalizeAgreement,
      providerStatus: providerArchived ? "archived" : submission.status,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Signature packet recovery could not complete.");
  }
}

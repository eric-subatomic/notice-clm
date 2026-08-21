import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  agreementDocumentVersions,
  agreementEvents,
  agreements,
  agreementVersions,
  approvalRequests,
  documents,
  mutationGuards,
  outboxEvents,
  signaturePackets,
} from "../../db/schema";
import { computeAgreementBasisHash } from "./agreement-basis";
import { approvalsSatisfyPolicy } from "./approval-policy";
import { inspectDocument, normalizedDocumentName, scanDocument, sha256Hex } from "./document-security";
import { downloadDocuSealArtifact, getDocuSealDocuments, getDocuSealSubmission, type DocuSealSubmission } from "./docuseal";
import { crmAgreementProjection, prepareAgreementLifecycleUpdatedIntegrationEvent, prepareIntegrationOutboxEvent } from "./integration-events";
import { findActiveAgreement, prepareAgreementEvent, prepareAgreementSnapshot, prepareOutboxEvent } from "./persistence";
import { getDocuSealConfiguration, getScannerConfiguration } from "./providers";
import { isTerminalSignaturePacketStatus, reconcileCompletedSignerEvidence, reconcilePendingSignerEvidence, reconcileSignerEventEvidence } from "./signature-evidence";
import { findReusableSignedArtifact } from "./signed-artifact-reuse";
import { cleanupStagedDocumentObject, type StagedObjectIdentity } from "./staged-object-cleanup";

type ReconciliationEnv = { DOCUMENTS: R2Bucket };
type Database = ReturnType<typeof getDb>;
type SignaturePacket = typeof signaturePackets.$inferSelect;
type Agreement = typeof agreements.$inferSelect;

const DOCUSEAL_ACTOR = Object.freeze({
  userId: "system:docuseal",
  email: "system@notice.local",
  displayName: "DocuSeal",
});

async function packetBasisIsCurrent(
  db: Database,
  workspaceId: string,
  packet: SignaturePacket,
  agreement: Agreement,
): Promise<boolean> {
  if (!packet.activeKey || agreement.stage !== "Signature") return false;
  const [latestDocumentVersion] = await db.select().from(agreementDocumentVersions).where(and(
    eq(agreementDocumentVersions.workspaceId, workspaceId),
    eq(agreementDocumentVersions.agreementId, agreement.id),
  )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
  if (!latestDocumentVersion) return false;
  const currentBasisHash = await computeAgreementBasisHash(agreement, latestDocumentVersion);
  const currentApprovals = agreement.approvalStatus === "Not required"
    ? []
    : await db.select().from(approvalRequests).where(and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.agreementId, agreement.id),
      ));
  return Boolean(
    packet.basisHash &&
    packet.basisHash === currentBasisHash &&
    packet.documentVersion === latestDocumentVersion.version &&
    packet.documentSha256 === latestDocumentVersion.sha256 &&
    approvalsSatisfyPolicy(agreement, currentApprovals, {
      hash: currentBasisHash,
      documentVersion: latestDocumentVersion.version,
      documentSha256: latestDocumentVersion.sha256,
    }),
  );
}

export async function partiallyCompleteSubmission(
  packet: SignaturePacket,
  workspaceId: string,
  providerSubmitter: Record<string, unknown>,
) {
  if (!new Set(["pending", "partially_signed", "superseded"]).has(packet.status)) return;
  const db = getDb();
  const agreement = await findActiveAgreement(db, workspaceId, packet.agreementId);
  if (!agreement) throw new Error("Signature packet agreement is unavailable");
  const now = new Date().toISOString();
  const signerEvidence = reconcileSignerEventEvidence(packet.signers, providerSubmitter, "completed");
  if (!signerEvidence.matched) throw new Error("DocuSeal form completion did not match a registered signer");
  const basisCurrent = await packetBasisIsCurrent(db, workspaceId, packet, agreement);
  const targetPacketStatus = basisCurrent ? "partially_signed" : "superseded";
  const targetActiveKey = basisCurrent ? packet.activeKey : null;
  const agreementPatch = basisCurrent && agreement.signatureStatus !== "Partially signed"
    ? { signatureStatus: "Partially signed", version: agreement.version + 1, updated: now, updatedAt: now, updatedByUserId: DOCUSEAL_ACTOR.userId }
    : null;
  if (
    packet.status === targetPacketStatus
    && packet.activeKey === targetActiveKey
    && JSON.stringify(packet.signers) === JSON.stringify(signerEvidence.signers)
    && agreementPatch === null
  ) {
    // Receipt finalization is deliberately retryable. If the durable signer and
    // agreement states already match this callback, replay must not create a
    // second audit event or advance the packet version again.
    return;
  }
  const packetPatch = basisCurrent
    ? { status: targetPacketStatus, signers: signerEvidence.signers, updatedAt: now, version: packet.version + 1 }
    : { status: targetPacketStatus, activeKey: null, signers: signerEvidence.signers, updatedAt: now, version: packet.version + 1 };
  const saved: typeof agreements.$inferSelect = agreementPatch ? { ...agreement, ...agreementPatch } : agreement;
  const event = await prepareAgreementEvent(db, {
    workspaceId,
    agreementId: agreement.id,
    type: "Signature",
    detail: basisCurrent
      ? "A signer completed their part of the DocuSeal submission."
      : "A signer completed a superseded DocuSeal submission; signer evidence was retained without changing the current agreement.",
    actor: DOCUSEAL_ACTOR,
    createdAt: now,
  });
  const packetGuardId = crypto.randomUUID();
  const agreementGuardId = crypto.randomUUID();
  const agreementIntegrationEvent = agreementPatch
    ? prepareAgreementLifecycleUpdatedIntegrationEvent({
        before: agreement,
        agreement: saved,
        candidateFields: ["signatureStatus"],
      })
    : null;
  const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
  const statements = [
    db.update(signaturePackets).set(packetPatch).where(and(
      eq(signaturePackets.workspaceId, workspaceId),
      eq(signaturePackets.id, packet.id),
      eq(signaturePackets.version, packet.version),
      eq(signaturePackets.status, packet.status),
    )),
    db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: "signature.partial.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.update(agreements).set(agreementPatch ?? { updatedAt: sql`${agreements.updatedAt}` }).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, agreement.id),
      eq(agreements.version, agreement.version),
      eq(agreements.nextAction, agreement.nextAction),
      isNull(agreements.deletedAt),
    )),
    db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "signature.partial.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.insert(agreementEvents).values(event),
    ...(agreementPatch ? [db.insert(agreementVersions).values(await prepareAgreementSnapshot(saved, DOCUSEAL_ACTOR.userId, event.id))] : []),
    ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, workspaceId),
      inArray(mutationGuards.id, [packetGuardId, agreementGuardId]),
    )),
  ] as Parameters<typeof db.batch>[0];
  await db.batch(statements);
}

export async function archiveSubmission(packet: SignaturePacket, workspaceId: string) {
  if (
    !packet.activeKey
    || packet.status === "archived"
    || isTerminalSignaturePacketStatus(packet.status)
    || new Set(["declined", "expired"]).has(packet.status)
  ) {
    // An inactive packet is already permanently nonactionable. The durable
    // webhook receipt records delivery; replay must not append an unguarded
    // agreement event after the agreement and packet may have been purged.
    return;
  }
  const db = getDb();
  const agreement = await findActiveAgreement(db, workspaceId, packet.agreementId);
  if (!agreement) throw new Error("Signature packet agreement is unavailable");
  const now = new Date().toISOString();
  const packetPatch = { status: "archived", updatedAt: now, version: packet.version + 1 };
  const event = await prepareAgreementEvent(db, {
    workspaceId,
    agreementId: agreement.id,
    type: "Signature",
    detail: "The DocuSeal submission was archived. Its reservation remains active because the provider can unarchive it.",
    actor: DOCUSEAL_ACTOR,
    createdAt: now,
  });
  const packetGuardId = crypto.randomUUID();
  const agreementGuardId = crypto.randomUUID();
  await db.batch([
    db.update(signaturePackets).set(packetPatch).where(and(
      eq(signaturePackets.workspaceId, workspaceId),
      eq(signaturePackets.id, packet.id),
      eq(signaturePackets.version, packet.version),
      eq(signaturePackets.status, packet.status),
    )),
    db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: "signature.archive.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.update(agreements).set({ updatedAt: sql`${agreements.updatedAt}` }).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, agreement.id),
      eq(agreements.version, agreement.version),
      eq(agreements.nextAction, agreement.nextAction),
      isNull(agreements.deletedAt),
    )),
    db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "signature.archive.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
    db.insert(agreementEvents).values(event),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, workspaceId),
      inArray(mutationGuards.id, [packetGuardId, agreementGuardId]),
    )),
  ]);
}

export async function refreshNonterminalSubmission(
  packet: SignaturePacket,
  submission: DocuSealSubmission,
  workspaceId: string,
): Promise<{ packet: SignaturePacket; agreement: Agreement; event: typeof agreementEvents.$inferInsert | null }> {
  if (!new Set(["pending", "partially_signed", "archived"]).has(packet.status) || submission.status !== "pending") {
    throw new Error("Only a mapped nonterminal DocuSeal submission can be refreshed");
  }
  const db = getDb();
  const agreement = await findActiveAgreement(db, workspaceId, packet.agreementId);
  if (!agreement) throw new Error("Signature packet agreement is unavailable");
  const signers = reconcilePendingSignerEvidence(packet.signers, submission.submitters);
  const providerArchived = Boolean(submission.archived_at);
  const basisCurrent = await packetBasisIsCurrent(db, workspaceId, packet, agreement);
  const hasCompletedSigner = signers.some((signer) => signer.status === "completed");
  const targetStatus = providerArchived
    ? "archived"
    : basisCurrent
      ? hasCompletedSigner ? "partially_signed" : "pending"
      : "superseded";
  const targetActiveKey = targetStatus === "superseded" ? null : packet.activeKey;
  const targetAgreementSignatureStatus = providerArchived || !basisCurrent
    ? null
    : hasCompletedSigner ? "Partially signed" : "Sent";
  const packetChanged = packet.status !== targetStatus ||
    packet.activeKey !== targetActiveKey ||
    JSON.stringify(packet.signers) !== JSON.stringify(signers);
  const agreementChanged = targetAgreementSignatureStatus !== null && agreement.signatureStatus !== targetAgreementSignatureStatus;
  if (!packetChanged && !agreementChanged) return { packet, agreement, event: null };

  const now = new Date().toISOString();
  const packetPatch = {
    status: targetStatus,
    activeKey: targetActiveKey,
    signers,
    updatedAt: now,
    version: packet.version + 1,
  };
  const agreementPatch = agreementChanged ? {
    signatureStatus: targetAgreementSignatureStatus as "Sent" | "Partially signed",
    version: agreement.version + 1,
    updated: now,
    updatedAt: now,
    updatedByUserId: DOCUSEAL_ACTOR.userId,
  } : null;
  const savedAgreement: Agreement = agreementPatch ? { ...agreement, ...agreementPatch } : agreement;
  const event = await prepareAgreementEvent(db, {
    workspaceId,
    agreementId: agreement.id,
    type: "Signature",
    detail: providerArchived
      ? "Refreshed DocuSeal state and confirmed that the reversible provider archive remains in place."
      : !basisCurrent
        ? "Refreshed DocuSeal state and marked the packet superseded because its approved working-paper basis is no longer current."
        : hasCompletedSigner
          ? "Refreshed DocuSeal state and reconciled attributable partial signer progress."
          : packet.status === "archived"
            ? "Refreshed DocuSeal state and confirmed that the submission was unarchived."
            : "Refreshed attributable DocuSeal signer state.",
    actor: DOCUSEAL_ACTOR,
    createdAt: now,
  });
  const packetGuardId = crypto.randomUUID();
  const agreementGuardId = crypto.randomUUID();
  const agreementIntegrationEvent = agreementPatch
    ? prepareAgreementLifecycleUpdatedIntegrationEvent({
        before: agreement,
        agreement: savedAgreement,
        candidateFields: ["signatureStatus"],
      })
    : null;
  const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
  const statements = [
    db.update(signaturePackets).set(packetPatch).where(and(
      eq(signaturePackets.workspaceId, workspaceId),
      eq(signaturePackets.id, packet.id),
      eq(signaturePackets.version, packet.version),
      eq(signaturePackets.status, packet.status),
    )),
    db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: "signature.refresh.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
    ...(agreementPatch ? [
      db.update(agreements).set(agreementPatch).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, agreement.id),
        eq(agreements.version, agreement.version),
        eq(agreements.nextAction, agreement.nextAction),
      )),
      db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "signature.refresh.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
    ] : []),
    db.insert(agreementEvents).values(event),
    ...(agreementPatch ? [db.insert(agreementVersions).values(await prepareAgreementSnapshot(savedAgreement, DOCUSEAL_ACTOR.userId, event.id))] : []),
    ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, workspaceId),
      inArray(mutationGuards.id, agreementPatch ? [packetGuardId, agreementGuardId] : [packetGuardId]),
    )),
  ] as Parameters<typeof db.batch>[0];
  await db.batch(statements);
  return { packet: { ...packet, ...packetPatch }, agreement: savedAgreement, event };
}

export async function closeSubmission(
  packet: SignaturePacket,
  workspaceId: string,
  status: "declined" | "expired",
  providerSubmitter: Record<string, unknown> | null = null,
): Promise<"closed" | "busy"> {
  if (new Set(["declined", "expired"]).has(packet.status) || isTerminalSignaturePacketStatus(packet.status)) return "closed";
  const reconciliationStartedAt = Date.parse(packet.updatedAt);
  if (packet.status === "reconciling" && Number.isFinite(reconciliationStartedAt) && Date.now() - reconciliationStartedAt < 15 * 60_000) return "busy";
  const db = getDb();
  const agreement = await findActiveAgreement(db, workspaceId, packet.agreementId);
  if (!agreement) throw new Error("Signature packet agreement is unavailable");
  const now = new Date().toISOString();
  const signerEvidence = status === "declined"
    ? reconcileSignerEventEvidence(packet.signers, providerSubmitter, "declined")
    : { signers: packet.signers, matched: true };
  if (!signerEvidence.matched) throw new Error("DocuSeal decline did not match a registered signer");
  const basisCurrent = await packetBasisIsCurrent(db, workspaceId, packet, agreement);
  const packetPatch = { status, activeKey: null, signers: signerEvidence.signers, updatedAt: now, version: packet.version + 1 };
  const agreementPatch = basisCurrent ? {
    signatureStatus: "Not sent",
    nextAction: status === "declined" ? "Resolve signature decline" : "Prepare a new signature packet",
    version: agreement.version + 1,
    updated: now,
    updatedAt: now,
    updatedByUserId: DOCUSEAL_ACTOR.userId,
  } : null;
  const saved: typeof agreements.$inferSelect = agreementPatch ? { ...agreement, ...agreementPatch } : agreement;
  const providerAction = status === "declined" ? "declined" : "expired";
  const event = await prepareAgreementEvent(db, {
    workspaceId,
    agreementId: agreement.id,
    type: "Signature",
    detail: basisCurrent
      ? `The DocuSeal submission ${providerAction}.`
      : `A superseded DocuSeal submission ${providerAction}; the current agreement was not changed.`,
    actor: DOCUSEAL_ACTOR,
    createdAt: now,
  });
  const packetGuardId = crypto.randomUUID();
  const agreementGuardId = crypto.randomUUID();
  const agreementIntegrationEvent = agreementPatch
    ? prepareAgreementLifecycleUpdatedIntegrationEvent({
        before: agreement,
        agreement: saved,
        candidateFields: ["signatureStatus"],
      })
    : null;
  const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
  const statements = [
    db.update(signaturePackets).set(packetPatch).where(and(
      eq(signaturePackets.workspaceId, workspaceId),
      eq(signaturePackets.id, packet.id),
      eq(signaturePackets.version, packet.version),
      eq(signaturePackets.status, packet.status),
    )),
    db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: `signature.${status}.packet`, guardChanges: sql<number>`changes()`, createdAt: now }),
    ...(agreementPatch ? [
      db.update(agreements).set(agreementPatch).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, agreement.id),
        eq(agreements.version, agreement.version),
        eq(agreements.nextAction, agreement.nextAction),
      )),
      db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: `signature.${status}.agreement`, guardChanges: sql<number>`changes()`, createdAt: now }),
    ] : []),
    db.insert(agreementEvents).values(event),
    ...(agreementPatch ? [db.insert(agreementVersions).values(await prepareAgreementSnapshot(saved, DOCUSEAL_ACTOR.userId, event.id))] : []),
    ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
    db.delete(mutationGuards).where(and(
      eq(mutationGuards.workspaceId, workspaceId),
      inArray(mutationGuards.id, agreementPatch ? [packetGuardId, agreementGuardId] : [packetGuardId]),
    )),
  ] as Parameters<typeof db.batch>[0];
  await db.batch(statements);
  return "closed";
}

export async function completeSubmission(
  packet: SignaturePacket,
  configuration: ReturnType<typeof getDocuSealConfiguration>,
  workspaceId: string,
): Promise<"completed" | "busy"> {
  if (isTerminalSignaturePacketStatus(packet.status)) return "completed";
  const db = getDb();
  const lockAt = new Date().toISOString();
  const reconcilingSince = Date.parse(packet.updatedAt);
  const lockIsFresh = Number.isFinite(reconcilingSince) && Date.now() - reconcilingSince < 15 * 60_000;
  if (packet.status === "reconciling" && lockIsFresh) return "busy";
  const restoreStatus = packet.status === "reconciling"
    ? packet.activeKey === null
      ? "superseded"
      : Array.isArray(packet.signers) && packet.signers.some((signer) =>
          signer && typeof signer === "object" && "status" in signer && (signer as { status?: unknown }).status === "completed"
        )
        ? "partially_signed"
        : "pending"
    : packet.status;
  const submissionId = Number(packet.submissionId);
  if (!Number.isSafeInteger(submissionId) || submissionId <= 0) throw new Error("Signature packet has no valid DocuSeal submission identifier");
  const claimedPacket: SignaturePacket = {
    ...packet,
    status: "reconciling",
    updatedAt: lockAt,
    version: packet.version + 1,
  };
  const lock = await db.update(signaturePackets).set({
    status: claimedPacket.status,
    updatedAt: claimedPacket.updatedAt,
    version: claimedPacket.version,
  }).where(and(
    eq(signaturePackets.workspaceId, workspaceId),
    eq(signaturePackets.id, packet.id),
    eq(signaturePackets.version, packet.version),
    eq(signaturePackets.status, packet.status),
  ));
  if (!lock.meta.changes) return "busy";

  try {
    const bucket = (env as unknown as ReconciliationEnv).DOCUMENTS;
    const submission = await getDocuSealSubmission(configuration, submissionId);
    if (submission.status !== "completed") throw new Error("DocuSeal reconciliation did not confirm completion");
    // Validate every signer identity and terminal status before any signed
    // bytes are downloaded or persisted. Invalid provider evidence must not
    // leave visible artifact rows behind.
    const completedSigners = reconcileCompletedSignerEvidence(claimedPacket.signers, submission.submitters);
    const artifactPolicyAgreement = await findActiveAgreement(db, workspaceId, claimedPacket.agreementId);
    if (!artifactPolicyAgreement) throw new Error("Signature packet agreement is unavailable");
    const artifactList = await getDocuSealDocuments(configuration, submissionId);
    // The adapter creates one signing document and requests the merged result.
    // Reject cardinality before the first download/write so a late failure can
    // never leave a successfully persisted prefix of a multi-artifact response.
    if (artifactList.documents.length !== 1) throw new Error("Completed DocuSeal submission must have exactly one merged signed artifact");
    let evidenceDocumentId: string | null = null;
    for (const [index, artifact] of artifactList.documents.entries()) {
      const downloaded = await downloadDocuSealArtifact(configuration, artifact.url);
      const fileName = normalizedDocumentName(`${artifact.name || `signed-${index + 1}`}.pdf`);
      const inspected = inspectDocument(downloaded.bytes, fileName);
      const sha256 = await sha256Hex(downloaded.bytes);
      const candidates = await db.select().from(documents).where(and(
        eq(documents.workspaceId, workspaceId),
        eq(documents.agreementId, claimedPacket.agreementId),
        eq(documents.sha256, sha256),
        eq(documents.role, "signed_artifact"),
        eq(documents.direction, "inbound"),
        eq(documents.providerMessageId, String(submissionId)),
        eq(documents.parentSha256, claimedPacket.documentSha256),
        eq(documents.scanStatus, "clean"),
        isNull(documents.deletedAt),
      )).limit(10);
      const existing = await findReusableSignedArtifact(candidates, {
        workspaceId,
        agreementId: claimedPacket.agreementId,
        sha256,
        providerMessageId: String(submissionId),
        parentSha256: claimedPacket.documentSha256,
      }, (objectKey) => bucket.get(objectKey));
      if (existing) {
        evidenceDocumentId ??= existing.id;
        continue;
      }
      const scan = await scanDocument(downloaded.bytes, { id: claimedPacket.id, fileName, contentType: inspected.contentType, sha256 }, getScannerConfiguration());
      if (scan.status !== "clean") throw new Error(scan.status === "malicious" ? "Signed artifact failed security scanning" : "Signed artifact scanner is unavailable");
      const documentId = crypto.randomUUID();
      const objectKey = `workspaces/${workspaceId}/signed/${claimedPacket.agreementId}/${claimedPacket.id}/${documentId}/${fileName}`;
      await bucket.put(objectKey, downloaded.bytes, {
        httpMetadata: { contentType: inspected.contentType },
        customMetadata: { source: "docuseal-signed-artifact", documentId, sha256, scanStatus: "clean" },
      });
      const stagedArtifact: StagedObjectIdentity = { workspaceId, id: documentId, objectKey, sha256 };
      try {
        const artifactCreatedAt = new Date().toISOString();
        const agreementGuardId = crypto.randomUUID();
        await db.batch([
          db.update(agreements).set({ updatedAt: sql`${agreements.updatedAt}` }).where(and(
            eq(agreements.workspaceId, workspaceId),
            eq(agreements.id, artifactPolicyAgreement.id),
            eq(agreements.version, artifactPolicyAgreement.version),
            eq(agreements.nextAction, artifactPolicyAgreement.nextAction),
            isNull(agreements.deletedAt),
          )),
          db.insert(mutationGuards).values({
            id: agreementGuardId,
            workspaceId,
            operation: "signature.artifact.agreement_policy",
            guardChanges: sql<number>`changes()`,
            createdAt: artifactCreatedAt,
          }),
          db.insert(documents).values({
            id: documentId,
            workspaceId,
            version: 1,
            agreementId: claimedPacket.agreementId,
            role: "signed_artifact",
            direction: "inbound",
            negotiationRoundId: null,
            providerMessageId: String(submissionId),
            parentSha256: claimedPacket.documentSha256,
            originalSenderEmail: null,
            fileName,
            objectKey,
            contentType: inspected.contentType,
            size: downloaded.bytes.byteLength,
            tags: ["Signed artifact", "DocuSeal evidence"],
            extracted: {},
            extractionMode: "Signed artifact; extraction intentionally skipped",
            sha256,
            scanStatus: "clean",
            scanProvider: scan.provider,
            scannedAt: scan.scannedAt,
            createdByUserId: DOCUSEAL_ACTOR.userId,
            legalHold: artifactPolicyAgreement.legalHold,
            retentionUntil: artifactPolicyAgreement.retentionUntil,
            deletedAt: null,
            createdAt: artifactCreatedAt,
          }),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, workspaceId),
            eq(mutationGuards.id, agreementGuardId),
          )),
        ]);
      } catch (error) {
        try { await cleanupStagedDocumentObject(db, bucket, stagedArtifact); } catch { /* retain on unknown authority for reconciliation */ }
        throw error;
      }
      evidenceDocumentId ??= documentId;
    }
    if (!evidenceDocumentId) throw new Error("Completed DocuSeal submission has no retained evidence artifact");

    const now = new Date().toISOString();
    const agreement = await findActiveAgreement(db, workspaceId, claimedPacket.agreementId);
    if (!agreement) throw new Error("Signature packet agreement is unavailable");
    const basisStillCurrent = await packetBasisIsCurrent(db, workspaceId, claimedPacket, agreement);
    const packetPatch = {
      // Provider evidence is necessary but never sufficient to activate legal
      // obligations. Keep the reservation until a legal/admin reviewer binds
      // an explicit decision to this exact basis and final artifact hash.
      status: basisStillCurrent ? "completed_review_required" : "completed_superseded",
      activeKey: basisStillCurrent ? claimedPacket.activeKey : null,
      signers: completedSigners,
      evidenceDocumentId,
      completedAt: submission.completed_at ?? now,
      updatedAt: now,
      version: claimedPacket.version + 1,
    };
    const reviewRequiredAgreementPatch = {
      signatureStatus: "completed_review_required",
      nextAction: "Review completed signature evidence",
      version: agreement.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: DOCUSEAL_ACTOR.userId,
    };
    const projectedAgreement: typeof agreements.$inferSelect = basisStillCurrent
      ? { ...agreement, ...reviewRequiredAgreementPatch }
      : agreement;
    if (!basisStillCurrent) {
      const completionOutbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
        workspaceId,
        topic: "signature.completed",
        aggregateType: "signature",
        aggregateId: claimedPacket.id,
        payload: {
          packetId: claimedPacket.id,
          agreementId: agreement.id,
          provider: "docuseal",
          submissionId: claimedPacket.submissionId,
          status: "completed_superseded",
          activated: false,
          documentVersion: claimedPacket.documentVersion,
          documentSha256: claimedPacket.documentSha256,
          evidenceDocumentId,
          aggregateVersion: packetPatch.version,
          crmAgreement: crmAgreementProjection(projectedAgreement),
        },
      }));
      const event = await prepareAgreementEvent(db, {
        workspaceId,
        agreementId: agreement.id,
        type: "Signature",
        detail: `DocuSeal submission ${submission.id} completed and its scanned artifact was retained, but it did not activate the agreement because the approved working-paper basis or lifecycle state changed.`,
        actor: DOCUSEAL_ACTOR,
        createdAt: now,
      });
      const packetGuardId = crypto.randomUUID();
      const agreementGuardId = crypto.randomUUID();
      await db.batch([
        db.update(signaturePackets).set(packetPatch).where(and(
          eq(signaturePackets.workspaceId, workspaceId),
          eq(signaturePackets.id, claimedPacket.id),
          eq(signaturePackets.version, claimedPacket.version),
          eq(signaturePackets.status, "reconciling"),
        )),
        db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: "signature.complete_superseded.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
        db.update(agreements).set({ updatedAt: sql`${agreements.updatedAt}` }).where(and(
          eq(agreements.workspaceId, workspaceId),
          eq(agreements.id, agreement.id),
          eq(agreements.version, agreement.version),
          eq(agreements.nextAction, agreement.nextAction),
          isNull(agreements.deletedAt),
        )),
        db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "signature.complete_superseded.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
        db.insert(agreementEvents).values(event),
        db.insert(outboxEvents).values(completionOutbox),
        db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), inArray(mutationGuards.id, [packetGuardId, agreementGuardId]))),
      ]);
      return "completed";
    }
    const agreementPatch = reviewRequiredAgreementPatch;
    const saved = projectedAgreement;
    const event = await prepareAgreementEvent(db, {
      workspaceId,
      agreementId: agreement.id,
      type: "Signature",
      detail: `DocuSeal submission ${submission.id} completed; its one merged signed artifact and signer evidence were ingested and verified. Human review of the exact retained evidence is required before activation.`,
      actor: DOCUSEAL_ACTOR,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, DOCUSEAL_ACTOR.userId, event.id);
    const agreementIntegrationEvent = prepareAgreementLifecycleUpdatedIntegrationEvent({
      before: agreement,
      agreement: saved,
      candidateFields: ["signatureStatus"],
    });
    const agreementOutbox = agreementIntegrationEvent ? prepareOutboxEvent(agreementIntegrationEvent) : null;
    const packetGuardId = crypto.randomUUID();
    const agreementGuardId = crypto.randomUUID();
    await db.batch([
      db.update(signaturePackets).set(packetPatch).where(and(
        eq(signaturePackets.workspaceId, workspaceId),
        eq(signaturePackets.id, claimedPacket.id),
        eq(signaturePackets.version, claimedPacket.version),
        eq(signaturePackets.status, "reconciling"),
        eq(signaturePackets.activeKey, claimedPacket.activeKey as string),
      )),
      db.insert(mutationGuards).values({ id: packetGuardId, workspaceId, operation: "signature.complete_review_required.packet", guardChanges: sql<number>`changes()`, createdAt: now }),
      db.update(agreements).set(agreementPatch).where(and(
        eq(agreements.workspaceId, workspaceId),
        eq(agreements.id, agreement.id),
        eq(agreements.version, agreement.version),
        eq(agreements.nextAction, agreement.nextAction),
        eq(agreements.stage, "Signature"),
        isNull(agreements.deletedAt),
      )),
      db.insert(mutationGuards).values({ id: agreementGuardId, workspaceId, operation: "signature.complete_review_required.agreement", guardChanges: sql<number>`changes()`, createdAt: now }),
      db.insert(agreementEvents).values(event),
      db.insert(agreementVersions).values(snapshot),
      ...(agreementOutbox ? [db.insert(outboxEvents).values(agreementOutbox)] : []),
      db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, workspaceId), inArray(mutationGuards.id, [packetGuardId, agreementGuardId]))),
    ]);
    return "completed";
  } catch (error) {
    await db.update(signaturePackets).set({
      status: restoreStatus,
      updatedAt: new Date().toISOString(),
      version: claimedPacket.version + 1,
    }).where(and(
      eq(signaturePackets.workspaceId, workspaceId),
      eq(signaturePackets.id, claimedPacket.id),
      eq(signaturePackets.version, claimedPacket.version),
      eq(signaturePackets.status, "reconciling"),
    ));
    throw error;
  }
}

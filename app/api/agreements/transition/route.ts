import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agreementDocumentVersions, agreementEvents, agreements, agreementVersions, approvalRequests, mutationGuards, negotiationRounds, outboxEvents } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { computeAgreementBasisHash } from "../../../lib/agreement-basis";
import { evaluateAgreementRiskReadiness } from "../../../lib/agreement-risk";
import { approvalsSatisfyPolicy } from "../../../lib/approval-policy";
import { apiError, apiJson } from "../../../lib/http";
import { crmAgreementProjection, prepareIntegrationOutboxEvent } from "../../../lib/integration-events";
import {
  findActiveAgreement,
  prepareAgreementEvent,
  prepareAgreementSnapshot,
  prepareOutboxEvent,
} from "../../../lib/persistence";
import { agreementTransitionSchema, parseJson } from "../../../lib/validation";

const nextStage: Record<string, string> = {
  Intake: "Draft",
  Draft: "Review",
  Review: "Negotiation",
  Negotiation: "Signature",
};

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agreement:update", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, agreementTransitionSchema, 16_000);
    await ensureStorageSchema();
    const db = getDb();
    const current = await findActiveAgreement(db, auth.context.workspace.id, input.id);
    if (!current) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    if (current.version !== input.version) return apiError("version_conflict", "Reload the agreement before advancing it.", { status: 409, requestId: auth.requestId });
    if (nextStage[current.stage] !== input.toStage) {
      return apiError("invalid_transition", `The agreement cannot move directly from ${current.stage} to ${input.toStage}.`, { status: 409, requestId: auth.requestId });
    }
    if (input.toStage === "Signature") {
      const [unresolvedRound] = await db.select({ id: negotiationRounds.id, status: negotiationRounds.status }).from(negotiationRounds).where(and(
        eq(negotiationRounds.workspaceId, auth.context.workspace.id),
        eq(negotiationRounds.agreementId, current.id),
        isNotNull(negotiationRounds.activeKey),
      )).limit(1);
      if (unresolvedRound) {
        return apiError(
          "negotiation_round_unresolved",
          "Resolve or close the current counterparty review round before signature.",
          { status: 409, requestId: auth.requestId },
        );
      }
      const [documentVersion] = await db.select().from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
        eq(agreementDocumentVersions.agreementId, current.id),
      )).orderBy(desc(agreementDocumentVersions.version)).limit(1);
      if (!documentVersion) return apiError("document_version_required", "Create and review an immutable working document version before signature.", { status: 409, requestId: auth.requestId });
      const riskReadiness = await evaluateAgreementRiskReadiness(current, documentVersion);
      if (!riskReadiness.evaluation.cleared) {
        return apiError("risk_assessment_required", riskReadiness.evaluation.blockers[0]?.message ?? "A current risk decision is required before signature.", { status: 409, requestId: auth.requestId });
      }
      const basisHash = await computeAgreementBasisHash(current, documentVersion);
      const requests = await db.select().from(approvalRequests).where(and(
        eq(approvalRequests.workspaceId, auth.context.workspace.id),
        eq(approvalRequests.agreementId, current.id),
      ));
      const approvalsMatchPaperAndPolicy = approvalsSatisfyPolicy(current, requests, {
        hash: basisHash,
        documentVersion: documentVersion.version,
        documentSha256: documentVersion.sha256,
      });
      if (!approvalsMatchPaperAndPolicy) {
        return apiError("approval_required", "All required approvals must be completed before signature.", { status: 409, requestId: auth.requestId });
      }
    }

    const now = new Date().toISOString();
    const nextAction = input.toStage === "Signature" ? "Prepare signature packet" : `Complete ${input.toStage.toLowerCase()}`;
    const patch = {
      stage: input.toStage,
      nextAction,
      signatureStatus: input.toStage === "Signature" ? "Preparing" : current.signatureStatus,
      version: current.version + 1,
      updated: now,
      updatedAt: now,
      updatedByUserId: auth.context.user.id,
    };
    const saved: typeof agreements.$inferSelect = { ...current, ...patch };
    const event = await prepareAgreementEvent(db, {
      workspaceId: auth.context.workspace.id,
      agreementId: current.id,
      type: "Workflow",
      detail: `Advanced from ${current.stage} to ${input.toStage}.`,
      actor: auth.context.user,
      createdAt: now,
    });
    const snapshot = await prepareAgreementSnapshot(saved, auth.context.user.id, event.id);
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: auth.context.workspace.id,
      topic: "agreement.stage_changed",
      aggregateType: "agreement",
      aggregateId: String(current.id),
      payload: {
        agreementId: current.id,
        from: current.stage,
        to: input.toStage,
        version: saved.version,
        aggregateVersion: saved.version,
        causationId: auth.requestId,
        crmAgreement: crmAgreementProjection(saved),
      },
    }));
    const guardId = crypto.randomUUID();
    const [result] = await db.batch([db.update(agreements).set(patch).where(and(
      eq(agreements.workspaceId, auth.context.workspace.id),
      eq(agreements.id, current.id),
      eq(agreements.version, current.version),
      eq(agreements.nextAction, current.nextAction),
    )), db.insert(mutationGuards).values({ id: guardId, workspaceId: auth.context.workspace.id, operation: "agreement.transition", guardChanges: sql<number>`changes()`, createdAt: now }), db.insert(agreementEvents).values(event), db.insert(agreementVersions).values(snapshot), db.insert(outboxEvents).values(outbox), db.delete(mutationGuards).where(and(eq(mutationGuards.workspaceId, auth.context.workspace.id), eq(mutationGuards.id, guardId)))]);
    if (!result.meta.changes) return apiError("version_conflict", "Reload the agreement before advancing it.", { status: 409, requestId: auth.requestId });
    return apiJson({ agreement: saved, event, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Agreement could not be advanced.");
  }
}

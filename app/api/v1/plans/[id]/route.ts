import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { agentActionExecutions, agentActionPlans, agentPlanDecisions, agreements } from "../../../../../db/schema";
import { actionIds, type ActionId } from "../../../../lib/action-registry";
import { evaluatePersistedAgentPlanReview } from "../../../../lib/agent-plan-review";
import { handleRouteError } from "../../../../lib/api";
import { apiError, apiJson } from "../../../../lib/http";
import {
  authorizeServicePrincipalRequest,
  authorizeV1ReadRequest,
} from "../../../../lib/service-principal-auth";

type Database = ReturnType<typeof getDb>;

async function hasActiveAgreementTarget(db: Database, workspaceId: string, agreementId: number): Promise<boolean> {
  const [activeAgreement] = await db.select({ id: agreements.id }).from(agreements).where(and(
    eq(agreements.workspaceId, workspaceId),
    eq(agreements.id, agreementId),
    isNull(agreements.deletedAt),
  )).limit(1);
  return Boolean(activeAgreement);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = (await context.params).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return apiError("plan_not_found", "Agent plan was not found.", { status: 404 });
  }
  const identity = await authorizeV1ReadRequest(request);
  if (!identity.ok) return identity.response;
  if (identity.actor.kind === "human" && !identity.actor.context.permissions.has("agent:admin")) {
    return apiError("permission_denied", "Agent-administration authority is required to review an agent plan.", {
      status: 403, requestId: identity.requestId, headers: identity.headers,
    });
  }
  try {
    await ensureStorageSchema();
    const db = getDb();
    const workspaceId = identity.actor.context.workspace.id;
    const [plan] = await db.select().from(agentActionPlans).where(and(
      eq(agentActionPlans.workspaceId, workspaceId),
      identity.actor.kind === "service"
        ? eq(agentActionPlans.principalId, identity.actor.context.principal.id)
        : undefined,
      eq(agentActionPlans.id, id),
    )).limit(1);
    if (!plan) {
      return apiError("plan_not_found", "Agent plan was not found.", {
        status: 404, requestId: identity.requestId, headers: identity.headers,
      });
    }
    const actionId = (actionIds as readonly string[]).includes(plan.actionId)
      ? plan.actionId as ActionId
      : null;
    let responseRequestId = identity.requestId;
    let responseHeaders = identity.headers;
    if (identity.actor.kind === "service") {
      if (!actionId) {
        return apiError("plan_authority_changed", "The persisted plan action is no longer registered.", {
          status: 409, requestId: identity.requestId, headers: identity.headers,
        });
      }
      const resource = { type: plan.resourceType, id: plan.resourceId };
      const authority = await authorizeServicePrincipalRequest(request, actionId, resource, plan.grantId);
      if (!authority.ok) return authority.response;
      if (authority.principal.id !== plan.principalId || authority.grant.id !== plan.grantId) {
        return apiError("plan_authority_changed", "The exact grant that created this plan is no longer the active authority for it.", {
          status: 403, requestId: authority.requestId, headers: authority.headers,
        });
      }
      if (
        plan.resourceType !== "agreement"
        || plan.agreementId === null
        || String(plan.agreementId) !== plan.resourceId
      ) {
        return apiError("plan_not_found", "Agent plan was not found.", {
          status: 404, requestId: authority.requestId, headers: authority.headers,
        });
      }
      if (!await hasActiveAgreementTarget(db, workspaceId, plan.agreementId)) {
        return apiError("plan_not_found", "Agent plan was not found.", {
          status: 404, requestId: authority.requestId, headers: authority.headers,
        });
      }
      responseRequestId = authority.requestId;
      responseHeaders = authority.headers;
    }
    const [[decision], [execution], review] = await Promise.all([
      db.select({
        id: agentPlanDecisions.id,
        planSha256: agentPlanDecisions.planSha256,
        decision: agentPlanDecisions.decision,
        reason: agentPlanDecisions.reason,
        decidedByUserId: agentPlanDecisions.decidedByUserId,
        decidedAt: agentPlanDecisions.decidedAt,
      }).from(agentPlanDecisions).where(and(
        eq(agentPlanDecisions.workspaceId, workspaceId),
        eq(agentPlanDecisions.planId, plan.id),
      )).limit(1),
      db.select({
        id: agentActionExecutions.id,
        status: agentActionExecutions.status,
        requestSha256: agentActionExecutions.requestSha256,
        result: agentActionExecutions.result,
        startedAt: agentActionExecutions.startedAt,
        completedAt: agentActionExecutions.completedAt,
      }).from(agentActionExecutions).where(and(
        eq(agentActionExecutions.workspaceId, workspaceId),
        eq(agentActionExecutions.planId, plan.id),
        identity.actor.kind === "service"
          ? eq(agentActionExecutions.principalId, identity.actor.context.principal.id)
          : undefined,
      )).limit(1),
      evaluatePersistedAgentPlanReview(db, plan),
    ]);
    if (
      identity.actor.kind === "service"
      && (plan.agreementId === null || !await hasActiveAgreementTarget(db, workspaceId, plan.agreementId))
    ) {
      return apiError("plan_not_found", "Agent plan was not found.", {
        status: 404, requestId: responseRequestId, headers: responseHeaders,
      });
    }
    return apiJson({
      plan: {
        id: plan.id,
        principalId: plan.principalId,
        grantId: plan.grantId,
        actionId: plan.actionId,
        target: { type: plan.resourceType, id: plan.resourceId },
        durableStatus: plan.status,
        status: plan.status,
        review: {
          evaluatedAt: review.evaluatedAt,
          effectiveStatus: review.effectiveStatus,
          eligible: review.eligible,
          blockers: review.blockers,
          currentBasis: review.currentBasis,
        },
        riskTier: plan.riskTier,
        input: plan.canonicalInput,
        inputSha256: plan.inputSha256,
        planSha256: plan.planSha256,
        expectedVersion: plan.expectedVersion,
        basisHash: plan.basisHash,
        workingDocument: plan.documentVersion && plan.documentSha256
          ? { version: plan.documentVersion, sha256: plan.documentSha256 }
          : null,
        policyVersion: plan.policyVersion,
        before: plan.beforeSnapshot,
        proposedDiff: plan.proposedDiff,
        blockers: plan.blockers,
        provenance: plan.provenance,
        expiresAt: plan.expiresAt,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        decision: decision ?? null,
        execution: execution ?? null,
      },
      requestId: responseRequestId,
    }, { requestId: responseRequestId, headers: responseHeaders });
  } catch (error) {
    return handleRouteError(error, identity.requestId, "The agent plan could not be loaded.");
  }
}

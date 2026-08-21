import { and, eq, exists, gt, inArray, isNotNull, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../../../db";
import { ensureStorageSchema } from "../../../../../../db/ensure";
import {
  agentActionPlans,
  agentGrants,
  agentPlanDecisions,
  agreementDocumentVersions,
  agreements,
  approvalRequests,
  mutationGuards,
  negotiationRounds,
  servicePrincipals,
  users,
  workspaceMemberships,
} from "../../../../../../db/schema";
import { evaluatePlanDecisionBinding } from "../../../../../lib/agent-governance";
import { evaluatePersistedAgentPlanReview } from "../../../../../lib/agent-plan-review";
import { authorizeApiRequest, handleRouteError } from "../../../../../lib/api";
import { apiError, apiJson } from "../../../../../lib/http";
import { isMutationGuardConflict } from "../../../../../lib/persistence";
import {
  EVALUATION_SERVICE_PRINCIPAL_HEADER,
} from "../../../../../lib/service-principal-auth";
import { parseJson } from "../../../../../lib/validation";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPEN_NEGOTIATION_STATUSES = ["prepared", "outbound", "returned", "review"] as const;
const decisionSchema = z.object({
  expectedStatus: z.literal("pending_approval"),
  planDigest: z.string().regex(SHA256_PATTERN),
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(8).max(4_000),
  confirmed: z.literal(true),
}).strict();

function isDecisionConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("uq_agent_plan_decisions_workspace_plan")
    || (message.includes("unique constraint failed") && message.includes("agent_plan_decisions"));
}

function approvalRoutingCommitFence(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  plan: typeof agentActionPlans.$inferSelect,
) {
  if (plan.actionId !== "approval.request") return sql`1 = 1`;
  const proposed = plan.proposedDiff;
  const policy = proposed && typeof proposed === "object" && !Array.isArray(proposed)
    ? (proposed as Record<string, unknown>).policy
    : null;
  const lanes = policy && typeof policy === "object" && !Array.isArray(policy)
    ? (policy as Record<string, unknown>).currentExactBasisLanes
    : null;
  if (
    !Array.isArray(lanes)
    || lanes.length > 20
    || plan.agreementId === null
    || !plan.basisHash
    || plan.documentVersion === null
    || !plan.documentSha256
  ) return sql`0 = 1`;
  const parsed = lanes.map((lane) => {
    if (!lane || typeof lane !== "object" || Array.isArray(lane)) return null;
    const record = lane as Record<string, unknown>;
    return typeof record.id === "string"
      && typeof record.role === "string"
      && typeof record.status === "string"
      && typeof record.version === "number"
      && Number.isSafeInteger(record.version)
      ? { id: record.id, role: record.role, status: record.status, version: record.version }
      : null;
  });
  if (parsed.some((lane) => lane === null)) return sql`0 = 1`;
  const exactLanes = parsed as Array<{ id: string; role: string; status: string; version: number }>;
  return and(
    notExists(db.select({ id: negotiationRounds.id }).from(negotiationRounds).where(and(
      eq(negotiationRounds.workspaceId, workspaceId),
      eq(negotiationRounds.agreementId, plan.agreementId),
      or(
        inArray(negotiationRounds.status, OPEN_NEGOTIATION_STATUSES),
        isNotNull(negotiationRounds.activeKey),
      ),
    ))),
    sql`(
      select count(*) from ${approvalRequests}
      where ${approvalRequests.workspaceId} = ${workspaceId}
        and ${approvalRequests.agreementId} = ${plan.agreementId}
        and ${approvalRequests.status} <> 'Superseded'
        and ${approvalRequests.basisHash} = ${plan.basisHash}
        and ${approvalRequests.documentVersion} = ${plan.documentVersion}
        and ${approvalRequests.documentSha256} = ${plan.documentSha256}
    ) = ${exactLanes.length}`,
    ...exactLanes.map((lane) => exists(db.select({ id: approvalRequests.id }).from(approvalRequests).where(and(
      eq(approvalRequests.workspaceId, workspaceId),
      eq(approvalRequests.agreementId, plan.agreementId!),
      eq(approvalRequests.id, lane.id),
      eq(approvalRequests.role, lane.role),
      eq(approvalRequests.status, lane.status),
      eq(approvalRequests.version, lane.version),
      ne(approvalRequests.status, "Superseded"),
      eq(approvalRequests.basisHash, plan.basisHash!),
      eq(approvalRequests.documentVersion, plan.documentVersion!),
      eq(approvalRequests.documentSha256, plan.documentSha256!),
    )))),
  );
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  // Evaluation mode otherwise supplies a human bootstrap identity on loopback.
  // Explicitly reject its service-principal marker so an agent cannot self-approve.
  if (request.headers.has(EVALUATION_SERVICE_PRINCIPAL_HEADER)) {
    return apiError("human_approval_required", "A service principal cannot decide its own action plan.", { status: 403 });
  }
  const auth = await authorizeApiRequest(request, "agent:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const id = (await context.params).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return apiError("plan_not_found", "Agent plan was not found.", { status: 404, requestId: auth.requestId, headers: auth.headers });
    }
    const input = await parseJson(request, decisionSchema, 8_000);
    await ensureStorageSchema();
    const db = getDb();
    const [plan] = await db.select().from(agentActionPlans).where(and(
      eq(agentActionPlans.workspaceId, auth.context.workspace.id),
      eq(agentActionPlans.id, id),
    )).limit(1);
    if (!plan) {
      return apiError("plan_not_found", "Agent plan was not found.", { status: 404, requestId: auth.requestId, headers: auth.headers });
    }
    const now = new Date().toISOString();
    const review = await evaluatePersistedAgentPlanReview(db, plan, now);
    if (plan.planSha256 !== input.planDigest) {
      return apiError("plan_digest_mismatch", "The persisted plan no longer matches its cryptographic decision basis.", {
        status: 409, requestId: auth.requestId, headers: auth.headers,
      });
    }
    if (!review.eligible || !review.material || !review.commitFence) {
      if (plan.status === "pending_approval" && (review.effectiveStatus === "expired" || review.effectiveStatus === "superseded")) {
        await db.update(agentActionPlans).set({ status: review.effectiveStatus, updatedAt: now }).where(and(
          eq(agentActionPlans.workspaceId, auth.context.workspace.id),
          eq(agentActionPlans.id, plan.id),
          eq(agentActionPlans.status, "pending_approval"),
          eq(agentActionPlans.planSha256, input.planDigest),
        ));
      }
      const codes = new Set(review.blockers.map((blocker) => blocker.code));
      const error = codes.has("PLAN_EXPIRED")
        ? { code: "plan_expired", message: "The plan expired before it was decided." }
        : codes.has("PLAN_NOT_PENDING")
          ? { code: "plan_state_conflict", message: "The plan is no longer awaiting a decision." }
          : codes.has("PLAN_DIGEST_MISMATCH") || codes.has("PLAN_DIGEST_UNVERIFIABLE")
            ? { code: "plan_digest_mismatch", message: "The persisted plan no longer matches its cryptographic decision basis." }
            : codes.has("ACTION_HUMAN_REQUIRED")
              ? { code: "action_not_executable", message: "A human-only domain action cannot be converted into agent authority by approving a plan." }
              : [...codes].some((code) => ["AUTHORITY", "GRANT", "SPONSOR", "PRINCIPAL", "MEMBERSHIP", "PERMISSION"]
                .some((marker) => code.includes(marker)))
                ? { code: "plan_authority_changed", message: "The plan's exact current delegated authority is no longer valid." }
                : { code: "plan_basis_stale", message: "The plan's action, policy, target, or exact paper basis changed after proposal." };
      return apiError(error.code, error.message, { status: 409, requestId: auth.requestId, headers: auth.headers });
    }
    const binding = await evaluatePlanDecisionBinding(review.material, {
      planId: plan.id,
      workspaceId: plan.workspaceId,
      planDigest: input.planDigest,
      decision: input.decision,
      decidedByHumanPrincipalId: auth.context.user.id,
      decidedAt: now,
      rationale: input.reason,
    });
    if (!binding.valid) {
      return apiError("plan_decision_invalid", "The decision is not valid for this exact plan and decision window.", {
        status: 409, requestId: auth.requestId, headers: auth.headers,
      });
    }

    const guardId = crypto.randomUUID();
    const nextStatus = input.decision === "approved" ? "approved" as const : "rejected" as const;
    const fence = review.commitFence;
    const documentFence = fence.target.documentVersion === null || fence.target.documentSha256 === null
      ? notExists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
        eq(agreementDocumentVersions.agreementId, fence.target.agreementId),
      )))
      : and(
        exists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
          eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
          eq(agreementDocumentVersions.agreementId, fence.target.agreementId),
          eq(agreementDocumentVersions.version, fence.target.documentVersion),
          eq(agreementDocumentVersions.sha256, fence.target.documentSha256),
        ))),
        notExists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
          eq(agreementDocumentVersions.workspaceId, auth.context.workspace.id),
          eq(agreementDocumentVersions.agreementId, fence.target.agreementId),
          gt(agreementDocumentVersions.version, fence.target.documentVersion),
        ))),
      );
    const actionFence = approvalRoutingCommitFence(db, auth.context.workspace.id, plan);
    try {
      await db.batch([
        db.update(agentActionPlans).set({ status: nextStatus, updatedAt: now }).where(and(
          eq(agentActionPlans.workspaceId, auth.context.workspace.id),
          eq(agentActionPlans.id, plan.id),
          eq(agentActionPlans.principalId, fence.principal.id),
          eq(agentActionPlans.grantId, fence.grant.id),
          eq(agentActionPlans.status, input.expectedStatus),
          eq(agentActionPlans.planSha256, input.planDigest),
          gt(agentActionPlans.expiresAt, now),
          exists(db.select({ id: servicePrincipals.id }).from(servicePrincipals).where(and(
            eq(servicePrincipals.workspaceId, auth.context.workspace.id),
            eq(servicePrincipals.id, fence.principal.id),
            eq(servicePrincipals.version, fence.principal.version),
            eq(servicePrincipals.status, "active"),
          ))),
          exists(db.select({ id: agentGrants.id }).from(agentGrants).where(and(
            eq(agentGrants.workspaceId, auth.context.workspace.id),
            eq(agentGrants.id, fence.grant.id),
            eq(agentGrants.principalId, fence.principal.id),
            eq(agentGrants.delegatorUserId, fence.grant.sponsorUserId),
            ne(agentGrants.delegatorUserId, auth.context.user.id),
            eq(agentGrants.version, fence.grant.version),
            eq(agentGrants.policyVersion, fence.grant.policyVersion),
            eq(agentGrants.status, "active"),
            isNull(agentGrants.revokedAt),
            eq(agentGrants.startsAt, fence.grant.startsAt),
            eq(agentGrants.expiresAt, fence.grant.expiresAt),
            lte(agentGrants.startsAt, now),
            gt(agentGrants.expiresAt, now),
          ))),
          exists(db.select({ id: users.id }).from(users).where(and(
            eq(users.id, fence.sponsor.id),
            eq(users.status, "active"),
            eq(users.updatedAt, fence.sponsor.updatedAt),
          ))),
          exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships).where(and(
            eq(workspaceMemberships.workspaceId, auth.context.workspace.id),
            eq(workspaceMemberships.userId, fence.sponsor.id),
            eq(workspaceMemberships.status, "active"),
            eq(workspaceMemberships.role, fence.membership.role as typeof workspaceMemberships.$inferSelect.role),
            eq(workspaceMemberships.updatedAt, fence.membership.updatedAt),
          ))),
          exists(db.select({ id: users.id }).from(users).where(and(
            eq(users.id, auth.context.user.id),
            eq(users.status, "active"),
          ))),
          exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships).where(and(
            eq(workspaceMemberships.workspaceId, auth.context.workspace.id),
            eq(workspaceMemberships.userId, auth.context.user.id),
            eq(workspaceMemberships.status, "active"),
            eq(workspaceMemberships.role, "admin"),
            eq(workspaceMemberships.role, auth.context.role),
          ))),
          exists(db.select({ id: agreements.id }).from(agreements).where(and(
            eq(agreements.workspaceId, auth.context.workspace.id),
            eq(agreements.id, fence.target.agreementId),
            eq(agreements.version, fence.target.version),
            eq(agreements.party, fence.target.party),
            eq(agreements.side, fence.target.side),
            eq(agreements.type, fence.target.type),
            eq(agreements.value, fence.target.value),
            eq(agreements.valueMinor, fence.target.valueMinor),
            eq(agreements.currencyCode, fence.target.currencyCode),
            eq(agreements.department, fence.target.department),
            eq(agreements.risk, fence.target.risk),
            fence.target.riskDisposition === null
              ? isNull(agreements.riskDisposition)
              : eq(agreements.riskDisposition, fence.target.riskDisposition),
            eq(agreements.effectiveDate, fence.target.effectiveDate),
            eq(agreements.expirationDate, fence.target.expirationDate),
            fence.target.workflowDefinitionId === null
              ? isNull(agreements.workflowDefinitionId)
              : eq(agreements.workflowDefinitionId, fence.target.workflowDefinitionId),
            fence.target.workflowPolicySha256 === null
              ? isNull(agreements.workflowPolicySha256)
              : eq(agreements.workflowPolicySha256, fence.target.workflowPolicySha256),
            fence.target.workflowApprovalLanes === null
              ? isNull(agreements.workflowApprovalLanes)
              : eq(agreements.workflowApprovalLanes, [...fence.target.workflowApprovalLanes]),
            isNull(agreements.deletedAt),
          ))),
          documentFence,
          actionFence,
        )),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId: auth.context.workspace.id,
          operation: "agent-plan.decide",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(agentPlanDecisions).values({
          id: crypto.randomUUID(),
          workspaceId: auth.context.workspace.id,
          planId: plan.id,
          planSha256: input.planDigest,
          decision: input.decision,
          reason: input.reason,
          decidedByUserId: auth.context.user.id,
          decidedAt: now,
        }),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, guardId),
        )),
      ]);
    } catch (error) {
      if (isMutationGuardConflict(error) || isDecisionConflict(error)) {
        return apiError("plan_state_conflict", "This plan was already decided or changed concurrently.", {
          status: 409, requestId: auth.requestId, headers: auth.headers,
        });
      }
      throw error;
    }
    return apiJson({
      decision: {
        planId: plan.id,
        planSha256: input.planDigest,
        decision: input.decision,
        reason: input.reason,
        decidedByUserId: auth.context.user.id,
        decidedAt: now,
      },
      planStatus: nextStatus,
      requestId: auth.requestId,
    }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The plan decision could not be recorded.");
  }
}

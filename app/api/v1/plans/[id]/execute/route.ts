import { and, desc, eq, exists, gt, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../../../db";
import { ensureStorageSchema } from "../../../../../../db/ensure";
import {
  agentActionExecutions,
  agentActionPlans,
  agentGrants,
  agentPlanDecisions,
  agentRuns,
  agreementDocumentVersions,
  agreements,
  mutationGuards,
  servicePrincipals,
  users,
  workspaceMemberships,
} from "../../../../../../db/schema";
import { computeAgreementBasisHash } from "../../../../../lib/agreement-basis";
import { parseAgentActionInput } from "../../../../../lib/agent-action-contracts";
import {
  actionIds,
  getAgentApiV1ActionCapability,
  getActionDefinition,
  type ActionId,
} from "../../../../../lib/action-registry";
import { matchesCurrentActionDefinition } from "../../../../../lib/agent-plan-review";
import {
  canonicalJson,
  canonicalJsonDigest,
  computeAgentActionPlanDigest,
  computeIdempotencyRequestDigest,
  computeIdempotencyScopeDigest,
  validateAgentExecutionProvenance,
  type AgentActionPlanMaterial,
  type AgentExecutionProvenance,
} from "../../../../../lib/agent-governance";
import {
  buildRequiredApprovalRoutingStatements,
  inspectRequiredApprovalRouting,
} from "../../../../../lib/approval-routing-service";
import { handleRouteError } from "../../../../../lib/api";
import { apiError, apiJson } from "../../../../../lib/http";
import { isMutationGuardConflict } from "../../../../../lib/persistence";
import {
  authorizeServicePrincipalRequest,
  authorizeV1ReadRequest,
} from "../../../../../lib/service-principal-auth";
import { parseJson } from "../../../../../lib/validation";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const idempotencyKeySchema = z.string().min(8).max(200)
  .regex(/^[\x21-\x7e]+$/, "Idempotency-Key must contain bounded visible ASCII characters.");
const executionSchema = z.object({
  planDigest: z.string().regex(SHA256_PATTERN),
}).strict();
type Database = ReturnType<typeof getDb>;

async function loadActiveAgreementTarget(db: Database, workspaceId: string, agreementId: number) {
  const [agreement] = await db.select().from(agreements).where(and(
    eq(agreements.workspaceId, workspaceId),
    eq(agreements.id, agreementId),
    isNull(agreements.deletedAt),
  )).limit(1);
  return agreement ?? null;
}

function activeExecutionAuthorityFence(
  db: Database,
  input: Readonly<{
    workspaceId: string;
    principalId: string;
    principalVersion: number;
    grantId: string;
    grantVersion: number;
    grantActionIds: readonly string[];
    grantResourceConstraints: unknown;
    grantPolicyVersion: string;
    grantStartsAt: string;
    grantExpiresAt: string;
    sponsorUserId: string;
    sponsorMembershipRole: string;
    at: string;
  }>,
) {
  return and(
    exists(db.select({ id: servicePrincipals.id }).from(servicePrincipals).where(and(
      eq(servicePrincipals.workspaceId, input.workspaceId),
      eq(servicePrincipals.id, input.principalId),
      eq(servicePrincipals.version, input.principalVersion),
      eq(servicePrincipals.status, "active"),
    ))),
    exists(db.select({ id: agentGrants.id }).from(agentGrants).where(and(
      eq(agentGrants.workspaceId, input.workspaceId),
      eq(agentGrants.id, input.grantId),
      eq(agentGrants.principalId, input.principalId),
      eq(agentGrants.delegatorUserId, input.sponsorUserId),
      eq(agentGrants.version, input.grantVersion),
      eq(agentGrants.actionIds, [...input.grantActionIds]),
      eq(
        agentGrants.resourceConstraints,
        input.grantResourceConstraints as typeof agentGrants.$inferSelect.resourceConstraints,
      ),
      eq(agentGrants.policyVersion, input.grantPolicyVersion),
      eq(agentGrants.startsAt, input.grantStartsAt),
      eq(agentGrants.expiresAt, input.grantExpiresAt),
      eq(agentGrants.status, "active"),
      isNull(agentGrants.revokedAt),
      lte(agentGrants.startsAt, input.at),
      gt(agentGrants.expiresAt, input.at),
    ))),
    exists(db.select({ id: users.id }).from(users).where(and(
      eq(users.id, input.sponsorUserId),
      eq(users.status, "active"),
    ))),
    exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships).where(and(
      eq(workspaceMemberships.workspaceId, input.workspaceId),
      eq(workspaceMemberships.userId, input.sponsorUserId),
      eq(workspaceMemberships.status, "active"),
      eq(
        workspaceMemberships.role,
        input.sponsorMembershipRole as typeof workspaceMemberships.$inferSelect.role,
      ),
    ))),
  );
}

function exactAgreementReadTargetFence(
  db: Database,
  workspaceId: string,
  agreement: typeof agreements.$inferSelect,
  document: Readonly<{ version: number; sha256: string }> | null,
) {
  const documentFence = document === null
    ? notExists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
      eq(agreementDocumentVersions.workspaceId, workspaceId),
      eq(agreementDocumentVersions.agreementId, agreement.id),
    )))
    : and(
      exists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, workspaceId),
        eq(agreementDocumentVersions.agreementId, agreement.id),
        eq(agreementDocumentVersions.version, document.version),
        eq(agreementDocumentVersions.sha256, document.sha256),
      ))),
      notExists(db.select({ id: agreementDocumentVersions.id }).from(agreementDocumentVersions).where(and(
        eq(agreementDocumentVersions.workspaceId, workspaceId),
        eq(agreementDocumentVersions.agreementId, agreement.id),
        gt(agreementDocumentVersions.version, document.version),
      ))),
    );
  return and(
    exists(db.select({ id: agreements.id }).from(agreements).where(and(
      eq(agreements.workspaceId, workspaceId),
      eq(agreements.id, agreement.id),
      eq(agreements.version, agreement.version),
      eq(agreements.party, agreement.party),
      eq(agreements.side, agreement.side),
      eq(agreements.type, agreement.type),
      eq(agreements.value, agreement.value),
      eq(agreements.valueMinor, agreement.valueMinor),
      eq(agreements.currencyCode, agreement.currencyCode),
      eq(agreements.stage, agreement.stage),
      eq(agreements.owner, agreement.owner),
      agreement.ownerUserId === null ? isNull(agreements.ownerUserId) : eq(agreements.ownerUserId, agreement.ownerUserId),
      agreement.primaryCounterpartyId === null
        ? isNull(agreements.primaryCounterpartyId)
        : eq(agreements.primaryCounterpartyId, agreement.primaryCounterpartyId),
      agreement.legalEntityId === null ? isNull(agreements.legalEntityId) : eq(agreements.legalEntityId, agreement.legalEntityId),
      agreement.governedTemplateVersionId === null
        ? isNull(agreements.governedTemplateVersionId)
        : eq(agreements.governedTemplateVersionId, agreement.governedTemplateVersionId),
      agreement.workflowDefinitionId === null
        ? isNull(agreements.workflowDefinitionId)
        : eq(agreements.workflowDefinitionId, agreement.workflowDefinitionId),
      agreement.workflowPolicySha256 === null
        ? isNull(agreements.workflowPolicySha256)
        : eq(agreements.workflowPolicySha256, agreement.workflowPolicySha256),
      agreement.workflowApprovalLanes === null
        ? isNull(agreements.workflowApprovalLanes)
        : eq(agreements.workflowApprovalLanes, [...agreement.workflowApprovalLanes]),
      eq(agreements.nextAction, agreement.nextAction),
      eq(agreements.due, agreement.due),
      eq(agreements.department, agreement.department),
      eq(agreements.risk, agreement.risk),
      agreement.riskDisposition === null
        ? isNull(agreements.riskDisposition)
        : eq(agreements.riskDisposition, agreement.riskDisposition),
      eq(agreements.approvalStatus, agreement.approvalStatus),
      eq(agreements.signatureStatus, agreement.signatureStatus),
      eq(agreements.effectiveDate, agreement.effectiveDate),
      eq(agreements.expirationDate, agreement.expirationDate),
      eq(agreements.tags, [...agreement.tags]),
      eq(agreements.updatedAt, agreement.updatedAt),
      isNull(agreements.deletedAt),
    ))),
    documentFence,
  );
}

function isUniqueExecutionConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("uq_agent_action_executions_workspace_principal_key")
    || (message.includes("unique constraint failed") && message.includes("agent_action_executions"));
}

function isAgreementEventSequenceConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("uq_agreement_events_workspace_agreement_sequence")
    || (message.includes("unique constraint failed") && message.includes("agreement_events.workspace_id") && message.includes("agreement_events.sequence"));
}

function isExactExecutionRetry(
  execution: typeof agentActionExecutions.$inferSelect,
  expected: Readonly<{
    planId: string;
    grantId: string;
    actionId: string;
    planSha256: string;
    requestSha256: string;
    idempotencyKeySha256: string;
  }>,
): boolean {
  return execution.planId === expected.planId
    && execution.grantId === expected.grantId
    && execution.actionId === expected.actionId
    && execution.planSha256 === expected.planSha256
    && execution.requestSha256 === expected.requestSha256
    && execution.idempotencyKeySha256 === expected.idempotencyKeySha256;
}

function runProvenance(plan: typeof agentActionPlans.$inferSelect, actionId: ActionId): { modelId: string; toolId: string } | null {
  if (!plan.provenance || typeof plan.provenance !== "object") return null;
  const run = (plan.provenance as Record<string, unknown>).run;
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const modelId = (run as Record<string, unknown>).modelId;
  const toolVersion = (run as Record<string, unknown>).toolVersion;
  if (typeof modelId !== "string" || !modelId.trim() || typeof toolVersion !== "string" || !toolVersion.trim()) return null;
  return { modelId, toolId: `notice.${actionId}@${toolVersion}` };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = (await context.params).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return apiError("plan_not_found", "Agent plan was not found.", { status: 404 });
  }
  const identity = await authorizeV1ReadRequest(request);
  if (!identity.ok) return identity.response;
  if (identity.actor.kind !== "service") {
    return apiError("service_principal_required", "Only the service principal that proposed a plan can execute it.", {
      status: 403, requestId: identity.requestId, headers: identity.headers,
    });
  }
  try {
    const input = await parseJson(request, executionSchema, 4_000);
    const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    if (!idempotencyKey.success) {
      return apiError("idempotency_key_required", "A bounded Idempotency-Key is required and must be retained for every retry.", {
        status: 400, requestId: identity.requestId, headers: identity.headers,
      });
    }
    await ensureStorageSchema();
    const db = getDb();
    const [plan] = await db.select().from(agentActionPlans).where(and(
      eq(agentActionPlans.workspaceId, identity.actor.context.workspace.id),
      eq(agentActionPlans.principalId, identity.actor.context.principal.id),
      eq(agentActionPlans.id, id),
    )).limit(1);
    if (!plan || !(actionIds as readonly string[]).includes(plan.actionId)) {
      return apiError("plan_not_found", "Agent plan was not found.", {
        status: 404, requestId: identity.requestId, headers: identity.headers,
      });
    }
    const actionId = plan.actionId as ActionId;
    const agentApiV1 = getAgentApiV1ActionCapability(actionId);
    if (!agentApiV1.executable) {
      return apiError(
        "action_not_executable",
        agentApiV1.blocker?.message ?? "This action is not executable through the v1 agent contract.",
        { status: 409, requestId: identity.requestId, headers: identity.headers },
      );
    }
    const resource = { type: plan.resourceType, id: plan.resourceId };
    const authority = await authorizeServicePrincipalRequest(request, actionId, resource, plan.grantId);
    if (!authority.ok) return authority.response;
    if (authority.principal.id !== plan.principalId || authority.grant.id !== plan.grantId) {
      return apiError("plan_authority_changed", "The exact grant that created this plan is no longer active for execution.", {
        status: 403, requestId: authority.requestId, headers: authority.headers,
      });
    }
    const definition = getActionDefinition(actionId);
    if (plan.planSha256 !== input.planDigest) {
      return apiError("plan_digest_mismatch", "The execution request does not match the exact persisted plan digest.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }

    const scope = {
      workspaceId: authority.workspace.id,
      principalId: authority.principal.id,
      actionId,
      resourceType: plan.resourceType,
      resourceId: plan.resourceId,
    };
    const keySha256 = await canonicalJsonDigest({ kind: "notice.idempotency-key", key: idempotencyKey.data });
    const scopeSha256 = await computeIdempotencyScopeDigest(scope);
    const requestSha256 = await computeIdempotencyRequestDigest(scope, {
      planId: plan.id,
      planDigest: input.planDigest,
      grantId: plan.grantId,
    });
    const [existing] = await db.select().from(agentActionExecutions).where(and(
      eq(agentActionExecutions.workspaceId, authority.workspace.id),
      eq(agentActionExecutions.principalId, authority.principal.id),
      eq(agentActionExecutions.idempotencyKeySha256, keySha256),
    )).limit(1);
    if (existing) {
      if (!isExactExecutionRetry(existing, {
        planId: plan.id,
        grantId: plan.grantId,
        actionId,
        planSha256: input.planDigest,
        requestSha256,
        idempotencyKeySha256: keySha256,
      })) {
        return apiError("idempotency_key_conflict", "This Idempotency-Key was already used for a different authorized request.", {
          status: 409, requestId: authority.requestId, headers: authority.headers,
        });
      }
    }
    if (
      plan.resourceType !== "agreement"
      || plan.agreementId === null
      || String(plan.agreementId) !== plan.resourceId
      || plan.expectedVersion === null
      || !plan.basisHash
    ) {
      return apiError("action_not_executable", "The plan does not contain a complete agreement target snapshot.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }
    const [agreement, [document]] = await Promise.all([
      loadActiveAgreementTarget(db, authority.workspace.id, plan.agreementId),
      db.select({ version: agreementDocumentVersions.version, sha256: agreementDocumentVersions.sha256 })
        .from(agreementDocumentVersions).where(and(
          eq(agreementDocumentVersions.workspaceId, authority.workspace.id),
          eq(agreementDocumentVersions.agreementId, plan.agreementId),
        )).orderBy(desc(agreementDocumentVersions.version)).limit(1),
    ]);
    if (!agreement) {
      return apiError("plan_basis_stale", "The agreement target is no longer available.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }
    if (existing) {
      // A committed result is the authoritative answer to an exact retry even
      // after the plan expires or the mutable agreement later changes. Current
      // principal/grant authority and active-target visibility were rechecked.
      if (existing.status === "succeeded" && existing.result) {
        const replayHeaders = new Headers(authority.headers);
        replayHeaders.set("Idempotency-Replayed", "true");
        return apiJson({ execution: { id: existing.id, status: existing.status, result: existing.result }, replay: true, requestId: authority.requestId }, {
          requestId: authority.requestId, headers: replayHeaders,
        });
      }
    }

    const savedActionDefinition = plan.provenance && typeof plan.provenance === "object" && !Array.isArray(plan.provenance)
      ? (plan.provenance as Record<string, unknown>).actionDefinition
      : null;
    if (!matchesCurrentActionDefinition(savedActionDefinition, plan.riskTier, definition)) {
      return apiError("plan_basis_stale", "The governed action implementation changed after human approval. Re-propose and review the current action contract.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }
    if (plan.policyVersion !== authority.grant.policyVersion) {
      return apiError("plan_authority_changed", "The grant policy version changed after this plan was approved.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }

    const now = new Date().toISOString();
    if (now >= plan.expiresAt) {
      if (plan.status === "approved") {
        await db.update(agentActionPlans).set({ status: "expired", updatedAt: now }).where(and(
          eq(agentActionPlans.workspaceId, authority.workspace.id),
          eq(agentActionPlans.id, plan.id),
          eq(agentActionPlans.status, "approved"),
        ));
      }
      return apiError("plan_expired", "The plan expired before this execution attempt.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }
    const exactDocument = document && document.version > 0 && SHA256_PATTERN.test(document.sha256) ? document : null;
    const currentBasisHash = exactDocument
      ? await computeAgreementBasisHash(agreement, exactDocument)
      : await canonicalJsonDigest({
        kind: "notice.agreement-without-working-document",
        workspaceId: authority.workspace.id,
        agreementId: agreement.id,
        agreementVersion: agreement.version,
      });
    if (
      agreement.version !== plan.expectedVersion
      || currentBasisHash !== plan.basisHash
      || (exactDocument?.version ?? null) !== plan.documentVersion
      || (exactDocument?.sha256 ?? null) !== plan.documentSha256
    ) {
      if (plan.status === "approved") {
        await db.update(agentActionPlans).set({ status: "superseded", updatedAt: now }).where(and(
          eq(agentActionPlans.workspaceId, authority.workspace.id),
          eq(agentActionPlans.id, plan.id),
          eq(agentActionPlans.status, "approved"),
        ));
      }
      return apiError("plan_basis_stale", "The agreement version or exact working-paper basis changed after approval.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }

    const material: AgentActionPlanMaterial = {
      schemaVersion: "1.0",
      planId: plan.id,
      workspaceId: plan.workspaceId,
      serviceAccountId: plan.principalId,
      grantId: plan.grantId,
      delegatorPrincipalId: authority.sponsor.id,
      actionId: plan.actionId,
      target: {
        resourceType: plan.resourceType,
        resourceId: plan.resourceId,
        version: plan.expectedVersion,
        basisHash: plan.basisHash,
      },
      input: plan.canonicalInput,
      policyVersion: plan.policyVersion,
      actionDefinition: plan.provenance && typeof plan.provenance === "object"
        ? (plan.provenance as Record<string, unknown>).actionDefinition
        : null,
      riskTier: plan.riskTier,
      beforeSnapshot: plan.beforeSnapshot,
      proposedDiff: plan.proposedDiff,
      blockers: plan.blockers,
      provenance: plan.provenance,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
    };
    if (await computeAgentActionPlanDigest(material) !== plan.planSha256) {
      return apiError("plan_digest_mismatch", "The persisted plan no longer matches its cryptographic execution basis.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }

    if (existing) {
      if (existing.status !== "executing" || plan.status !== "executing") {
        return apiError("execution_state_conflict", "The prior execution attempt is not safely replayable.", {
          status: 409, requestId: authority.requestId, headers: authority.headers,
        });
      }
    } else if (plan.status !== "approved") {
      return apiError("plan_state_conflict", "Only an approved, unexpired plan can begin execution.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }

    const run = runProvenance(plan, actionId);
    if (!run || !plan.runId) {
      return apiError("plan_provenance_invalid", "The plan is missing bounded execution provenance.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }
    const provenance: AgentExecutionProvenance & { idempotencyScopeSha256: string; requestId: string } = {
      schemaVersion: "1.0",
      workspaceId: authority.workspace.id,
      serviceAccountId: authority.principal.id,
      delegatorPrincipalId: authority.sponsor.id,
      grantId: authority.grant.id,
      agentRunId: plan.runId,
      planId: plan.id,
      planDigest: plan.planSha256,
      actionId,
      target: {
        resourceType: plan.resourceType,
        resourceId: plan.resourceId,
        version: plan.expectedVersion,
        basisHash: plan.basisHash,
      },
      policyVersion: plan.policyVersion,
      modelId: run.modelId,
      toolId: run.toolId,
      inputDigest: plan.inputSha256,
      startedAt: existing?.startedAt ?? now,
      idempotencyScopeSha256: scopeSha256,
      requestId: authority.requestId,
    };
    const provenanceValidation = validateAgentExecutionProvenance(provenance, {
      workspaceId: authority.workspace.id,
      serviceAccountId: authority.principal.id,
      delegatorPrincipalId: authority.sponsor.id,
      grantId: authority.grant.id,
      planId: plan.id,
      planDigest: plan.planSha256,
      actionId,
      resourceType: plan.resourceType,
      resourceId: plan.resourceId,
      version: plan.expectedVersion,
      basisHash: plan.basisHash,
      policyVersion: plan.policyVersion,
    });
    if (!provenanceValidation.valid) {
      return apiError("plan_provenance_invalid", "Execution provenance does not match the authorized plan.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }

    const [grantFence] = await db.select({ version: agentGrants.version }).from(agentGrants).where(and(
      eq(agentGrants.workspaceId, authority.workspace.id),
      eq(agentGrants.id, authority.grant.id),
      eq(agentGrants.principalId, authority.principal.id),
    )).limit(1);
    if (!grantFence) {
      return apiError("plan_authority_changed", "The exact grant is no longer available for atomic execution.", {
        status: 403, requestId: authority.requestId, headers: authority.headers,
      });
    }

    if (actionId === "approval.request") {
      if (existing) {
        return apiError("execution_in_progress", "This atomic routing execution is already being committed. Retry with the same Idempotency-Key.", {
          status: 409, requestId: authority.requestId, headers: authority.headers,
        });
      }
      const actionInput = parseAgentActionInput("approval.request", plan.canonicalInput);
      const inspection = await inspectRequiredApprovalRouting({
        db,
        workspaceId: authority.workspace.id,
        agreementId: plan.agreementId,
        due: actionInput.due,
      });
      if (inspection.blockers.length > 0) {
        const blocker = inspection.blockers[0];
        return apiError("plan_basis_stale", blocker.message, {
          status: 409, requestId: authority.requestId, headers: authority.headers,
        });
      }
      if (inspection.noOp || canonicalJson(inspection.preview) !== canonicalJson(plan.proposedDiff)) {
        return apiError("plan_basis_stale", "The server-compiled approval routing effect changed after human review.", {
          status: 409, requestId: authority.requestId, headers: authority.headers,
        });
      }
      const [decision] = await db.select().from(agentPlanDecisions).where(and(
        eq(agentPlanDecisions.workspaceId, authority.workspace.id),
        eq(agentPlanDecisions.planId, plan.id),
        eq(agentPlanDecisions.planSha256, plan.planSha256),
        eq(agentPlanDecisions.decision, "approved"),
        ne(agentPlanDecisions.decidedByUserId, authority.sponsor.id),
      )).limit(1);
      if (!decision) {
        return apiError("human_approval_required", "The exact plan digest has no attributable human approval decision.", {
          status: 409, requestId: authority.requestId, headers: authority.headers,
        });
      }
      const completedAt = new Date().toISOString();
      const claimGuardId = crypto.randomUUID();
      const receiptGuardId = crypto.randomUUID();
      const completionGuardId = crypto.randomUUID();
      const routing = await buildRequiredApprovalRoutingStatements({
        db,
        inspection,
        workspaceId: authority.workspace.id,
        requestedByUserId: authority.sponsor.id,
        actor: {
          id: authority.sponsor.id,
          email: `service-principal:${authority.principal.id}`,
          displayName: `${authority.principal.name} (governed agent)`,
        },
        requestId: authority.requestId,
        now: completedAt,
        attribution: {
          sourceAgentPlanId: plan.id,
          sourceAgentPlanReviewerUserId: decision.decidedByUserId,
          servicePrincipalId: authority.principal.id,
        },
      });
      const result = {
        schemaVersion: "1.0",
        actionId: "approval.request",
        mode: "ensure_required",
        agreement: {
          id: routing.agreement.id,
          version: routing.agreement.version,
          approvalStatus: routing.agreement.approvalStatus,
          nextAction: routing.agreement.nextAction,
        },
        createdApprovals: routing.createdApprovals.map((approval) => ({
          id: approval.id,
          role: approval.role,
          status: approval.status,
          due: approval.due,
          basisHash: approval.basisHash,
          documentVersion: approval.documentVersion,
          documentSha256: approval.documentSha256,
          requestedByUserId: approval.requestedByUserId,
          sourceAgentPlanId: approval.sourceAgentPlanId,
          sourceAgentPlanReviewerUserId: approval.sourceAgentPlanReviewerUserId,
        })),
        supersededApprovalIds: [...inspection.obsoleteApprovalIds],
        evidence: {
          planSha256: plan.planSha256,
          inputSha256: plan.inputSha256,
          basisHash: plan.basisHash,
          humanReviewerUserId: decision.decidedByUserId,
          agreementEventIds: [routing.event.id],
        },
      };
      try {
        await db.batch([
          db.insert(agentActionExecutions).values({
            id: plan.id,
            workspaceId: authority.workspace.id,
            planId: plan.id,
            principalId: authority.principal.id,
            grantId: authority.grant.id,
            actionId,
            planSha256: plan.planSha256,
            requestSha256,
            idempotencyKeySha256: keySha256,
            status: "executing",
            result: null,
            agreementEventIds: [],
            provenance,
            startedAt: now,
            completedAt: null,
          }),
          db.update(agentActionPlans).set({ status: "executing", updatedAt: now }).where(and(
            eq(agentActionPlans.workspaceId, authority.workspace.id),
            eq(agentActionPlans.id, plan.id),
            eq(agentActionPlans.principalId, authority.principal.id),
            eq(agentActionPlans.grantId, authority.grant.id),
            eq(agentActionPlans.status, "approved"),
            eq(agentActionPlans.planSha256, input.planDigest),
            gt(agentActionPlans.expiresAt, now),
            exists(db.select({ id: agentPlanDecisions.id }).from(agentPlanDecisions).where(and(
              eq(agentPlanDecisions.workspaceId, authority.workspace.id),
              eq(agentPlanDecisions.id, decision.id),
              eq(agentPlanDecisions.planId, plan.id),
              eq(agentPlanDecisions.planSha256, plan.planSha256),
              eq(agentPlanDecisions.decision, "approved"),
              eq(agentPlanDecisions.decidedByUserId, decision.decidedByUserId),
              ne(agentPlanDecisions.decidedByUserId, authority.sponsor.id),
            ))),
            exists(db.select({ id: servicePrincipals.id }).from(servicePrincipals).where(and(
              eq(servicePrincipals.workspaceId, authority.workspace.id),
              eq(servicePrincipals.id, authority.principal.id),
              eq(servicePrincipals.version, authority.principal.version),
              eq(servicePrincipals.status, "active"),
            ))),
            exists(db.select({ id: agentGrants.id }).from(agentGrants).where(and(
              eq(agentGrants.workspaceId, authority.workspace.id),
              eq(agentGrants.id, authority.grant.id),
              eq(agentGrants.principalId, authority.principal.id),
              eq(agentGrants.delegatorUserId, authority.sponsor.id),
              eq(agentGrants.version, grantFence.version),
              eq(agentGrants.policyVersion, plan.policyVersion),
              eq(agentGrants.status, "active"),
              isNull(agentGrants.revokedAt),
              lte(agentGrants.startsAt, now),
              gt(agentGrants.expiresAt, now),
            ))),
            exists(db.select({ id: users.id }).from(users).where(and(
              eq(users.id, authority.sponsor.id),
              eq(users.status, "active"),
            ))),
            exists(db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships).where(and(
              eq(workspaceMemberships.workspaceId, authority.workspace.id),
              eq(workspaceMemberships.userId, authority.sponsor.id),
              eq(workspaceMemberships.status, "active"),
              eq(workspaceMemberships.role, authority.membership.role as typeof workspaceMemberships.$inferSelect.role),
            ))),
          )),
          db.insert(mutationGuards).values({
            id: claimGuardId,
            workspaceId: authority.workspace.id,
            operation: "agent-plan.execute.approval-routing.claim",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
          ...routing.statements,
          db.update(agentActionExecutions).set({
            status: "succeeded",
            result,
            agreementEventIds: [routing.event.id],
            completedAt,
          }).where(and(
            eq(agentActionExecutions.workspaceId, authority.workspace.id),
            eq(agentActionExecutions.id, plan.id),
            eq(agentActionExecutions.principalId, authority.principal.id),
            eq(agentActionExecutions.status, "executing"),
            eq(agentActionExecutions.requestSha256, requestSha256),
          )),
          db.insert(mutationGuards).values({
            id: receiptGuardId,
            workspaceId: authority.workspace.id,
            operation: "agent-plan.execute.approval-routing.receipt",
            guardChanges: sql<number>`changes()`,
            createdAt: completedAt,
          }),
          db.update(agentActionPlans).set({ status: "succeeded", updatedAt: completedAt }).where(and(
            eq(agentActionPlans.workspaceId, authority.workspace.id),
            eq(agentActionPlans.id, plan.id),
            eq(agentActionPlans.status, "executing"),
            eq(agentActionPlans.planSha256, input.planDigest),
          )),
          db.insert(mutationGuards).values({
            id: completionGuardId,
            workspaceId: authority.workspace.id,
            operation: "agent-plan.execute.approval-routing.complete",
            guardChanges: sql<number>`changes()`,
            createdAt: completedAt,
          }),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, authority.workspace.id),
            or(
              eq(mutationGuards.id, claimGuardId),
              eq(mutationGuards.id, receiptGuardId),
              eq(mutationGuards.id, completionGuardId),
            ),
          )),
        ] as unknown as Parameters<typeof db.batch>[0]);
      } catch (error) {
        if (isUniqueExecutionConflict(error)) {
          const [winner] = await db.select().from(agentActionExecutions).where(and(
            eq(agentActionExecutions.workspaceId, authority.workspace.id),
            eq(agentActionExecutions.principalId, authority.principal.id),
            or(
              eq(agentActionExecutions.idempotencyKeySha256, keySha256),
              eq(agentActionExecutions.id, plan.id),
            ),
          )).limit(1);
          if (winner && isExactExecutionRetry(winner, {
            planId: plan.id,
            grantId: plan.grantId,
            actionId,
            planSha256: input.planDigest,
            requestSha256,
            idempotencyKeySha256: keySha256,
          }) && winner.status === "succeeded" && winner.result) {
            const replayHeaders = new Headers(authority.headers);
            replayHeaders.set("Idempotency-Replayed", "true");
            return apiJson({ execution: { id: winner.id, status: winner.status, result: winner.result }, replay: true, requestId: authority.requestId }, {
              requestId: authority.requestId, headers: replayHeaders,
            });
          }
          return apiError("idempotency_key_conflict", "The concurrent execution used a different request or Idempotency-Key.", {
            status: 409, requestId: authority.requestId, headers: authority.headers,
          });
        }
        if (isMutationGuardConflict(error) || isAgreementEventSequenceConflict(error)) {
          return apiError("plan_basis_stale", "Approval routing state changed before the atomic execution committed. Re-propose and review the current effect.", {
            status: 409, requestId: authority.requestId, headers: authority.headers,
          });
        }
        throw error;
      }
      return apiJson({
        execution: { id: plan.id, status: "succeeded", result, completedAt },
        replay: false,
        requestId: authority.requestId,
      }, { requestId: authority.requestId, headers: authority.headers });
    }

    const authorityFenceAt = (at: string) => activeExecutionAuthorityFence(db, {
      workspaceId: authority.workspace.id,
      principalId: authority.principal.id,
      principalVersion: authority.principal.version,
      grantId: authority.grant.id,
      grantVersion: grantFence.version,
      grantActionIds: authority.grant.actionIds,
      grantResourceConstraints: authority.grant.resourceConstraints,
      grantPolicyVersion: plan.policyVersion,
      grantStartsAt: authority.grant.startsAt,
      grantExpiresAt: authority.grant.expiresAt,
      sponsorUserId: authority.sponsor.id,
      sponsorMembershipRole: authority.membership.role,
      at,
    });
    const targetFence = exactAgreementReadTargetFence(
      db,
      authority.workspace.id,
      agreement,
      exactDocument,
    );

    if (!existing) {
      const claimGuardId = crypto.randomUUID();
      try {
        await db.batch([
          db.insert(agentActionExecutions).values({
            id: plan.id,
            workspaceId: authority.workspace.id,
            planId: plan.id,
            principalId: authority.principal.id,
            grantId: authority.grant.id,
            actionId,
            planSha256: plan.planSha256,
            requestSha256,
            idempotencyKeySha256: keySha256,
            status: "executing",
            result: null,
            agreementEventIds: [],
            provenance,
            startedAt: now,
            completedAt: null,
          }),
          db.update(agentActionPlans).set({ status: "executing", updatedAt: now }).where(and(
            eq(agentActionPlans.workspaceId, authority.workspace.id),
            eq(agentActionPlans.id, plan.id),
            eq(agentActionPlans.principalId, authority.principal.id),
            eq(agentActionPlans.grantId, authority.grant.id),
            eq(agentActionPlans.status, "approved"),
            eq(agentActionPlans.planSha256, input.planDigest),
            gt(agentActionPlans.expiresAt, now),
            authorityFenceAt(now),
            targetFence,
          )),
          db.insert(mutationGuards).values({
            id: claimGuardId,
            workspaceId: authority.workspace.id,
            operation: "agent-plan.execute.claim",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, authority.workspace.id),
            eq(mutationGuards.id, claimGuardId),
          )),
        ]);
      } catch (error) {
        if (isMutationGuardConflict(error)) {
          return apiError("plan_basis_stale", "The plan's authority, expiry, or exact agreement basis changed before the atomic execution claim committed.", {
            status: 409, requestId: authority.requestId, headers: authority.headers,
          });
        }
        if (isUniqueExecutionConflict(error)) {
          const [winner] = await db.select().from(agentActionExecutions).where(and(
            eq(agentActionExecutions.workspaceId, authority.workspace.id),
            eq(agentActionExecutions.principalId, authority.principal.id),
            or(
              eq(agentActionExecutions.idempotencyKeySha256, keySha256),
              eq(agentActionExecutions.id, plan.id),
            ),
          )).limit(1);
          if (winner && isExactExecutionRetry(winner, {
            planId: plan.id,
            grantId: plan.grantId,
            actionId,
            planSha256: input.planDigest,
            requestSha256,
            idempotencyKeySha256: keySha256,
          })) {
            if (winner.status === "succeeded" && winner.result) {
              const activeAgreement = await loadActiveAgreementTarget(db, authority.workspace.id, plan.agreementId);
              if (!activeAgreement) {
                return apiError("plan_basis_stale", "The agreement target is no longer available.", {
                  status: 409, requestId: authority.requestId, headers: authority.headers,
                });
              }
              const replayHeaders = new Headers(authority.headers);
              replayHeaders.set("Idempotency-Replayed", "true");
              return apiJson({
                execution: { id: winner.id, status: winner.status, result: winner.result },
                replay: true,
                requestId: authority.requestId,
              }, { requestId: authority.requestId, headers: replayHeaders });
            }
            return apiError("execution_in_progress", "Another execution attempt claimed this exact plan. Retry with the same Idempotency-Key.", {
              status: 409, requestId: authority.requestId, headers: authority.headers,
            });
          }
          return apiError("idempotency_key_conflict", "The concurrent execution claim used a different request or Idempotency-Key.", {
            status: 409, requestId: authority.requestId, headers: authority.headers,
          });
        }
        throw error;
      }
    }

    const result = {
      schemaVersion: "1.0",
      agreement: {
        id: agreement.id,
        version: agreement.version,
        party: agreement.party,
        side: agreement.side,
        type: agreement.type,
        value: agreement.value,
        valueMinor: agreement.valueMinor,
        currencyCode: agreement.currencyCode,
        stage: agreement.stage,
        owner: agreement.owner,
        ownerUserId: agreement.ownerUserId,
        primaryCounterpartyId: agreement.primaryCounterpartyId,
        legalEntityId: agreement.legalEntityId,
        governedTemplateVersionId: agreement.governedTemplateVersionId,
        workflowDefinitionId: agreement.workflowDefinitionId,
        workflowPolicySha256: agreement.workflowPolicySha256,
        workflowApprovalLanes: agreement.workflowApprovalLanes,
        nextAction: agreement.nextAction,
        due: agreement.due,
        department: agreement.department,
        risk: agreement.risk,
        riskDisposition: agreement.riskDisposition,
        approvalStatus: agreement.approvalStatus,
        signatureStatus: agreement.signatureStatus,
        effectiveDate: agreement.effectiveDate,
        expirationDate: agreement.expirationDate,
        tags: agreement.tags,
        updatedAt: agreement.updatedAt,
      },
      workingDocument: exactDocument,
      evidence: {
        planSha256: plan.planSha256,
        inputSha256: plan.inputSha256,
        basisHash: plan.basisHash,
      },
    };
    const completedAt = new Date().toISOString();
    const executionGuardId = crypto.randomUUID();
    const planGuardId = crypto.randomUUID();
    try {
      await db.batch([
        db.update(agentActionExecutions).set({ status: "succeeded", result, completedAt }).where(and(
          eq(agentActionExecutions.workspaceId, authority.workspace.id),
          eq(agentActionExecutions.id, plan.id),
          eq(agentActionExecutions.principalId, authority.principal.id),
          eq(agentActionExecutions.status, "executing"),
          eq(agentActionExecutions.requestSha256, requestSha256),
          exists(db.select({ id: agentActionPlans.id }).from(agentActionPlans).where(and(
            eq(agentActionPlans.workspaceId, authority.workspace.id),
            eq(agentActionPlans.id, plan.id),
            eq(agentActionPlans.principalId, authority.principal.id),
            eq(agentActionPlans.grantId, authority.grant.id),
            eq(agentActionPlans.status, "executing"),
            eq(agentActionPlans.planSha256, input.planDigest),
            gt(agentActionPlans.expiresAt, completedAt),
          ))),
          authorityFenceAt(completedAt),
          targetFence,
        )),
        db.insert(mutationGuards).values({
          id: executionGuardId,
          workspaceId: authority.workspace.id,
          operation: "agent-plan.execute.receipt",
          guardChanges: sql<number>`changes()`,
          createdAt: completedAt,
        }),
        db.update(agentActionPlans).set({ status: "succeeded", updatedAt: completedAt }).where(and(
          eq(agentActionPlans.workspaceId, authority.workspace.id),
          eq(agentActionPlans.id, plan.id),
          eq(agentActionPlans.status, "executing"),
          eq(agentActionPlans.planSha256, input.planDigest),
        )),
        db.insert(mutationGuards).values({
          id: planGuardId,
          workspaceId: authority.workspace.id,
          operation: "agent-plan.execute.complete",
          guardChanges: sql<number>`changes()`,
          createdAt: completedAt,
        }),
        db.update(agentRuns).set({ status: "succeeded", completedAt }).where(and(
          eq(agentRuns.workspaceId, authority.workspace.id),
          eq(agentRuns.id, plan.runId),
          eq(agentRuns.principalId, authority.principal.id),
        )),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, authority.workspace.id),
          eq(mutationGuards.id, executionGuardId),
        )),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, authority.workspace.id),
          eq(mutationGuards.id, planGuardId),
        )),
      ]);
    } catch (error) {
      if (isMutationGuardConflict(error)) {
        return apiError("execution_state_conflict", "The execution receipt or plan state changed concurrently.", {
          status: 409, requestId: authority.requestId, headers: authority.headers,
        });
      }
      throw error;
    }
    const activeAgreement = await loadActiveAgreementTarget(db, authority.workspace.id, plan.agreementId);
    if (!activeAgreement) {
      return apiError("plan_basis_stale", "The agreement target is no longer available.", {
        status: 409, requestId: authority.requestId, headers: authority.headers,
      });
    }
    return apiJson({
      execution: { id: plan.id, status: "succeeded", result, completedAt },
      replay: Boolean(existing),
      requestId: authority.requestId,
    }, { requestId: authority.requestId, headers: authority.headers });
  } catch (error) {
    return handleRouteError(error, identity.requestId, "The governed plan execution could not be completed.");
  }
}

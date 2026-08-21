import { and, desc, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  agentActionPlans,
  agentGrants,
  agreementDocumentVersions,
  agreements,
  servicePrincipals,
  users,
  workspaceMemberships,
  type AgentPlanStatus,
} from "../../db/schema";
import { computeAgreementBasisHash, computeRiskAssessmentBasisHash } from "./agreement-basis";
import { parseAgentActionInput } from "./agent-action-contracts";
import { inspectRequiredApprovalRouting } from "./approval-routing-service";
import { actionIds, getActionDefinition, type ActionDefinition, type ActionId } from "./action-registry";
import {
  canonicalJson,
  canonicalJsonDigest,
  computeAgentActionPlanDigest,
  type AgentActionPlanMaterial,
} from "./agent-governance";
import {
  ACTION_CATALOG_VERSION,
  evaluatePersistedAgentAuthority,
} from "./service-principal-auth";

type Database = ReturnType<typeof getDb>;
type PersistedPlan = typeof agentActionPlans.$inferSelect;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type AgentPlanReviewBlocker = Readonly<{
  code: string;
  message: string;
  permission?: string;
}>;

export type AgentPlanCurrentBasis = Readonly<{
  targetVersion: number;
  basisHash: string;
  documentVersion: number | null;
  documentSha256: string | null;
}>;

export type PersistedAgentPlanReview = Readonly<{
  evaluatedAt: string;
  effectiveStatus: AgentPlanStatus;
  eligible: boolean;
  blockers: readonly AgentPlanReviewBlocker[];
  currentBasis: AgentPlanCurrentBasis | null;
  /** Exact reconstructed material for the guarded decision write; never expose directly. */
  material: AgentActionPlanMaterial | null;
  /** Read facts that the decision UPDATE must re-prove atomically. */
  commitFence: AgentPlanReviewCommitFence | null;
}>;

export type AgentPlanReviewCommitFence = Readonly<{
  principal: Readonly<{ id: string; version: number }>;
  grant: Readonly<{
    id: string;
    version: number;
    sponsorUserId: string;
    policyVersion: string;
    startsAt: string;
    expiresAt: string;
  }>;
  sponsor: Readonly<{ id: string; updatedAt: string }>;
  membership: Readonly<{ role: string; updatedAt: string }>;
  target: Readonly<{
    agreementId: number;
    version: number;
    party: string;
    side: string;
    type: string;
    value: number;
    valueMinor: number;
    currencyCode: string;
    department: string;
    risk: string;
    riskDisposition: "assessed" | "waived" | null;
    effectiveDate: string;
    expirationDate: string;
    workflowDefinitionId: string | null;
    workflowPolicySha256: string | null;
    workflowApprovalLanes: readonly string[] | null;
    documentVersion: number | null;
    documentSha256: string | null;
  }>;
}>;

function addBlocker(blockers: AgentPlanReviewBlocker[], blocker: AgentPlanReviewBlocker): void {
  if (!blockers.some((candidate) => candidate.code === blocker.code && candidate.permission === blocker.permission)) {
    blockers.push(blocker);
  }
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** Equality is expired: decisions must occur strictly before the bound. */
export function isAgentPlanReviewExpired(expiresAt: string, now: string): boolean {
  if (!isCanonicalInstant(expiresAt) || !isCanonicalInstant(now)) return true;
  return now >= expiresAt;
}

export function deriveAgentPlanReviewDisposition(
  durableStatus: AgentPlanStatus,
  blockers: readonly AgentPlanReviewBlocker[],
): Readonly<{ effectiveStatus: AgentPlanStatus; eligible: boolean }> {
  const eligible = durableStatus === "pending_approval" && blockers.length === 0;
  const reviewable = new Set<AgentPlanStatus>(["draft", "pending_approval", "approved", "failed_retryable"]);
  if (!reviewable.has(durableStatus)) return { effectiveStatus: durableStatus, eligible };
  const materialBlockers = blockers.filter((blocker) => blocker.code !== "PLAN_NOT_PENDING");
  if (materialBlockers.some((blocker) => blocker.code === "PLAN_EXPIRED")) {
    return { effectiveStatus: "expired", eligible: false };
  }
  if (materialBlockers.length > 0) return { effectiveStatus: "superseded", eligible: false };
  return { effectiveStatus: durableStatus, eligible };
}

export function currentActionDefinitionSnapshot(definition: ActionDefinition) {
  return {
    catalogVersion: ACTION_CATALOG_VERSION,
    id: definition.id,
    implementationVersion: definition.implementationVersion,
    label: definition.label,
    targetTypes: [...definition.targetTypes],
    permissions: [...definition.permissions],
    riskTier: definition.riskTier,
    executionPolicy: definition.executionPolicy,
    confirmationPolicy: definition.confirmationPolicy,
    requiresTargetVersion: definition.requiresTargetVersion,
    requiresBasis: definition.requiresBasis,
    allowedStages: definition.allowedStages ? [...definition.allowedStages] : null,
    preconditions: [...definition.preconditions],
  };
}

/**
 * Compare a durable, reviewer-visible action contract with the implementation
 * that would execute it now. This check is shared by review and execution so a
 * deployment between those phases cannot silently reuse older human authority.
 */
export function matchesCurrentActionDefinition(
  savedDefinition: unknown,
  savedRiskTier: string,
  definition: ActionDefinition,
): boolean {
  try {
    return savedRiskTier === definition.riskTier
      && canonicalJson(savedDefinition) === canonicalJson(currentActionDefinitionSnapshot(definition));
  } catch {
    return false;
  }
}

function persistedActionDefinition(plan: PersistedPlan): unknown {
  if (!plan.provenance || typeof plan.provenance !== "object" || Array.isArray(plan.provenance)) return null;
  return (plan.provenance as Record<string, unknown>).actionDefinition ?? null;
}

/**
 * Read-only decision basis shared by reviewer GET and decision POST. It performs
 * no repair or terminal-state write; callers deciding to persist an effective
 * terminal status must do so under their own optimistic guard.
 */
export async function evaluatePersistedAgentPlanReview(
  db: Database,
  plan: PersistedPlan,
  now = new Date().toISOString(),
): Promise<PersistedAgentPlanReview> {
  const blockers: AgentPlanReviewBlocker[] = [];
  let authorityFence: Omit<AgentPlanReviewCommitFence, "target"> | null = null;
  let targetFence: AgentPlanReviewCommitFence["target"] | null = null;
  if (plan.status !== "pending_approval") {
    addBlocker(blockers, { code: "PLAN_NOT_PENDING", message: "The durable plan is not awaiting human approval." });
  }
  if (isAgentPlanReviewExpired(plan.expiresAt, now)) {
    addBlocker(blockers, { code: "PLAN_EXPIRED", message: "The plan decision window has expired." });
  }

  const actionId = (actionIds as readonly string[]).includes(plan.actionId)
    ? plan.actionId as ActionId
    : null;
  const definition = actionId ? getActionDefinition(actionId) : null;
  if (!definition) {
    addBlocker(blockers, { code: "PLAN_ACTION_UNKNOWN", message: "The persisted action is no longer registered." });
  } else {
    if (definition.executionPolicy === "human_only") {
      addBlocker(blockers, { code: "ACTION_HUMAN_REQUIRED", message: "A human-only domain action cannot be delegated through an agent plan." });
    }
    const savedDefinition = persistedActionDefinition(plan);
    if (!matchesCurrentActionDefinition(savedDefinition, plan.riskTier, definition)) {
      addBlocker(blockers, { code: "PLAN_ACTION_DEFINITION_DRIFT", message: "The governed action definition changed after proposal or is invalid." });
    }
  }

  const [[principal], [grantAuthority]] = await Promise.all([
    db.select().from(servicePrincipals).where(and(
      eq(servicePrincipals.workspaceId, plan.workspaceId),
      eq(servicePrincipals.id, plan.principalId),
    )).limit(1),
    db.select({
      grant: agentGrants,
      sponsorId: users.id,
      sponsorStatus: users.status,
      sponsorUpdatedAt: users.updatedAt,
      membershipWorkspaceId: workspaceMemberships.workspaceId,
      membershipUserId: workspaceMemberships.userId,
      membershipRole: workspaceMemberships.role,
      membershipStatus: workspaceMemberships.status,
      membershipUpdatedAt: workspaceMemberships.updatedAt,
    }).from(agentGrants)
      .innerJoin(users, eq(users.id, agentGrants.delegatorUserId))
      .leftJoin(workspaceMemberships, and(
        eq(workspaceMemberships.workspaceId, agentGrants.workspaceId),
        eq(workspaceMemberships.userId, agentGrants.delegatorUserId),
      )).where(and(
        eq(agentGrants.workspaceId, plan.workspaceId),
        eq(agentGrants.id, plan.grantId),
        eq(agentGrants.principalId, plan.principalId),
      )).limit(1),
  ]);

  const resolvedAuthority = principal
    && grantAuthority
    && grantAuthority.membershipWorkspaceId
    && grantAuthority.membershipUserId
    && grantAuthority.membershipRole
    && grantAuthority.membershipStatus
    && grantAuthority.membershipUpdatedAt
    ? {
      principal,
      grantAuthority,
      membership: {
        workspaceId: grantAuthority.membershipWorkspaceId,
        userId: grantAuthority.membershipUserId,
        role: grantAuthority.membershipRole,
        status: grantAuthority.membershipStatus,
        updatedAt: grantAuthority.membershipUpdatedAt,
      },
    }
    : null;
  if (!resolvedAuthority) {
    addBlocker(blockers, { code: "PLAN_AUTHORITY_UNAVAILABLE", message: "The exact principal, grant, sponsor, or membership is unavailable." });
  } else if (actionId) {
    if (plan.policyVersion !== resolvedAuthority.grantAuthority.grant.policyVersion) {
      addBlocker(blockers, { code: "PLAN_POLICY_DRIFT", message: "The grant policy version changed after proposal." });
    }
    const authority = evaluatePersistedAgentAuthority({
      principal: resolvedAuthority.principal,
      grant: resolvedAuthority.grantAuthority.grant,
      sponsor: {
        id: resolvedAuthority.grantAuthority.sponsorId,
        status: resolvedAuthority.grantAuthority.sponsorStatus,
      },
      membership: resolvedAuthority.membership,
      workspaceId: plan.workspaceId,
      actionId,
      resource: { type: plan.resourceType, id: plan.resourceId },
      now,
    });
    for (const blocker of authority.blockers) {
      addBlocker(blockers, { code: blocker.code, message: blocker.message, ...(blocker.permission ? { permission: blocker.permission } : {}) });
    }
    if (authority.authorized) {
      authorityFence = {
        principal: { id: resolvedAuthority.principal.id, version: resolvedAuthority.principal.version },
        grant: {
          id: resolvedAuthority.grantAuthority.grant.id,
          version: resolvedAuthority.grantAuthority.grant.version,
          sponsorUserId: resolvedAuthority.grantAuthority.grant.delegatorUserId,
          policyVersion: resolvedAuthority.grantAuthority.grant.policyVersion,
          startsAt: resolvedAuthority.grantAuthority.grant.startsAt,
          expiresAt: resolvedAuthority.grantAuthority.grant.expiresAt,
        },
        sponsor: {
          id: resolvedAuthority.grantAuthority.sponsorId,
          updatedAt: resolvedAuthority.grantAuthority.sponsorUpdatedAt,
        },
        membership: {
          role: resolvedAuthority.membership.role,
          updatedAt: resolvedAuthority.membership.updatedAt,
        },
      };
    }
  }

  let currentBasis: AgentPlanCurrentBasis | null = null;
  if (plan.resourceType !== "agreement" || plan.agreementId === null || String(plan.agreementId) !== plan.resourceId) {
    addBlocker(blockers, { code: "PLAN_TARGET_INVALID", message: "The persisted agreement target is incomplete or inconsistent." });
  } else {
    const [[agreement], [document]] = await Promise.all([
      db.select().from(agreements).where(and(
        eq(agreements.workspaceId, plan.workspaceId),
        eq(agreements.id, plan.agreementId),
      )).limit(1),
      db.select({ version: agreementDocumentVersions.version, sha256: agreementDocumentVersions.sha256 })
        .from(agreementDocumentVersions).where(and(
          eq(agreementDocumentVersions.workspaceId, plan.workspaceId),
          eq(agreementDocumentVersions.agreementId, plan.agreementId),
        )).orderBy(desc(agreementDocumentVersions.version)).limit(1),
    ]);
    if (!agreement) {
      addBlocker(blockers, { code: "PLAN_TARGET_MISSING", message: "The agreement target no longer exists." });
    } else if (agreement.deletedAt !== null) {
      addBlocker(blockers, { code: "PLAN_TARGET_DELETED", message: "The agreement target was deleted after proposal." });
    } else {
      const exactDocument = document && Number.isSafeInteger(document.version) && document.version > 0
        && SHA256_PATTERN.test(document.sha256) ? document : null;
      const workingDocumentRequired = Boolean(
        definition?.requiresBasis
        || definition?.preconditions.includes("working_document_present")
        || plan.documentVersion !== null
        || plan.documentSha256 !== null,
      );
      if (!exactDocument && workingDocumentRequired) {
        addBlocker(blockers, { code: "PLAN_WORKING_DOCUMENT_MISSING", message: "The current working document is missing or invalid." });
      }
      const basisHash = exactDocument
        ? (actionId === "risk.assess" || actionId === "risk.waive"
          ? await computeRiskAssessmentBasisHash(agreement, exactDocument)
          : await computeAgreementBasisHash(agreement, exactDocument))
        : await canonicalJsonDigest({
          kind: "notice.agreement-without-working-document",
          workspaceId: plan.workspaceId,
          agreementId: agreement.id,
          agreementVersion: agreement.version,
        });
      currentBasis = {
        targetVersion: agreement.version,
        basisHash,
        documentVersion: exactDocument?.version ?? null,
        documentSha256: exactDocument?.sha256 ?? null,
      };
      targetFence = {
        agreementId: agreement.id,
        version: agreement.version,
        party: agreement.party,
        side: agreement.side,
        type: agreement.type,
        value: agreement.value,
        valueMinor: agreement.valueMinor,
        currencyCode: agreement.currencyCode,
        department: agreement.department,
        risk: agreement.risk,
        riskDisposition: agreement.riskDisposition,
        effectiveDate: agreement.effectiveDate,
        expirationDate: agreement.expirationDate,
        workflowDefinitionId: agreement.workflowDefinitionId,
        workflowPolicySha256: agreement.workflowPolicySha256,
        workflowApprovalLanes: agreement.workflowApprovalLanes,
        documentVersion: exactDocument?.version ?? null,
        documentSha256: exactDocument?.sha256 ?? null,
      };
      if (plan.expectedVersion === null || plan.expectedVersion !== agreement.version) {
        addBlocker(blockers, { code: "PLAN_TARGET_VERSION_DRIFT", message: "The agreement version changed after proposal." });
      }
      if (plan.documentVersion !== currentBasis.documentVersion) {
        addBlocker(blockers, { code: "PLAN_DOCUMENT_VERSION_DRIFT", message: "The working-document version changed after proposal." });
      }
      if (plan.documentSha256 !== currentBasis.documentSha256) {
        addBlocker(blockers, { code: "PLAN_DOCUMENT_HASH_DRIFT", message: "The working-document hash changed after proposal." });
      }
      if (!plan.basisHash || plan.basisHash !== currentBasis.basisHash) {
        addBlocker(blockers, { code: "PLAN_BASIS_DRIFT", message: "The exact agreement basis changed after proposal." });
      }

      if (actionId === "approval.request") {
        try {
          const actionInput = parseAgentActionInput("approval.request", plan.canonicalInput);
          const routing = await inspectRequiredApprovalRouting({
            db,
            workspaceId: plan.workspaceId,
            agreementId: agreement.id,
            due: actionInput.due,
          });
          for (const blocker of routing.blockers) {
            addBlocker(blockers, {
              code: `PLAN_ACTION_${blocker.code.toUpperCase()}`,
              message: blocker.message,
            });
          }
          if (routing.noOp) {
            addBlocker(blockers, {
              code: "PLAN_ACTION_NO_EFFECT",
              message: "Current policy and approval lanes no longer require the proposed routing mutation.",
            });
          }
          if (canonicalJson(plan.proposedDiff) !== canonicalJson(routing.preview)) {
            addBlocker(blockers, {
              code: "PLAN_ACTION_EFFECT_DRIFT",
              message: "The server-compiled approval routing effect changed after proposal.",
            });
          }
        } catch {
          addBlocker(blockers, {
            code: "PLAN_ACTION_INPUT_INVALID",
            message: "The approval routing input is no longer valid under the registered action contract.",
          });
        }
      }
    }
  }

  let material: AgentActionPlanMaterial | null = null;
  if (resolvedAuthority && plan.expectedVersion !== null && plan.basisHash) {
    material = {
      schemaVersion: "1.0",
      planId: plan.id,
      workspaceId: plan.workspaceId,
      serviceAccountId: plan.principalId,
      grantId: plan.grantId,
      delegatorPrincipalId: resolvedAuthority.grantAuthority.grant.delegatorUserId,
      actionId: plan.actionId,
      target: {
        resourceType: plan.resourceType,
        resourceId: plan.resourceId,
        version: plan.expectedVersion,
        basisHash: plan.basisHash,
      },
      input: plan.canonicalInput,
      policyVersion: plan.policyVersion,
      actionDefinition: persistedActionDefinition(plan),
      riskTier: plan.riskTier,
      beforeSnapshot: plan.beforeSnapshot,
      proposedDiff: plan.proposedDiff,
      blockers: plan.blockers,
      provenance: plan.provenance,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
    };
    if (await computeAgentActionPlanDigest(material) !== plan.planSha256) {
      addBlocker(blockers, { code: "PLAN_DIGEST_MISMATCH", message: "The persisted plan no longer matches its cryptographic digest." });
    }
  } else {
    addBlocker(blockers, { code: "PLAN_DIGEST_UNVERIFIABLE", message: "The plan digest cannot be reconstructed from complete durable authority and target evidence." });
  }

  const disposition = deriveAgentPlanReviewDisposition(plan.status, blockers);
  return {
    evaluatedAt: now,
    ...disposition,
    blockers: Object.freeze(blockers),
    currentBasis,
    material,
    commitFence: disposition.eligible && authorityFence && targetFence
      ? { ...authorityFence, target: targetFence }
      : null,
  };
}

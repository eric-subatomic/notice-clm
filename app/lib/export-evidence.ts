import {
  agreementEvents,
  agentActionExecutions,
  agentActionPlans,
  agentGrants,
  agentPlanDecisions,
  agentRuns,
  ingestionBatches,
  integrationDiagnostics,
  purgeJobs,
  servicePrincipals,
} from "../../db/schema";

type PurgeJob = typeof purgeJobs.$inferSelect;
type IntegrationDiagnostic = typeof integrationDiagnostics.$inferSelect;
type ServicePrincipal = typeof servicePrincipals.$inferSelect;
type AgentGrant = typeof agentGrants.$inferSelect;
type AgentRun = typeof agentRuns.$inferSelect;
type AgentActionPlan = typeof agentActionPlans.$inferSelect;
type AgentPlanDecision = typeof agentPlanDecisions.$inferSelect;
type AgentActionExecution = typeof agentActionExecutions.$inferSelect;
type IngestionBatch = typeof ingestionBatches.$inferSelect;
type AgreementEvent = typeof agreementEvents.$inferSelect;

export type SourceAgentPlanReference = Readonly<{
  agreementId: number;
  planId: string;
}>;

export type AgentEvidenceClosure = Readonly<{
  valid: boolean;
  checkedReferences: number;
  sourceAgentPlanReferences: number;
  violations: readonly string[];
}>;

/**
 * Purge manifests prove that primary-storage cleanup was scheduled/completed,
 * but raw object keys and provider errors can expose storage layout or copied
 * credentials. The offboarding ledger needs only the safe durable state.
 */
export function sanitizePurgeJob(record: PurgeJob) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    objectCount: record.objectKeys.length,
    status: record.status,
    guardChanges: record.guardChanges,
    attempts: record.attempts,
    lastAttemptAt: record.lastAttemptAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

/** Configuration fingerprints include secret-backed provider state and live
 * diagnostic detail can echo provider metadata. Export only the durable,
 * attributable acceptance result. */
export function sanitizeIntegrationDiagnostic(record: IntegrationDiagnostic) {
  return {
    workspaceId: record.workspaceId,
    integrationId: record.integrationId,
    status: record.status,
    testedAt: record.testedAt,
    testedByUserId: record.testedByUserId,
    updatedAt: record.updatedAt,
  };
}

/** Ingestion idempotency and request digests are live retry correlation
 * material. The signed export preserves the attributable batch lifecycle and
 * counts without exporting either digest. */
export function sanitizeIngestionBatch(record: IngestionBatch) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    createdByUserId: record.createdByUserId,
    status: record.status,
    itemCount: record.itemCount,
    acceptedCount: record.acceptedCount,
    rejectedCount: record.rejectedCount,
    blockerCode: record.blockerCode,
    blockerMessage: record.blockerMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

/** Agent plan provenance contains the hash of the caller's idempotency key.
 * That correlation secret is useful to live retry handling, not an export.
 * Preserve the request digest and all non-secret provenance. */
export function sanitizeAgentActionPlan(record: AgentActionPlan): AgentActionPlan {
  if (!record.provenance || typeof record.provenance !== "object" || Array.isArray(record.provenance)) return record;
  const idempotency = record.provenance.idempotency;
  if (!idempotency || typeof idempotency !== "object" || Array.isArray(idempotency)) return record;
  const requestSha256 = (idempotency as Record<string, unknown>).requestSha256;
  const safeIdempotency = typeof requestSha256 === "string" ? { requestSha256 } : {};
  return {
    ...record,
    provenance: {
      ...record.provenance,
      idempotency: safeIdempotency,
    },
  };
}

/** The execution key digest is deliberately omitted: it is a live retry
 * correlation value, while the request/plan digests and receipt ID are the
 * durable evidence identifiers. */
export function sanitizeAgentActionExecution(record: AgentActionExecution) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    planId: record.planId,
    principalId: record.principalId,
    grantId: record.grantId,
    actionId: record.actionId,
    planSha256: record.planSha256,
    requestSha256: record.requestSha256,
    status: record.status,
    result: record.result,
    agreementEventIds: record.agreementEventIds,
    provenance: record.provenance,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

type AgentEvidenceClosureInput = Readonly<{
  workspaceId: string;
  servicePrincipals: readonly ServicePrincipal[];
  grants: readonly AgentGrant[];
  runs: readonly AgentRun[];
  plans: readonly AgentActionPlan[];
  decisions: readonly AgentPlanDecision[];
  executions: readonly AgentActionExecution[];
  agreementEvents?: readonly AgreementEvent[];
  sourcePlanReferences?: readonly SourceAgentPlanReference[];
  /** Agreement exports intentionally include only source-attributed plans and
   * omit the workspace-wide principal/grant/run collections. */
  scopedAgreementId?: number;
}>;

/**
 * Validate that an evidence bundle is tenant-pure and closed over every
 * exported agent-governance relationship. A workspace bundle checks the full
 * principal -> grant -> run -> plan -> decision/execution graph. An agreement
 * bundle checks the exact plans attributed by its approvals/events and their
 * decision/execution children.
 */
export function verifyAgentEvidenceClosure(input: AgentEvidenceClosureInput): AgentEvidenceClosure {
  const violations: string[] = [];
  let checkedReferences = 0;
  const principalById = uniqueById(input.servicePrincipals, "service principal", violations);
  const grantById = uniqueById(input.grants, "agent grant", violations);
  const runById = uniqueById(input.runs, "agent run", violations);
  const planById = uniqueById(input.plans, "agent plan", violations);
  uniqueById(input.decisions, "agent decision", violations);
  uniqueById(input.executions, "agent execution", violations);

  const workspaceRows: readonly Readonly<{ id?: string; workspaceId: string }>[] = [
    ...input.servicePrincipals,
    ...input.grants,
    ...input.runs,
    ...input.plans,
    ...input.decisions,
    ...input.executions,
    ...(input.agreementEvents ?? []),
  ];
  for (const row of workspaceRows) {
    checkedReferences += 1;
    if (row.workspaceId !== input.workspaceId) violations.push("Evidence row belongs to another workspace.");
  }

  if (input.scopedAgreementId === undefined) {
    for (const grant of input.grants) {
      checkedReferences += 1;
      const principal = principalById.get(grant.principalId);
      if (!principal) violations.push(`Agent grant ${grant.id} has no exported service principal.`);
    }
    for (const run of input.runs) {
      checkedReferences += 2;
      const principal = principalById.get(run.principalId);
      const grant = grantById.get(run.grantId);
      if (!principal) violations.push(`Agent run ${run.id} has no exported service principal.`);
      if (!grant || grant.principalId !== run.principalId) violations.push(`Agent run ${run.id} has no matching exported grant.`);
    }
    for (const plan of input.plans) {
      checkedReferences += plan.runId ? 3 : 2;
      const principal = principalById.get(plan.principalId);
      const grant = grantById.get(plan.grantId);
      const run = plan.runId ? runById.get(plan.runId) : null;
      if (!principal) violations.push(`Agent plan ${plan.id} has no exported service principal.`);
      if (!grant || grant.principalId !== plan.principalId) violations.push(`Agent plan ${plan.id} has no matching exported grant.`);
      if (plan.runId && (!run || run.principalId !== plan.principalId || run.grantId !== plan.grantId)) {
        violations.push(`Agent plan ${plan.id} has no matching exported run.`);
      }
    }
  }

  for (const decision of input.decisions) {
    checkedReferences += 1;
    const plan = planById.get(decision.planId);
    if (!plan || plan.planSha256 !== decision.planSha256) {
      violations.push(`Agent decision ${decision.id} has no digest-matching exported plan.`);
    }
  }
  const agreementEventById = input.agreementEvents
    ? uniqueById(input.agreementEvents, "agreement event", violations)
    : null;
  const claimedAgreementEventIds = new Set<string>();
  for (const execution of input.executions) {
    checkedReferences += 1 + execution.agreementEventIds.length;
    const plan = planById.get(execution.planId);
    if (
      !plan
      || plan.planSha256 !== execution.planSha256
      || plan.principalId !== execution.principalId
      || plan.grantId !== execution.grantId
      || plan.actionId !== execution.actionId
    ) {
      violations.push(`Agent execution ${execution.id} has no authority- and digest-matching exported plan.`);
    }
    const receiptEventIds = new Set<string>();
    if (agreementEventById) {
      for (const eventId of execution.agreementEventIds) {
        if (receiptEventIds.has(eventId)) {
          violations.push(`Agent execution ${execution.id} repeats an agreement event reference.`);
          continue;
        }
        receiptEventIds.add(eventId);
        if (claimedAgreementEventIds.has(eventId)) {
          violations.push(`Agreement event ${eventId} is referenced by more than one agent execution.`);
        }
        claimedAgreementEventIds.add(eventId);
        const event = agreementEventById.get(eventId);
        if (!event) {
          violations.push(`Agent execution ${execution.id} references an unavailable agreement event.`);
        } else if (!plan || event.agreementId !== plan.agreementId || event.sourceAgentPlanId !== execution.planId) {
          violations.push(`Agent execution ${execution.id} references an agreement event that is not bound to its plan and agreement.`);
        }
      }
    }
  }
  if (agreementEventById) {
    for (const event of agreementEventById.values()) {
      if (!event.sourceAgentPlanId || !planById.has(event.sourceAgentPlanId)) continue;
      checkedReferences += 1;
      if (!claimedAgreementEventIds.has(event.id)) {
        violations.push(`Source-attributed agreement event ${event.id} is not claimed by its agent execution receipt.`);
      }
    }
  }

  const sourceReferences = input.sourcePlanReferences ?? [];
  const decisionPlanIds = new Set(input.decisions.map((decision) => decision.planId));
  const executionPlanIds = new Set(input.executions.map((execution) => execution.planId));
  for (const reference of sourceReferences) {
    checkedReferences += 1;
    const plan = planById.get(reference.planId);
    if (!plan || plan.agreementId !== reference.agreementId) {
      violations.push(`Agreement ${reference.agreementId} references an unavailable or mismatched agent plan.`);
    }
    if (input.scopedAgreementId !== undefined && reference.agreementId !== input.scopedAgreementId) {
      violations.push("Agreement export contains an out-of-scope source plan reference.");
    }
  }
  for (const planId of new Set(sourceReferences.map((reference) => reference.planId))) {
    checkedReferences += 2;
    if (!decisionPlanIds.has(planId)) {
      violations.push(`Source-attributed agent plan ${planId} has no exported human decision.`);
    }
    if (!executionPlanIds.has(planId)) {
      violations.push(`Source-attributed agent plan ${planId} has no exported execution receipt.`);
    }
  }
  if (input.scopedAgreementId !== undefined) {
    const referencedIds = new Set(sourceReferences.map((reference) => reference.planId));
    for (const plan of input.plans) {
      checkedReferences += 1;
      if (plan.agreementId !== input.scopedAgreementId || !referencedIds.has(plan.id)) {
        violations.push(`Agent plan ${plan.id} is outside the agreement export scope.`);
      }
    }
    if (referencedIds.size !== planById.size) {
      violations.push("Agreement export is not closed over its distinct source agent plans.");
    }
  }

  return Object.freeze({
    valid: violations.length === 0,
    checkedReferences,
    sourceAgentPlanReferences: sourceReferences.length,
    violations: Object.freeze(violations),
  });
}

function uniqueById<T extends Readonly<{ id: string }>>(
  rows: readonly T[],
  label: string,
  violations: string[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (result.has(row.id)) violations.push(`Duplicate ${label} ${row.id}.`);
    result.set(row.id, row);
  }
  return result;
}

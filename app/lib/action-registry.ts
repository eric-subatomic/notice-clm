export const actionIds = [
  "agreement.read",
  "agreement.update",
  "risk.assess",
  "risk.waive",
  "approval.request",
  "approval.decide",
  "document.promote",
  "agreement.advance",
  "signature.create",
  "obligation.schedule.create",
  "obligation.schedule.reassign",
  "obligation.schedule.status",
  "obligation.complete",
  "workspace.membership.update",
  "integration.configure",
] as const;

export type ActionId = (typeof actionIds)[number];

/**
 * The registry is intentionally broader than the public machine surface. These
 * are the only actions that version 1 will accept for agent grants, planning,
 * and execution. Human application routes continue to use the full registry.
 */
export const agentApiV1ActionIds = Object.freeze([
  "agreement.read",
  "approval.request",
] as const satisfies readonly ActionId[]);

export type AgentApiV1ActionId = (typeof agentApiV1ActionIds)[number];

export const AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE = "AGENT_API_V1_ACTION_UNSUPPORTED" as const;
export const AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE = "agent_api_v1_action_unsupported" as const;

export type AgentApiV1ActionCapability = Readonly<{
  plannable: boolean;
  executable: boolean;
  inputMode: "ensure_required" | null;
  blocker: Readonly<{ code: typeof AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE; message: string }> | null;
}>;

export function isAgentApiV1ActionId(actionId: ActionId): actionId is AgentApiV1ActionId {
  return (agentApiV1ActionIds as readonly ActionId[]).includes(actionId);
}

/** Machine capability metadata shared by discovery and every mutating boundary. */
export function getAgentApiV1ActionCapability(actionId: ActionId): AgentApiV1ActionCapability {
  if (isAgentApiV1ActionId(actionId)) {
    return Object.freeze({
      plannable: true,
      executable: true,
      inputMode: actionId === "approval.request" ? "ensure_required" : null,
      blocker: null,
    });
  }
  return Object.freeze({
    plannable: false,
    executable: false,
    inputMode: null,
    blocker: Object.freeze({
      code: AGENT_API_V1_UNSUPPORTED_ACTION_BLOCKER_CODE,
      message: `${actionId} is registered for human/domain use but is not supported by the v1 agent planning or execution contract.`,
    }),
  });
}

export type ActionActorKind = "human" | "agent";
export type ActionRiskTier = "low" | "medium" | "high" | "critical";
export type ActionExecutionPolicy = "direct" | "plan_required" | "human_only";
export type ActionConfirmationPolicy =
  | "none"
  | "actor_confirmation"
  | "human_confirmation"
  | "exact_basis_confirmation";

export const targetPreconditions = [
  "working_document_present",
  "risk_cleared",
  "no_open_changes",
  "approvals_satisfied",
  "assigned_approval",
  "separation_of_duties",
  "candidate_document_clean",
  "human_review_complete",
  "signature_not_in_flight",
] as const;

export type ActionTargetPrecondition = (typeof targetPreconditions)[number];

export type ActionDefinition = Readonly<{
  id: ActionId;
  /** Bumped whenever the server-side contract or effect compiler changes. */
  implementationVersion: string;
  label: string;
  targetTypes: readonly ("agreement" | "approval" | "document" | "obligation" | "workspace" | "integration")[];
  permissions: readonly string[];
  riskTier: ActionRiskTier;
  executionPolicy: ActionExecutionPolicy;
  confirmationPolicy: ActionConfirmationPolicy;
  requiresTargetVersion: boolean;
  requiresBasis: boolean;
  allowedStages?: readonly string[];
  preconditions: readonly ActionTargetPrecondition[];
}>;

const definitions: readonly ActionDefinition[] = [
  {
    id: "agreement.read",
    implementationVersion: "agreement.read.v1",
    label: "Read agreement",
    targetTypes: ["agreement"],
    permissions: ["agreement:read"],
    riskTier: "low",
    executionPolicy: "direct",
    confirmationPolicy: "none",
    requiresTargetVersion: false,
    requiresBasis: false,
    preconditions: [],
  },
  {
    id: "agreement.update",
    implementationVersion: "agreement.update.v1",
    label: "Update agreement details",
    targetTypes: ["agreement"],
    permissions: ["agreement:read", "agreement:update"],
    riskTier: "medium",
    executionPolicy: "direct",
    confirmationPolicy: "actor_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    preconditions: [],
  },
  {
    id: "risk.assess",
    implementationVersion: "risk.assess.v1",
    label: "Assess agreement risk",
    targetTypes: ["agreement"],
    permissions: ["agreement:read", "risk:assess"],
    riskTier: "high",
    executionPolicy: "direct",
    confirmationPolicy: "actor_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    preconditions: ["working_document_present"],
  },
  {
    id: "risk.waive",
    implementationVersion: "risk.waive.v1",
    label: "Waive risk assessment",
    targetTypes: ["agreement"],
    permissions: ["agreement:read", "risk:waive"],
    riskTier: "critical",
    executionPolicy: "human_only",
    confirmationPolicy: "exact_basis_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    preconditions: ["working_document_present"],
  },
  {
    id: "approval.request",
    implementationVersion: "approval.ensure-required.v1",
    label: "Request approval",
    targetTypes: ["agreement"],
    permissions: ["agreement:read", "approval:request"],
    riskTier: "high",
    executionPolicy: "plan_required",
    confirmationPolicy: "exact_basis_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    preconditions: ["working_document_present", "risk_cleared", "no_open_changes"],
  },
  {
    id: "approval.decide",
    implementationVersion: "approval.decide.v1",
    label: "Decide approval",
    targetTypes: ["approval"],
    permissions: ["approval:decide"],
    riskTier: "critical",
    executionPolicy: "human_only",
    confirmationPolicy: "exact_basis_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    preconditions: ["assigned_approval", "separation_of_duties"],
  },
  {
    id: "document.promote",
    implementationVersion: "document.promote.v1",
    label: "Promote document to working paper",
    targetTypes: ["document"],
    permissions: ["document:manage"],
    riskTier: "critical",
    executionPolicy: "human_only",
    confirmationPolicy: "exact_basis_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    preconditions: ["candidate_document_clean", "human_review_complete"],
  },
  {
    id: "agreement.advance",
    implementationVersion: "agreement.advance.v1",
    label: "Advance agreement lifecycle",
    targetTypes: ["agreement"],
    permissions: ["agreement:read", "agreement:update"],
    riskTier: "high",
    executionPolicy: "plan_required",
    confirmationPolicy: "exact_basis_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    preconditions: ["working_document_present", "risk_cleared", "no_open_changes", "approvals_satisfied"],
  },
  {
    id: "signature.create",
    implementationVersion: "signature.create.v1",
    label: "Create signature packet",
    targetTypes: ["agreement"],
    permissions: ["agreement:read", "agreement:update", "document:read"],
    riskTier: "critical",
    executionPolicy: "plan_required",
    confirmationPolicy: "exact_basis_confirmation",
    requiresTargetVersion: true,
    requiresBasis: true,
    allowedStages: ["Signature"],
    preconditions: ["working_document_present", "risk_cleared", "no_open_changes", "approvals_satisfied", "signature_not_in_flight"],
  },
  {
    id: "obligation.schedule.create",
    implementationVersion: "obligation.schedule.create.v1",
    label: "Create obligation schedule",
    targetTypes: ["agreement"],
    permissions: ["agreement:read", "obligation:write"],
    riskTier: "high",
    executionPolicy: "human_only",
    confirmationPolicy: "human_confirmation",
    requiresTargetVersion: true,
    requiresBasis: false,
    allowedStages: ["Active"],
    preconditions: [],
  },
  {
    id: "obligation.schedule.reassign",
    implementationVersion: "obligation.schedule.reassign.v1",
    label: "Reassign obligation schedule",
    targetTypes: ["obligation"],
    permissions: ["obligation:write"],
    riskTier: "high",
    executionPolicy: "human_only",
    confirmationPolicy: "human_confirmation",
    requiresTargetVersion: true,
    requiresBasis: false,
    preconditions: [],
  },
  {
    id: "obligation.schedule.status",
    implementationVersion: "obligation.schedule.status.v1",
    label: "Change obligation schedule status",
    targetTypes: ["obligation"],
    permissions: ["obligation:write"],
    riskTier: "high",
    executionPolicy: "human_only",
    confirmationPolicy: "human_confirmation",
    requiresTargetVersion: true,
    requiresBasis: false,
    preconditions: [],
  },
  {
    id: "obligation.complete",
    implementationVersion: "obligation.complete.v2",
    label: "Complete obligation",
    targetTypes: ["obligation"],
    permissions: ["obligation:fulfill"],
    riskTier: "high",
    executionPolicy: "human_only",
    confirmationPolicy: "human_confirmation",
    requiresTargetVersion: true,
    requiresBasis: false,
    preconditions: [],
  },
  {
    id: "workspace.membership.update",
    implementationVersion: "workspace.membership.update.v1",
    label: "Update workspace membership",
    targetTypes: ["workspace"],
    permissions: ["workspace:admin"],
    riskTier: "critical",
    executionPolicy: "human_only",
    confirmationPolicy: "human_confirmation",
    requiresTargetVersion: true,
    requiresBasis: false,
    preconditions: [],
  },
  {
    id: "integration.configure",
    implementationVersion: "integration.configure.v1",
    label: "Configure integration",
    targetTypes: ["integration"],
    permissions: ["integration:manage"],
    riskTier: "critical",
    executionPolicy: "human_only",
    confirmationPolicy: "human_confirmation",
    requiresTargetVersion: true,
    requiresBasis: false,
    preconditions: [],
  },
];

/** Shared, stable catalog consumed by both human UI and agent adapters. */
export const actionRegistry: readonly ActionDefinition[] = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
  targetTypes: Object.freeze([...definition.targetTypes]),
  permissions: Object.freeze([...definition.permissions]),
  allowedStages: definition.allowedStages ? Object.freeze([...definition.allowedStages]) : undefined,
  preconditions: Object.freeze([...definition.preconditions]),
})));

export type ActionBlockerCode =
  | "ACTION_TARGET_TYPE_INVALID"
  | "ACTION_PERMISSION_REQUIRED"
  | "ACTION_HUMAN_REQUIRED"
  | "ACTION_APPROVED_PLAN_REQUIRED"
  | "ACTION_APPROVED_PLAN_INVALID"
  | "ACTION_CONFIRMATION_REQUIRED"
  | "ACTION_CONFIRMATION_ACTOR_MISMATCH"
  | "ACTION_TARGET_VERSION_UNAVAILABLE"
  | "ACTION_TARGET_VERSION_REQUIRED"
  | "ACTION_TARGET_VERSION_STALE"
  | "ACTION_BASIS_UNAVAILABLE"
  | "ACTION_BASIS_REQUIRED"
  | "ACTION_BASIS_STALE"
  | "ACTION_STAGE_INVALID"
  | "ACTION_PRECONDITION_FAILED";

export type ActionBlocker = Readonly<{
  code: ActionBlockerCode;
  message: string;
  permission?: string;
  precondition?: ActionTargetPrecondition;
}>;

export type ActionEvaluationContext = Readonly<{
  actor: Readonly<{
    kind: ActionActorKind;
    permissions: readonly string[] | ReadonlySet<string>;
  }>;
  target: Readonly<{
    type: string;
    id: string;
    version?: number;
    basisHash?: string;
    stage?: string;
    satisfiedPreconditions?: readonly ActionTargetPrecondition[] | ReadonlySet<ActionTargetPrecondition>;
  }>;
  attempt?: Readonly<{
    expectedVersion?: number;
    expectedBasisHash?: string;
    approvedPlanDigest?: string;
    confirmation?: Readonly<{
      by: ActionActorKind;
      basisHash?: string;
    }>;
  }>;
}>;

export type ActionEvaluation = Readonly<{
  action: ActionDefinition;
  allowed: boolean;
  blockers: readonly ActionBlocker[];
  requiredVersion: number | null;
  requiredBasisHash: string | null;
  requiresHuman: boolean;
}>;

function addBlocker(blockers: ActionBlocker[], blocker: ActionBlocker): void {
  const duplicate = blockers.some((existing) => existing.code === blocker.code
    && existing.permission === blocker.permission
    && existing.precondition === blocker.precondition);
  if (!duplicate) blockers.push(blocker);
}

export function getActionDefinition(actionId: ActionId): ActionDefinition {
  const definition = actionRegistry.find((candidate) => candidate.id === actionId);
  if (!definition) throw new Error(`Unknown action: ${actionId}`);
  return definition;
}

export function evaluateAction(
  definition: ActionDefinition,
  context: ActionEvaluationContext,
): ActionEvaluation {
  const blockers: ActionBlocker[] = [];
  const actorPermissions = new Set(context.actor.permissions);
  const satisfiedPreconditions = new Set(context.target.satisfiedPreconditions ?? []);
  const requiredVersion = definition.requiresTargetVersion && typeof context.target.version === "number"
    ? context.target.version
    : null;
  const requiredBasisHash = definition.requiresBasis && typeof context.target.basisHash === "string"
    ? context.target.basisHash
    : null;
  const requiresHuman = definition.executionPolicy !== "direct"
    || definition.confirmationPolicy === "human_confirmation"
    || definition.confirmationPolicy === "exact_basis_confirmation";

  if (!definition.targetTypes.includes(context.target.type as ActionDefinition["targetTypes"][number])) {
    addBlocker(blockers, { code: "ACTION_TARGET_TYPE_INVALID", message: "The action does not support this target type." });
  }
  for (const permission of definition.permissions) {
    if (!actorPermissions.has(permission)) {
      addBlocker(blockers, { code: "ACTION_PERMISSION_REQUIRED", permission, message: `Missing permission: ${permission}.` });
    }
  }
  if (definition.executionPolicy === "human_only" && context.actor.kind !== "human") {
    addBlocker(blockers, { code: "ACTION_HUMAN_REQUIRED", message: "This action can only be performed by a human principal." });
  }
  if (definition.executionPolicy === "plan_required" && !context.attempt?.approvedPlanDigest) {
    addBlocker(blockers, { code: "ACTION_APPROVED_PLAN_REQUIRED", message: "Execution requires an approved action plan." });
  } else if (
    definition.executionPolicy === "plan_required"
    && !/^[a-f0-9]{64}$/.test(context.attempt?.approvedPlanDigest ?? "")
  ) {
    addBlocker(blockers, { code: "ACTION_APPROVED_PLAN_INVALID", message: "The approved plan must be identified by its exact SHA-256 digest." });
  }

  if (definition.requiresTargetVersion) {
    if (requiredVersion === null) {
      addBlocker(blockers, { code: "ACTION_TARGET_VERSION_UNAVAILABLE", message: "The target has no authoritative version." });
    } else if (context.attempt?.expectedVersion === undefined) {
      addBlocker(blockers, { code: "ACTION_TARGET_VERSION_REQUIRED", message: "The current target version must be supplied." });
    } else if (context.attempt.expectedVersion !== requiredVersion) {
      addBlocker(blockers, { code: "ACTION_TARGET_VERSION_STALE", message: "The supplied target version is stale." });
    }
  }
  if (definition.requiresBasis) {
    if (requiredBasisHash === null || requiredBasisHash.length === 0) {
      addBlocker(blockers, { code: "ACTION_BASIS_UNAVAILABLE", message: "The target has no authoritative paper basis." });
    } else if (context.attempt?.expectedBasisHash === undefined) {
      addBlocker(blockers, { code: "ACTION_BASIS_REQUIRED", message: "The exact paper basis must be supplied." });
    } else if (context.attempt.expectedBasisHash !== requiredBasisHash) {
      addBlocker(blockers, { code: "ACTION_BASIS_STALE", message: "The supplied paper basis is stale." });
    }
  }
  if (definition.allowedStages && (!context.target.stage || !definition.allowedStages.includes(context.target.stage))) {
    addBlocker(blockers, { code: "ACTION_STAGE_INVALID", message: "The target is not in a stage allowed for this action." });
  }
  for (const precondition of definition.preconditions) {
    if (!satisfiedPreconditions.has(precondition)) {
      addBlocker(blockers, { code: "ACTION_PRECONDITION_FAILED", precondition, message: `Target precondition failed: ${precondition}.` });
    }
  }

  const confirmation = context.attempt?.confirmation;
  if (definition.confirmationPolicy !== "none" && confirmation === undefined) {
    addBlocker(blockers, { code: "ACTION_CONFIRMATION_REQUIRED", message: "The action requires explicit confirmation." });
  } else if (confirmation) {
    if (definition.confirmationPolicy === "actor_confirmation" && confirmation.by !== context.actor.kind) {
      addBlocker(blockers, { code: "ACTION_CONFIRMATION_ACTOR_MISMATCH", message: "Confirmation must come from the executing principal." });
    }
    if ((definition.confirmationPolicy === "human_confirmation" || definition.confirmationPolicy === "exact_basis_confirmation") && confirmation.by !== "human") {
      addBlocker(blockers, { code: "ACTION_HUMAN_REQUIRED", message: "A human confirmation is required." });
    }
    if (
      definition.confirmationPolicy === "exact_basis_confirmation"
      && requiredBasisHash !== null
      && confirmation.basisHash !== requiredBasisHash
    ) {
      addBlocker(blockers, { code: "ACTION_BASIS_STALE", message: "Human confirmation is not bound to the exact current paper basis." });
    }
  }

  return {
    action: definition,
    allowed: blockers.length === 0,
    blockers,
    requiredVersion,
    requiredBasisHash,
    requiresHuman,
  };
}

/** Return every registered action, including denied actions and their blockers. */
export function evaluateActionRegistry(context: ActionEvaluationContext): readonly ActionEvaluation[] {
  return actionRegistry.map((definition) => evaluateAction(definition, context));
}

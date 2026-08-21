export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function serializeCanonicalJson(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON does not support ${typeof value} values.`);
  }
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("Canonical JSON arrays cannot contain symbol keys.");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Canonical JSON arrays cannot be sparse.");
        }
      }
      const expectedNames = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (Object.getOwnPropertyNames(value).some((name) => !expectedNames.has(name))) {
        throw new TypeError("Canonical JSON arrays cannot contain extra properties.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const items = Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("Canonical JSON arrays cannot contain accessors.");
        }
        return serializeCanonicalJson(descriptor.value, ancestors);
      });
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain records.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON objects cannot contain symbol keys.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value).sort();
    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      throw new TypeError("Canonical JSON objects cannot contain non-enumerable properties.");
    }
    return `{${keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Canonical JSON objects cannot contain accessors.");
      }
      return `${JSON.stringify(key)}:${serializeCanonicalJson(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deterministic, sorted-key JSON for security decisions and durable digests.
 * Unsupported JSON-adjacent values fail rather than being silently omitted.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, new WeakSet());
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJsonDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function canonicalInstantMilliseconds(value: string): number | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

export type AgentGrantResource = Readonly<{
  type: string;
  /** An explicit resource ID, or `*` for every resource of this type. */
  id: string;
}>;

export type AgentGrant = Readonly<{
  id: string;
  workspaceId: string;
  serviceAccountId: string;
  delegatorPrincipalId: string;
  scopes: readonly string[];
  /** Maximum permissions delegated at grant creation. */
  permissions: readonly string[];
  resources: readonly AgentGrantResource[];
  notBefore: string;
  expiresAt: string;
  revokedAt: string | null;
}>;

export type AgentGrantBlockerCode =
  | "AGENT_GRANT_INVALID"
  | "AGENT_GRANT_PRINCIPAL_MISMATCH"
  | "AGENT_GRANT_DELEGATOR_MISMATCH"
  | "AGENT_GRANT_WORKSPACE_MISMATCH"
  | "AGENT_GRANT_NOT_ACTIVE"
  | "AGENT_GRANT_EXPIRED"
  | "AGENT_GRANT_REVOKED"
  | "AGENT_GRANT_SCOPE_DENIED"
  | "AGENT_GRANT_RESOURCE_DENIED"
  | "AGENT_GRANT_PERMISSION_DENIED"
  | "AGENT_GRANT_DELEGATOR_PERMISSION_DENIED";

export type AgentGrantBlocker = Readonly<{
  code: AgentGrantBlockerCode;
  message: string;
  permission?: string;
}>;

export type AgentGrantEvaluation = Readonly<{
  authorized: boolean;
  effectivePermissions: readonly string[];
  blockers: readonly AgentGrantBlocker[];
}>;

export function evaluateAgentGrant(input: Readonly<{
  grant: AgentGrant;
  serviceAccountId: string;
  delegatorPrincipalId: string;
  workspaceId: string;
  scope: string;
  resource: AgentGrantResource;
  requiredPermissions: readonly string[];
  delegatorPermissions: readonly string[] | ReadonlySet<string>;
  now: string;
}>): AgentGrantEvaluation {
  const blockers: AgentGrantBlocker[] = [];
  const grantPermissionSet = new Set(input.grant.permissions);
  const delegatorPermissionSet = new Set(input.delegatorPermissions);
  const effectivePermissions = [...grantPermissionSet]
    .filter((permission) => delegatorPermissionSet.has(permission))
    .sort();

  const notBefore = canonicalInstantMilliseconds(input.grant.notBefore);
  const expiresAt = canonicalInstantMilliseconds(input.grant.expiresAt);
  const now = canonicalInstantMilliseconds(input.now);
  const validGrantShape = isNonEmpty(input.grant.id)
    && isNonEmpty(input.grant.workspaceId)
    && isNonEmpty(input.grant.serviceAccountId)
    && isNonEmpty(input.grant.delegatorPrincipalId)
    && input.grant.scopes.every(isNonEmpty)
    && input.grant.permissions.every(isNonEmpty)
    && input.grant.resources.every((resource) => isNonEmpty(resource.type) && isNonEmpty(resource.id))
    && notBefore !== null
    && expiresAt !== null
    && now !== null
    && (input.grant.revokedAt === null || canonicalInstantMilliseconds(input.grant.revokedAt) !== null)
    && notBefore < expiresAt;
  if (!validGrantShape) {
    blockers.push({ code: "AGENT_GRANT_INVALID", message: "The agent grant is incomplete or has an invalid time window." });
  }
  if (input.grant.serviceAccountId !== input.serviceAccountId) {
    blockers.push({ code: "AGENT_GRANT_PRINCIPAL_MISMATCH", message: "The grant belongs to a different service account." });
  }
  if (input.grant.delegatorPrincipalId !== input.delegatorPrincipalId) {
    blockers.push({ code: "AGENT_GRANT_DELEGATOR_MISMATCH", message: "The supplied permissions belong to a different delegating principal." });
  }
  if (input.grant.workspaceId !== input.workspaceId) {
    blockers.push({ code: "AGENT_GRANT_WORKSPACE_MISMATCH", message: "The grant belongs to a different workspace." });
  }
  if (input.grant.revokedAt !== null) {
    blockers.push({ code: "AGENT_GRANT_REVOKED", message: "The agent grant has been revoked." });
  }
  if (now !== null && notBefore !== null && now < notBefore) {
    blockers.push({ code: "AGENT_GRANT_NOT_ACTIVE", message: "The agent grant is not active yet." });
  }
  if (now !== null && expiresAt !== null && now >= expiresAt) {
    blockers.push({ code: "AGENT_GRANT_EXPIRED", message: "The agent grant has expired." });
  }
  if (!input.grant.scopes.includes(input.scope)) {
    blockers.push({ code: "AGENT_GRANT_SCOPE_DENIED", message: "The requested action is outside the grant scope." });
  }
  const resourceAllowed = input.grant.resources.some((resource) => resource.type === input.resource.type
    && (resource.id === "*" || resource.id === input.resource.id));
  if (!resourceAllowed) {
    blockers.push({ code: "AGENT_GRANT_RESOURCE_DENIED", message: "The target is outside the grant resource boundary." });
  }
  for (const permission of input.requiredPermissions) {
    if (!grantPermissionSet.has(permission)) {
      blockers.push({ code: "AGENT_GRANT_PERMISSION_DENIED", permission, message: `The grant does not delegate ${permission}.` });
    }
    if (!delegatorPermissionSet.has(permission)) {
      blockers.push({ code: "AGENT_GRANT_DELEGATOR_PERMISSION_DENIED", permission, message: `The delegator no longer holds ${permission}.` });
    }
  }

  return {
    authorized: blockers.length === 0,
    effectivePermissions,
    blockers,
  };
}

export type AgentActionPlanMaterial = Readonly<{
  schemaVersion: "1.0";
  planId: string;
  workspaceId: string;
  serviceAccountId: string;
  grantId: string;
  delegatorPrincipalId: string;
  actionId: string;
  target: Readonly<{
    resourceType: string;
    resourceId: string;
    version: number;
    basisHash: string;
  }>;
  input: unknown;
  policyVersion: string;
  /** Exact registry definition and version shown to the reviewer. */
  actionDefinition: unknown;
  riskTier: string;
  beforeSnapshot: unknown;
  proposedDiff: unknown;
  blockers: unknown;
  provenance: unknown;
  createdAt: string;
  expiresAt: string;
}>;

/** The digest covers every executable and governance-relevant plan field. */
export function computeAgentActionPlanDigest(plan: AgentActionPlanMaterial): Promise<string> {
  return canonicalJsonDigest({ kind: "notice.agent-action-plan", ...plan });
}

export type AgentPlanDecision = Readonly<{
  planId: string;
  workspaceId: string;
  planDigest: string;
  decision: "approved" | "rejected";
  decidedByHumanPrincipalId: string;
  decidedAt: string;
  rationale: string;
}>;

export type PlanDecisionBlockerCode =
  | "PLAN_DECISION_INVALID"
  | "PLAN_DECISION_PLAN_MISMATCH"
  | "PLAN_DECISION_WORKSPACE_MISMATCH"
  | "PLAN_DECISION_DIGEST_MISMATCH"
  | "PLAN_DECISION_HUMAN_REQUIRED"
  | "PLAN_DECISION_REVIEWER_SEPARATION_REQUIRED";

export type PlanDecisionBinding = Readonly<{
  valid: boolean;
  expectedDigest: string;
  blockers: readonly Readonly<{ code: PlanDecisionBlockerCode; message: string }>[];
}>;

export async function evaluatePlanDecisionBinding(
  plan: AgentActionPlanMaterial,
  decision: AgentPlanDecision,
): Promise<PlanDecisionBinding> {
  const expectedDigest = await computeAgentActionPlanDigest(plan);
  const blockers: Array<Readonly<{ code: PlanDecisionBlockerCode; message: string }>> = [];
  if (decision.planId !== plan.planId) {
    blockers.push({ code: "PLAN_DECISION_PLAN_MISMATCH", message: "The decision references a different plan." });
  }
  if (decision.workspaceId !== plan.workspaceId) {
    blockers.push({ code: "PLAN_DECISION_WORKSPACE_MISMATCH", message: "The decision belongs to a different workspace." });
  }
  if (decision.planDigest !== expectedDigest) {
    blockers.push({ code: "PLAN_DECISION_DIGEST_MISMATCH", message: "The decision is not bound to the exact plan digest." });
  }
  if (!isNonEmpty(decision.decidedByHumanPrincipalId)) {
    blockers.push({ code: "PLAN_DECISION_HUMAN_REQUIRED", message: "A human principal must make the decision." });
  }
  if (decision.decidedByHumanPrincipalId === plan.delegatorPrincipalId) {
    blockers.push({
      code: "PLAN_DECISION_REVIEWER_SEPARATION_REQUIRED",
      message: "The grant sponsor cannot approve or reject the agent plan they sponsored.",
    });
  }
  const createdAt = canonicalInstantMilliseconds(plan.createdAt);
  const expiresAt = canonicalInstantMilliseconds(plan.expiresAt);
  const decidedAt = canonicalInstantMilliseconds(decision.decidedAt);
  const validDecisionWindow = createdAt !== null
    && expiresAt !== null
    && decidedAt !== null
    && createdAt < expiresAt
    && decidedAt >= createdAt
    && decidedAt < expiresAt;
  if (
    !isNonEmpty(decision.rationale)
    || (decision.decision !== "approved" && decision.decision !== "rejected")
    || !validDecisionWindow
  ) {
    blockers.push({ code: "PLAN_DECISION_INVALID", message: "The decision requires a supported outcome, rationale, and a canonical timestamp inside the plan window." });
  }
  return { valid: blockers.length === 0, expectedDigest, blockers };
}

export async function bindPlanDecision(
  plan: AgentActionPlanMaterial,
  decision: Omit<AgentPlanDecision, "planId" | "workspaceId" | "planDigest">,
): Promise<AgentPlanDecision> {
  return {
    ...decision,
    planId: plan.planId,
    workspaceId: plan.workspaceId,
    planDigest: await computeAgentActionPlanDigest(plan),
  };
}

export const agentPlanStatuses = [
  "draft",
  "pending_approval",
  "approved",
  "executing",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "superseded",
  "expired",
  "rejected",
  "cancelled",
] as const;

export type AgentPlanStatus = (typeof agentPlanStatuses)[number];

const planTransitions: Readonly<Record<AgentPlanStatus, ReadonlySet<AgentPlanStatus>>> = {
  draft: new Set(["pending_approval", "cancelled", "superseded"]),
  pending_approval: new Set(["approved", "rejected", "expired", "cancelled", "superseded"]),
  approved: new Set(["executing", "expired", "cancelled", "superseded"]),
  executing: new Set(["succeeded", "failed_retryable", "failed_terminal"]),
  failed_retryable: new Set(["executing", "expired", "cancelled", "superseded"]),
  succeeded: new Set(),
  failed_terminal: new Set(),
  superseded: new Set(),
  expired: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
};

export function canTransitionAgentPlan(from: AgentPlanStatus, to: AgentPlanStatus): boolean {
  return planTransitions[from].has(to);
}

export function evaluateAgentPlanTransition(
  from: AgentPlanStatus,
  to: AgentPlanStatus,
): Readonly<{
  allowed: boolean;
  code: "PLAN_TRANSITION_ALLOWED" | "PLAN_TRANSITION_INVALID";
}> {
  const allowed = canTransitionAgentPlan(from, to);
  return { allowed, code: allowed ? "PLAN_TRANSITION_ALLOWED" : "PLAN_TRANSITION_INVALID" };
}

export type AgentExecutionProvenance = Readonly<{
  schemaVersion: "1.0";
  workspaceId: string;
  serviceAccountId: string;
  delegatorPrincipalId: string;
  grantId: string;
  agentRunId: string;
  planId: string;
  planDigest: string;
  actionId: string;
  target: Readonly<{
    resourceType: string;
    resourceId: string;
    version: number;
    basisHash: string;
  }>;
  policyVersion: string;
  modelId: string;
  toolId: string;
  inputDigest: string;
  startedAt: string;
}>;

export type ProvenanceBlockerCode =
  | "PROVENANCE_FIELD_REQUIRED"
  | "PROVENANCE_DIGEST_INVALID"
  | "PROVENANCE_TIMESTAMP_INVALID"
  | "PROVENANCE_MISMATCH";

export type ProvenanceValidation = Readonly<{
  valid: boolean;
  blockers: readonly Readonly<{
    code: ProvenanceBlockerCode;
    field: string;
    message: string;
  }>[];
}>;

export function validateAgentExecutionProvenance(
  provenance: AgentExecutionProvenance,
  expected: Readonly<{
    workspaceId: string;
    serviceAccountId: string;
    delegatorPrincipalId: string;
    grantId: string;
    planId: string;
    planDigest: string;
    actionId: string;
    resourceType: string;
    resourceId: string;
    version: number;
    basisHash: string;
    policyVersion: string;
  }>,
): ProvenanceValidation {
  const blockers: Array<Readonly<{ code: ProvenanceBlockerCode; field: string; message: string }>> = [];
  const requiredFields: Readonly<Record<string, string>> = {
    workspaceId: provenance.workspaceId,
    serviceAccountId: provenance.serviceAccountId,
    delegatorPrincipalId: provenance.delegatorPrincipalId,
    grantId: provenance.grantId,
    agentRunId: provenance.agentRunId,
    planId: provenance.planId,
    actionId: provenance.actionId,
    policyVersion: provenance.policyVersion,
    modelId: provenance.modelId,
    toolId: provenance.toolId,
    resourceType: provenance.target.resourceType,
    resourceId: provenance.target.resourceId,
  };
  for (const [field, value] of Object.entries(requiredFields)) {
    if (!isNonEmpty(value)) blockers.push({ code: "PROVENANCE_FIELD_REQUIRED", field, message: `${field} is required.` });
  }
  for (const [field, digest] of [
    ["planDigest", provenance.planDigest],
    ["basisHash", provenance.target.basisHash],
    ["inputDigest", provenance.inputDigest],
  ] as const) {
    if (!SHA256_PATTERN.test(digest)) blockers.push({ code: "PROVENANCE_DIGEST_INVALID", field, message: `${field} must be a lowercase SHA-256 digest.` });
  }
  if (canonicalInstantMilliseconds(provenance.startedAt) === null) {
    blockers.push({ code: "PROVENANCE_TIMESTAMP_INVALID", field: "startedAt", message: "startedAt must be a canonical UTC instant." });
  }
  if (!Number.isSafeInteger(provenance.target.version) || provenance.target.version < 1) {
    blockers.push({ code: "PROVENANCE_FIELD_REQUIRED", field: "version", message: "A positive target version is required." });
  }

  const comparisons: readonly (readonly [string, unknown, unknown])[] = [
    ["workspaceId", provenance.workspaceId, expected.workspaceId],
    ["serviceAccountId", provenance.serviceAccountId, expected.serviceAccountId],
    ["delegatorPrincipalId", provenance.delegatorPrincipalId, expected.delegatorPrincipalId],
    ["grantId", provenance.grantId, expected.grantId],
    ["planId", provenance.planId, expected.planId],
    ["planDigest", provenance.planDigest, expected.planDigest],
    ["actionId", provenance.actionId, expected.actionId],
    ["resourceType", provenance.target.resourceType, expected.resourceType],
    ["resourceId", provenance.target.resourceId, expected.resourceId],
    ["version", provenance.target.version, expected.version],
    ["basisHash", provenance.target.basisHash, expected.basisHash],
    ["policyVersion", provenance.policyVersion, expected.policyVersion],
  ];
  for (const [field, actual, wanted] of comparisons) {
    if (actual !== wanted) blockers.push({ code: "PROVENANCE_MISMATCH", field, message: `${field} does not match the authorized execution context.` });
  }
  return { valid: blockers.length === 0, blockers };
}

export type IdempotencyScope = Readonly<{
  workspaceId: string;
  principalId: string;
  actionId: string;
  resourceType: string;
  resourceId: string;
}>;

export type IdempotencyAttempt = Readonly<{
  key: string;
  scopeDigest: string;
  requestDigest: string;
}>;

export type IdempotencyReceipt = IdempotencyAttempt & Readonly<{
  resultDigest: string;
}>;

export function computeIdempotencyScopeDigest(scope: IdempotencyScope): Promise<string> {
  return canonicalJsonDigest({ kind: "notice.idempotency-scope", ...scope });
}

export function computeIdempotencyRequestDigest(scope: IdempotencyScope, payload: unknown): Promise<string> {
  return canonicalJsonDigest({ kind: "notice.idempotent-request", scope, payload });
}

export type IdempotencyClassification =
  | Readonly<{ kind: "new"; code: "IDEMPOTENCY_NEW" }>
  | Readonly<{ kind: "replay"; code: "IDEMPOTENCY_REPLAY"; receipt: IdempotencyReceipt }>
  | Readonly<{ kind: "collision"; code: "IDEMPOTENCY_KEY_COLLISION" }>;

/**
 * An identical key is replayable only when both its authorization scope and
 * canonical request material match. Every other reuse is a hard collision.
 */
export function classifyIdempotency(
  existing: IdempotencyReceipt | null,
  attempt: IdempotencyAttempt,
): IdempotencyClassification {
  if (existing === null) return { kind: "new", code: "IDEMPOTENCY_NEW" };
  if (
    existing.key === attempt.key
    && existing.scopeDigest === attempt.scopeDigest
    && existing.requestDigest === attempt.requestDigest
  ) {
    return { kind: "replay", code: "IDEMPOTENCY_REPLAY", receipt: existing };
  }
  return { kind: "collision", code: "IDEMPOTENCY_KEY_COLLISION" };
}

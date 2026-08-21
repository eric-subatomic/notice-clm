import { and, desc, eq, gt, lte } from "drizzle-orm";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type RemoteJWKSet,
} from "jose";
import { z } from "zod";
import {
  agentGrants,
  servicePrincipals,
  users,
  workspaceMemberships,
  workspaceRoles,
  workspaces,
  type WorkspaceRole,
} from "../../db/schema";
import {
  actionIds,
  actionRegistry,
  evaluateAction,
  getAgentApiV1ActionCapability,
  getActionDefinition,
  isAgentApiV1ActionId,
  type ActionBlocker,
  type ActionDefinition,
  type ActionId,
  type ActionTargetPrecondition,
} from "./action-registry";
import { evaluateAgentGrant } from "./agent-governance";
import { permissionsForRole, type Permission } from "./authorization";
import { CLOUDFLARE_ACCESS_JWT_HEADER, createCloudflareAccessKeyResolver } from "./cloudflare-access";
import { isLoopbackRequestUrl } from "./deployment-values";
import {
  apiError,
  checkBestEffortRateLimit,
  createRequestId,
  rateLimitExceeded,
  rateLimitHeaders,
  safeInternalError,
} from "./http";
import type { CloudflareAccessConfig } from "./notice-config";

export const EVALUATION_SERVICE_PRINCIPAL_HEADER = "x-notice-evaluation-service-principal-id";
export const AGENT_API_SCHEMA_VERSION = "1.0";
export const ACTION_CATALOG_VERSION = "2026-08-20.1";

const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const CLOCK_TOLERANCE_SECONDS = 5;
const MAX_RESOURCES = 200;
const SERVICE_PRINCIPAL_RATE_LIMIT_WINDOW_MS = 60_000;
const serviceRemoteKeySets = new Map<string, RemoteJWKSet>();
const V1_AGREEMENT_AVAILABLE_ACTIONS_PATH = /^\/api\/v1\/agreements\/[^/]+\/available-actions\/?$/;
const V1_PLAN_DETAIL_PATH = /^\/api\/v1\/plans\/[0-9a-f-]{36}\/?$/i;
const V1_PLAN_EXECUTE_PATH = /^\/api\/v1\/plans\/[0-9a-f-]{36}\/execute\/?$/i;
const INVALID_V1_RATE_LIMIT_PATH = "<invalid-v1-rate-limit-path>";

const boundedIdentifierSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, "A bounded identifier without whitespace or control characters is required.");

const resourceIdSchema = z.union([
  z.literal("*"),
  z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
]);

const resourceTypeSchema = z.enum([
  "agreement",
  "approval",
  "document",
  "obligation",
  "workspace",
  "integration",
]);

export const agentResourceConstraintsSchema = z.object({
  resources: z.array(z.object({
    type: resourceTypeSchema,
    ids: z.array(resourceIdSchema).min(1).max(100),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, context) => {
  let total = 0;
  const seenTypes = new Set<string>();
  for (const resource of value.resources) {
    total += resource.ids.length;
    if (seenTypes.has(resource.type)) {
      context.addIssue({ code: "custom", message: `Resource type ${resource.type} may appear only once.` });
    }
    seenTypes.add(resource.type);
    if (resource.ids.includes("*") && resource.ids.length !== 1) {
      context.addIssue({ code: "custom", message: `Wildcard access for ${resource.type} must be the only ID in that allowlist.` });
    }
    if (new Set(resource.ids).size !== resource.ids.length) {
      context.addIssue({ code: "custom", message: `Resource IDs for ${resource.type} must be unique.` });
    }
  }
  if (total > MAX_RESOURCES) {
    context.addIssue({ code: "custom", message: `A grant may contain at most ${MAX_RESOURCES} resource IDs.` });
  }
});

export type AgentResourceConstraints = z.infer<typeof agentResourceConstraintsSchema>;

type PreparedAgentResourceConstraints = Readonly<{
  normalized: AgentResourceConstraints;
  resources: readonly Readonly<{ type: string; id: string }>[];
}>;

export function normalizeAgentResourceConstraints(value: AgentResourceConstraints): AgentResourceConstraints {
  return {
    resources: [...value.resources]
      .map((resource) => ({ type: resource.type, ids: [...resource.ids].sort() }))
      .sort((left, right) => left.type.localeCompare(right.type)),
  };
}

function prepareAgentResourceConstraints(value: unknown): PreparedAgentResourceConstraints | null {
  const parsed = agentResourceConstraintsSchema.safeParse(value);
  if (!parsed.success) return null;
  const normalized = normalizeAgentResourceConstraints(parsed.data);
  return Object.freeze({
    normalized,
    resources: Object.freeze(normalized.resources.flatMap((resource) =>
      resource.ids.map((id) => Object.freeze({ type: resource.type, id })))),
  });
}

export function flattenAgentResourceConstraints(
  value: unknown,
): readonly Readonly<{ type: string; id: string }>[] {
  return prepareAgentResourceConstraints(value)?.resources ?? [];
}

function representativeResourceForAction(
  definition: ActionDefinition,
  resources: readonly Readonly<{ type: string; id: string }>[],
): Readonly<{ type: string; id: string }> | null {
  return resources.find((resource) => definition.targetTypes.some((targetType) => targetType === resource.type)) ?? null;
}

/**
 * Match the route spelling that vinext exposes to handlers without decoding
 * reserved path delimiters such as `%2F`. Remaining escapes are uppercased and
 * empty literal path segments are collapsed because vinext discards them while
 * matching. Malformed escapes share one fail-closed bucket instead of retaining
 * attacker input.
 */
function canonicalizeV1RateLimitPathname(pathname: string): string {
  try {
    const decodedPathname = decodeURI(pathname)
      .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
    const collapsedPathname = decodedPathname.replace(/\/+/g, "/");
    if (collapsedPathname === "/" || collapsedPathname === "/api/v1/") return collapsedPathname;
    return collapsedPathname.replace(/\/+$/, "");
  } catch {
    return INVALID_V1_RATE_LIMIT_PATH;
  }
}

/** Collapse equivalent encodings and dynamic V1 IDs into route-template buckets. */
export function normalizeV1ReadRateLimitPath(pathname: string): string {
  const canonicalPathname = canonicalizeV1RateLimitPathname(pathname);
  if (V1_AGREEMENT_AVAILABLE_ACTIONS_PATH.test(canonicalPathname)) {
    return "/api/v1/agreements/:id/available-actions";
  }
  if (V1_PLAN_EXECUTE_PATH.test(canonicalPathname)) return "/api/v1/plans/:id/execute";
  if (V1_PLAN_DETAIL_PATH.test(canonicalPathname)) return "/api/v1/plans/:id";
  return canonicalPathname;
}

export type ServicePrincipalRateLimitDescriptor = Readonly<{
  key: string;
  limit: number;
  windowMs: number;
}>;

function servicePrincipalRateLimitRequest(request: Pick<Request, "method" | "url">) {
  const requestMethod = request.method.toUpperCase();
  const method = requestMethod === "HEAD" ? "GET" : requestMethod;
  return {
    method,
    normalizedPath: normalizeV1ReadRateLimitPath(new URL(request.url).pathname),
    limit: method === "GET" ? 240 : 60,
  };
}

export function servicePrincipalActorRateLimit(
  workspaceId: string,
  principalId: string,
  request: Pick<Request, "method" | "url">,
): ServicePrincipalRateLimitDescriptor {
  const route = servicePrincipalRateLimitRequest(request);
  return {
    key: `service-principal:actor:${workspaceId}:${principalId}:${route.method}:${route.normalizedPath}`,
    limit: route.limit,
    windowMs: SERVICE_PRINCIPAL_RATE_LIMIT_WINDOW_MS,
  };
}

export function servicePrincipalActionRateLimits(
  workspaceId: string,
  principalId: string,
  request: Pick<Request, "method" | "url">,
  actionId: ActionId,
  resource: Readonly<{ type: string; id: string }>,
): Readonly<{
  aggregate: ServicePrincipalRateLimitDescriptor;
  resource: ServicePrincipalRateLimitDescriptor;
}> {
  const route = servicePrincipalRateLimitRequest(request);
  const descriptor = { limit: route.limit, windowMs: SERVICE_PRINCIPAL_RATE_LIMIT_WINDOW_MS };
  return {
    aggregate: {
      key: `service-principal:action-aggregate:${workspaceId}:${principalId}:${route.method}:${route.normalizedPath}`,
      ...descriptor,
    },
    resource: {
      key: `service-principal:action-resource:${workspaceId}:${principalId}:${actionId}:${resource.type}:${resource.id}:${route.method}:${route.normalizedPath}`,
      ...descriptor,
    },
  };
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (workspaceRoles as readonly string[]).includes(value);
}

function serviceKeyResolver(config: CloudflareAccessConfig): RemoteJWKSet {
  const cacheKey = config.jwksUrl ?? config.teamDomain;
  let resolver = serviceRemoteKeySets.get(cacheKey);
  if (!resolver) {
    resolver = config.jwksUrl
      ? createRemoteJWKSet(new URL(config.jwksUrl), {
        timeoutDuration: 3_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      })
      : createCloudflareAccessKeyResolver(config.teamDomain);
    serviceRemoteKeySets.set(cacheKey, resolver);
  }
  return resolver;
}

export type VerifiedCloudflareServiceIdentity = Readonly<{
  issuer: string;
  /** Cloudflare's signed service-token client ID (`common_name`). */
  commonName: string;
}>;

export type ServiceTokenVerificationErrorCode =
  | "TOKEN_MISSING"
  | "TOKEN_INVALID"
  | "TOKEN_NOT_SERVICE";

export class ServiceTokenVerificationError extends Error {
  constructor(readonly code: ServiceTokenVerificationErrorCode) {
    super(code === "TOKEN_MISSING"
      ? "A Cloudflare Access assertion is required."
      : code === "TOKEN_NOT_SERVICE"
        ? "The verified Access assertion is not a service-token identity."
        : "The Cloudflare Access service-token assertion is invalid.");
    this.name = "ServiceTokenVerificationError";
  }
}

export type ServiceTokenVerificationOptions = Readonly<{
  /** Test seam for a local or synthetic JWKS. Production callers omit this. */
  keyResolver?: JWTVerifyGetKey;
  currentDate?: Date;
}>;

/**
 * Verify a Cloudflare Access service-token JWT independently from human auth.
 * The raw client ID/secret headers are deliberately ignored: only the signed
 * `common_name` claim identifies the registered workload. Cloudflare service
 * tokens legitimately carry an explicitly empty `sub`; requiring that shape
 * keeps human and service assertion classes separate.
 */
export async function verifyCloudflareAccessServiceIdentity(
  request: Request,
  config: CloudflareAccessConfig,
  options: ServiceTokenVerificationOptions = {},
): Promise<VerifiedCloudflareServiceIdentity> {
  const token = request.headers.get(CLOUDFLARE_ACCESS_JWT_HEADER);
  if (!token) throw new ServiceTokenVerificationError("TOKEN_MISSING");
  if (token.length > MAX_ACCESS_TOKEN_LENGTH) throw new ServiceTokenVerificationError("TOKEN_INVALID");

  try {
    const { payload } = await jwtVerify(
      token,
      options.keyResolver ?? serviceKeyResolver(config),
      {
        algorithms: ["RS256"],
        issuer: config.teamDomain,
        audience: config.audience,
        typ: "JWT",
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: options.currentDate,
        requiredClaims: ["exp", "nbf", "type"],
      },
    );
    if (payload.type !== "app") throw new ServiceTokenVerificationError("TOKEN_INVALID");
    if (!Object.hasOwn(payload, "common_name")) {
      throw new ServiceTokenVerificationError("TOKEN_NOT_SERVICE");
    }
    const commonName = boundedIdentifierSchema.safeParse(payload.common_name);
    if (!commonName.success) throw new ServiceTokenVerificationError("TOKEN_INVALID");
    // Cloudflare service-token application assertions have an explicitly
    // empty subject. Requiring it prevents a human application assertion that
    // happens to carry an unrelated common_name claim from crossing auth
    // classes; TOKEN_NOT_SERVICE lets the normal human verifier handle it.
    if (payload.sub !== "") throw new ServiceTokenVerificationError("TOKEN_NOT_SERVICE");
    return Object.freeze({ issuer: config.teamDomain, commonName: commonName.data });
  } catch (error) {
    if (error instanceof ServiceTokenVerificationError) throw error;
    throw new ServiceTokenVerificationError("TOKEN_INVALID");
  }
}

export type PersistedServicePrincipal = Readonly<{
  id: string;
  workspaceId: string;
  issuer: string;
  subject: string;
  status: string;
}>;

export type PersistedAgentGrant = Readonly<{
  id: string;
  workspaceId: string;
  principalId: string;
  delegatorUserId: string;
  status: string;
  actionIds: readonly string[];
  resourceConstraints: unknown;
  policyVersion: string;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
}>;

export type PersistedGrantSponsor = Readonly<{
  id: string;
  status: string;
}>;

export type PersistedSponsorMembership = Readonly<{
  workspaceId: string;
  userId: string;
  role: string;
  status: string;
}> | null;

export type AgentAuthorityBlocker = Readonly<{
  code: string;
  message: string;
  permission?: string;
}>;

export type PersistedAgentAuthorityEvaluation = Readonly<{
  authorized: boolean;
  effectivePermissions: readonly string[];
  blockers: readonly AgentAuthorityBlocker[];
}>;

function addAuthorityBlocker(
  blockers: AgentAuthorityBlocker[],
  blocker: AgentAuthorityBlocker,
): void {
  if (!blockers.some((candidate) => candidate.code === blocker.code && candidate.permission === blocker.permission)) {
    blockers.push(blocker);
  }
}

function grantedPermissionCeiling(grantActionIds: readonly string[]): readonly string[] {
  const granted = new Set(grantActionIds);
  return [...new Set(actionRegistry
    .filter((action) => isAgentApiV1ActionId(action.id) && granted.has(action.id))
    .flatMap((action) => action.permissions))].sort();
}

type PersistedAgentAuthorityInput = Readonly<{
  principal: PersistedServicePrincipal;
  grant: PersistedAgentGrant;
  sponsor: PersistedGrantSponsor;
  membership: PersistedSponsorMembership;
  workspaceId: string;
  actionId: ActionId;
  resource: Readonly<{ type: string; id: string }>;
  now: string;
}>;

/**
 * Adapt the persisted action/resource grant to the shared governance evaluator.
 * A single grant must satisfy every condition; callers must never union partial
 * authorization decisions from different grants.
 */
function evaluatePreparedAgentAuthority(
  input: PersistedAgentAuthorityInput,
  preparedConstraints: PreparedAgentResourceConstraints | null,
): PersistedAgentAuthorityEvaluation {
  const blockers: AgentAuthorityBlocker[] = [];
  const definition = getActionDefinition(input.actionId);
  const resources = preparedConstraints?.resources ?? [];
  const membershipRole = input.membership && isWorkspaceRole(input.membership.role)
    ? input.membership.role
    : null;
  const sponsorPermissions = membershipRole && input.membership?.status === "active" && input.sponsor.status === "active"
    ? permissionsForRole(membershipRole)
    : new Set<Permission>();
  const agentApiV1 = getAgentApiV1ActionCapability(input.actionId);

  if (input.principal.workspaceId !== input.workspaceId) {
    addAuthorityBlocker(blockers, { code: "SERVICE_PRINCIPAL_WORKSPACE_MISMATCH", message: "The service principal belongs to another workspace." });
  }
  if (input.principal.status !== "active") {
    addAuthorityBlocker(blockers, { code: "SERVICE_PRINCIPAL_DISABLED", message: "The service principal is disabled." });
  }
  if (input.grant.status !== "active") {
    addAuthorityBlocker(blockers, { code: "AGENT_GRANT_REVOKED", message: "The agent grant has been revoked." });
  }
  if (!preparedConstraints) {
    addAuthorityBlocker(blockers, { code: "AGENT_GRANT_INVALID", message: "The grant resource allowlist is invalid." });
  }
  if (!input.grant.actionIds.every((actionId) => (actionIds as readonly string[]).includes(actionId))) {
    addAuthorityBlocker(blockers, { code: "AGENT_GRANT_INVALID", message: "The grant contains an unknown action ID." });
  }
  if (!agentApiV1.executable && agentApiV1.blocker) {
    addAuthorityBlocker(blockers, agentApiV1.blocker);
  }
  if (
    input.resource.type === "agreement"
    && input.actionId !== "agreement.read"
    && !input.grant.actionIds.includes("agreement.read")
  ) {
    addAuthorityBlocker(blockers, {
      code: "AGENT_GRANT_READ_SCOPE_REQUIRED",
      message: "An agreement action grant must explicitly include agreement.read for the same resource boundary.",
      permission: "agreement:read",
    });
  }
  if (input.sponsor.id !== input.grant.delegatorUserId) {
    addAuthorityBlocker(blockers, { code: "AGENT_GRANT_DELEGATOR_MISMATCH", message: "The grant sponsor does not match its delegating user." });
  }
  if (input.sponsor.status !== "active") {
    addAuthorityBlocker(blockers, { code: "AGENT_SPONSOR_DISABLED", message: "The human sponsor account is disabled." });
  }
  if (
    !input.membership
    || input.membership.workspaceId !== input.workspaceId
    || input.membership.userId !== input.sponsor.id
    || input.membership.status !== "active"
    || membershipRole === null
  ) {
    addAuthorityBlocker(blockers, { code: "AGENT_SPONSOR_MEMBERSHIP_INACTIVE", message: "The human sponsor is not an active member of this workspace." });
  }
  if (!isCanonicalInstant(input.now)) {
    addAuthorityBlocker(blockers, { code: "AGENT_GRANT_INVALID", message: "Authority evaluation requires a canonical current instant." });
  }
  if (definition.executionPolicy === "human_only") {
    addAuthorityBlocker(blockers, { code: "ACTION_HUMAN_REQUIRED", message: "This action is reserved for a human principal." });
  }

  const evaluated = evaluateAgentGrant({
    grant: {
      id: input.grant.id,
      workspaceId: input.grant.workspaceId,
      serviceAccountId: input.grant.principalId,
      delegatorPrincipalId: input.grant.delegatorUserId,
      scopes: input.grant.actionIds,
      permissions: grantedPermissionCeiling(input.grant.actionIds),
      resources,
      notBefore: input.grant.startsAt,
      expiresAt: input.grant.expiresAt,
      revokedAt: input.grant.revokedAt,
    },
    serviceAccountId: input.principal.id,
    delegatorPrincipalId: input.sponsor.id,
    workspaceId: input.workspaceId,
    scope: input.actionId,
    resource: input.resource,
    requiredPermissions: definition.permissions,
    delegatorPermissions: sponsorPermissions,
    now: input.now,
  });
  for (const blocker of evaluated.blockers) addAuthorityBlocker(blockers, blocker);

  return Object.freeze({
    authorized: blockers.length === 0,
    effectivePermissions: Object.freeze([...evaluated.effectivePermissions]),
    blockers: Object.freeze(blockers),
  });
}

export function evaluatePersistedAgentAuthority(
  input: PersistedAgentAuthorityInput,
): PersistedAgentAuthorityEvaluation {
  return evaluatePreparedAgentAuthority(
    input,
    prepareAgentResourceConstraints(input.grant.resourceConstraints),
  );
}

export type ResolvedServiceGrant = Readonly<{
  grant: PersistedAgentGrant;
  sponsor: PersistedGrantSponsor;
  membership: Exclude<PersistedSponsorMembership, null>;
  resources: readonly Readonly<{ type: string; id: string }>[];
}>;

export type ServicePrincipalContext = Readonly<{
  kind: "service";
  workspace: Readonly<{ id: string; slug: string; name: string }>;
  principal: PersistedServicePrincipal & Readonly<{ name: string; version: number }>;
  grants: readonly ResolvedServiceGrant[];
  authenticatedAt: string;
  identitySource: "cloudflare-access-service-token" | "evaluation-service-principal";
}>;

export type ServiceActionAuthority = Readonly<{
  authorized: boolean;
  grantIds: readonly string[];
  effectivePermissions: readonly string[];
  blockers: readonly AgentAuthorityBlocker[];
}>;

export function authorizeResolvedServiceAction(
  context: ServicePrincipalContext,
  actionId: ActionId,
  resource: Readonly<{ type: string; id: string }>,
): ServiceActionAuthority {
  const allowed: Array<{ grantId: string; permissions: readonly string[] }> = [];
  const blockers: AgentAuthorityBlocker[] = [];
  for (const resolved of context.grants) {
    const evaluation = evaluatePersistedAgentAuthority({
      principal: context.principal,
      grant: resolved.grant,
      sponsor: resolved.sponsor,
      membership: resolved.membership,
      workspaceId: context.workspace.id,
      actionId,
      resource,
      now: context.authenticatedAt,
    });
    if (evaluation.authorized) {
      allowed.push({ grantId: resolved.grant.id, permissions: evaluation.effectivePermissions });
    } else {
      for (const blocker of evaluation.blockers) addAuthorityBlocker(blockers, blocker);
    }
  }
  if (allowed.length === 0) {
    return Object.freeze({ authorized: false, grantIds: Object.freeze([]), effectivePermissions: Object.freeze([]), blockers: Object.freeze(blockers) });
  }
  return Object.freeze({
    authorized: true,
    grantIds: Object.freeze(allowed.map((candidate) => candidate.grantId).sort()),
    // Use one independently sufficient grant. Never union partial grants.
    effectivePermissions: Object.freeze([...allowed[0].permissions]),
    blockers: Object.freeze([]),
  });
}

function grantHasAnyEffectiveAuthority(input: Readonly<{
  principal: ServicePrincipalContext["principal"];
  grant: PersistedAgentGrant;
  sponsor: PersistedGrantSponsor;
  membership: Exclude<PersistedSponsorMembership, null>;
  workspaceId: string;
  now: string;
}>): boolean {
  const preparedConstraints = prepareAgentResourceConstraints(input.grant.resourceConstraints);
  if (!preparedConstraints) return false;
  return input.grant.actionIds.some((candidate) => {
    if (!(actionIds as readonly string[]).includes(candidate)) return false;
    const actionId = candidate as ActionId;
    if (!isAgentApiV1ActionId(actionId)) return false;
    const resource = representativeResourceForAction(
      getActionDefinition(actionId),
      preparedConstraints.resources,
    );
    if (!resource) return false;
    return evaluatePreparedAgentAuthority({
      ...input,
      actionId,
      resource,
    }, preparedConstraints).authorized;
  });
}

export type ServicePrincipalAuthErrorCode =
  | "SERVICE_AUTHENTICATION_REQUIRED"
  | "SERVICE_IDENTITY_INVALID"
  | "SERVICE_PRINCIPAL_DISABLED"
  | "SERVICE_PRINCIPAL_UNREGISTERED"
  | "SERVICE_GRANT_REQUIRED"
  | "SERVICE_EVALUATION_LOCAL_ONLY";

export class ServicePrincipalAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: ServicePrincipalAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServicePrincipalAuthError";
  }
}

async function resolveRegisteredServicePrincipal(
  request: Request,
): Promise<ServicePrincipalContext | null> {
  const [{ getNoticeConfig }, { ensureStorageSchema }, { getDb }] = await Promise.all([
    import("./config"),
    import("../../db/ensure"),
    import("../../db"),
  ]);
  const config = getNoticeConfig();
  let registeredId: string | null = null;
  let verifiedIdentity: VerifiedCloudflareServiceIdentity | null = null;
  let identitySource: ServicePrincipalContext["identitySource"];

  if (config.mode === "evaluation") {
    registeredId = request.headers.get(EVALUATION_SERVICE_PRINCIPAL_HEADER);
    if (!registeredId) return null;
    if (!isLoopbackRequestUrl(request.url)) {
      throw new ServicePrincipalAuthError(403, "SERVICE_EVALUATION_LOCAL_ONLY", "Evaluation service principals are available only on a loopback origin.");
    }
    if (!z.string().uuid().safeParse(registeredId).success) {
      throw new ServicePrincipalAuthError(401, "SERVICE_IDENTITY_INVALID", "The evaluation service principal identifier is invalid.");
    }
    identitySource = "evaluation-service-principal";
  } else {
    if (config.authMode !== "cloudflare-access" || !config.cloudflareAccess) return null;
    if (!request.headers.has(CLOUDFLARE_ACCESS_JWT_HEADER)) return null;
    try {
      verifiedIdentity = await verifyCloudflareAccessServiceIdentity(request, config.cloudflareAccess);
    } catch (error) {
      if (error instanceof ServiceTokenVerificationError && error.code === "TOKEN_NOT_SERVICE") return null;
      throw new ServicePrincipalAuthError(401, "SERVICE_IDENTITY_INVALID", "The Cloudflare Access service identity is invalid.");
    }
    identitySource = "cloudflare-access-service-token";
  }

  await ensureStorageSchema();
  const db = getDb();
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, config.workspace.id)).limit(1);
  if (!workspace || workspace.status !== "active") {
    throw new ServicePrincipalAuthError(403, "SERVICE_PRINCIPAL_UNREGISTERED", "The service principal is not registered for an active workspace.");
  }
  const [principal] = registeredId
    ? await db.select().from(servicePrincipals).where(and(
      eq(servicePrincipals.workspaceId, workspace.id),
      eq(servicePrincipals.id, registeredId),
    )).limit(1)
    : await db.select().from(servicePrincipals).where(and(
      eq(servicePrincipals.workspaceId, workspace.id),
      eq(servicePrincipals.issuer, verifiedIdentity!.issuer),
      eq(servicePrincipals.subject, verifiedIdentity!.commonName),
    )).limit(1);
  if (!principal) {
    throw new ServicePrincipalAuthError(403, "SERVICE_PRINCIPAL_UNREGISTERED", "The service principal is not registered for this workspace.");
  }
  if (principal.status !== "active") {
    throw new ServicePrincipalAuthError(403, "SERVICE_PRINCIPAL_DISABLED", "The service principal is disabled.");
  }

  const now = new Date().toISOString();
  const rows = await db.select({
    grantId: agentGrants.id,
    grantWorkspaceId: agentGrants.workspaceId,
    grantPrincipalId: agentGrants.principalId,
    delegatorUserId: agentGrants.delegatorUserId,
    grantStatus: agentGrants.status,
    actionIds: agentGrants.actionIds,
    resourceConstraints: agentGrants.resourceConstraints,
    policyVersion: agentGrants.policyVersion,
    startsAt: agentGrants.startsAt,
    expiresAt: agentGrants.expiresAt,
    revokedAt: agentGrants.revokedAt,
    sponsorId: users.id,
    sponsorStatus: users.status,
    membershipWorkspaceId: workspaceMemberships.workspaceId,
    membershipUserId: workspaceMemberships.userId,
    membershipRole: workspaceMemberships.role,
    membershipStatus: workspaceMemberships.status,
  }).from(agentGrants)
    .innerJoin(users, eq(users.id, agentGrants.delegatorUserId))
    .leftJoin(workspaceMemberships, and(
      eq(workspaceMemberships.workspaceId, agentGrants.workspaceId),
      eq(workspaceMemberships.userId, agentGrants.delegatorUserId),
    ))
    .where(and(
      eq(agentGrants.workspaceId, workspace.id),
      eq(agentGrants.principalId, principal.id),
      eq(agentGrants.status, "active"),
      lte(agentGrants.startsAt, now),
      gt(agentGrants.expiresAt, now),
    ))
    .orderBy(desc(agentGrants.updatedAt))
    .limit(100);

  const principalContext = Object.freeze({
    id: principal.id,
    workspaceId: principal.workspaceId,
    issuer: principal.issuer,
    subject: principal.subject,
    status: principal.status,
    name: principal.name,
    version: principal.version,
  });
  const resolved: ResolvedServiceGrant[] = [];
  for (const row of rows) {
    if (!row.membershipWorkspaceId || !row.membershipUserId || !row.membershipRole || !row.membershipStatus) continue;
    const grant: PersistedAgentGrant = {
      id: row.grantId,
      workspaceId: row.grantWorkspaceId,
      principalId: row.grantPrincipalId,
      delegatorUserId: row.delegatorUserId,
      status: row.grantStatus,
      actionIds: row.actionIds,
      resourceConstraints: row.resourceConstraints,
      policyVersion: row.policyVersion,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
    const sponsor = { id: row.sponsorId, status: row.sponsorStatus };
    const membership = {
      workspaceId: row.membershipWorkspaceId,
      userId: row.membershipUserId,
      role: row.membershipRole,
      status: row.membershipStatus,
    };
    if (grantHasAnyEffectiveAuthority({
      principal: principalContext,
      grant,
      sponsor,
      membership,
      workspaceId: workspace.id,
      now,
    })) {
      resolved.push(Object.freeze({ grant, sponsor, membership, resources: flattenAgentResourceConstraints(grant.resourceConstraints) }));
    }
  }
  if (resolved.length === 0) {
    throw new ServicePrincipalAuthError(403, "SERVICE_GRANT_REQUIRED", "No active grant currently authorizes this service principal.");
  }

  return Object.freeze({
    kind: "service",
    workspace: Object.freeze({ id: workspace.id, slug: workspace.slug, name: workspace.name }),
    principal: principalContext,
    grants: Object.freeze(resolved),
    authenticatedAt: now,
    identitySource,
  });
}

export type AuthorizedV1Request = Readonly<{
  ok: true;
  actor:
    | Readonly<{ kind: "human"; context: import("./authorization").PermissionContext }>
    | Readonly<{ kind: "service"; context: ServicePrincipalContext }>;
  requestId: string;
  headers: Headers;
}>;

export type RejectedV1Request = Readonly<{ ok: false; response: Response }>;

export type AuthorizedServicePrincipalRequest = Readonly<{
  ok: true;
  context: ServicePrincipalContext;
  workspace: ServicePrincipalContext["workspace"];
  principal: ServicePrincipalContext["principal"];
  grant: PersistedAgentGrant;
  sponsor: PersistedGrantSponsor;
  membership: Exclude<PersistedSponsorMembership, null>;
  effectivePermissions: readonly string[];
  requestId: string;
  headers: Headers;
}>;

/**
 * Authorize one service-principal action against one concrete resource. The
 * returned grant is independently sufficient for the action; separate grants
 * are never combined. This is the stable auth entry point for future plan and
 * execution routes.
 */
export async function authorizeServicePrincipalRequest(
  request: Request,
  actionId: ActionId,
  resource: Readonly<{ type: string; id: string }>,
  requiredGrantId?: string,
): Promise<AuthorizedServicePrincipalRequest | RejectedV1Request> {
  const requestId = createRequestId();
  try {
    const context = await resolveRegisteredServicePrincipal(request);
    if (!context) {
      return {
        ok: false,
        response: apiError("service_authentication_required", "A registered service-principal identity is required.", { status: 401, requestId }),
      };
    }

    for (const resolved of context.grants) {
      if (requiredGrantId && resolved.grant.id !== requiredGrantId) continue;
      const evaluation = evaluatePersistedAgentAuthority({
        principal: context.principal,
        grant: resolved.grant,
        sponsor: resolved.sponsor,
        membership: resolved.membership,
        workspaceId: context.workspace.id,
        actionId,
        resource,
        now: context.authenticatedAt,
      });
      if (!evaluation.authorized) continue;

      const rateLimits = servicePrincipalActionRateLimits(
        context.workspace.id,
        context.principal.id,
        request,
        actionId,
        resource,
      );
      const aggregateDecision = checkBestEffortRateLimit(rateLimits.aggregate.key, rateLimits.aggregate);
      if (!aggregateDecision.allowed) {
        return { ok: false, response: rateLimitExceeded(aggregateDecision, requestId) };
      }
      const resourceDecision = checkBestEffortRateLimit(rateLimits.resource.key, rateLimits.resource);
      if (!resourceDecision.allowed) {
        return { ok: false, response: rateLimitExceeded(resourceDecision, requestId) };
      }
      return {
        ok: true,
        context,
        workspace: context.workspace,
        principal: context.principal,
        grant: resolved.grant,
        sponsor: resolved.sponsor,
        membership: resolved.membership,
        effectivePermissions: evaluation.effectivePermissions,
        requestId,
        headers: rateLimitHeaders(aggregateDecision),
      };
    }

    return {
      ok: false,
      response: apiError(
        "service_authority_denied",
        requiredGrantId
          ? "The exact grant bound to this request no longer authorizes the action and resource."
          : "No single active grant authorizes this action for the requested resource.",
        { status: 403, requestId },
      ),
    };
  } catch (error) {
    if (error instanceof ServicePrincipalAuthError) {
      return {
        ok: false,
        response: apiError(error.code.toLowerCase(), error.message, { status: error.status, requestId }),
      };
    }
    return {
      ok: false,
      response: safeInternalError(error, { requestId, publicMessage: "The service-principal request could not be authorized." }),
    };
  }
}

/** Resolve the machine auth path first, then a normal human session. */
export async function authorizeV1ReadRequest(
  request: Request,
): Promise<AuthorizedV1Request | RejectedV1Request> {
  const requestId = createRequestId();
  try {
    const service = await resolveRegisteredServicePrincipal(request);
    if (service) {
      const rateLimit = servicePrincipalActorRateLimit(
        service.workspace.id,
        service.principal.id,
        request,
      );
      const decision = checkBestEffortRateLimit(rateLimit.key, rateLimit);
      if (!decision.allowed) return { ok: false, response: rateLimitExceeded(decision, requestId) };
      return { ok: true, actor: { kind: "service", context: service }, requestId, headers: rateLimitHeaders(decision) };
    }
    const { authorizeApiRequest } = await import("./api");
    const human = await authorizeApiRequest(request, "agent:read");
    if (!human.ok) return human;
    return {
      ok: true,
      actor: { kind: "human", context: human.context },
      requestId: human.requestId,
      headers: human.headers,
    };
  } catch (error) {
    if (error instanceof ServicePrincipalAuthError) {
      return {
        ok: false,
        response: apiError(error.code.toLowerCase(), error.message, { status: error.status, requestId }),
      };
    }
    return {
      ok: false,
      response: safeInternalError(error, { requestId, publicMessage: "The agent identity could not be authorized." }),
    };
  }
}

export type CatalogActor =
  | Readonly<{ kind: "human"; permissions: readonly string[] | ReadonlySet<string> }>
  | Readonly<{ kind: "service"; context: ServicePrincipalContext }>;

export function buildActionCatalog(actor: CatalogActor) {
  const preparedGrants = actor.kind === "service"
    ? actor.context.grants.flatMap((resolved) => {
      const constraints = prepareAgentResourceConstraints(resolved.grant.resourceConstraints);
      return constraints ? [{ resolved, constraints }] : [];
    })
    : [];
  return actionRegistry.map((definition) => {
    const agentApiV1 = getAgentApiV1ActionCapability(definition.id);
    const metadata = {
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
      agentApiV1,
    };
    if (actor.kind === "human") {
      const permissions = new Set(actor.permissions);
      const missingPermissions = definition.permissions.filter((permission) => !permissions.has(permission));
      return {
        ...metadata,
        authority: {
          eligible: missingPermissions.length === 0,
          grantIds: [] as string[],
          missingPermissions,
          resourceConstraints: [] as AgentResourceConstraints[],
        },
      };
    }

    const coverage = agentApiV1.plannable ? preparedGrants.filter(({ resolved, constraints }) => {
      const resource = representativeResourceForAction(definition, constraints.resources);
      if (!resource) return false;
      return evaluatePreparedAgentAuthority({
        principal: actor.context.principal,
        grant: resolved.grant,
        sponsor: resolved.sponsor,
        membership: resolved.membership,
        workspaceId: actor.context.workspace.id,
        actionId: definition.id,
        resource,
        now: actor.context.authenticatedAt,
      }, constraints).authorized;
    }) : [];
    return {
      ...metadata,
      authority: {
        eligible: coverage.length > 0,
        grantIds: coverage.map(({ resolved }) => resolved.grant.id).sort(),
        missingPermissions: [] as string[],
        resourceConstraints: coverage.map(({ constraints }) =>
          normalizeAgentResourceConstraints(constraints.normalized)),
      },
    };
  });
}

/** Actor-independent material used for the stable registry digest. */
export function actionCatalogPolicyMetadata(actions: ReturnType<typeof buildActionCatalog>) {
  return actions.map((action) => ({
    id: action.id,
    implementationVersion: action.implementationVersion,
    label: action.label,
    targetTypes: [...action.targetTypes],
    permissions: [...action.permissions],
    riskTier: action.riskTier,
    executionPolicy: action.executionPolicy,
    confirmationPolicy: action.confirmationPolicy,
    requiresTargetVersion: action.requiresTargetVersion,
    requiresBasis: action.requiresBasis,
    allowedStages: action.allowedStages ? [...action.allowedStages] : null,
    preconditions: [...action.preconditions],
    agentApiV1: action.agentApiV1,
  }));
}

export type ActionAffordanceBlocker = AgentAuthorityBlocker | ActionBlocker;

export function buildActionAffordance(input: Readonly<{
  definition: ActionDefinition;
  actorKind: "human" | "agent";
  permissions: readonly string[] | ReadonlySet<string>;
  target: Readonly<{
    type: string;
    id: string;
    version?: number;
    basisHash?: string;
    documentVersion?: number;
    documentSha256?: string;
    stage?: string;
    satisfiedPreconditions?: readonly ActionTargetPrecondition[];
  }>;
  authority: Readonly<{
    authorized: boolean;
    grantIds?: readonly string[];
    blockers?: readonly AgentAuthorityBlocker[];
  }>;
}>) {
  const agentApiV1 = getAgentApiV1ActionCapability(input.definition.id);
  const evaluation = evaluateAction(input.definition, {
    actor: { kind: input.actorKind, permissions: input.permissions },
    target: input.target,
    attempt: {
      ...(typeof input.target.version === "number" ? { expectedVersion: input.target.version } : {}),
      ...(typeof input.target.basisHash === "string" ? { expectedBasisHash: input.target.basisHash } : {}),
    },
  });
  const blockers: ActionAffordanceBlocker[] = [
    ...(input.authority.blockers ?? []),
    ...evaluation.blockers,
  ];
  if (
    input.actorKind === "agent"
    && agentApiV1.blocker
    && !blockers.some((blocker) => blocker.code === agentApiV1.blocker?.code)
  ) blockers.push(agentApiV1.blocker);
  const authorized = input.authority.authorized
    && (input.actorKind !== "agent" || agentApiV1.plannable);
  return {
    id: input.definition.id,
    label: input.definition.label,
    targetTypes: [...input.definition.targetTypes],
    requiredPermissions: [...input.definition.permissions],
    riskTier: input.definition.riskTier,
    executionPolicy: input.definition.executionPolicy,
    confirmationPolicy: input.definition.confirmationPolicy,
    requiresTargetVersion: input.definition.requiresTargetVersion,
    requiresBasis: input.definition.requiresBasis,
    allowedStages: input.definition.allowedStages ? [...input.definition.allowedStages] : null,
    requiredPreconditions: [...input.definition.preconditions],
    agentApiV1,
    authority: {
      authorized,
      grantIds: authorized ? [...(input.authority.grantIds ?? [])] : [],
    },
    availableNow: authorized && evaluation.allowed,
    requiredEvidence: {
      targetVersion: evaluation.requiredVersion,
      basisHash: evaluation.requiredBasisHash,
      documentVersion: input.target.documentVersion ?? null,
      documentSha256: input.target.documentSha256 ?? null,
    },
    requiresHuman: evaluation.requiresHuman,
    blockers,
  };
}

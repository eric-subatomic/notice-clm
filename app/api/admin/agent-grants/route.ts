import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agentGrants, mutationGuards, servicePrincipals, workspaceEvents } from "../../../../db/schema";
import {
  AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE,
  actionIds,
  getAgentApiV1ActionCapability,
  getActionDefinition,
  isAgentApiV1ActionId,
} from "../../../lib/action-registry";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { apiError, apiJson } from "../../../lib/http";
import { isMutationGuardConflict, prepareWorkspaceEvent } from "../../../lib/persistence";
import {
  agentResourceConstraintsSchema,
  normalizeAgentResourceConstraints,
} from "../../../lib/service-principal-auth";
import { parseJson } from "../../../lib/validation";

const MAX_GRANT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const MIN_GRANT_LIFETIME_MS = 5 * 60 * 1_000;

const canonicalInstantSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "Use a canonical ISO-8601 UTC instant.");

const actionAllowlistSchema = z.array(z.enum(actionIds)).min(1).max(actionIds.length)
  .refine((value) => new Set(value).size === value.length, "Action IDs must be unique.");

const createGrantSchema = z.object({
  principalId: z.string().uuid(),
  actionIds: actionAllowlistSchema,
  resourceConstraints: agentResourceConstraintsSchema,
  policyVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  startsAt: canonicalInstantSchema.optional(),
  expiresAt: canonicalInstantSchema,
}).strict();

const revokeGrantSchema = z.object({
  action: z.literal("revoke"),
  grantId: z.string().uuid(),
  version: z.number().int().positive(),
  reason: z.string().trim().min(8).max(500),
}).strict();

function compatibleResourceAllowlist(
  grantedActions: readonly (typeof actionIds)[number][],
  constraints: z.infer<typeof agentResourceConstraintsSchema>,
): boolean {
  const resourceTypes = new Set(constraints.resources.map((resource) => resource.type));
  return grantedActions.every((actionId) =>
    getActionDefinition(actionId).targetTypes.some((targetType) => resourceTypes.has(targetType)));
}

function isGrantLimitConflict(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error))
    .toLowerCase()
    .includes("agent_grant_limit_reached");
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agent:admin");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const rows = await getDb().select({
      id: agentGrants.id,
      principalId: agentGrants.principalId,
      delegatorUserId: agentGrants.delegatorUserId,
      status: agentGrants.status,
      actionIds: agentGrants.actionIds,
      resourceConstraints: agentGrants.resourceConstraints,
      policyVersion: agentGrants.policyVersion,
      startsAt: agentGrants.startsAt,
      expiresAt: agentGrants.expiresAt,
      revokedAt: agentGrants.revokedAt,
      revokedByUserId: agentGrants.revokedByUserId,
      revocationReason: agentGrants.revocationReason,
      version: agentGrants.version,
      createdAt: agentGrants.createdAt,
      updatedAt: agentGrants.updatedAt,
    }).from(agentGrants).where(
      eq(agentGrants.workspaceId, auth.context.workspace.id),
    ).orderBy(desc(agentGrants.updatedAt)).limit(200);
    return apiJson({ grants: rows, requestId: auth.requestId }, {
      requestId: auth.requestId,
      headers: auth.headers,
    });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Agent grants could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agent:admin", { limit: 20 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, createGrantSchema, 64_000);
    await ensureStorageSchema();
    const now = new Date().toISOString();
    const startsAt = input.startsAt ?? now;
    const startsMilliseconds = Date.parse(startsAt);
    const expiresMilliseconds = Date.parse(input.expiresAt);
    const nowMilliseconds = Date.parse(now);
    if (
      startsMilliseconds < nowMilliseconds
      || expiresMilliseconds - Math.max(startsMilliseconds, nowMilliseconds) < MIN_GRANT_LIFETIME_MS
      || expiresMilliseconds - nowMilliseconds > MAX_GRANT_LIFETIME_MS
    ) {
      return apiError(
        "invalid_grant_window",
        "A grant must start now or later, remain active for at least five minutes, and expire within 90 days.",
        { status: 400, requestId: auth.requestId, headers: auth.headers },
      );
    }
    const unsupportedAction = input.actionIds.find((actionId) => !isAgentApiV1ActionId(actionId));
    if (unsupportedAction) {
      const capability = getAgentApiV1ActionCapability(unsupportedAction);
      return apiError(
        AGENT_API_V1_UNSUPPORTED_ACTION_ERROR_CODE,
        capability.blocker?.message ?? "The requested action is not supported by the v1 agent contract.",
        { status: 400, requestId: auth.requestId, headers: auth.headers },
      );
    }
    const delegatesAgreementWork = input.actionIds.some((actionId) =>
      actionId !== "agreement.read" && getActionDefinition(actionId).targetTypes.includes("agreement"));
    if (delegatesAgreementWork && !input.actionIds.includes("agreement.read")) {
      return apiError(
        "agreement_read_scope_required",
        "Delegating an agreement action also requires explicit agreement.read coverage in the same grant.",
        { status: 400, requestId: auth.requestId, headers: auth.headers },
      );
    }
    if (!compatibleResourceAllowlist(input.actionIds, input.resourceConstraints)) {
      return apiError(
        "resource_allowlist_incomplete",
        "Every delegated action needs an allowlisted resource type that it supports.",
        { status: 400, requestId: auth.requestId, headers: auth.headers },
      );
    }
    for (const actionId of input.actionIds) {
      const missingPermission = getActionDefinition(actionId).permissions.find((permission) =>
        !auth.context.permissions.has(permission as never));
      if (missingPermission) {
        return apiError(
          "delegator_permission_denied",
          `The current administrator cannot delegate ${actionId} because ${missingPermission} is not currently held.`,
          { status: 403, requestId: auth.requestId, headers: auth.headers },
        );
      }
    }

    const db = getDb();
    const [principal] = await db.select().from(servicePrincipals).where(and(
      eq(servicePrincipals.workspaceId, auth.context.workspace.id),
      eq(servicePrincipals.id, input.principalId),
    )).limit(1);
    if (!principal) {
      return apiError("service_principal_not_found", "Service principal was not found.", {
        status: 404,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    if (principal.status !== "active") {
      return apiError("service_principal_disabled", "Enable the service principal before creating a grant.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    const activeGrants = await db.select({ id: agentGrants.id }).from(agentGrants).where(and(
      eq(agentGrants.workspaceId, auth.context.workspace.id),
      eq(agentGrants.principalId, principal.id),
      eq(agentGrants.status, "active"),
      gt(agentGrants.expiresAt, now),
    )).limit(50);
    if (activeGrants.length >= 50) {
      return apiError(
        "active_grant_limit_reached",
        "Revoke or let an existing grant expire before creating another; a principal may have at most 50 active unexpired or scheduled grants.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }

    const grant = {
      id: crypto.randomUUID(),
      workspaceId: auth.context.workspace.id,
      principalId: principal.id,
      delegatorUserId: auth.context.user.id,
      status: "active" as const,
      actionIds: [...input.actionIds],
      resourceConstraints: normalizeAgentResourceConstraints(input.resourceConstraints),
      policyVersion: input.policyVersion,
      startsAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
      revokedByUserId: null,
      revocationReason: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "AgentGrant",
      detail: `Granted ${grant.actionIds.join(", ")} to service principal ${principal.name} until ${grant.expiresAt}.`,
      actor: auth.context.user,
      createdAt: now,
    });
    try {
      await db.batch([
        db.insert(agentGrants).values(grant),
        db.insert(workspaceEvents).values(event),
      ]);
    } catch (error) {
      if (isGrantLimitConflict(error)) {
        return apiError(
          "active_grant_limit_reached",
          "Revoke or let an existing grant expire before creating another; a principal may have at most 50 active unexpired or scheduled grants.",
          { status: 409, requestId: auth.requestId, headers: auth.headers },
        );
      }
      throw error;
    }
    return apiJson({ grant, requestId: auth.requestId }, {
      status: 201,
      requestId: auth.requestId,
      headers: auth.headers,
    });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The agent grant could not be created.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "agent:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, revokeGrantSchema, 8_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(agentGrants).where(and(
      eq(agentGrants.workspaceId, auth.context.workspace.id),
      eq(agentGrants.id, input.grantId),
    )).limit(1);
    if (!current) {
      return apiError("agent_grant_not_found", "Agent grant was not found.", {
        status: 404,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    if (current.version !== input.version) {
      return apiError("version_conflict", "The grant changed. Reload before revoking it.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    if (current.status === "revoked") {
      return apiJson({ grant: current, unchanged: true, requestId: auth.requestId }, {
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    const now = new Date().toISOString();
    const guardId = crypto.randomUUID();
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "AgentGrant",
      detail: `Revoked agent grant ${current.id}. Reason: ${input.reason}`,
      actor: auth.context.user,
      createdAt: now,
    });
    try {
      await db.batch([
        db.update(agentGrants).set({
          status: "revoked",
          revokedAt: now,
          revokedByUserId: auth.context.user.id,
          revocationReason: input.reason,
          version: current.version + 1,
          updatedAt: now,
        }).where(and(
          eq(agentGrants.workspaceId, auth.context.workspace.id),
          eq(agentGrants.id, current.id),
          eq(agentGrants.version, current.version),
          eq(agentGrants.status, "active"),
        )),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId: auth.context.workspace.id,
          operation: "agent-grant.revoke",
          guardChanges: sql<number>`changes()`,
          createdAt: now,
        }),
        db.insert(workspaceEvents).values(event),
        db.delete(mutationGuards).where(and(
          eq(mutationGuards.workspaceId, auth.context.workspace.id),
          eq(mutationGuards.id, guardId),
        )),
      ]);
    } catch (error) {
      if (isMutationGuardConflict(error)) {
        return apiError("version_conflict", "The grant changed. Reload before revoking it.", {
          status: 409,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
      throw error;
    }
    return apiJson({
      grant: {
        id: current.id,
        status: "revoked",
        revokedAt: now,
        revocationReason: input.reason,
        version: current.version + 1,
      },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The agent grant could not be revoked.");
  }
}

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { mutationGuards, servicePrincipals, workspaceEvents } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { getNoticeConfig } from "../../../lib/config";
import { apiError, apiJson } from "../../../lib/http";
import { isMutationGuardConflict, prepareWorkspaceEvent } from "../../../lib/persistence";
import { parseJson } from "../../../lib/validation";

const principalNameSchema = z.string().trim().min(2).max(120)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value), "The principal name contains unsafe formatting characters.");

const serviceSubjectSchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, "Use the exact bounded Cloudflare service-token client ID.");

const createPrincipalSchema = z.object({
  name: principalNameSchema,
  commonName: serviceSubjectSchema,
}).strict();

const updatePrincipalSchema = z.object({
  principalId: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(["active", "disabled"]),
  reason: z.string().trim().min(8).max(500),
}).strict();

function isIdentityConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("unique constraint failed")
    && message.includes("service_principals.workspace_id");
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agent:admin");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const rows = await getDb().select({
      id: servicePrincipals.id,
      name: servicePrincipals.name,
      issuer: servicePrincipals.issuer,
      commonName: servicePrincipals.subject,
      status: servicePrincipals.status,
      version: servicePrincipals.version,
      createdByUserId: servicePrincipals.createdByUserId,
      createdAt: servicePrincipals.createdAt,
      updatedAt: servicePrincipals.updatedAt,
      lastSeenAt: servicePrincipals.lastSeenAt,
    }).from(servicePrincipals).where(
      eq(servicePrincipals.workspaceId, auth.context.workspace.id),
    ).orderBy(desc(servicePrincipals.updatedAt)).limit(200);
    return apiJson({ principals: rows, requestId: auth.requestId }, {
      requestId: auth.requestId,
      headers: auth.headers,
    });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Service principals could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "agent:admin", { limit: 20 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, createPrincipalSchema, 8_000);
    await ensureStorageSchema();
    const config = getNoticeConfig();
    if (config.mode === "production" && (!config.cloudflareAccess || config.authMode !== "cloudflare-access")) {
      return apiError(
        "service_identity_provider_unavailable",
        "Cloudflare Access service-token verification must be configured before registering a service principal.",
        { status: 409, requestId: auth.requestId, headers: auth.headers },
      );
    }
    const now = new Date().toISOString();
    const principal = {
      id: crypto.randomUUID(),
      workspaceId: auth.context.workspace.id,
      name: input.name,
      issuer: config.cloudflareAccess?.teamDomain ?? "notice-evaluation",
      subject: input.commonName,
      status: "active" as const,
      version: 1,
      createdByUserId: auth.context.user.id,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    };
    const db = getDb();
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "AgentPrincipal",
      detail: `Registered service principal ${principal.name} (${principal.id}); no bearer secret was stored.`,
      actor: auth.context.user,
      createdAt: now,
    });
    try {
      await db.batch([
        db.insert(servicePrincipals).values(principal),
        db.insert(workspaceEvents).values(event),
      ]);
    } catch (error) {
      if (isIdentityConflict(error)) {
        return apiError("service_principal_exists", "That verified service identity is already registered in this workspace.", {
          status: 409,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
      throw error;
    }
    return apiJson({
      principal: {
        id: principal.id,
        name: principal.name,
        issuer: principal.issuer,
        commonName: principal.subject,
        status: principal.status,
        version: principal.version,
        createdAt: principal.createdAt,
      },
      requestId: auth.requestId,
    }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The service principal could not be registered.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "agent:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, updatePrincipalSchema, 8_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(servicePrincipals).where(and(
      eq(servicePrincipals.workspaceId, auth.context.workspace.id),
      eq(servicePrincipals.id, input.principalId),
    )).limit(1);
    if (!current) {
      return apiError("service_principal_not_found", "Service principal was not found.", {
        status: 404,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    if (current.version !== input.version) {
      return apiError("version_conflict", "The service principal changed. Reload before updating it.", {
        status: 409,
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }
    if (current.status === input.status) {
      return apiJson({ principal: current, unchanged: true, requestId: auth.requestId }, {
        requestId: auth.requestId,
        headers: auth.headers,
      });
    }

    const now = new Date().toISOString();
    const guardId = crypto.randomUUID();
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "AgentPrincipal",
      detail: `Changed service principal ${current.name} from ${current.status} to ${input.status}. Reason: ${input.reason}`,
      actor: auth.context.user,
      createdAt: now,
    });
    try {
      await db.batch([
        db.update(servicePrincipals).set({
          status: input.status,
          version: current.version + 1,
          updatedAt: now,
        }).where(and(
          eq(servicePrincipals.workspaceId, auth.context.workspace.id),
          eq(servicePrincipals.id, current.id),
          eq(servicePrincipals.version, current.version),
        )),
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId: auth.context.workspace.id,
          operation: "agent-principal.update",
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
        return apiError("version_conflict", "The service principal changed. Reload before updating it.", {
          status: 409,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
      throw error;
    }
    return apiJson({
      principal: {
        id: current.id,
        name: current.name,
        status: input.status,
        version: current.version + 1,
        updatedAt: now,
      },
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "The service principal could not be updated.");
  }
}

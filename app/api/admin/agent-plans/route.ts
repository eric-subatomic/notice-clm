import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agentActionPlans, agentPlanStatuses } from "../../../../db/schema";
import { actionIds } from "../../../lib/action-registry";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { apiError, apiJson } from "../../../lib/http";

const listSchema = z.object({
  status: z.enum(agentPlanStatuses).optional(),
  principalId: z.string().uuid().optional(),
  actionId: z.enum(actionIds).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().uuid().optional(),
}).strict();

function planSummary(plan: typeof agentActionPlans.$inferSelect) {
  return {
    id: plan.id,
    principalId: plan.principalId,
    grantId: plan.grantId,
    actionId: plan.actionId,
    target: { type: plan.resourceType, id: plan.resourceId },
    status: plan.status,
    riskTier: plan.riskTier,
    planSha256: plan.planSha256,
    expectedVersion: plan.expectedVersion,
    basisHash: plan.basisHash,
    blockers: plan.blockers,
    expiresAt: plan.expiresAt,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

/** Human oversight inbox. This read path never grants service execution authority. */
export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "agent:admin");
  if (!auth.ok) return auth.response;
  const parsed = listSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return apiError("invalid_agent_plan_query", "Agent-plan filters are invalid.", {
      status: 400,
      requestId: auth.requestId,
      headers: auth.headers,
    });
  }
  try {
    await ensureStorageSchema();
    const db = getDb();
    let cursorCondition;
    if (parsed.data.cursor) {
      const [cursor] = await db.select({
        id: agentActionPlans.id,
        createdAt: agentActionPlans.createdAt,
      }).from(agentActionPlans).where(and(
        eq(agentActionPlans.workspaceId, auth.context.workspace.id),
        eq(agentActionPlans.id, parsed.data.cursor),
        parsed.data.status ? eq(agentActionPlans.status, parsed.data.status) : undefined,
        parsed.data.principalId ? eq(agentActionPlans.principalId, parsed.data.principalId) : undefined,
        parsed.data.actionId ? eq(agentActionPlans.actionId, parsed.data.actionId) : undefined,
      )).limit(1);
      if (!cursor) {
        return apiError("invalid_cursor", "The plan cursor is invalid for these oversight filters.", {
          status: 400,
          requestId: auth.requestId,
          headers: auth.headers,
        });
      }
      cursorCondition = or(
        lt(agentActionPlans.createdAt, cursor.createdAt),
        and(eq(agentActionPlans.createdAt, cursor.createdAt), lt(agentActionPlans.id, cursor.id)),
      );
    }
    const rows = await db.select().from(agentActionPlans).where(and(
      eq(agentActionPlans.workspaceId, auth.context.workspace.id),
      parsed.data.status ? eq(agentActionPlans.status, parsed.data.status) : undefined,
      parsed.data.principalId ? eq(agentActionPlans.principalId, parsed.data.principalId) : undefined,
      parsed.data.actionId ? eq(agentActionPlans.actionId, parsed.data.actionId) : undefined,
      cursorCondition,
    )).orderBy(desc(agentActionPlans.createdAt), desc(agentActionPlans.id)).limit(parsed.data.limit + 1);
    const hasMore = rows.length > parsed.data.limit;
    const page = rows.slice(0, parsed.data.limit);
    return apiJson({
      plans: page.map(planSummary),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      requestId: auth.requestId,
    }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Agent plans could not be loaded for human oversight.");
  }
}

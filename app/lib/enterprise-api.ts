import { and, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { mutationGuards, workspaceEvents } from "../../db/schema";
import { handleRouteError, withResponseHeaders } from "./api";
import { EnterpriseError } from "./enterprise-domain";
import { apiJson } from "./http";
import { isWorkspaceEventSequenceConflict, prepareWorkspaceEvent, type EventActor } from "./persistence";

type Database = ReturnType<typeof getDb>;
export type EnterpriseBatchItem = Parameters<Database["batch"]>[0][number];

export type EnterpriseMutationStep = Readonly<{
  statement: EnterpriseBatchItem;
  guardOperation?: string;
}>;

/** Commit mutations, optimistic row-count assertions, and one hash-linked audit event atomically. */
export async function executeEnterpriseMutation(db: Database, input: Readonly<{
  workspaceId: string;
  actor: EventActor;
  type: string;
  detail: Readonly<Record<string, unknown>>;
  steps: readonly EnterpriseMutationStep[];
  createdAt?: string;
}>): Promise<void> {
  if (input.steps.length === 0) throw new Error("An enterprise mutation needs at least one statement");
  const createdAt = input.createdAt ?? new Date().toISOString();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      type: input.type,
      detail: JSON.stringify(input.detail),
      createdAt,
    });
    const guardIds: string[] = [];
    const statements: EnterpriseBatchItem[] = [];
    for (const step of input.steps) {
      statements.push(step.statement);
      if (step.guardOperation) {
        const guardId = crypto.randomUUID();
        guardIds.push(guardId);
        statements.push(db.insert(mutationGuards).values({
          id: guardId,
          workspaceId: input.workspaceId,
          operation: step.guardOperation,
          guardChanges: sql<number>`changes()`,
          createdAt,
        }));
      }
    }
    statements.push(db.insert(workspaceEvents).values(event));
    if (guardIds.length > 0) {
      statements.push(db.delete(mutationGuards).where(and(
        sql`${mutationGuards.workspaceId} = ${input.workspaceId}`,
        inArray(mutationGuards.id, guardIds),
      )));
    }
    try {
      await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
      return;
    } catch (error) {
      if (attempt === 3 || !isWorkspaceEventSequenceConflict(error)) throw error;
    }
  }
  throw new Error("Workspace audit event could not be sequenced");
}

export function enterpriseRouteError(
  error: unknown,
  requestId: string,
  headers: Headers,
  publicMessage: string,
): Response {
  if (error instanceof EnterpriseError) {
    return apiJson({
      error: { code: error.code, message: error.message },
      ...(error.details ? { details: error.details } : {}),
      requestId,
    }, { status: error.status, requestId, headers });
  }
  return withResponseHeaders(handleRouteError(error, requestId, publicMessage), headers);
}

export function parseEnterpriseListQuery(request: Request): { limit: number; id?: string; status?: string } {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new EnterpriseError(400, "invalid_query", "limit must be an integer between 1 and 200.");
  }
  const id = url.searchParams.get("id")?.trim() || undefined;
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new EnterpriseError(400, "invalid_query", "id must be a UUID.");
  }
  const status = url.searchParams.get("status")?.trim() || undefined;
  if (status && status.length > 40) throw new EnterpriseError(400, "invalid_query", "status is too long.");
  return { limit, ...(id ? { id } : {}), ...(status ? { status } : {}) };
}

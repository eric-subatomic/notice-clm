import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { approvalLaneAuthorities } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import { assertExpectedVersion, EnterpriseError, isUniqueConstraintError } from "../../../../lib/enterprise-domain";
import { requireActiveAuthoritySubject } from "../../../../lib/enterprise-references";
import { approvalAuthorityCreateSchema, approvalAuthorityPatchSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

function isAuthorityIdentityConflict(error: unknown): boolean {
  return isUniqueConstraintError(error, [
    "approval_lane_authorities.workspace_id", "approval_lane_authorities.lane",
    "approval_lane_authorities.subject_type", "approval_lane_authorities.subject_id",
    "approval_lane_authorities.currency_code",
  ]);
}

function authorityIdentityConflict(): EnterpriseError {
  return new EnterpriseError(409, "approval_authority_exists", "That subject already has authority for this approval lane and currency.");
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    await ensureStorageSchema();
    const conditions = [eq(approvalLaneAuthorities.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(approvalLaneAuthorities.id, query.id));
    if (query.status === "active" || query.status === "revoked") conditions.push(eq(approvalLaneAuthorities.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported authority status.");
    const authorities = await getDb().select().from(approvalLaneAuthorities).where(and(...conditions))
      .orderBy(desc(approvalLaneAuthorities.updatedAt)).limit(query.limit);
    return apiJson({ approvalAuthorities: authorities, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Approval authority could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, approvalAuthorityCreateSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    await requireActiveAuthoritySubject(db, auth.context.workspace.id, input.subjectType, input.subjectId);
    const now = new Date().toISOString();
    const authority = {
      id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1,
      lane: input.lane, subjectType: input.subjectType, subjectId: input.subjectId,
      currencyCode: input.currencyCode, amountLimitMinor: input.amountLimitMinor,
      status: "active" as const, reason: input.reason, createdByUserId: auth.context.user.id, createdAt: now,
      updatedByUserId: auth.context.user.id, updatedAt: now,
    };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: authority.workspaceId, actor: auth.context.user, type: "ApprovalAuthorityGranted",
        detail: { action: "approval_authority.granted", authorityId: authority.id, lane: authority.lane, subjectType: authority.subjectType, subjectId: authority.subjectId, currencyCode: authority.currencyCode, amountLimitMinor: authority.amountLimitMinor, reason: input.reason, version: 1 },
        steps: [{ statement: db.insert(approvalLaneAuthorities).values(authority) }], createdAt: now,
      });
    } catch (error) {
      if (isAuthorityIdentityConflict(error)) throw authorityIdentityConflict();
      throw error;
    }
    return apiJson({ approvalAuthority: authority, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Approval authority could not be granted.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 40 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, approvalAuthorityPatchSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(approvalLaneAuthorities).where(and(
      eq(approvalLaneAuthorities.workspaceId, auth.context.workspace.id), eq(approvalLaneAuthorities.id, input.id),
    )).limit(1);
    if (!current) throw new EnterpriseError(404, "approval_authority_not_found", "Approval authority was not found.");
    assertExpectedVersion(current.version, input.version);
    if (current.status === "revoked") throw new EnterpriseError(409, "approval_authority_immutable", "Revoked approval authority cannot be changed.");
    const now = new Date().toISOString();
    const version = current.version + 1;
    if (input.action === "update") await requireActiveAuthoritySubject(db, current.workspaceId, current.subjectType, current.subjectId);
    const patch = input.action === "revoke"
      ? { status: "revoked" as const, reason: input.reason, version, updatedByUserId: auth.context.user.id, updatedAt: now }
      : {
          ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
          ...(input.amountLimitMinor !== undefined ? { amountLimitMinor: input.amountLimitMinor } : {}),
          reason: input.reason, version, updatedByUserId: auth.context.user.id, updatedAt: now,
        };
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: current.workspaceId, actor: auth.context.user,
        type: input.action === "revoke" ? "ApprovalAuthorityRevoked" : "ApprovalAuthorityUpdated",
        detail: { action: input.action === "revoke" ? "approval_authority.revoked" : "approval_authority.updated", authorityId: current.id, reason: input.reason, previousVersion: current.version, version },
        steps: [{ statement: db.update(approvalLaneAuthorities).set(patch).where(and(
          eq(approvalLaneAuthorities.workspaceId, current.workspaceId), eq(approvalLaneAuthorities.id, current.id),
          eq(approvalLaneAuthorities.version, current.version), eq(approvalLaneAuthorities.status, "active"),
        )), guardOperation: `approval-authority.${input.action}` }], createdAt: now,
      });
    } catch (error) {
      if (isAuthorityIdentityConflict(error)) throw authorityIdentityConflict();
      throw error;
    }
    return apiJson({ approvalAuthority: { ...current, ...patch }, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Approval authority could not be changed.");
  }
}

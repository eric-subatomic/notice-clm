import { and, desc, eq, inArray, notExists } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { approvalLaneAuthorities, users, workspaceGroupMembers, workspaceGroups, workspaceMemberships } from "../../../../../db/schema";
import { authorizeApiRequest } from "../../../../lib/api";
import { executeEnterpriseMutation, enterpriseRouteError, parseEnterpriseListQuery } from "../../../../lib/enterprise-api";
import { assertExpectedVersion, EnterpriseError, isUniqueConstraintError, omitEnterpriseProperties } from "../../../../lib/enterprise-domain";
import { workspaceGroupPatchSchema, workspaceGroupPostSchema } from "../../../../lib/enterprise-validation";
import { apiJson } from "../../../../lib/http";
import { parseJson } from "../../../../lib/validation";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    const query = parseEnterpriseListQuery(request);
    await ensureStorageSchema();
    const db = getDb();
    const conditions = [eq(workspaceGroups.workspaceId, auth.context.workspace.id)];
    if (query.id) conditions.push(eq(workspaceGroups.id, query.id));
    if (query.status === "active" || query.status === "disabled") conditions.push(eq(workspaceGroups.status, query.status));
    else if (query.status) throw new EnterpriseError(400, "invalid_query", "Unsupported group status.");
    const groups = await db.select().from(workspaceGroups).where(and(...conditions))
      .orderBy(desc(workspaceGroups.updatedAt)).limit(query.limit);
    const groupIds = groups.map((group) => group.id);
    const members = groupIds.length === 0 ? [] : await db.select({
      workspaceId: workspaceGroupMembers.workspaceId, groupId: workspaceGroupMembers.groupId,
      userId: workspaceGroupMembers.userId, source: workspaceGroupMembers.source,
      displayName: users.displayName, email: users.email, createdAt: workspaceGroupMembers.createdAt,
    }).from(workspaceGroupMembers).innerJoin(users, eq(users.id, workspaceGroupMembers.userId))
      .where(and(
        eq(workspaceGroupMembers.workspaceId, auth.context.workspace.id),
        inArray(workspaceGroupMembers.groupId, groupIds),
      )).limit(Math.min(query.limit * 5, 500));
    return apiJson({ groups, members, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "Workspace groups could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, workspaceGroupPostSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const now = new Date().toISOString();
    if (input.action === "create_group") {
      const group = {
        id: crypto.randomUUID(), workspaceId: auth.context.workspace.id, version: 1, name: input.name,
        description: input.description, externalProvider: input.externalProvider ?? null, externalId: input.externalId ?? null,
        status: "active" as const, createdByUserId: auth.context.user.id, createdAt: now,
        updatedByUserId: auth.context.user.id, updatedAt: now,
      };
      try {
        await executeEnterpriseMutation(db, {
          workspaceId: group.workspaceId, actor: auth.context.user, type: "WorkspaceGroupCreated",
          detail: { action: "workspace_group.created", groupId: group.id, version: 1 },
          steps: [{ statement: db.insert(workspaceGroups).values(group) }], createdAt: now,
        });
      } catch (error) {
        if (isUniqueConstraintError(error, ["workspace_groups.workspace_id", "workspace_groups.name"])) {
          throw new EnterpriseError(409, "workspace_group_exists", "A group with that name already exists in this workspace.");
        }
        if (isUniqueConstraintError(error, ["workspace_groups.workspace_id", "workspace_groups.external_provider", "workspace_groups.external_id"])) {
          throw new EnterpriseError(409, "workspace_group_external_exists", "That external group identity is already linked in this workspace.");
        }
        throw error;
      }
      return apiJson({ group, requestId: auth.requestId }, { status: 201, requestId: auth.requestId, headers: auth.headers });
    }

    const [group] = await db.select().from(workspaceGroups).where(and(
      eq(workspaceGroups.workspaceId, auth.context.workspace.id), eq(workspaceGroups.id, input.groupId),
    )).limit(1);
    if (!group || group.status !== "active") throw new EnterpriseError(404, "active_group_not_found", "An active workspace group was not found.");
    assertExpectedVersion(group.version, input.groupVersion);
    const [member] = await db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId)).where(and(
        eq(workspaceMemberships.workspaceId, group.workspaceId), eq(workspaceMemberships.userId, input.userId),
        eq(workspaceMemberships.status, "active"), eq(users.status, "active"),
      )).limit(1);
    if (!member) throw new EnterpriseError(422, "active_member_required", "The selected user is not an active member of this workspace.");
    const [existing] = await db.select().from(workspaceGroupMembers).where(and(
      eq(workspaceGroupMembers.workspaceId, group.workspaceId), eq(workspaceGroupMembers.groupId, group.id),
      eq(workspaceGroupMembers.userId, input.userId),
    )).limit(1);
    if (existing) throw new EnterpriseError(409, "group_member_exists", "That user is already a member of this group.");
    try {
      await executeEnterpriseMutation(db, {
        workspaceId: group.workspaceId, actor: auth.context.user, type: "WorkspaceGroupMemberAdded",
        detail: { action: "workspace_group.member_added", groupId: group.id, userId: input.userId, version: group.version + 1 },
        steps: [
          { statement: db.insert(workspaceGroupMembers).values({
            workspaceId: group.workspaceId, groupId: group.id, userId: input.userId, source: "manual",
            createdByUserId: auth.context.user.id, createdAt: now,
          }) },
          { statement: db.update(workspaceGroups).set({ version: group.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now }).where(and(
            eq(workspaceGroups.workspaceId, group.workspaceId), eq(workspaceGroups.id, group.id), eq(workspaceGroups.version, group.version), eq(workspaceGroups.status, "active"),
          )), guardOperation: "workspace-group.member-add" },
        ], createdAt: now,
      });
    } catch (error) {
      if (isUniqueConstraintError(error, ["workspace_group_members.workspace_id", "workspace_group_members.group_id", "workspace_group_members.user_id"])) {
        throw new EnterpriseError(409, "group_member_exists", "That user is already a member of this group.");
      }
      throw error;
    }
    return apiJson({ membership: { groupId: group.id, userId: input.userId, source: "manual" }, groupVersion: group.version + 1, requestId: auth.requestId }, {
      status: 201, requestId: auth.requestId, headers: auth.headers,
    });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The workspace group mutation could not be completed.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 60 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, workspaceGroupPatchSchema, 12_000);
    await ensureStorageSchema();
    const db = getDb();
    const groupId = input.action === "update_group" ? input.id : input.groupId;
    const expectedVersion = input.action === "update_group" ? input.version : input.groupVersion;
    const [group] = await db.select().from(workspaceGroups).where(and(
      eq(workspaceGroups.workspaceId, auth.context.workspace.id), eq(workspaceGroups.id, groupId),
    )).limit(1);
    if (!group) throw new EnterpriseError(404, "workspace_group_not_found", "Workspace group was not found.");
    assertExpectedVersion(group.version, expectedVersion);
    const now = new Date().toISOString();

    if (input.action === "update_group") {
      if (input.status === "disabled") {
        const [authority] = await db.select({ id: approvalLaneAuthorities.id }).from(approvalLaneAuthorities).where(and(
          eq(approvalLaneAuthorities.workspaceId, group.workspaceId), eq(approvalLaneAuthorities.subjectType, "group"),
          eq(approvalLaneAuthorities.subjectId, group.id), eq(approvalLaneAuthorities.status, "active"),
        )).limit(1);
        if (authority) throw new EnterpriseError(409, "group_has_active_authority", "Revoke this group's approval authority before disabling it.");
      }
      const changes = omitEnterpriseProperties(input, ["action", "id", "version"]);
      const saved = { ...group, ...changes, version: group.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now };
      await executeEnterpriseMutation(db, {
        workspaceId: group.workspaceId, actor: auth.context.user, type: "WorkspaceGroupUpdated",
        detail: { action: "workspace_group.updated", groupId: group.id, previousVersion: group.version, version: saved.version },
        steps: [{ statement: db.update(workspaceGroups).set({ ...changes, version: saved.version, updatedByUserId: saved.updatedByUserId, updatedAt: now }).where(and(
          eq(workspaceGroups.workspaceId, group.workspaceId), eq(workspaceGroups.id, group.id), eq(workspaceGroups.version, group.version),
          input.status === "disabled" ? notExists(db.select({ id: approvalLaneAuthorities.id }).from(approvalLaneAuthorities).where(and(
            eq(approvalLaneAuthorities.workspaceId, group.workspaceId),
            eq(approvalLaneAuthorities.subjectType, "group"),
            eq(approvalLaneAuthorities.subjectId, group.id),
            eq(approvalLaneAuthorities.status, "active"),
          )).limit(1)) : undefined,
        )), guardOperation: "workspace-group.update" }], createdAt: now,
      });
      return apiJson({ group: saved, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
    }

    const [membership] = await db.select().from(workspaceGroupMembers).where(and(
      eq(workspaceGroupMembers.workspaceId, group.workspaceId), eq(workspaceGroupMembers.groupId, group.id),
      eq(workspaceGroupMembers.userId, input.userId),
    )).limit(1);
    if (!membership) throw new EnterpriseError(404, "group_member_not_found", "Group membership was not found.");
    if (membership.source === "scim") throw new EnterpriseError(409, "scim_membership_managed", "SCIM-managed membership must be changed in the identity provider.");
    await executeEnterpriseMutation(db, {
      workspaceId: group.workspaceId, actor: auth.context.user, type: "WorkspaceGroupMemberRemoved",
      detail: { action: "workspace_group.member_removed", groupId: group.id, userId: input.userId, reason: input.reason, version: group.version + 1 },
      steps: [
        { statement: db.delete(workspaceGroupMembers).where(and(
          eq(workspaceGroupMembers.workspaceId, group.workspaceId), eq(workspaceGroupMembers.groupId, group.id),
          eq(workspaceGroupMembers.userId, input.userId), eq(workspaceGroupMembers.source, "manual"),
        )), guardOperation: "workspace-group.member-remove" },
        { statement: db.update(workspaceGroups).set({ version: group.version + 1, updatedByUserId: auth.context.user.id, updatedAt: now }).where(and(
          eq(workspaceGroups.workspaceId, group.workspaceId), eq(workspaceGroups.id, group.id), eq(workspaceGroups.version, group.version),
        )), guardOperation: "workspace-group.member-version" },
      ], createdAt: now,
    });
    return apiJson({ removed: true, groupId: group.id, userId: input.userId, groupVersion: group.version + 1, requestId: auth.requestId }, {
      requestId: auth.requestId, headers: auth.headers,
    });
  } catch (error) {
    return enterpriseRouteError(error, auth.requestId, auth.headers, "The workspace group could not be updated.");
  }
}

import { and, asc, eq, exists, isNull, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  approvalLaneAuthorities,
  users,
  workspaceGroupMembers,
  workspaceGroups,
  workspaceMemberships,
  type WorkspaceRole,
} from "../../db/schema";
import { formatMoney } from "./money";

type Database = ReturnType<typeof getDb>;

export type ApprovalAuthorityBasis = Readonly<{
  workspaceId: string;
  lane: string;
  userId: string;
  role: WorkspaceRole;
  currencyCode: string;
  amountMinor: number;
}>;

export type ApprovalAuthorityEvaluation = Readonly<{
  configured: boolean;
  authorized: boolean;
  source: "direct" | "group" | "legacy_default" | "none";
  authorityId: string | null;
  blocker: Readonly<{ code: "approval_lane_authority_required"; message: string }> | null;
}>;

function legacyLaneAuthorized(lane: string, role: WorkspaceRole): boolean {
  if (lane === "Legal") return role === "admin" || role === "legal";
  if (lane === "Finance") return role === "admin" || role === "approver";
  return role === "admin";
}

function activeWorkspaceMemberQuery(db: Database, basis: ApprovalAuthorityBasis) {
  return db.select({ userId: workspaceMemberships.userId }).from(workspaceMemberships)
    .innerJoin(users, and(
      eq(users.id, workspaceMemberships.userId),
      eq(users.status, "active"),
    )).where(and(
      eq(workspaceMemberships.workspaceId, basis.workspaceId),
      eq(workspaceMemberships.userId, basis.userId),
      eq(workspaceMemberships.status, "active"),
      eq(workspaceMemberships.role, basis.role),
    )).limit(1);
}

/**
 * Resolve one approval lane against explicit direct/group authority. Existing
 * workspaces retain a narrow role-based compatibility default only until the
 * first authority record (active or revoked) is configured for that lane.
 */
export async function evaluateApprovalLaneAuthority(
  db: Database,
  basis: ApprovalAuthorityBasis,
): Promise<ApprovalAuthorityEvaluation> {
  const [configured] = await db.select({ id: approvalLaneAuthorities.id }).from(approvalLaneAuthorities).where(and(
    eq(approvalLaneAuthorities.workspaceId, basis.workspaceId),
    eq(approvalLaneAuthorities.lane, basis.lane),
  )).limit(1);
  if (!configured) {
    const [activeMember] = await activeWorkspaceMemberQuery(db, basis);
    const authorized = Boolean(activeMember) && legacyLaneAuthorized(basis.lane, basis.role);
    return {
      configured: false,
      authorized,
      source: authorized ? "legacy_default" : "none",
      authorityId: null,
      blocker: authorized ? null : {
        code: "approval_lane_authority_required",
        message: `You do not have authority for the ${basis.lane} approval lane.`,
      },
    };
  }

  const [direct] = await db.select({ id: approvalLaneAuthorities.id }).from(approvalLaneAuthorities)
    .innerJoin(workspaceMemberships, and(
      eq(workspaceMemberships.workspaceId, approvalLaneAuthorities.workspaceId),
      eq(workspaceMemberships.userId, basis.userId),
      eq(workspaceMemberships.status, "active"),
      eq(workspaceMemberships.role, basis.role),
    )).innerJoin(users, and(
      eq(users.id, workspaceMemberships.userId),
      eq(users.status, "active"),
    )).where(and(
    eq(approvalLaneAuthorities.workspaceId, basis.workspaceId),
    eq(approvalLaneAuthorities.lane, basis.lane),
    eq(approvalLaneAuthorities.status, "active"),
    eq(approvalLaneAuthorities.subjectType, "user"),
    eq(approvalLaneAuthorities.subjectId, basis.userId),
    eq(approvalLaneAuthorities.currencyCode, basis.currencyCode),
    or(
      isNull(approvalLaneAuthorities.amountLimitMinor),
      lte(sqlAmount(basis.amountMinor), approvalLaneAuthorities.amountLimitMinor),
    ),
    )).orderBy(asc(approvalLaneAuthorities.id)).limit(1);
  if (direct) {
    return { configured: true, authorized: true, source: "direct", authorityId: direct.id, blocker: null };
  }

  const [group] = await db.select({ id: approvalLaneAuthorities.id }).from(approvalLaneAuthorities)
    .innerJoin(workspaceGroupMembers, and(
      eq(workspaceGroupMembers.workspaceId, approvalLaneAuthorities.workspaceId),
      eq(workspaceGroupMembers.groupId, approvalLaneAuthorities.subjectId),
      eq(workspaceGroupMembers.userId, basis.userId),
    )).innerJoin(workspaceGroups, and(
      eq(workspaceGroups.workspaceId, approvalLaneAuthorities.workspaceId),
      eq(workspaceGroups.id, approvalLaneAuthorities.subjectId),
      eq(workspaceGroups.status, "active"),
    )).innerJoin(workspaceMemberships, and(
      eq(workspaceMemberships.workspaceId, approvalLaneAuthorities.workspaceId),
      eq(workspaceMemberships.userId, basis.userId),
      eq(workspaceMemberships.status, "active"),
      eq(workspaceMemberships.role, basis.role),
    )).innerJoin(users, and(
      eq(users.id, workspaceMemberships.userId),
      eq(users.status, "active"),
    )).where(and(
      eq(approvalLaneAuthorities.workspaceId, basis.workspaceId),
      eq(approvalLaneAuthorities.lane, basis.lane),
      eq(approvalLaneAuthorities.status, "active"),
      eq(approvalLaneAuthorities.subjectType, "group"),
      eq(approvalLaneAuthorities.currencyCode, basis.currencyCode),
      or(
        isNull(approvalLaneAuthorities.amountLimitMinor),
        lte(sqlAmount(basis.amountMinor), approvalLaneAuthorities.amountLimitMinor),
      ),
    )).orderBy(asc(approvalLaneAuthorities.id)).limit(1);
  if (group) {
    return { configured: true, authorized: true, source: "group", authorityId: group.id, blocker: null };
  }

  return {
    configured: true,
    authorized: false,
    source: "none",
    authorityId: null,
    blocker: {
      code: "approval_lane_authority_required",
      message: `Your current authority does not cover the ${basis.lane} lane for ${formatMoney(basis.amountMinor, basis.currencyCode)}.`,
    },
  };
}

/** Commit-time equivalent of evaluateApprovalLaneAuthority. The compatibility
 * branch is selected only when no authority record exists for the lane. */
export function approvalLaneAuthorityCommitPredicate(
  db: Database,
  basis: ApprovalAuthorityBasis,
): SQL {
  const activeMember = activeWorkspaceMemberQuery(db, basis);
  const anyConfigured = db.select({ id: approvalLaneAuthorities.id }).from(approvalLaneAuthorities).where(and(
    eq(approvalLaneAuthorities.workspaceId, basis.workspaceId),
    eq(approvalLaneAuthorities.lane, basis.lane),
  )).limit(1);
  const activeMatch = db.select({ id: approvalLaneAuthorities.id }).from(approvalLaneAuthorities).where(and(
    eq(approvalLaneAuthorities.workspaceId, basis.workspaceId),
    eq(approvalLaneAuthorities.lane, basis.lane),
    eq(approvalLaneAuthorities.status, "active"),
    eq(approvalLaneAuthorities.currencyCode, basis.currencyCode),
    or(
      isNull(approvalLaneAuthorities.amountLimitMinor),
      lte(sqlAmount(basis.amountMinor), approvalLaneAuthorities.amountLimitMinor),
    ),
    or(
      and(
        eq(approvalLaneAuthorities.subjectType, "user"),
        eq(approvalLaneAuthorities.subjectId, basis.userId),
      ),
      and(
        eq(approvalLaneAuthorities.subjectType, "group"),
        exists(db.select({ groupId: workspaceGroupMembers.groupId }).from(workspaceGroupMembers)
          .innerJoin(workspaceGroups, and(
            eq(workspaceGroups.workspaceId, workspaceGroupMembers.workspaceId),
            eq(workspaceGroups.id, workspaceGroupMembers.groupId),
            eq(workspaceGroups.status, "active"),
          )).where(and(
            eq(workspaceGroupMembers.workspaceId, basis.workspaceId),
            eq(workspaceGroupMembers.userId, basis.userId),
            eq(workspaceGroupMembers.groupId, approvalLaneAuthorities.subjectId),
          )).limit(1)),
      ),
    ),
  )).limit(1);
  return and(
    exists(activeMember),
    or(
      and(sqlBoolean(legacyLaneAuthorized(basis.lane, basis.role)), notExists(anyConfigured)),
      exists(activeMatch),
    ),
  )!;
}

function sqlAmount(value: number) {
  return sql`${value}`;
}

function sqlBoolean(value: boolean) {
  return sql`${value ? 1 : 0} = 1`;
}

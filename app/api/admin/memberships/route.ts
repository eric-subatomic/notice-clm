import { and, desc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../db";
import { ensureStorageSchema } from "../../../../db/ensure";
import { agreements, mutationGuards, obligationSchedules, obligations, outboxEvents, users, workspaceEvents, workspaceMemberships, workspaceRoles } from "../../../../db/schema";
import { authorizeApiRequest, handleRouteError } from "../../../lib/api";
import { apiError, apiJson } from "../../../lib/http";
import {
  normalizeVerifiedDisplayName,
  normalizeVerifiedEmail,
  normalizeVerifiedSubject,
} from "../../../lib/identity";
import { prepareIntegrationOutboxEvent } from "../../../lib/integration-events";
import { isMutationGuardConflict, prepareOutboxEvent, prepareWorkspaceEvent } from "../../../lib/persistence";
import { parseJson } from "../../../lib/validation";

const verifiedEmailSchema = z.string().refine(
  (value) => normalizeVerifiedEmail(value) !== null,
  "A bounded verified email address is required.",
).transform((value) => normalizeVerifiedEmail(value)!);

const verifiedDisplayNameSchema = z.string().refine(
  (value) => normalizeVerifiedDisplayName(value) !== null,
  "A bounded display name without control or bidirectional formatting characters is required.",
).transform((value) => normalizeVerifiedDisplayName(value)!);

const inviteSchema = z.object({
  email: verifiedEmailSchema,
  displayName: verifiedDisplayNameSchema,
  role: z.enum(workspaceRoles),
});

const accessUpdateSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(workspaceRoles),
  status: z.enum(["active", "disabled"]),
}).strict();

const identityReplacementSchema = z.object({
  action: z.literal("replace_identity"),
  userId: z.string().uuid(),
  confirmationEmail: verifiedEmailSchema,
  newIdentitySubject: z.string().refine(
    (value) => normalizeVerifiedSubject(value) !== null,
    "The replacement identity subject must be an exact bounded identifier without whitespace or control characters.",
  ),
}).strict();

const updateSchema = z.union([accessUpdateSchema, identityReplacementSchema]);
const OBLIGATION_OWNER_ROLES = ["admin", "legal", "approver", "requester"] as const;

async function ownedObligationCounts(db: ReturnType<typeof getDb>, workspaceId: string, userId: string) {
  const [[scheduleCount], [occurrenceCount]] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(obligationSchedules).innerJoin(agreements, and(
      eq(agreements.workspaceId, obligationSchedules.workspaceId),
      eq(agreements.id, obligationSchedules.agreementId),
      isNull(agreements.deletedAt),
    )).where(and(
      eq(obligationSchedules.workspaceId, workspaceId),
      eq(obligationSchedules.ownerUserId, userId),
      inArray(obligationSchedules.status, ["active", "paused"]),
    )),
    db.select({ count: sql<number>`count(*)` }).from(obligations).innerJoin(agreements, and(
      eq(agreements.workspaceId, obligations.workspaceId),
      eq(agreements.id, obligations.agreementId),
      isNull(agreements.deletedAt),
    )).where(and(
      eq(obligations.workspaceId, workspaceId),
      eq(obligations.ownerUserId, userId),
      eq(obligations.status, "Open"),
    )),
  ]);
  return {
    schedules: Number(scheduleCount?.count ?? 0),
    openOccurrences: Number(occurrenceCount?.count ?? 0),
  };
}

function ownedObligationsError(requestId: string, counts: { schedules: number; openOccurrences: number }): Response {
  return apiError(
    "owned_obligations_require_reassignment",
    `Reassign ${counts.schedules} active or paused schedule(s) and ${counts.openOccurrences} open occurrence(s) before removing this member's obligation-owner eligibility.`,
    { status: 409, requestId },
  );
}

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin");
  if (!auth.ok) return auth.response;
  try {
    await ensureStorageSchema();
    const db = getDb();
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        identityProvider: users.identityProvider,
        userStatus: users.status,
        role: workspaceMemberships.role,
        membershipStatus: workspaceMemberships.status,
        createdAt: workspaceMemberships.createdAt,
        lastSeenAt: users.lastSeenAt,
      })
      .from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(eq(workspaceMemberships.workspaceId, auth.context.workspace.id));
    const recentEvents = await db.select().from(workspaceEvents).where(
      eq(workspaceEvents.workspaceId, auth.context.workspace.id),
    ).orderBy(desc(workspaceEvents.sequence)).limit(50);
    return apiJson({ members: rows, recentEvents, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Workspace members could not be loaded.");
  }
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 20 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, inviteSchema, 16_000);
    await ensureStorageSchema();
    const db = getDb();
    const now = new Date().toISOString();
    let [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
    let pendingUser: typeof users.$inferSelect | null = null;
    if (!user) {
      const userId = crypto.randomUUID();
      pendingUser = {
        id: userId,
        identityProvider: "pending-email",
        identitySubject: input.email,
        email: input.email,
        displayName: input.displayName,
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      };
      user = pendingUser;
    }

    const membership = {
      workspaceId: auth.context.workspace.id,
      userId: user.id,
      role: input.role,
      status: "active",
      createdAt: now,
      updatedAt: now,
    } as const;
    const assigningIneligibleObligationRole = !OBLIGATION_OWNER_ROLES.includes(
      input.role as (typeof OBLIGATION_OWNER_ROLES)[number],
    );
    if (assigningIneligibleObligationRole) {
      const counts = await ownedObligationCounts(db, auth.context.workspace.id, user.id);
      if (counts.schedules > 0 || counts.openOccurrences > 0) {
        return ownedObligationsError(auth.requestId, counts);
      }
    }
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "Membership",
      detail: `Granted ${input.role} workspace access to ${input.email}.`,
      actor: auth.context.user,
      subjectUserId: user.id,
      subjectEmail: input.email,
      createdAt: now,
    });
    const outbox = prepareOutboxEvent(prepareIntegrationOutboxEvent({
      workspaceId: auth.context.workspace.id,
      topic: "notification.workspace_access",
      aggregateType: "workspace_membership",
      aggregateId: user.id,
      payload: {
        workspaceId: auth.context.workspace.id,
        role: input.role,
        recipient: { userId: user.id, email: user.email, displayName: user.displayName },
        causationId: auth.requestId,
      },
    }));
    const membershipWrite = db.insert(workspaceMemberships).values(membership).onConflictDoUpdate({
      target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      set: { role: input.role, status: "active", updatedAt: now },
      ...(assigningIneligibleObligationRole ? {
        setWhere: and(
          notExists(db.select({ id: obligationSchedules.id }).from(obligationSchedules).innerJoin(agreements, and(
            eq(agreements.workspaceId, obligationSchedules.workspaceId),
            eq(agreements.id, obligationSchedules.agreementId),
            isNull(agreements.deletedAt),
          )).where(and(
            eq(obligationSchedules.workspaceId, auth.context.workspace.id),
            eq(obligationSchedules.ownerUserId, user.id),
            inArray(obligationSchedules.status, ["active", "paused"]),
          ))),
          notExists(db.select({ id: obligations.id }).from(obligations).innerJoin(agreements, and(
            eq(agreements.workspaceId, obligations.workspaceId),
            eq(agreements.id, obligations.agreementId),
            isNull(agreements.deletedAt),
          )).where(and(
            eq(obligations.workspaceId, auth.context.workspace.id),
            eq(obligations.ownerUserId, user.id),
            eq(obligations.status, "Open"),
          ))),
        ),
      } : {}),
    });
    const guardId = crypto.randomUUID();
    try {
      if (pendingUser) {
        await db.batch([
          db.insert(users).values(pendingUser),
          membershipWrite,
          db.insert(mutationGuards).values({
            id: guardId,
            workspaceId: auth.context.workspace.id,
            operation: "membership.invite",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
          db.insert(workspaceEvents).values(event),
          db.insert(outboxEvents).values(outbox),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, auth.context.workspace.id),
            eq(mutationGuards.id, guardId),
          )),
        ]);
      } else {
        await db.batch([
          membershipWrite,
          db.insert(mutationGuards).values({
            id: guardId,
            workspaceId: auth.context.workspace.id,
            operation: "membership.invite",
            guardChanges: sql<number>`changes()`,
            createdAt: now,
          }),
          db.insert(workspaceEvents).values(event),
          db.insert(outboxEvents).values(outbox),
          db.delete(mutationGuards).where(and(
            eq(mutationGuards.workspaceId, auth.context.workspace.id),
            eq(mutationGuards.id, guardId),
          )),
        ]);
      }
    } catch (error) {
      if (isLastActiveAdminError(error)) return lastAdminError(auth.requestId);
      if (isMutationGuardConflict(error)) {
        if (assigningIneligibleObligationRole) {
          const counts = await ownedObligationCounts(db, auth.context.workspace.id, user.id);
          if (counts.schedules > 0 || counts.openOccurrences > 0) {
            return ownedObligationsError(auth.requestId, counts);
          }
        }
        return apiError("membership_basis_changed", "Workspace membership changed while access was granted. Reload before retrying.", {
          status: 409,
          requestId: auth.requestId,
        });
      }
      throw error;
    }
    return apiJson({
      member: { userId: user.id, email: user.email, displayName: user.displayName, role: input.role, status: "active" },
      requestId: auth.requestId,
    }, { status: 201, requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Workspace member could not be invited.");
  }
}

export async function PATCH(request: Request) {
  const auth = await authorizeApiRequest(request, "workspace:admin", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const input = await parseJson(request, updateSchema, 16_000);
    await ensureStorageSchema();
    const db = getDb();
    const [current] = await db.select().from(workspaceMemberships).where(and(
      eq(workspaceMemberships.workspaceId, auth.context.workspace.id),
      eq(workspaceMemberships.userId, input.userId),
    )).limit(1);
    if (!current) return apiError("member_not_found", "Workspace member was not found.", { status: 404, requestId: auth.requestId });

    if ("action" in input) {
      if (input.userId === auth.context.user.id) {
        return apiError("identity_replacement_self_forbidden", "A different administrator must replace this identity.", {
          status: 409,
          requestId: auth.requestId,
        });
      }
      if (current.status !== "disabled") {
        return apiError("identity_replacement_requires_disabled_member", "Disable this workspace member before replacing its identity.", {
          status: 409,
          requestId: auth.requestId,
        });
      }

      const [subject] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
      if (!subject) {
        return apiError("member_not_found", "Workspace member was not found.", { status: 404, requestId: auth.requestId });
      }
      if (subject.email !== input.confirmationEmail) {
        return apiError("identity_confirmation_mismatch", "The confirmation email does not match this workspace member.", {
          status: 409,
          requestId: auth.requestId,
        });
      }
      const [otherWorkspaceMembership] = await db.select({ workspaceId: workspaceMemberships.workspaceId })
        .from(workspaceMemberships)
        .where(and(
          eq(workspaceMemberships.userId, input.userId),
          ne(workspaceMemberships.workspaceId, auth.context.workspace.id),
        )).limit(1);
      if (otherWorkspaceMembership) {
        return apiError("identity_replacement_shared_account", "This account belongs to another workspace and cannot be replaced from this workspace.", {
          status: 409,
          requestId: auth.requestId,
        });
      }

      const [actor] = await db.select({ identityProvider: users.identityProvider }).from(users)
        .where(eq(users.id, auth.context.user.id)).limit(1);
      if (!actor || actor.identityProvider === "pending-email") {
        return apiError("identity_provider_unavailable", "The administrator identity provider could not be verified.", {
          status: 409,
          requestId: auth.requestId,
        });
      }
      const [conflict] = await db.select({ id: users.id }).from(users).where(and(
        eq(users.identityProvider, actor.identityProvider),
        eq(users.identitySubject, input.newIdentitySubject),
      )).limit(1);
      if (conflict && conflict.id !== subject.id) {
        return apiError("identity_already_assigned", "That verified identity is already assigned to another account.", {
          status: 409,
          requestId: auth.requestId,
        });
      }

      const now = new Date().toISOString();
      const event = await prepareWorkspaceEvent(db, {
        workspaceId: auth.context.workspace.id,
        type: "MembershipIdentity",
        detail: `Replaced the disabled member identity using provider ${actor.identityProvider}; workspace access remains disabled.`,
        actor: auth.context.user,
        subjectUserId: subject.id,
        subjectEmail: subject.email,
        createdAt: now,
      });
      const guardId = crypto.randomUUID();
      try {
        await db.batch([
          db.update(users).set({
            identityProvider: actor.identityProvider,
            identitySubject: input.newIdentitySubject,
            updatedAt: now,
          }).where(and(
            eq(users.id, subject.id),
            eq(users.identityProvider, subject.identityProvider),
            eq(users.identitySubject, subject.identitySubject),
            sql`exists (
              select 1 from workspace_memberships as identity_current
              where identity_current.user_id = ${subject.id}
                and identity_current.workspace_id = ${auth.context.workspace.id}
                and identity_current.status = 'disabled'
            )`,
            sql`not exists (
              select 1 from workspace_memberships as identity_other
              where identity_other.user_id = ${subject.id}
                and identity_other.workspace_id <> ${auth.context.workspace.id}
            )`,
          )),
          db.insert(mutationGuards).values({
            id: guardId,
            workspaceId: auth.context.workspace.id,
            operation: "membership.replace_identity",
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
          return apiError("identity_replacement_precondition_changed", "The member's workspace access changed during recovery. Reload and verify every precondition again.", {
            status: 409,
            requestId: auth.requestId,
          });
        }
        throw error;
      }
      return apiJson({
        member: {
          userId: subject.id,
          email: subject.email,
          identityProvider: actor.identityProvider,
          status: "disabled",
        },
        requestId: auth.requestId,
      }, { requestId: auth.requestId, headers: auth.headers });
    }

    const removesAdmin = current.role === "admin" && (input.role !== "admin" || input.status !== "active");
    if (removesAdmin) {
      const [result] = await db.select({ count: sql<number>`count(*)` }).from(workspaceMemberships).where(and(
        eq(workspaceMemberships.workspaceId, auth.context.workspace.id),
        eq(workspaceMemberships.role, "admin"),
        eq(workspaceMemberships.status, "active"),
      ));
      if (Number(result?.count ?? 0) <= 1) {
        return apiError("last_admin", "Add another active administrator before removing this administrator.", { status: 409, requestId: auth.requestId });
      }
    }

    const losesObligationEligibility = input.status !== "active"
      || !OBLIGATION_OWNER_ROLES.includes(input.role as (typeof OBLIGATION_OWNER_ROLES)[number]);
    if (losesObligationEligibility) {
      const counts = await ownedObligationCounts(db, auth.context.workspace.id, input.userId);
      if (counts.schedules > 0 || counts.openOccurrences > 0) {
        return ownedObligationsError(auth.requestId, counts);
      }
    }

    const now = new Date().toISOString();
    const membershipWrite = db.update(workspaceMemberships).set({ role: input.role, status: input.status, updatedAt: now }).where(and(
      eq(workspaceMemberships.workspaceId, auth.context.workspace.id),
      eq(workspaceMemberships.userId, input.userId),
      eq(workspaceMemberships.role, current.role),
      eq(workspaceMemberships.status, current.status),
      ...(losesObligationEligibility ? [
        notExists(db.select({ id: obligationSchedules.id }).from(obligationSchedules).innerJoin(agreements, and(
          eq(agreements.workspaceId, obligationSchedules.workspaceId),
          eq(agreements.id, obligationSchedules.agreementId),
          isNull(agreements.deletedAt),
        )).where(and(
          eq(obligationSchedules.workspaceId, auth.context.workspace.id),
          eq(obligationSchedules.ownerUserId, input.userId),
          inArray(obligationSchedules.status, ["active", "paused"]),
        ))),
        notExists(db.select({ id: obligations.id }).from(obligations).innerJoin(agreements, and(
          eq(agreements.workspaceId, obligations.workspaceId),
          eq(agreements.id, obligations.agreementId),
          isNull(agreements.deletedAt),
        )).where(and(
          eq(obligations.workspaceId, auth.context.workspace.id),
          eq(obligations.ownerUserId, input.userId),
          eq(obligations.status, "Open"),
        ))),
      ] : []),
    ));
    const [subject] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
    const event = await prepareWorkspaceEvent(db, {
      workspaceId: auth.context.workspace.id,
      type: "Membership",
      detail: `Changed workspace access from ${current.role}/${current.status} to ${input.role}/${input.status}.`,
      actor: auth.context.user,
      subjectUserId: input.userId,
      subjectEmail: subject?.email ?? null,
      createdAt: now,
    });
    const guardId = crypto.randomUUID();
    try {
      await db.batch([
        membershipWrite,
        db.insert(mutationGuards).values({
          id: guardId,
          workspaceId: auth.context.workspace.id,
          operation: "membership.update",
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
      if (isLastActiveAdminError(error)) return lastAdminError(auth.requestId);
      if (isMutationGuardConflict(error)) {
        if (losesObligationEligibility) {
          const counts = await ownedObligationCounts(db, auth.context.workspace.id, input.userId);
          if (counts.schedules > 0 || counts.openOccurrences > 0) {
            return ownedObligationsError(auth.requestId, counts);
          }
        }
        return apiError("membership_basis_changed", "Workspace membership changed while access was updated. Reload before retrying.", {
          status: 409,
          requestId: auth.requestId,
        });
      }
      throw error;
    }
    return apiJson({ member: { userId: input.userId, role: input.role, status: input.status }, requestId: auth.requestId }, {
      requestId: auth.requestId,
      headers: auth.headers,
    });
  } catch (error) {
    return handleRouteError(error, auth.requestId, "Workspace member could not be updated.");
  }
}

function isLastActiveAdminError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).toLowerCase().includes("last_active_admin");
}

function lastAdminError(requestId: string): Response {
  return apiError("last_admin", "Add another active administrator before removing this administrator.", { status: 409, requestId });
}

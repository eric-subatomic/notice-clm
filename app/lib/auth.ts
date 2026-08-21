import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { ensureStorageSchema } from "../../db/ensure";
import {
  users,
  workspaceEvents,
  workspaceMemberships,
  workspaceRoles,
  workspaces,
  type WorkspaceRole,
} from "../../db/schema";
import {
  getNoticeConfig,
  isBootstrapAdmin,
  type NoticeConfig,
} from "./config";
import {
  NoticeAuthError,
  permissionsForRole,
  type Permission,
  type PermissionContext,
} from "./authorization";
import {
  CloudflareAccessIdentityError,
  verifyCloudflareAccessIdentity,
} from "./cloudflare-access";
import {
  InvalidVerifiedIdentityError,
  readTrustedHeaderIdentity,
} from "./identity";
import { isLoopbackRequestUrl } from "./deployment-values";
import { isWorkspaceEventSequenceConflict, prepareWorkspaceEvent } from "./persistence";

export {
  assertWorkspaceScope,
  auditAttribution,
  NoticeAuthError,
  permissions,
  permissionsForRole,
  workspaceRecord,
} from "./authorization";
export type {
  AuthErrorCode,
  IdentitySource,
  Permission,
  PermissionContext,
} from "./authorization";

const IDENTITY_PROVIDER = "trusted-edge";

type RequestIdentity = Readonly<{
  provider: string;
  subject: string;
  email: string;
  displayName: string;
  source: PermissionContext["identitySource"];
}>;

function trustedIdentity(headers: Headers): RequestIdentity | null {
  let identity;
  try {
    identity = readTrustedHeaderIdentity(headers);
  } catch (error) {
    if (!(error instanceof InvalidVerifiedIdentityError)) throw error;
    throw new NoticeAuthError(401, "IDENTITY_INVALID", "The trusted identity headers are incomplete or invalid.");
  }
  if (!identity) return null;

  return Object.freeze({
    provider: IDENTITY_PROVIDER,
    ...identity,
    source: "trusted-headers",
  });
}

export function isLocalEvaluationRequest(request: Request): boolean {
  return isLoopbackRequestUrl(request.url);
}

async function requestIdentity(request: Request, config: NoticeConfig): Promise<RequestIdentity> {
  if (config.mode === "evaluation" && config.evaluationIdentity) {
    if (!isLocalEvaluationRequest(request)) {
      throw new NoticeAuthError(403, "EVALUATION_LOCAL_ONLY", "Evaluation mode is available only on a loopback development origin.");
    }
    return Object.freeze({
      provider: "notice-evaluation",
      subject: config.evaluationIdentity.subject,
      email: config.evaluationIdentity.email,
      displayName: config.evaluationIdentity.displayName,
      source: "evaluation",
    });
  }
  if (config.authMode === "cloudflare-access") {
    if (!config.cloudflareAccess) {
      throw new NoticeAuthError(401, "IDENTITY_INVALID", "Cloudflare Access identity configuration is incomplete.");
    }
    try {
      const identity = await verifyCloudflareAccessIdentity(request, config.cloudflareAccess);
      return Object.freeze({ ...identity, source: "cloudflare-access" });
    } catch (error) {
      if (error instanceof CloudflareAccessIdentityError && error.code === "TOKEN_MISSING") {
        throw new NoticeAuthError(401, "AUTHENTICATION_REQUIRED", "Sign in through Cloudflare Access to use Notice.");
      }
      throw new NoticeAuthError(401, "IDENTITY_INVALID", "The Cloudflare Access identity assertion is invalid.");
    }
  }

  if (config.authMode === "trusted-headers") {
    const trusted = trustedIdentity(request.headers);
    if (trusted) return trusted;
  }
  throw new NoticeAuthError(401, "AUTHENTICATION_REQUIRED", "Sign in to access Notice.");
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (workspaceRoles as readonly string[]).includes(value);
}

async function ensureWorkspace(config: NoticeConfig, canBootstrap: boolean) {
  const db = getDb();
  let [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, config.workspace.id)).limit(1);
  if (!workspace && canBootstrap) {
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: config.workspace.id,
      slug: config.workspace.slug,
      name: config.workspace.name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, config.workspace.id)).limit(1);
  }
  if (!workspace || workspace.status !== "active") {
    throw new NoticeAuthError(403, "WORKSPACE_DISABLED", "This Notice workspace is unavailable.");
  }
  return workspace;
}

async function resolveUser(identity: RequestIdentity, canBootstrap: boolean) {
  const db = getDb();
  let [user] = await db.select().from(users).where(and(
    eq(users.identityProvider, identity.provider),
    eq(users.identitySubject, identity.subject),
  )).limit(1);

  // Administrators invite by verified email before the user has a provider
  // subject. The first verified identity request binds that pending record once;
  // a record already bound to a different provider subject is never rebound.
  if (!user) {
    const [pending] = await db.select().from(users).where(and(
      eq(users.email, identity.email),
      eq(users.identityProvider, "pending-email"),
    )).limit(1);
    if (pending) {
      const now = new Date().toISOString();
      const bound = await db.update(users).set({
        identityProvider: identity.provider,
        identitySubject: identity.subject,
        displayName: identity.displayName,
        updatedAt: now,
        lastSeenAt: now,
      }).where(and(
        eq(users.id, pending.id),
        eq(users.identityProvider, "pending-email"),
        eq(users.identitySubject, identity.email),
      ));
      if (bound.meta.changes) {
        user = {
          ...pending,
          identityProvider: identity.provider,
          identitySubject: identity.subject,
          displayName: identity.displayName,
          updatedAt: now,
          lastSeenAt: now,
        };
      } else {
        // A concurrent first sign-in may have won the one-time bind. Accept it
        // only when it bound this exact verified provider subject.
        [user] = await db.select().from(users).where(and(
          eq(users.identityProvider, identity.provider),
          eq(users.identitySubject, identity.subject),
        )).limit(1);
      }
    }
  }

  if (!user && canBootstrap) {
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: crypto.randomUUID(),
      identityProvider: identity.provider,
      identitySubject: identity.subject,
      email: identity.email,
      displayName: identity.displayName,
      status: "active",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }).onConflictDoNothing();
    [user] = await db.select().from(users).where(and(
      eq(users.identityProvider, identity.provider),
      eq(users.identitySubject, identity.subject),
    )).limit(1);
  }

  if (!user) {
    throw new NoticeAuthError(403, "MEMBERSHIP_REQUIRED", "Your account is not a member of this workspace.");
  }
  if (user.status !== "active") {
    throw new NoticeAuthError(403, "ACCOUNT_DISABLED", "This Notice account is disabled.");
  }

  const now = new Date().toISOString();
  await db.update(users).set({
    email: identity.email,
    displayName: identity.displayName,
    updatedAt: now,
    lastSeenAt: now,
  }).where(eq(users.id, user.id));
  return { ...user, email: identity.email, displayName: identity.displayName, updatedAt: now, lastSeenAt: now };
}

function isWorkspaceMembershipConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("unique constraint failed")
    && message.includes("workspace_memberships.workspace_id")
    && message.includes("workspace_memberships.user_id");
}

async function resolveMembership(
  workspaceId: string,
  user: typeof users.$inferSelect,
  canBootstrap: boolean,
) {
  const db = getDb();
  let [membership] = await db.select().from(workspaceMemberships).where(and(
    eq(workspaceMemberships.workspaceId, workspaceId),
    eq(workspaceMemberships.userId, user.id),
  )).limit(1);

  if (!membership && canBootstrap) {
    for (let attempt = 0; attempt < 4 && !membership; attempt += 1) {
      const now = new Date().toISOString();
      const event = await prepareWorkspaceEvent(db, {
        workspaceId,
        type: "MembershipBootstrap",
        detail: `Granted initial administrator workspace access to ${user.email}.`,
        actor: user,
        subjectUserId: user.id,
        subjectEmail: user.email,
        createdAt: now,
      });
      try {
        await db.batch([
          db.insert(workspaceMemberships).values({
            workspaceId,
            userId: user.id,
            role: "admin",
            status: "active",
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(workspaceEvents).values(event),
        ]);
      } catch (error) {
        if (!isWorkspaceEventSequenceConflict(error) && !isWorkspaceMembershipConflict(error)) throw error;
      }
      [membership] = await db.select().from(workspaceMemberships).where(and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, user.id),
      )).limit(1);
    }
  }

  if (!membership || membership.status !== "active" || !isWorkspaceRole(membership.role)) {
    throw new NoticeAuthError(403, "MEMBERSHIP_REQUIRED", "Your account is not an active workspace member.");
  }
  return membership;
}

/**
 * Resolves verified edge identity, workspace membership, and role permissions.
 * Production auto-provisioning is limited to emails explicitly present in
 * NOTICE_BOOTSTRAP_ADMIN_EMAILS. All other users require a pre-existing active user and
 * membership created by a trusted administration path.
 */
export async function getPermissionContext(request: Request): Promise<PermissionContext> {
  const config = getNoticeConfig();
  const identity = await requestIdentity(request, config);
  const canBootstrap = config.mode === "evaluation" || isBootstrapAdmin(config, identity.email);

  await ensureStorageSchema();
  const workspace = await ensureWorkspace(config, canBootstrap);
  const user = await resolveUser(identity, canBootstrap);
  const membership = await resolveMembership(workspace.id, user, canBootstrap);
  const granted = permissionsForRole(membership.role);

  return Object.freeze({
    mode: config.mode,
    identitySource: identity.source,
    workspace: Object.freeze({ id: workspace.id, slug: workspace.slug, name: workspace.name }),
    user: Object.freeze({ id: user.id, email: user.email, displayName: user.displayName }),
    role: membership.role,
    permissions: granted,
  });
}

export async function requirePermission(request: Request, permission: Permission): Promise<PermissionContext> {
  const context = await getPermissionContext(request);
  if (!context.permissions.has(permission)) {
    throw new NoticeAuthError(403, "PERMISSION_DENIED", "You do not have permission to perform this action.");
  }
  return context;
}

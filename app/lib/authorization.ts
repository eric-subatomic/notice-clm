import type { WorkspaceRole } from "../../db/schema";
import type { NoticeMode } from "./notice-config";

export const permissions = [
  "workspace:admin",
  "agreement:read",
  "agreement:create",
  "agreement:update",
  "risk:assess",
  "risk:waive",
  "approval:read",
  "approval:request",
  "approval:decide",
  "obligation:read",
  "obligation:write",
  "obligation:fulfill",
  "language:read",
  "language:write",
  "document:read",
  "document:upload",
  "document:manage",
  "audit:read",
  "audit:append",
  "notification:send",
  "integration:manage",
  "agent:read",
  "agent:admin",
] as const;

export type Permission = (typeof permissions)[number];

const rolePermissions: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  admin: new Set(permissions),
  legal: new Set([
    "agreement:read",
    "agreement:create",
    "agreement:update",
    "risk:assess",
    "approval:read",
    "approval:request",
    "approval:decide",
    "obligation:read",
    "obligation:write",
    "obligation:fulfill",
    "language:read",
    "language:write",
    "document:read",
    "document:upload",
    "document:manage",
    "audit:read",
    "audit:append",
    "notification:send",
    "agent:read",
  ]),
  approver: new Set([
    "agreement:read",
    "approval:read",
    "approval:decide",
    "obligation:read",
    "obligation:fulfill",
    "document:read",
    "audit:read",
    "audit:append",
    "agent:read",
  ]),
  requester: new Set([
    "agreement:read",
    "agreement:create",
    "approval:read",
    "approval:request",
    "obligation:read",
    "obligation:fulfill",
    "language:read",
    "document:read",
    "document:upload",
    "audit:read",
    "audit:append",
    "agent:read",
  ]),
  viewer: new Set([
    "agreement:read",
    "approval:read",
    "obligation:read",
    "language:read",
    "document:read",
    "audit:read",
    "agent:read",
  ]),
};

export type IdentitySource = "cloudflare-access" | "trusted-headers" | "evaluation";

export type PermissionContext = Readonly<{
  mode: NoticeMode;
  identitySource: IdentitySource;
  workspace: Readonly<{
    id: string;
    slug: string;
    name: string;
  }>;
  user: Readonly<{
    id: string;
    email: string;
    displayName: string;
  }>;
  role: WorkspaceRole;
  permissions: ReadonlySet<Permission>;
}>;

export type AuthErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "EVALUATION_LOCAL_ONLY"
  | "IDENTITY_INVALID"
  | "ACCOUNT_DISABLED"
  | "WORKSPACE_DISABLED"
  | "MEMBERSHIP_REQUIRED"
  | "PERMISSION_DENIED";

export class NoticeAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NoticeAuthError";
  }
}

export function permissionsForRole(role: WorkspaceRole): ReadonlySet<Permission> {
  return rolePermissions[role];
}

export function assertWorkspaceScope(context: PermissionContext, workspaceId: string): void {
  if (workspaceId !== context.workspace.id) {
    throw new NoticeAuthError(403, "PERMISSION_DENIED", "The requested record is outside this workspace.");
  }
}

export function workspaceRecord<T extends object>(context: PermissionContext, record: T): T & { workspaceId: string } {
  return { ...record, workspaceId: context.workspace.id };
}

/** Server-owned attribution for activity rows; never copy actor fields from a request body. */
export function auditAttribution(context: PermissionContext) {
  return {
    actorUserId: context.user.id,
    actorEmail: context.user.email,
    actor: context.user.displayName,
    createdAt: new Date().toISOString(),
  } as const;
}

import {
  isSafePublicApplicationUrl,
  isValidDeploymentEmail,
  isValidWorkspaceId,
  isValidWorkspaceName,
} from "./deployment-values";

export type NoticeMode = "evaluation" | "production";
export type NoticeAuthMode = "evaluation" | "cloudflare-access" | "trusted-headers";

export type CloudflareAccessConfig = Readonly<{
  teamDomain: string;
  audience: string;
  /** Isolated production-evidence seam; real deployments always derive JWKS from teamDomain. */
  jwksUrl?: string;
}>;

export type NoticeConfig = Readonly<{
  mode: NoticeMode;
  workspace: Readonly<{
    id: string;
    slug: string;
    name: string;
  }>;
  bootstrapAdminEmails: ReadonlySet<string>;
  bootstrapEnabled: boolean;
  authMode: NoticeAuthMode;
  cloudflareAccess: CloudflareAccessConfig | null;
  trustIdentityHeaders: boolean;
  publicBaseUrl: string | null;
  evaluationIdentity: Readonly<{
    subject: string;
    email: string;
    displayName: string;
  }> | null;
}>;

export class NoticeConfigurationError extends Error {
  readonly code = "NOTICE_CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "NoticeConfigurationError";
  }
}

export type NoticeBindings = Readonly<Record<string, unknown>>;

function readBinding(bindings: NoticeBindings, name: string): string | undefined {
  const value = bindings[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeEmail(value: string, variable = "NOTICE_BOOTSTRAP_ADMIN_EMAILS"): string {
  const email = value.trim().toLowerCase();
  if (!isValidDeploymentEmail(email)) {
    throw new NoticeConfigurationError(`Invalid or placeholder email address in ${variable}.`);
  }
  return email;
}

function requireWorkspaceId(value: string | undefined, variable: string): string {
  if (!value || !isValidWorkspaceId(value)) {
    throw new NoticeConfigurationError(`${variable} must be explicitly set to a safe workspace identifier; placeholders are not allowed.`);
  }
  return value;
}

function requireCloudflareAccessTeamDomain(value: string | undefined): string {
  if (!value) {
    throw new NoticeConfigurationError("NOTICE_ACCESS_TEAM_DOMAIN is required when NOTICE_AUTH_MODE is cloudflare-access.");
  }
  try {
    const url = new URL(value);
    const exactOrigin = url.origin === value.replace(/\/$/, "");
    const validHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/i.test(url.hostname);
    if (
      url.protocol !== "https:"
      || url.port
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
      || !exactOrigin
      || !validHostname
    ) {
      throw new Error("unsafe team domain");
    }
    return url.origin;
  } catch {
    throw new NoticeConfigurationError(
      "NOTICE_ACCESS_TEAM_DOMAIN must be the exact HTTPS origin https://<team>.cloudflareaccess.com without a path, credentials, query, fragment, or port.",
    );
  }
}

function requireCloudflareAccessAudience(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new NoticeConfigurationError("NOTICE_ACCESS_AUDIENCE must be the 64-character hexadecimal AUD tag for this Access application.");
  }
  return value.toLowerCase();
}

function localEvidenceJwksUrl(bindings: NoticeBindings): string | undefined {
  const candidate = readBinding(bindings, "NOTICE_INTERNAL_ACCESS_JWKS_URL");
  if (!candidate) return undefined;
  if (readBinding(bindings, "NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP") !== "local-production-evidence-v1") {
    throw new NoticeConfigurationError("NOTICE_INTERNAL_ACCESS_JWKS_URL is restricted to the isolated local production-evidence harness.");
  }
  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      || url.username
      || url.password
      || url.hash
    ) throw new Error("unsafe local JWKS URL");
    return url.toString();
  } catch {
    throw new NoticeConfigurationError("NOTICE_INTERNAL_ACCESS_JWKS_URL must be a loopback HTTP(S) URL in the isolated evidence harness.");
  }
}

function productionConfig(bindings: NoticeBindings): NoticeConfig {
  const id = requireWorkspaceId(readBinding(bindings, "NOTICE_WORKSPACE_ID"), "NOTICE_WORKSPACE_ID");
  const name = readBinding(bindings, "NOTICE_WORKSPACE_NAME");
  if (!name || !isValidWorkspaceName(name)) {
    throw new NoticeConfigurationError("NOTICE_WORKSPACE_NAME must contain the customer-approved workspace name.");
  }

  const bootstrapSetting = readBinding(bindings, "NOTICE_BOOTSTRAP_ENABLED");
  if (bootstrapSetting !== "true" && bootstrapSetting !== "false") {
    throw new NoticeConfigurationError("NOTICE_BOOTSTRAP_ENABLED must be true or false.");
  }
  const bootstrapEnabled = bootstrapSetting === "true";
  const rawAdminEmails = readBinding(bindings, "NOTICE_BOOTSTRAP_ADMIN_EMAILS") ?? "";
  const bootstrapAdminEmails = new Set(
    rawAdminEmails
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean)
      .map((email) => normalizeEmail(email)),
  );
  if (bootstrapEnabled && bootstrapAdminEmails.size < 2) {
    throw new NoticeConfigurationError("NOTICE_BOOTSTRAP_ADMIN_EMAILS must contain at least two distinct verified administrators.");
  }
  if (!bootstrapEnabled && rawAdminEmails.trim()) {
    throw new NoticeConfigurationError("Clear NOTICE_BOOTSTRAP_ADMIN_EMAILS when NOTICE_BOOTSTRAP_ENABLED is false.");
  }
  const publicBaseUrl = readBinding(bindings, "NOTICE_PUBLIC_BASE_URL");
  if (!publicBaseUrl || !isSafePublicApplicationUrl(publicBaseUrl)) {
    throw new NoticeConfigurationError("NOTICE_PUBLIC_BASE_URL must be an explicit canonical HTTPS origin without a path, credentials, or preview hostname.");
  }
  const authMode = readBinding(bindings, "NOTICE_AUTH_MODE");
  if (authMode !== "cloudflare-access" && authMode !== "trusted-headers") {
    throw new NoticeConfigurationError("NOTICE_AUTH_MODE must be explicitly set to cloudflare-access or trusted-headers in production.");
  }

  const trustIdentityHeaders = readBinding(bindings, "NOTICE_TRUST_IDENTITY_HEADERS") === "true";
  let cloudflareAccess: CloudflareAccessConfig | null = null;
  if (authMode === "cloudflare-access") {
    if (trustIdentityHeaders) {
      throw new NoticeConfigurationError("NOTICE_TRUST_IDENTITY_HEADERS must be false or unset when NOTICE_AUTH_MODE is cloudflare-access.");
    }
    const jwksUrl = localEvidenceJwksUrl(bindings);
    cloudflareAccess = Object.freeze({
      teamDomain: requireCloudflareAccessTeamDomain(readBinding(bindings, "NOTICE_ACCESS_TEAM_DOMAIN")),
      audience: requireCloudflareAccessAudience(readBinding(bindings, "NOTICE_ACCESS_AUDIENCE")),
      ...(jwksUrl ? { jwksUrl } : {}),
    });
  } else {
    if (!trustIdentityHeaders) {
      throw new NoticeConfigurationError(
        "NOTICE_TRUST_IDENTITY_HEADERS must be true after direct origin access and header spoofing are blocked when NOTICE_AUTH_MODE is trusted-headers.",
      );
    }
    if (readBinding(bindings, "NOTICE_ACCESS_TEAM_DOMAIN") || readBinding(bindings, "NOTICE_ACCESS_AUDIENCE")) {
      throw new NoticeConfigurationError("Clear NOTICE_ACCESS_TEAM_DOMAIN and NOTICE_ACCESS_AUDIENCE when NOTICE_AUTH_MODE is trusted-headers.");
    }
  }

  return Object.freeze({
    mode: "production",
    workspace: Object.freeze({
      id,
      slug: id,
      name,
    }),
    bootstrapAdminEmails,
    bootstrapEnabled,
    authMode,
    cloudflareAccess,
    trustIdentityHeaders,
    publicBaseUrl: new URL(publicBaseUrl).origin,
    evaluationIdentity: null,
  });
}

function evaluationConfig(bindings: NoticeBindings): NoticeConfig {
  const id = requireWorkspaceId(readBinding(bindings, "NOTICE_EVALUATION_WORKSPACE_ID") ?? "evaluation", "NOTICE_EVALUATION_WORKSPACE_ID");
  const email = normalizeEmail(readBinding(bindings, "NOTICE_EVALUATION_EMAIL") ?? "evaluation@notice.local", "NOTICE_EVALUATION_EMAIL");

  return Object.freeze({
    mode: "evaluation",
    workspace: Object.freeze({
      id,
      slug: id,
      name: readBinding(bindings, "NOTICE_EVALUATION_WORKSPACE_NAME") ?? "Notice evaluation",
    }),
    bootstrapAdminEmails: new Set<string>(),
    bootstrapEnabled: false,
    authMode: "evaluation",
    cloudflareAccess: null,
    trustIdentityHeaders: false,
    publicBaseUrl: null,
    evaluationIdentity: Object.freeze({
      subject: readBinding(bindings, "NOTICE_EVALUATION_SUBJECT") ?? "local-evaluation-user",
      email,
      displayName: readBinding(bindings, "NOTICE_EVALUATION_NAME") ?? "Evaluation administrator",
    }),
  });
}

/**
 * Resolve configuration from an explicit binding bag. Keeping this parser free
 * of runtime imports makes the fail-closed policy independently testable.
 */
export function resolveNoticeConfig(bindings: NoticeBindings): NoticeConfig {
  const mode = readBinding(bindings, "NOTICE_APP_MODE") ?? "production";
  if (mode === "evaluation") return evaluationConfig(bindings);
  if (mode === "production") return productionConfig(bindings);
  throw new NoticeConfigurationError("NOTICE_APP_MODE must be either production or evaluation.");
}

export function isBootstrapAdmin(config: NoticeConfig, email: string): boolean {
  return config.mode === "production"
    && config.bootstrapEnabled
    && config.bootstrapAdminEmails.has(email.trim().toLowerCase());
}

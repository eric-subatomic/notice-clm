import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkspaceScope,
  auditAttribution,
  NoticeAuthError,
  permissions,
  permissionsForRole,
  workspaceRecord,
  type PermissionContext,
} from "../app/lib/authorization";
import {
  isBootstrapAdmin,
  NoticeConfigurationError,
  resolveNoticeConfig,
} from "../app/lib/notice-config";
import { isLoopbackRequestUrl } from "../app/lib/deployment-values";

// Access configuration requires the provider's real hostname shape. This unique
// test-only team label is never resolved or contacted by these configuration tests.
const ACCESS_TEAM_ORIGIN = "https://notice-fixture-invalid-iana-org.cloudflareaccess.com";
const credentialedHttpsUrl = (host: string, path = "") =>
  `https://${["user", "password"].join(":")}@${host}${path}`;

test("runtime configuration defaults to production and fails closed when required bindings are absent", () => {
  assert.throws(
    () => resolveNoticeConfig({}),
    (error) => error instanceof NoticeConfigurationError && /NOTICE_WORKSPACE_ID/.test(error.message),
  );
  assert.throws(
    () => resolveNoticeConfig({ NOTICE_APP_MODE: "prodution" }),
    (error) => error instanceof NoticeConfigurationError && /either production or evaluation/.test(error.message),
  );
  assert.throws(
    () => resolveNoticeConfig({
      NOTICE_APP_MODE: "production",
      NOTICE_WORKSPACE_ID: "orchid-firm",
      NOTICE_WORKSPACE_NAME: "Orchid Firm",
      NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
      NOTICE_BOOTSTRAP_ENABLED: "true",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
    }),
    /NOTICE_AUTH_MODE must be explicitly set/,
  );
  assert.throws(
    () => resolveNoticeConfig({
      NOTICE_APP_MODE: "production",
      NOTICE_WORKSPACE_ID: "orchid-firm",
      NOTICE_WORKSPACE_NAME: "Orchid Firm",
      NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
      NOTICE_BOOTSTRAP_ENABLED: "true",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
      NOTICE_AUTH_MODE: "trusted-headers",
    }),
    /NOTICE_TRUST_IDENTITY_HEADERS must be true/,
  );
});

test("production configuration rejects placeholder identities and normalizes the approved bootstrap set", () => {
  const base = {
    NOTICE_APP_MODE: "production",
    NOTICE_WORKSPACE_ID: "orchid-firm",
    NOTICE_WORKSPACE_NAME: "Orchid Firm",
    NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
    NOTICE_BOOTSTRAP_ENABLED: "true",
    NOTICE_AUTH_MODE: "trusted-headers",
    NOTICE_TRUST_IDENTITY_HEADERS: "true",
  } as const;

  assert.throws(
    () => resolveNoticeConfig({
      NOTICE_APP_MODE: "production",
      NOTICE_WORKSPACE_ID: "orchid-firm",
      NOTICE_WORKSPACE_NAME: "Orchid Firm",
      NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test",
      NOTICE_TRUST_IDENTITY_HEADERS: "true",
    }),
    /NOTICE_BOOTSTRAP_ENABLED must be true or false/,
  );

  for (const publicBaseUrl of [
    "http://notice.orchid.test",
    "https://localhost",
    "https://notice.workers.dev",
    "https://notice.pages.dev",
    "https://notice.orchid.test/contracts",
    "https://notice.orchid.test/?preview=true",
    credentialedHttpsUrl("notice.orchid.test"),
    "https://notice.customer.invalid",
  ]) {
    assert.throws(
      () => resolveNoticeConfig({
        ...base,
        NOTICE_PUBLIC_BASE_URL: publicBaseUrl,
        NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
      }),
      /NOTICE_PUBLIC_BASE_URL must be an explicit canonical HTTPS origin/,
      `expected unsafe canonical URL to fail: ${publicBaseUrl}`,
    );
  }

  assert.throws(
    () => resolveNoticeConfig({ ...base, NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@example.com" }),
    /placeholder email address/,
  );
  assert.throws(
    () => resolveNoticeConfig({ ...base, NOTICE_BOOTSTRAP_ADMIN_EMAILS: "verified-admin@customer.invalid" }),
    /placeholder email address/,
  );
  assert.throws(
    () => resolveNoticeConfig({ ...base, NOTICE_BOOTSTRAP_ADMIN_EMAILS: "not-an-email" }),
    /Invalid or placeholder email address/,
  );
  assert.throws(
    () => resolveNoticeConfig({ ...base, NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test" }),
    /at least two distinct verified administrators/,
  );
  assert.throws(
    () => resolveNoticeConfig({
      ...base,
      NOTICE_WORKSPACE_ID: "replace-with-permanent-workspace-id",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
    }),
    /placeholders are not allowed/,
  );
  assert.throws(
    () => resolveNoticeConfig({
      ...base,
      NOTICE_WORKSPACE_ID: "replace-with-another-customer-id",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
    }),
    /placeholders are not allowed/,
  );
  assert.throws(
    () => resolveNoticeConfig({
      ...base,
      NOTICE_WORKSPACE_NAME: "Replace with customer-approved workspace name",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
    }),
    /customer-approved workspace name/,
  );

  const config = resolveNoticeConfig({
    ...base,
    NOTICE_BOOTSTRAP_ADMIN_EMAILS: " Admin@Orchid.test,legal@orchid.test,admin@orchid.test ",
  });
  assert.equal(config.mode, "production");
  assert.equal(config.evaluationIdentity, null);
  assert.equal(config.publicBaseUrl, "https://notice.orchid.test");
  assert.equal(config.bootstrapEnabled, true);
  assert.equal(config.authMode, "trusted-headers");
  assert.equal(config.cloudflareAccess, null);
  assert.deepEqual([...config.bootstrapAdminEmails], ["admin@orchid.test", "legal@orchid.test"]);
  assert.equal(isBootstrapAdmin(config, " ADMIN@ORCHID.TEST "), true);
  assert.equal(isBootstrapAdmin(config, "other@orchid.test"), false);
});

test("production bootstrap elevation can be explicitly retired", () => {
  const config = resolveNoticeConfig({
    NOTICE_APP_MODE: "production",
    NOTICE_WORKSPACE_ID: "orchid-firm",
    NOTICE_WORKSPACE_NAME: "Orchid Firm",
    NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
    NOTICE_AUTH_MODE: "trusted-headers",
    NOTICE_TRUST_IDENTITY_HEADERS: "true",
    NOTICE_BOOTSTRAP_ENABLED: "false",
  });
  assert.equal(config.bootstrapEnabled, false);
  assert.deepEqual([...config.bootstrapAdminEmails], []);
  assert.equal(isBootstrapAdmin(config, "former-admin@orchid.test"), false);
  assert.throws(
    () => resolveNoticeConfig({
      NOTICE_APP_MODE: "production",
      NOTICE_WORKSPACE_ID: "orchid-firm",
      NOTICE_WORKSPACE_NAME: "Orchid Firm",
      NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
      NOTICE_AUTH_MODE: "trusted-headers",
      NOTICE_TRUST_IDENTITY_HEADERS: "true",
      NOTICE_BOOTSTRAP_ENABLED: "false",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: "former-admin@orchid.test",
    }),
    /Clear NOTICE_BOOTSTRAP_ADMIN_EMAILS/,
  );
});

test("Cloudflare Access authentication requires an exact team origin and application audience", () => {
  const audience = "a".repeat(64);
  const base = {
    NOTICE_APP_MODE: "production",
    NOTICE_WORKSPACE_ID: "orchid-firm",
    NOTICE_WORKSPACE_NAME: "Orchid Firm",
    NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
    NOTICE_BOOTSTRAP_ENABLED: "true",
    NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
    NOTICE_AUTH_MODE: "cloudflare-access",
  } as const;

  const config = resolveNoticeConfig({
    ...base,
    NOTICE_ACCESS_TEAM_DOMAIN: `${ACCESS_TEAM_ORIGIN}/`,
    NOTICE_ACCESS_AUDIENCE: audience.toUpperCase(),
  });
  assert.equal(config.authMode, "cloudflare-access");
  assert.equal(config.trustIdentityHeaders, false);
  assert.deepEqual(config.cloudflareAccess, {
    teamDomain: ACCESS_TEAM_ORIGIN,
    audience,
  });

  for (const teamDomain of [
    ACCESS_TEAM_ORIGIN.replace("https://", "http://"),
    `${ACCESS_TEAM_ORIGIN}/certs`,
    ACCESS_TEAM_ORIGIN.replace("https://", "https://user:secret@"),
    ACCESS_TEAM_ORIGIN.replace("https://", "https://nested."),
    "https://orchid.example.com",
  ]) {
    assert.throws(
      () => resolveNoticeConfig({ ...base, NOTICE_ACCESS_TEAM_DOMAIN: teamDomain, NOTICE_ACCESS_AUDIENCE: audience }),
      /NOTICE_ACCESS_TEAM_DOMAIN/,
      `expected unsafe team domain to fail: ${teamDomain}`,
    );
  }

  assert.throws(
    () => resolveNoticeConfig({ ...base, NOTICE_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_ORIGIN, NOTICE_ACCESS_AUDIENCE: "not-an-audience" }),
    /NOTICE_ACCESS_AUDIENCE/,
  );
  assert.throws(
    () => resolveNoticeConfig({
      ...base,
      NOTICE_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_ORIGIN,
      NOTICE_ACCESS_AUDIENCE: audience,
      NOTICE_TRUST_IDENTITY_HEADERS: "true",
    }),
    /must be false or unset/,
  );
});

test("the local Access JWKS seam is unreachable outside the exact loopback evidence harness", () => {
  const base = {
    NOTICE_APP_MODE: "production",
    NOTICE_WORKSPACE_ID: "orchid-firm",
    NOTICE_WORKSPACE_NAME: "Orchid Firm",
    NOTICE_PUBLIC_BASE_URL: "https://notice.orchid.test",
    NOTICE_BOOTSTRAP_ENABLED: "true",
    NOTICE_BOOTSTRAP_ADMIN_EMAILS: "admin@orchid.test,backup-admin@orchid.test",
    NOTICE_AUTH_MODE: "cloudflare-access",
    NOTICE_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_ORIGIN,
    NOTICE_ACCESS_AUDIENCE: "a".repeat(64),
  } as const;

  assert.throws(
    () => resolveNoticeConfig({
      ...base,
      NOTICE_INTERNAL_ACCESS_JWKS_URL: "http://127.0.0.1:9091/access/certs",
    }),
    /restricted to the isolated local production-evidence harness/,
  );
  assert.throws(
    () => resolveNoticeConfig({
      ...base,
      NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP: "local-production-evidence-v1",
      NOTICE_INTERNAL_ACCESS_JWKS_URL: "https://attacker.orchid.test/access/certs",
    }),
    /must be a loopback HTTP\(S\) URL/,
  );

  const config = resolveNoticeConfig({
    ...base,
    NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP: "local-production-evidence-v1",
    NOTICE_INTERNAL_ACCESS_JWKS_URL: "http://127.0.0.1:9091/access/certs",
  });
  assert.equal(config.cloudflareAccess?.jwksUrl, "http://127.0.0.1:9091/access/certs");
});

test("synthetic identity exists only in explicitly selected evaluation mode", () => {
  const config = resolveNoticeConfig({ NOTICE_APP_MODE: "evaluation" });
  assert.equal(config.mode, "evaluation");
  assert.deepEqual(config.evaluationIdentity, {
    subject: "local-evaluation-user",
    email: "evaluation@notice.local",
    displayName: "Evaluation administrator",
  });
  assert.equal(config.trustIdentityHeaders, false);
  assert.equal(config.authMode, "evaluation");
  assert.equal(config.cloudflareAccess, null);
  assert.equal(config.bootstrapEnabled, false);
  assert.equal(config.publicBaseUrl, null);
  assert.equal(isBootstrapAdmin(config, "evaluation@notice.local"), false);
  assert.throws(
    () => resolveNoticeConfig({ NOTICE_APP_MODE: "evaluation", NOTICE_EVALUATION_WORKSPACE_ID: "../unsafe" }),
    /safe workspace identifier/,
  );
});

test("evaluation request URLs are restricted to loopback origins", () => {
  assert.equal(isLoopbackRequestUrl("http://localhost:3000/api/session"), true);
  assert.equal(isLoopbackRequestUrl("http://127.0.0.1:8787/api/session"), true);
  assert.equal(isLoopbackRequestUrl("http://[::1]:8787/api/session"), true);
  assert.equal(isLoopbackRequestUrl("ftp://localhost/evaluation"), false);
  assert.equal(isLoopbackRequestUrl("https://notice.example.com/api/session"), false);
  assert.equal(isLoopbackRequestUrl("not-a-url"), false);
});

test("role permissions preserve least privilege across the five workspace roles", () => {
  assert.deepEqual(new Set(permissionsForRole("admin")), new Set(permissions));
  assert.deepEqual(new Set(permissionsForRole("legal")), new Set([
    "agreement:read", "agreement:create", "agreement:update",
    "risk:assess",
    "approval:read", "approval:request", "approval:decide",
    "obligation:read", "obligation:write", "obligation:fulfill",
    "language:read", "language:write",
    "document:read", "document:upload", "document:manage",
    "audit:read", "audit:append", "notification:send", "agent:read",
  ]));
  assert.deepEqual(new Set(permissionsForRole("approver")), new Set([
    "agreement:read", "approval:read", "approval:decide", "obligation:read", "obligation:fulfill", "document:read", "audit:read", "audit:append", "agent:read",
  ]));
  assert.deepEqual(new Set(permissionsForRole("requester")), new Set([
    "agreement:read", "agreement:create", "approval:read", "approval:request", "obligation:read", "obligation:fulfill", "language:read",
    "document:read", "document:upload", "audit:read", "audit:append", "agent:read",
  ]));
  assert.deepEqual(new Set(permissionsForRole("viewer")), new Set([
    "agreement:read", "approval:read", "obligation:read", "language:read", "document:read", "audit:read", "agent:read",
  ]));

  assert.equal(permissionsForRole("viewer").has("agreement:update"), false);
  assert.equal(permissionsForRole("requester").has("approval:decide"), false);
  assert.equal(permissionsForRole("approver").has("document:upload"), false);
  assert.equal(permissionsForRole("legal").has("workspace:admin"), false);
  assert.equal(permissionsForRole("legal").has("integration:manage"), false);
});

test("tenant scoping and audit attribution override caller-controlled ownership", () => {
  const context: PermissionContext = {
    mode: "production",
    identitySource: "trusted-headers",
    workspace: { id: "orchid-firm", slug: "orchid-firm", name: "Orchid Firm" },
    user: { id: "user-123", email: "legal@orchid.test", displayName: "Orchid Legal" },
    role: "legal",
    permissions: permissionsForRole("legal"),
  };

  assert.doesNotThrow(() => assertWorkspaceScope(context, "orchid-firm"));
  assert.throws(
    () => assertWorkspaceScope(context, "other-firm"),
    (error) => error instanceof NoticeAuthError && error.status === 403 && error.code === "PERMISSION_DENIED",
  );
  assert.deepEqual(
    workspaceRecord(context, { id: "record-1", workspaceId: "caller-selected-workspace" }),
    { id: "record-1", workspaceId: "orchid-firm" },
  );
  const attribution = auditAttribution(context);
  assert.deepEqual(
    { actorUserId: attribution.actorUserId, actorEmail: attribution.actorEmail, actor: attribution.actor },
    { actorUserId: "user-123", actorEmail: "legal@orchid.test", actor: "Orchid Legal" },
  );
  assert.equal(Number.isNaN(Date.parse(attribution.createdAt)), false);
});

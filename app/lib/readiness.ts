import { getIntegrationSummary, type IntegrationId } from "./integration-status";
import { isValidCronSchedule } from "./cron";
import {
  isPlaceholderHostname,
  isProductionSecretValue,
  isSafePublicApplicationUrl,
  isValidDeploymentEmail,
  isValidWorkspaceId,
  isValidWorkspaceName,
} from "./deployment-values";

/**
 * Production-readiness policy for Notice.
 *
 * This module deliberately does not import an application configuration
 * singleton. Route handlers, tests, and future deployment tooling can pass a
 * Cloudflare environment, process.env, or a normalized configuration object.
 * Only non-secret readiness metadata is returned.
 */

export type ReadinessSource = Record<string, unknown>;

export type ReadinessStatus = "pass" | "fail" | "not_required";

export type ReadinessCheck = {
  id: string;
  area: string;
  label: string;
  owner: "maintainer" | "customer";
  required: boolean;
  status: ReadinessStatus;
  message: string;
  remediation?: string;
};

export type ReadinessSection = {
  ready: boolean;
  checks: ReadinessCheck[];
};

export type ProductionReadiness = {
  schemaVersion: "1.0";
  generatedAt: string;
  target: "production";
  appMode: string;
  readyForProduction: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    notRequired: number;
  };
  code: ReadinessSection;
  customer: ReadinessSection;
};

type CodeCapability = {
  id: string;
  area: string;
  label: string;
  ready: boolean;
  message: string;
  remediation: string;
};

/**
 * Stable capability IDs are release gates, not deployment switches.
 *
 * A maintainer should change `ready` only after the implementation and its
 * automated evidence land. Environment variables must never be able to turn a
 * missing code control into a passing check.
 */
export const PRODUCTION_CODE_CAPABILITIES: readonly CodeCapability[] = [
  {
    id: "code.auth.server_enforced",
    area: "identity",
    label: "Server-enforced identity and authorization",
    ready: true,
    message: "Protected pages and APIs enforce verified edge identity, active workspace membership, and action-level role permissions; production fails closed when the trust boundary is incomplete.",
    remediation: "Keep role-matrix and negative-path tests in the release gate whenever protected routes change.",
  },
  {
    id: "code.tenancy.row_authorization",
    area: "tenancy",
    label: "Workspace-scoped row authorization",
    ready: true,
    message: "Every domain record carries workspace ownership, every query is scoped from verified server context, and unassigned legacy rows remain quarantined.",
    remediation: "Keep tenant-isolation checks in the D1 integration suite when new tables or routes are added.",
  },
  {
    id: "code.storage.migration_enforcement",
    area: "storage",
    label: "Reviewed production schema enforcement",
    ready: true,
    message: "Production performs a read-only exact schema-marker check and fails closed when reviewed migrations do not match the application revision; request handling never creates or alters production schema.",
    remediation: "Advance the application schema version and marker in the same reviewed migration, apply it before the application revision, and retain migration evidence.",
  },
  {
    id: "code.api.authoritative_mutations",
    area: "api",
    label: "Validated, authoritative mutations",
    ready: true,
    message: "Mutations use bounded schemas, server-owned identifiers, actors and timestamps, explicit workflow transitions, optimistic versions, durable responses, and visible failures.",
    remediation: "Preserve server ownership and concurrency checks when extending the canonical agreement API.",
  },
  {
    id: "code.documents.safe_ingestion",
    area: "documents",
    label: "Safe document ingestion and versioning",
    ready: true,
    message: "Uploads use content signatures, quarantine and a fail-closed scan bridge; clean artifacts have protected retrieval, immutable R2 content versions, hashes, retention and cleanup.",
    remediation: "Provision and live-test the customer-selected scanning service before attesting production configuration.",
  },
  {
    id: "code.signatures.verified_events",
    area: "e-signature",
    label: "Verified e-signature lifecycle",
    ready: true,
    message: "Packets are created server-side; fresh HMAC-authenticated, replay-safe provider events reconcile status and ingest allowlisted, scanned signed artifacts before activation.",
    remediation: "Provision DocuSeal credentials, webhook delivery and a production scanner, then pass the live diagnostics.",
  },
  {
    id: "code.integrations.secret_backed",
    area: "integrations",
    label: "Secret-backed integration adapters",
    ready: true,
    message: "Secret-backed notification and CRM destinations consume a versioned canonical event contract through independently durable delivery ledgers; the included CRM gateway provides HubSpot, Salesforce, and signed custom-webhook adapters.",
    remediation: "Keep endpoints, OAuth credentials and mapping configuration in managed secrets, and retain live-test plus gateway receipt evidence.",
  },
  {
    id: "code.notifications.reliable_delivery",
    area: "notifications",
    label: "Reliable notifications and scheduled work",
    ready: true,
    message: "Reminders and lifecycle events enter a durable outbox processed by an authenticated scheduled job with locking, stale-lock recovery, bounded retries and dead-letter state.",
    remediation: "Configure the scheduler, delivery gateway and operational alerts before release.",
  },
  {
    id: "code.negotiation.secure_exchange",
    area: "counterparty exchange",
    label: "Secure counterparty draft exchange",
    ready: true,
    message: "Negotiation rounds bind an immutable outbound document hash to expiring portal links or signed per-round email aliases. Round records retain only the token hash; a queued email event carries the scoped URL only while delivery is pending and scrubs it on accepted or dead delivery. Returned files are content-inspected, scanned, quarantined when necessary, and require explicit human promotion before they replace the working version.",
    remediation: "Retain portal-token, inbound-signature, attachment-integrity, quarantine, replay, and human-promotion tests whenever the exchange boundary changes.",
  },
  {
    id: "code.audit.server_attributed",
    area: "audit",
    label: "Server-attributed audit evidence",
    ready: true,
    message: "Actors and time come from verified server context, events form a gap-checked hash chain, decisions and document lineage are preserved, and signed agreement/workspace exports verify integrity.",
    remediation: "Provision the audit signing key and retain exported evidence under the customer evidence policy.",
  },
] as const;

function value(source: ReadinessSource, name: string): string {
  const candidate = source[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function normalized(source: ReadinessSource, name: string): string {
  return value(source, name).toLowerCase();
}

function parseFlag(source: ReadinessSource, name: string): boolean | null {
  const candidate = value(source, name);
  if (candidate === "true") return true;
  if (candidate === "false") return false;
  return null;
}

function validAccessTeamDomain(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.origin === candidate.replace(/\/$/, "")
      && url.protocol === "https:"
      && !url.port
      && !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash
      && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function validAccessAudience(candidate: string): boolean {
  return /^[a-f0-9]{64}$/i.test(candidate);
}

function validInboundEmailDomain(candidate: string): boolean {
  const domain = candidate.trim().toLowerCase().replace(/\.$/, "");
  const reservedSuffixes = [".example", ".invalid", ".local", ".localhost", ".test"];
  const directPlatformSuffixes = ["workers.dev", "pages.dev"];
  const placeholderLabel = /^(?:change-?me|replace(?:-|$)|todo|tbd|unset|your(?:-|$))/;
  if (
    !domain
    || domain !== candidate
    || domain.length > 253
    || !domain.includes(".")
    || isPlaceholderHostname(domain)
    || reservedSuffixes.some((suffix) => domain.endsWith(suffix))
    || directPlatformSuffixes.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))
    || domain.split(".").some((label) => placeholderLabel.test(label))
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)
  ) {
    return false;
  }
  return domain.split(".").every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

function counterpartyExchangeChecks(source: ReadinessSource): ReadinessCheck[] {
  const portalEnabled = parseFlag(source, "NOTICE_COUNTERPARTY_PORTAL_ENABLED");
  const portalTtlValue = value(source, "NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS");
  const portalTtlHours = Number(portalTtlValue);
  const portalTtlValid = /^\d+$/.test(portalTtlValue)
    && Number.isSafeInteger(portalTtlHours)
    && portalTtlHours >= 1
    && portalTtlHours <= 336;
  const negotiationMailAccepted = parseFlag(source, "NOTICE_NEGOTIATION_MAIL_ACCEPTED");
  const deliveryGatewayReady = parseFlag(source, "NOTICE_MAIL_ENABLED") === true
    && value(source, "NOTICE_MAIL_PROVIDER") === "delivery-gateway"
    && parseFlag(source, "NOTICE_MAIL_CONFIGURED") === true;
  const emailEnabled = parseFlag(source, "NOTICE_EMAIL_CAPTURE_ENABLED");
  const emailProvider = normalized(source, "NOTICE_EMAIL_CAPTURE_PROVIDER");
  const emailConfigured = parseFlag(source, "NOTICE_EMAIL_CAPTURE_CONFIGURED");

  const checks: ReadinessCheck[] = [
    check(
      "customer.counterparty_portal.selection",
      "counterparty exchange",
      "Counterparty portal decision",
      portalEnabled === null ? "fail" : "pass",
      portalEnabled === true
        ? "The scoped counterparty portal is explicitly enabled."
        : portalEnabled === false
          ? "The scoped counterparty portal is explicitly disabled; operators must use the reviewed manual exchange path."
          : "NOTICE_COUNTERPARTY_PORTAL_ENABLED must be explicitly set to true or false.",
      "Choose whether counterparties may use expiring scoped upload links; do not rely on an implicit runtime default.",
    ),
    check(
      "customer.counterparty_portal.ttl",
      "counterparty exchange",
      "Counterparty portal expiry",
      portalTtlValid ? "pass" : "fail",
      portalTtlValid
        ? `Portal links expire after the explicitly configured ${portalTtlHours} hour${portalTtlHours === 1 ? "" : "s"}.`
        : "NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS must be an explicit whole number from 1 to 336.",
      "Select the shortest usable expiry for the customer's review process and record it in the deployment manifest.",
    ),
    check(
      "customer.negotiation_mail.acceptance",
      "counterparty exchange",
      "Automated counterparty-delivery acceptance",
      negotiationMailAccepted === null
        ? "fail"
        : negotiationMailAccepted === false || (deliveryGatewayReady && portalEnabled === true)
          ? "pass"
          : "fail",
      negotiationMailAccepted === null
        ? "NOTICE_NEGOTIATION_MAIL_ACCEPTED must be explicitly set to true or false."
        : negotiationMailAccepted === false
          ? "Automated counterparty email is explicitly locked; the reviewed manual-delivery path remains available."
          : deliveryGatewayReady && portalEnabled === true
            ? "Automated counterparty email is separately accepted on the attested delivery gateway and scoped portal."
            : "Automated counterparty email cannot be accepted until the delivery gateway and scoped portal are both ready.",
      "Keep this false for the baseline workflow. Set it true only after retaining negotiation-specific evidence for secure-link rendering, recipient policy, and optional Reply-To behavior.",
    ),
    check(
      "customer.email_capture.selection",
      "counterparty exchange",
      "Inbound email capture decision",
      emailEnabled === null ? "fail" : "pass",
      emailEnabled === true
        ? "Inbound email capture is explicitly enabled."
        : emailEnabled === false
          ? "Inbound email capture is explicitly disabled; portal or reviewed manual exchange remains available."
          : "NOTICE_EMAIL_CAPTURE_ENABLED must be explicitly set to true or false.",
      "Choose whether this deployment will operate the optional signed inbound email gateway.",
    ),
  ];

  if (emailEnabled === null) {
    return [
      ...checks,
      check("customer.email_capture.provider", "counterparty exchange", "Inbound email provider", "not_required", "Select whether inbound email capture is enabled before choosing a provider.", undefined, false),
      check("customer.email_capture.domain", "counterparty exchange", "Inbound email domain", "not_required", "Select whether inbound email capture is enabled before assigning a domain.", undefined, false),
      check("customer.email_capture.secret", "counterparty exchange", "Inbound email signing secret", "not_required", "Select whether inbound email capture is enabled before provisioning a secret.", undefined, false),
      check("customer.email_capture.configured", "counterparty exchange", "Inbound email gateway attestation", "not_required", "Select whether inbound email capture is enabled before attesting a gateway.", undefined, false),
    ];
  }

  if (emailEnabled === false) {
    return [
      ...checks,
      check(
        "customer.email_capture.provider",
        "counterparty exchange",
        "Inbound email provider",
        emailProvider === "none" ? "pass" : "fail",
        emailProvider === "none" ? "No inbound email provider is selected." : "NOTICE_EMAIL_CAPTURE_PROVIDER must be none while inbound email capture is disabled.",
        "Remove stale provider configuration and set the provider to none.",
      ),
      check("customer.email_capture.domain", "counterparty exchange", "Inbound email domain", "not_required", "No inbound domain is required while email capture is disabled.", undefined, false),
      check("customer.email_capture.secret", "counterparty exchange", "Inbound email signing secret", "not_required", "No inbound signing secret is required while email capture is disabled.", undefined, false),
      check(
        "customer.email_capture.configured",
        "counterparty exchange",
        "Inbound email gateway attestation",
        emailConfigured === false ? "pass" : "fail",
        emailConfigured === false ? "The disabled inbound email gateway is explicitly unattested." : "NOTICE_EMAIL_CAPTURE_CONFIGURED must be false while inbound email capture is disabled.",
        "Clear stale attestation before go-live.",
      ),
    ];
  }

  const inboundDomain = value(source, "NOTICE_INBOUND_EMAIL_DOMAIN");
  const inboundSecret = value(source, "NOTICE_INBOUND_EMAIL_SECRET");
  const inboundSecretValid = isProductionSecretValue(inboundSecret)
    && new TextEncoder().encode(inboundSecret).byteLength <= 4_096;
  return [
    ...checks,
    check(
      "customer.email_capture.provider",
      "counterparty exchange",
      "Inbound email provider",
      emailProvider === "inbound-gateway" ? "pass" : "fail",
      emailProvider === "inbound-gateway" ? "The repository-supported inbound-gateway adapter is selected." : "NOTICE_EMAIL_CAPTURE_PROVIDER must be inbound-gateway when email capture is enabled.",
      "Use the documented signed gateway contract, or implement and test a separate adapter before deployment.",
    ),
    check(
      "customer.email_capture.domain",
      "counterparty exchange",
      "Inbound email domain",
      validInboundEmailDomain(inboundDomain) ? "pass" : "fail",
      validInboundEmailDomain(inboundDomain) ? "A real dedicated inbound email domain is configured." : "NOTICE_INBOUND_EMAIL_DOMAIN must be a real lowercase public hostname, not a documentation or placeholder domain.",
      "Provision a dedicated inbound domain and route only generated per-round aliases through the signed gateway.",
    ),
    check(
      "customer.email_capture.secret",
      "counterparty exchange",
      "Inbound email signing secret",
      inboundSecretValid ? "pass" : "fail",
      inboundSecretValid ? "A production-strength inbound email signing secret is present." : "NOTICE_INBOUND_EMAIL_SECRET must be a unique non-placeholder managed secret of 32 to 4096 bytes.",
      "Generate an independent high-entropy secret and store it only in the Notice and inbound-gateway secret managers.",
    ),
    check(
      "customer.email_capture.configured",
      "counterparty exchange",
      "Inbound email gateway attestation",
      emailConfigured === true ? "pass" : "fail",
      emailConfigured === true ? "The inbound email gateway has been explicitly attested after conformance and a harmless round trip." : "NOTICE_EMAIL_CAPTURE_CONFIGURED must be true only after raw-body signature, freshness, alias, attachment, replay, and quarantine checks pass.",
      "Complete gateway conformance and a harmless attachment round trip, retain the evidence, then set the attestation to true.",
    ),
  ];
}

function check(
  id: string,
  area: string,
  label: string,
  status: ReadinessStatus,
  message: string,
  remediation?: string,
  required = true,
): ReadinessCheck {
  return { id, area, label, owner: "customer", required, status, message, remediation };
}

function requiredProviderChecks(
  source: ReadinessSource,
  prefix: "ESIGN" | "MAIL" | "SCAN",
  area: string,
  label: string,
  integrationId: IntegrationId,
  supportedProvider: string,
): ReadinessCheck[] {
  const enabledName = `NOTICE_${prefix}_ENABLED`;
  const providerName = `NOTICE_${prefix}_PROVIDER`;
  const configuredName = `NOTICE_${prefix}_CONFIGURED`;
  const enabled = parseFlag(source, enabledName);
  const provider = value(source, providerName);
  const configured = parseFlag(source, configuredName);
  const slug = prefix.toLowerCase();
  const integration = getIntegrationSummary(source, integrationId);

  return [
    check(
      `customer.${slug}.enabled`,
      area,
      `${label} enabled`,
      enabled === true ? "pass" : "fail",
      enabled === true ? `${label} is explicitly enabled.` : `${enabledName} must be explicitly set to true for production.`,
      `Enable and provision a production ${label.toLowerCase()} service; do not use a demonstration endpoint.`,
    ),
    check(
      `customer.${slug}.provider`,
      area,
      `${label} provider selected`,
      provider === supportedProvider ? "pass" : "fail",
      provider === supportedProvider ? `The repository-supported ${supportedProvider} adapter is selected.` : `${providerName} must be ${supportedProvider}; no other adapter is implemented in this repository.`,
      `Use ${supportedProvider}, or implement and test a separate provider adapter before deployment.`,
    ),
    check(
      `customer.${slug}.configured`,
      area,
      `${label} connection verified`,
      configured === true && integration.configured ? "pass" : "fail",
      integration.detail,
      `Store every required endpoint and credential in deployment configuration, run the live diagnostic, then set ${configuredName}=true.`,
    ),
  ];
}

function crmChecks(source: ReadinessSource): ReadinessCheck[] {
  const enabled = parseFlag(source, "NOTICE_CRM_ENABLED");
  const provider = value(source, "NOTICE_CRM_PROVIDER");
  const configured = parseFlag(source, "NOTICE_CRM_CONFIGURED");
  const integration = getIntegrationSummary(source, "crm");

  if (enabled === null) {
    return [
      check(
        "customer.crm.selection",
        "crm",
        "CRM integration decision",
        "fail",
        "NOTICE_CRM_ENABLED must be explicitly set to true or false.",
        "Choose whether this workspace will synchronize with a CRM.",
      ),
      check("customer.crm.provider", "crm", "CRM provider selected", "not_required", "Select whether CRM synchronization is enabled before configuring a provider.", undefined, false),
      check("customer.crm.configured", "crm", "CRM connection verified", "not_required", "Select whether CRM synchronization is enabled before testing a connection.", undefined, false),
    ];
  }

  if (enabled === false) {
    return [
      check(
        "customer.crm.selection",
        "crm",
        "CRM integration decision",
        "pass",
        "CRM synchronization is explicitly disabled for this workspace.",
        undefined,
        false,
      ),
      check("customer.crm.provider", "crm", "CRM provider selected", "not_required", "No CRM provider is required while CRM synchronization is disabled.", undefined, false),
      check("customer.crm.configured", "crm", "CRM connection verified", "not_required", "No CRM connection is required while CRM synchronization is disabled.", undefined, false),
    ];
  }

  return [
    check(
      "customer.crm.selection",
      "crm",
      "CRM integration decision",
      enabled === true ? "pass" : "fail",
      enabled === true ? "CRM synchronization is explicitly enabled." : "NOTICE_CRM_ENABLED must be explicitly set to true or false.",
      "Choose whether this workspace will synchronize with a CRM.",
    ),
    check(
      "customer.crm.provider",
      "crm",
      "CRM provider selected",
      ["hubspot", "salesforce", "custom"].includes(provider) ? "pass" : "fail",
      ["hubspot", "salesforce", "custom"].includes(provider) ? `The repository-supported ${provider} CRM adapter is selected.` : "NOTICE_CRM_PROVIDER must be hubspot, salesforce, or custom.",
      "Select the included CRM gateway adapter that matches the customer system.",
    ),
    check(
      "customer.crm.configured",
      "crm",
      "CRM connection verified",
      configured === true && integration.configured ? "pass" : "fail",
      configured === true && integration.configured ? "CRM gateway prerequisites are present and the connection has been explicitly attested." : integration.detail,
      "Deploy the included CRM gateway, configure provider credentials and mappings, run the no-side-effect live test, then set NOTICE_CRM_CONFIGURED=true.",
    ),
  ];
}

function customerChecks(source: ReadinessSource): ReadinessCheck[] {
  // Keep these names aligned with app/lib/config.ts. The evaluator remains
  // decoupled so the CLI can inspect process.env without importing Worker-only
  // bindings and the endpoint can report malformed configuration safely.
  const appMode = normalized(source, "NOTICE_APP_MODE");
  const deploymentModel = normalized(source, "NOTICE_DEPLOYMENT_MODEL");
  const workspaceId = normalized(source, "NOTICE_WORKSPACE_ID");
  const workspaceName = value(source, "NOTICE_WORKSPACE_NAME");
  const publicBaseUrl = value(source, "NOTICE_PUBLIC_BASE_URL");
  const bootstrapEnabled = parseFlag(source, "NOTICE_BOOTSTRAP_ENABLED");
  const adminEmails = value(source, "NOTICE_BOOTSTRAP_ADMIN_EMAILS")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const validAdmins = adminEmails.length >= 2
    && new Set(adminEmails).size === adminEmails.length
    && adminEmails.every(isValidDeploymentEmail);
  const bootstrapStateValid = bootstrapEnabled === false && adminEmails.length === 0;
  const authMode = normalized(source, "NOTICE_AUTH_MODE");
  const trustedHeaders = parseFlag(source, "NOTICE_TRUST_IDENTITY_HEADERS");
  const accessReady = validAccessTeamDomain(value(source, "NOTICE_ACCESS_TEAM_DOMAIN"))
    && validAccessAudience(value(source, "NOTICE_ACCESS_AUDIENCE"));
  const outboxCron = value(source, "NOTICE_OUTBOX_CRON");
  const retentionCron = value(source, "NOTICE_RETENTION_CRON");
  const schedulesReady = isValidCronSchedule(outboxCron)
    && isValidCronSchedule(retentionCron)
    && outboxCron !== retentionCron;

  return [
    check(
      "customer.mode.production",
      "deployment",
      "Production application mode",
      appMode === "production" ? "pass" : "fail",
      appMode === "production" ? "NOTICE_APP_MODE is production." : "NOTICE_APP_MODE must be explicitly set to production.",
      "Keep evaluation deployments private; switch modes only after every code and customer check passes.",
    ),
    check(
      "customer.deployment.model",
      "deployment",
      "Deployment responsibility selected",
      deploymentModel === "hosted" || deploymentModel === "self-hosted" ? "pass" : "fail",
      deploymentModel === "hosted" || deploymentModel === "self-hosted" ? `A ${deploymentModel} responsibility model is selected.` : "NOTICE_DEPLOYMENT_MODEL must be hosted or self-hosted.",
      "Choose who operates identity, storage, secrets, jobs, monitoring, backup, and incident response.",
    ),
    check(
      "customer.deployment.public_base_url",
      "deployment",
      "Canonical public application URL",
      isSafePublicApplicationUrl(publicBaseUrl) ? "pass" : "fail",
      isSafePublicApplicationUrl(publicBaseUrl) ? "A safe canonical public URL is configured for metadata and provider redirects." : "NOTICE_PUBLIC_BASE_URL must be an explicit canonical HTTPS origin without a path, credentials, or preview hostname.",
      "Set the protected customer-facing origin; do not use a direct Worker preview or workers.dev origin.",
    ),
    check(
      "customer.workspace.id",
      "workspace",
      "Stable workspace identifier",
      isValidWorkspaceId(workspaceId) ? "pass" : "fail",
      isValidWorkspaceId(workspaceId) ? "A non-placeholder workspace identifier is present." : "NOTICE_WORKSPACE_ID must contain a permanent, non-placeholder identifier of 3–63 lowercase letters, digits, or hyphens and start with a letter or digit.",
      "Assign a permanent identifier before importing records; do not reuse an identifier across customers.",
    ),
    check(
      "customer.workspace.name",
      "workspace",
      "Workspace display name",
      isValidWorkspaceName(workspaceName) ? "pass" : "fail",
      isValidWorkspaceName(workspaceName) ? "A non-placeholder workspace display name is present." : "NOTICE_WORKSPACE_NAME must contain the customer-approved, non-placeholder workspace name.",
      "Set the legal or operating name that administrators expect to see during onboarding.",
    ),
    check(
      "customer.bootstrap.mode",
      "identity",
      "Bootstrap lifecycle selected",
      bootstrapStateValid ? "pass" : "fail",
      bootstrapEnabled === false && adminEmails.length === 0
          ? "Bootstrap elevation is explicitly disabled and no bootstrap email remains configured."
          : bootstrapEnabled === true
            ? "Bootstrap elevation remains enabled for onboarding, so this deployment is not ready for go-live."
            : "NOTICE_BOOTSTRAP_ENABLED must be false and the administrator list empty for go-live.",
      "Enable bootstrap only for initial onboarding; after two durable administrators are verified, set false and clear NOTICE_BOOTSTRAP_ADMIN_EMAILS.",
    ),
    check(
      "customer.bootstrap.admins",
      "identity",
      "Bootstrap administrators",
      bootstrapEnabled === false ? "not_required" : validAdmins ? "pass" : "fail",
      bootstrapEnabled === false ? "Bootstrap elevation is disabled; existing active administrators remain authoritative." : validAdmins ? `${adminEmails.length} distinct bootstrap administrators declared for onboarding.` : "NOTICE_BOOTSTRAP_ADMIN_EMAILS must contain at least two distinct real organizational email addresses while bootstrap is enabled.",
      bootstrapEnabled === false ? undefined : "Use verified organizational accounts, verify at least two durable administrators, then disable bootstrap and clear the list.",
      bootstrapEnabled !== false,
    ),
    check(
      "customer.identity.mode",
      "identity",
      "Production identity mode",
      authMode === "cloudflare-access" || authMode === "trusted-headers" ? "pass" : "fail",
      authMode === "cloudflare-access" || authMode === "trusted-headers" ? `The ${authMode} identity adapter is selected.` : "NOTICE_AUTH_MODE must be cloudflare-access or trusted-headers.",
      "Use Cloudflare Access for common corporate SSO, or the advanced trusted-header mode behind a separately reviewed identity-aware edge.",
    ),
    check(
      "customer.identity.cloudflare_access",
      "identity",
      "Cloudflare Access JWT boundary",
      authMode !== "cloudflare-access" ? "not_required" : accessReady && trustedHeaders !== true ? "pass" : "fail",
      authMode !== "cloudflare-access" ? "Cloudflare Access configuration is not required for the selected identity mode." : accessReady && trustedHeaders !== true ? "An exact Access team origin and application audience are configured; caller identity headers remain untrusted." : "Cloudflare Access requires a safe team origin, 64-character application AUD, and NOTICE_TRUST_IDENTITY_HEADERS=false or unset.",
      authMode !== "cloudflare-access" ? undefined : "Copy the exact Access team domain and application AUD; do not enable compatibility identity headers.",
      authMode === "cloudflare-access",
    ),
    check(
      "customer.identity.trusted_headers",
      "identity",
      "Trusted identity-header boundary",
      authMode !== "trusted-headers" ? "not_required" : trustedHeaders === true ? "pass" : "fail",
      authMode !== "trusted-headers" ? "Trusted identity headers are not used by the selected identity mode." : trustedHeaders === true ? "Canonical identity headers are explicitly trusted for this protected deployment." : "NOTICE_TRUST_IDENTITY_HEADERS must be true for trusted-headers mode.",
      "Confirm the deployment blocks direct origin access and strips caller-supplied identity headers before enabling this flag.",
      authMode === "trusted-headers",
    ),
    ...requiredProviderChecks(source, "ESIGN", "e-signature", "E-signature", "docuseal", "docuseal"),
    ...crmChecks(source),
    ...requiredProviderChecks(source, "MAIL", "notifications", "Mail delivery", "delivery", "delivery-gateway"),
    ...requiredProviderChecks(source, "SCAN", "documents", "Document scanning", "scanner", "scan-gateway"),
    ...counterpartyExchangeChecks(source),
    check(
      "customer.jobs.crons",
      "operations",
      "Native scheduled jobs",
      schedulesReady ? "pass" : "fail",
      schedulesReady ? "Distinct native Cron Triggers are mapped to obligation/outbox delivery and retention jobs." : "NOTICE_OUTBOX_CRON and NOTICE_RETENTION_CRON must be distinct five-field schedules matching the deployed Cron Triggers.",
      "Configure distinct Cron Triggers and keep the matching non-secret schedule values in Worker configuration.",
    ),
    check(
      "customer.jobs.secret",
      "operations",
      "Scheduled-job authentication",
      isProductionSecretValue(value(source, "NOTICE_JOB_RUNNER_SECRET")) ? "pass" : "fail",
      isProductionSecretValue(value(source, "NOTICE_JOB_RUNNER_SECRET")) ? "A production-strength scheduled-job secret is present." : "NOTICE_JOB_RUNNER_SECRET must be supplied as a non-placeholder managed secret of at least 32 characters.",
      "Generate a unique high-entropy secret, store it in the deployment secret manager, and use it only for obligation, outbox, and retention scheduler calls.",
    ),
    check(
      "customer.audit.signing_key",
      "audit",
      "Audit export signing",
      isProductionSecretValue(value(source, "NOTICE_AUDIT_SIGNING_KEY")) ? "pass" : "fail",
      isProductionSecretValue(value(source, "NOTICE_AUDIT_SIGNING_KEY")) ? "A production-strength audit signing key is present." : "NOTICE_AUDIT_SIGNING_KEY must be supplied as a non-placeholder managed secret of at least 32 characters.",
      "Generate and protect a unique signing key so agreement and offboarding exports can be verified independently.",
    ),
  ];
}

function section(checks: ReadinessCheck[]): ReadinessSection {
  return {
    ready: checks.every((item) => !item.required || item.status === "pass"),
    checks,
  };
}

export function evaluateProductionReadiness(
  source: ReadinessSource,
  now = new Date(),
): ProductionReadiness {
  const code = section(PRODUCTION_CODE_CAPABILITIES.map((capability) => ({
    id: capability.id,
    area: capability.area,
    label: capability.label,
    owner: "maintainer" as const,
    required: true,
    status: capability.ready ? "pass" as const : "fail" as const,
    message: capability.message,
    remediation: capability.remediation,
  })));
  const customer = section(customerChecks(source));
  const checks = [...code.checks, ...customer.checks];

  return {
    schemaVersion: "1.0",
    generatedAt: now.toISOString(),
    target: "production",
    appMode: normalized(source, "NOTICE_APP_MODE") || "unset",
    readyForProduction: code.ready && customer.ready,
    summary: {
      total: checks.length,
      passed: checks.filter((item) => item.status === "pass").length,
      failed: checks.filter((item) => item.status === "fail").length,
      notRequired: checks.filter((item) => item.status === "not_required").length,
    },
    code,
    customer,
  };
}

import { z } from "zod";
import {
  isPlaceholderDeploymentValue,
  isPlaceholderHostname,
  isValidDeploymentEmail,
  isValidWorkspaceId,
  isValidWorkspaceName,
} from "../app/lib/deployment-values.ts";
import { isValidCronSchedule } from "../app/lib/cron.ts";
import {
  DOCUSEAL_API_CLIENT_CONTRACT_VERSION,
  DOCUSEAL_MAX_EXPIRATION_HOURS,
  DOCUSEAL_MCP_PROTOCOL_VERSION,
  DOCUSEAL_VALIDATED_RELEASE,
} from "../app/lib/docuseal.ts";
import { isValidCustomerHostedOcrIdentifier } from "../app/lib/document-security.ts";

export { isValidCronSchedule } from "../app/lib/cron.ts";

export const DEPLOYMENT_MANIFEST_SCHEMA_VERSION = "1.0" as const;
export const DEPLOYMENT_WRANGLER_COMPATIBILITY_DATE = "2026-05-22" as const;

const forbiddenSecretKey = /(?:secret|password|credential|private[-_]?key|api[-_]?(?:key|token)|access[-_]?token|refresh[-_]?token|client[-_]?(?:secret|token)|token$)/i;
const privateMaterial = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
const reservedHostnameSuffixes = [
  ".example",
  ".invalid",
  ".local",
  ".localhost",
  ".test",
] as const;
const directPlatformSuffixes = ["workers.dev", "pages.dev"] as const;
const hostnameLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const placeholderLabelPattern = /^(?:change-?me|replace(?:-|$)|todo|tbd|unset|your(?:-|$))/;
// Keep enough room for Wrangler's longest automatic resource suffix (`-documents`).
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{1,51}[a-z0-9])$/;
const environmentPattern = /^[a-z][a-z0-9-]{1,31}$/;
const accessAudiencePattern = /^[a-f0-9]{64}$/i;
const crmMappingVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const cloudflareAccountIdPattern = /^[a-f0-9]{32}$/;
const sourceRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class DeploymentManifestError extends Error {
  readonly code = "DEPLOYMENT_MANIFEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "DeploymentManifestError";
  }
}

function manifestPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "manifest" : `manifest.${path.map(String).join(".")}`;
}

function rejectSecretMaterial(value: unknown, path: Array<string | number> = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretMaterial(item, [...path, index]));
    return;
  }

  if (typeof value === "string") {
    if (privateMaterial.test(value)) {
      throw new DeploymentManifestError(`${manifestPath(path)} contains private key material. Deployment manifests must never contain secrets.`);
    }
    return;
  }

  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenSecretKey.test(key)) {
      throw new DeploymentManifestError(`${manifestPath([...path, key])} is a secret-bearing field. Put secret values only in the deployment secret store.`);
    }
    rejectSecretMaterial(child, [...path, key]);
  }
}

function isPlaceholderText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return isPlaceholderDeploymentValue(normalized)
    || normalized.includes("<")
    || normalized.includes(">")
    || normalized.includes("${")
    || normalized.startsWith("your-");
}

function isReservedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (isPlaceholderHostname(normalized)) return true;
  if (reservedHostnameSuffixes.some((suffix) => normalized.endsWith(suffix))) return true;
  return normalized.split(".").some((label) => placeholderLabelPattern.test(label));
}

function isValidPublicHostname(hostname: string, allowAccessDomain = false): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (normalized !== hostname || normalized.length > 253 || !normalized.includes(".")) return false;
  if (isReservedHostname(normalized) || normalized.includes(":")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return false;
  if (!allowAccessDomain && directPlatformSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  )) return false;
  return normalized.split(".").every((label) => hostnameLabelPattern.test(label));
}

function canonicalHttpsEndpoint(value: string, originOnly: boolean): string | null {
  try {
    const endpoint = new URL(value.trim());
    const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) return null;
    if (!isValidPublicHostname(hostname, true) || endpoint.hash || endpoint.search) return null;
    if (originOnly && endpoint.pathname !== "/") return null;
    return originOnly ? endpoint.origin : endpoint.toString();
  } catch {
    return null;
  }
}

const environmentSchema = z.string().trim().superRefine((value, context) => {
  if (!environmentPattern.test(value) || isPlaceholderText(value)) {
    context.addIssue({ code: "custom", message: "must be a lowercase environment name of 2-32 letters, digits, or hyphens" });
  }
});

const workerNameSchema = z.string().trim().superRefine((value, context) => {
  if (!workerNamePattern.test(value) || isPlaceholderText(value)) {
    context.addIssue({ code: "custom", message: "must be a non-placeholder lowercase Worker name of 3-63 letters, digits, or hyphens" });
  }
});

const publicHostnameSchema = z.string().trim().superRefine((value, context) => {
  if (!isValidPublicHostname(value)) {
    context.addIssue({ code: "custom", message: "must be a real lowercase public hostname, not a preview, IP, reserved, or placeholder hostname" });
  }
});

const workspaceIdSchema = z.string().trim().superRefine((value, context) => {
  if (!isValidWorkspaceId(value)) {
    context.addIssue({ code: "custom", message: "must be a permanent non-placeholder workspace identifier" });
  }
});

const workspaceNameSchema = z.string().trim().superRefine((value, context) => {
  if (!isValidWorkspaceName(value) || isPlaceholderText(value)) {
    context.addIssue({ code: "custom", message: "must be the customer-approved non-placeholder workspace name" });
  }
});

const deploymentEmailSchema = z.string().trim().transform((value) => value.toLowerCase()).superRefine((value, context) => {
  if (!isValidDeploymentEmail(value)) {
    context.addIssue({ code: "custom", message: "must be a real non-placeholder organizational email address" });
  }
});

const httpsOriginSchema = z.string().trim().transform((value, context) => {
  const endpoint = canonicalHttpsEndpoint(value, true);
  if (!endpoint) {
    context.addIssue({ code: "custom", message: "must be a safe HTTPS origin without credentials, path, query, fragment, or placeholder hostname" });
    return z.NEVER;
  }
  return endpoint;
});

const httpsGatewaySchema = z.string().trim().transform((value, context) => {
  const endpoint = canonicalHttpsEndpoint(value, false);
  if (!endpoint) {
    context.addIssue({ code: "custom", message: "must be a safe HTTPS endpoint without credentials, query, fragment, or placeholder hostname" });
    return z.NEVER;
  }
  return endpoint;
});

const docuSealApiBaseUrlSchema = z.string().trim().transform((value, context) => {
  const endpoint = canonicalHttpsEndpoint(value, false);
  if (!endpoint) {
    context.addIssue({ code: "custom", message: "must be a safe HTTPS DocuSeal API endpoint without credentials, query, fragment, or placeholder hostname" });
    return z.NEVER;
  }
  const parsed = new URL(endpoint);
  if (/%(?:2f|5c)/i.test(parsed.pathname)) {
    context.addIssue({ code: "custom", message: "must not contain encoded path separators" });
    return z.NEVER;
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return pathname === "/" ? parsed.origin : `${parsed.origin}${pathname}`;
});

const bootstrapSchema = z.object({
  enabled: z.boolean(),
  adminEmails: z.array(deploymentEmailSchema).max(20),
}).strict().superRefine((value, context) => {
  const unique = new Set(value.adminEmails);
  if (unique.size !== value.adminEmails.length) {
    context.addIssue({ code: "custom", path: ["adminEmails"], message: "must not contain duplicate email addresses" });
  }
  if (value.enabled && value.adminEmails.length < 2) {
    context.addIssue({ code: "custom", path: ["adminEmails"], message: "must contain at least two distinct verified administrators while bootstrap is enabled" });
  }
  if (!value.enabled && value.adminEmails.length > 0) {
    context.addIssue({ code: "custom", path: ["adminEmails"], message: "must be empty when bootstrap is disabled" });
  }
});

const cloudflareAccessIdentitySchema = z.object({
  mode: z.literal("cloudflare-access"),
  teamDomain: httpsOriginSchema.superRefine((value, context) => {
    const teamDomain = new URL(value);
    const hostname = teamDomain.hostname.toLowerCase();
    if (teamDomain.port || !hostname.endsWith(".cloudflareaccess.com") || hostname === "cloudflareaccess.com" || isReservedHostname(hostname)) {
      context.addIssue({ code: "custom", message: "must be the deployment's exact https://<team>.cloudflareaccess.com origin" });
    }
  }),
  audience: z.string().trim().transform((value) => value.toLowerCase()).superRefine((value, context) => {
    if (!accessAudiencePattern.test(value) || isPlaceholderText(value)) {
      context.addIssue({ code: "custom", message: "must be the non-placeholder 64-character hexadecimal Cloudflare Access application AUD value" });
    }
  }),
}).strict();

const trustedHeadersIdentitySchema = z.object({
  mode: z.literal("trusted-headers"),
}).strict();

const identitySchema = z.discriminatedUnion("mode", [
  cloudflareAccessIdentitySchema,
  trustedHeadersIdentitySchema,
]);

const disabledProviderSchema = z.object({
  enabled: z.literal(false),
  configured: z.literal(false),
}).strict();

const disabledDocuSealMcpSchema = z.object({ enabled: z.literal(false) }).strict();
const enabledDocuSealMcpSchema = z.object({
  enabled: z.literal(true),
  protocolVersion: z.literal(DOCUSEAL_MCP_PROTOCOL_VERSION),
  serverVersion: z.literal(DOCUSEAL_VALIDATED_RELEASE),
}).strict();

const enabledDocuSealSchema = z.object({
  enabled: z.literal(true),
  configured: z.boolean(),
  deployment: z.enum(["cloud-global", "cloud-eu", "self-hosted"]),
  apiBaseUrl: docuSealApiBaseUrlSchema,
  templateId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  validatedRelease: z.literal(DOCUSEAL_VALIDATED_RELEASE),
  apiClientContract: z.literal(DOCUSEAL_API_CLIENT_CONTRACT_VERSION),
  htmlSubmissionsEntitled: z.boolean(),
  expirationHours: z.number().int().min(1).max(DOCUSEAL_MAX_EXPIRATION_HOURS),
  email2faRequired: z.boolean(),
  mcp: z.discriminatedUnion("enabled", [enabledDocuSealMcpSchema, disabledDocuSealMcpSchema]),
}).strict().superRefine((value, context) => {
  const endpoint = new URL(value.apiBaseUrl);
  if (value.deployment === "cloud-global" && value.apiBaseUrl !== "https://api.docuseal.com") {
    context.addIssue({ code: "custom", path: ["apiBaseUrl"], message: "global Cloud must use https://api.docuseal.com" });
  }
  if (value.deployment === "cloud-eu" && value.apiBaseUrl !== "https://api.docuseal.eu") {
    context.addIssue({ code: "custom", path: ["apiBaseUrl"], message: "EU Cloud must use https://api.docuseal.eu" });
  }
  if (value.deployment === "self-hosted") {
    if (["api.docuseal.com", "api.docuseal.eu"].includes(endpoint.hostname)) {
      context.addIssue({ code: "custom", path: ["deployment"], message: "official Cloud origins must use the matching Cloud deployment type" });
    }
    if (!endpoint.pathname.endsWith("/api")) {
      context.addIssue({ code: "custom", path: ["apiBaseUrl"], message: "self-hosted DocuSeal API base URL must end with /api" });
    }
  }
  if (value.mcp.enabled && value.deployment !== "self-hosted") {
    context.addIssue({ code: "custom", path: ["mcp"], message: "MCP can be enabled only for self-hosted DocuSeal" });
  }
  if (value.configured && !value.htmlSubmissionsEntitled) {
    context.addIssue({ code: "custom", path: ["htmlSubmissionsEntitled"], message: "must be attested before DocuSeal can be marked configured" });
  }
});

const enabledGatewaySchema = z.object({
  enabled: z.literal(true),
  configured: z.boolean(),
  gatewayUrl: httpsGatewaySchema,
}).strict();

const disabledCustomerHostedOcrSchema = z.object({ enabled: z.literal(false) }).strict();
const customerHostedOcrIdentifierSchema = z.string().trim().superRefine((value, context) => {
  if (!isValidCustomerHostedOcrIdentifier(value) || isPlaceholderText(value)) {
    context.addIssue({ code: "custom", message: "must be a bounded non-placeholder model/profile identifier using only the approved identifier characters" });
  }
});
const enabledCustomerHostedOcrSchema = z.object({
  enabled: z.literal(true),
  modelId: customerHostedOcrIdentifierSchema,
  profileId: customerHostedOcrIdentifierSchema,
}).strict();
const customerHostedOcrSchema = z.discriminatedUnion("enabled", [
  enabledCustomerHostedOcrSchema,
  disabledCustomerHostedOcrSchema,
]);
const enabledScannerSchema = enabledGatewaySchema.extend({
  ocr: customerHostedOcrSchema.default({ enabled: false }),
}).strict();

const docuSealSchema = z.discriminatedUnion("enabled", [enabledDocuSealSchema, disabledProviderSchema]);
const gatewaySchema = z.discriminatedUnion("enabled", [enabledGatewaySchema, disabledProviderSchema]);
const scannerSchema = z.discriminatedUnion("enabled", [enabledScannerSchema, disabledProviderSchema]);

const enabledInboundEmailSchema = z.object({
  enabled: z.literal(true),
  configured: z.boolean(),
  provider: z.literal("inbound-gateway"),
  inboundDomain: publicHostnameSchema,
}).strict();

const disabledInboundEmailSchema = z.object({
  enabled: z.literal(false),
  configured: z.literal(false),
  provider: z.literal("none"),
}).strict();

const counterpartyExchangeSchema = z.object({
  automatedDeliveryAccepted: z.boolean(),
  portal: z.object({
    enabled: z.boolean(),
    ttlHours: z.number().int().min(1).max(336),
  }).strict(),
  emailCapture: z.discriminatedUnion("enabled", [enabledInboundEmailSchema, disabledInboundEmailSchema]),
}).strict();

const crmDisabledSchema = z.object({
  provider: z.literal("none"),
}).strict();

const crmEnabledSchema = z.object({
  provider: z.enum(["hubspot", "salesforce", "custom"]),
  mappingVersion: z.string().trim().superRefine((value, context) => {
    if (!crmMappingVersionPattern.test(value) || isPlaceholderText(value)) {
      context.addIssue({ code: "custom", message: "must be a stable non-placeholder CRM mapping version" });
    }
  }),
  configured: z.boolean(),
  gatewayUrl: httpsGatewaySchema,
}).strict();

const crmSchema = z.discriminatedUnion("provider", [crmDisabledSchema, crmEnabledSchema]);

const cronSchema = z.string().trim().transform((value) => value.toLowerCase().replace(/\s+/g, " ")).superRefine((value, context) => {
  if (!isValidCronSchedule(value)) {
    context.addIssue({ code: "custom", message: "must be a five-field Cloudflare cron using the supported *, list, range, and step syntax" });
  }
});

const deploymentManifestSchema = z.object({
  schemaVersion: z.literal(DEPLOYMENT_MANIFEST_SCHEMA_VERSION),
  accountId: z.string().trim().superRefine((value, context) => {
    if (!cloudflareAccountIdPattern.test(value)) {
      context.addIssue({ code: "custom", message: "must be the exact lowercase 32-character hexadecimal Cloudflare account ID" });
    }
  }),
  sourceRevision: z.string().trim().superRefine((value, context) => {
    if (!sourceRevisionPattern.test(value)) {
      context.addIssue({ code: "custom", message: "must be the exact lowercase 40- or 64-character Git source revision" });
    }
  }),
  environment: environmentSchema,
  deploymentModel: z.enum(["hosted", "self-hosted"]),
  workerName: workerNameSchema,
  customDomain: publicHostnameSchema,
  workspace: z.object({
    id: workspaceIdSchema,
    name: workspaceNameSchema,
    bootstrap: bootstrapSchema,
  }).strict(),
  identity: identitySchema,
  docuseal: docuSealSchema,
  scanner: scannerSchema,
  mail: gatewaySchema,
  counterpartyExchange: counterpartyExchangeSchema,
  crm: crmSchema,
  retention: z.object({
    purgeGraceDays: z.number().int().min(7).max(365),
  }).strict(),
  schedules: z.object({
    outbox: cronSchema,
    retention: cronSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.schedules.outbox === value.schedules.retention) {
    context.addIssue({ code: "custom", path: ["schedules"], message: "outbox and retention schedules must be distinct" });
  }
  if (value.counterpartyExchange.automatedDeliveryAccepted && (
    !value.mail.enabled
    || !value.mail.configured
    || !value.counterpartyExchange.portal.enabled
  )) {
    context.addIssue({
      code: "custom",
      path: ["counterpartyExchange", "automatedDeliveryAccepted"],
      message: "can be true only after the mail gateway is attested and the scoped portal is enabled",
    });
  }
});

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;

export type RenderedWranglerConfiguration = ReturnType<typeof renderWranglerConfiguration>;

export type DeploymentPlan = Readonly<{
  schemaVersion: "1.0";
  action: "plan";
  environment: string;
  workerName: string;
  customDomain: string;
  workspaceId: string;
  bootstrap: Readonly<{ enabled: boolean; administratorCount: number }>;
  identityMode: DeploymentManifest["identity"]["mode"];
  integrations: Readonly<{
    docuseal: "disabled" | "awaiting-live-test" | "attested";
    scanner: "disabled" | "awaiting-live-test" | "attested";
    mail: "disabled" | "awaiting-live-test" | "attested";
    negotiationMail: "locked" | "accepted";
    emailCapture: "disabled" | "awaiting-live-test" | "attested";
    crm: "disabled" | "awaiting-live-test" | "attested";
  }>;
  generatedConfig: string;
  requiredSecretNames: readonly string[];
  preconditions: readonly string[];
  nextCommands: readonly string[];
}>;

export function parseDeploymentManifest(input: unknown): DeploymentManifest {
  rejectSecretMaterial(input);
  const result = deploymentManifestSchema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${manifestPath(issue.path)}: ${issue.message}`)
    .sort()
    .join("; ");
  throw new DeploymentManifestError(details);
}

function providerState(provider: { enabled: boolean; configured: boolean }): "disabled" | "awaiting-live-test" | "attested" {
  return !provider.enabled ? "disabled" : provider.configured ? "attested" : "awaiting-live-test";
}

function crmState(crm: DeploymentManifest["crm"]): "disabled" | "awaiting-live-test" | "attested" {
  return crm.provider === "none" ? "disabled" : crm.configured ? "attested" : "awaiting-live-test";
}

export function generatedWranglerPath(manifest: DeploymentManifest): string {
  return `.wrangler/notice-deployment-${manifest.environment}.json`;
}

export function requiredSecretNames(manifest: DeploymentManifest): string[] {
  const names = new Set<string>([
    "NOTICE_AUDIT_SIGNING_KEY",
    "NOTICE_JOB_RUNNER_SECRET",
  ]);
  if (manifest.docuseal.enabled) {
    names.add("NOTICE_DOCUSEAL_API_TOKEN");
    names.add("NOTICE_DOCUSEAL_WEBHOOK_SECRET");
    if (manifest.docuseal.mcp.enabled) names.add("NOTICE_DOCUSEAL_MCP_TOKEN");
  }
  if (manifest.scanner.enabled) names.add("NOTICE_SCAN_GATEWAY_SECRET");
  if (manifest.mail.enabled) names.add("NOTICE_DELIVERY_GATEWAY_SECRET");
  if (manifest.counterpartyExchange.emailCapture.enabled) names.add("NOTICE_INBOUND_EMAIL_SECRET");
  if (manifest.crm.provider !== "none") names.add("NOTICE_CRM_GATEWAY_SECRET");
  return [...names].sort();
}

export function renderWranglerConfiguration(manifest: DeploymentManifest) {
  const vars: Record<string, string> = {
    NOTICE_APP_MODE: "production",
    NOTICE_RELEASE_REVISION: manifest.sourceRevision,
    NOTICE_DEPLOYMENT_MODEL: manifest.deploymentModel,
    NOTICE_PUBLIC_BASE_URL: `https://${manifest.customDomain}`,
    NOTICE_WORKSPACE_ID: manifest.workspace.id,
    NOTICE_WORKSPACE_NAME: manifest.workspace.name,
    NOTICE_BOOTSTRAP_ENABLED: String(manifest.workspace.bootstrap.enabled),
    NOTICE_BOOTSTRAP_ADMIN_EMAILS: [...manifest.workspace.bootstrap.adminEmails].sort().join(","),
    NOTICE_AUTH_MODE: manifest.identity.mode,
    NOTICE_TRUST_IDENTITY_HEADERS: String(manifest.identity.mode === "trusted-headers"),
    NOTICE_ESIGN_ENABLED: String(manifest.docuseal.enabled),
    NOTICE_ESIGN_PROVIDER: manifest.docuseal.enabled ? "docuseal" : "none",
    NOTICE_ESIGN_CONFIGURED: String(manifest.docuseal.configured),
    NOTICE_SCAN_ENABLED: String(manifest.scanner.enabled),
    NOTICE_SCAN_PROVIDER: manifest.scanner.enabled ? "scan-gateway" : "none",
    NOTICE_SCAN_CONFIGURED: String(manifest.scanner.configured),
    NOTICE_SCAN_OCR_ENABLED: String(manifest.scanner.enabled && manifest.scanner.ocr.enabled),
    NOTICE_MAIL_ENABLED: String(manifest.mail.enabled),
    NOTICE_MAIL_PROVIDER: manifest.mail.enabled ? "delivery-gateway" : "none",
    NOTICE_MAIL_CONFIGURED: String(manifest.mail.configured),
    NOTICE_NEGOTIATION_MAIL_ACCEPTED: String(manifest.counterpartyExchange.automatedDeliveryAccepted),
    NOTICE_COUNTERPARTY_PORTAL_ENABLED: String(manifest.counterpartyExchange.portal.enabled),
    NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: String(manifest.counterpartyExchange.portal.ttlHours),
    NOTICE_EMAIL_CAPTURE_ENABLED: String(manifest.counterpartyExchange.emailCapture.enabled),
    NOTICE_EMAIL_CAPTURE_PROVIDER: manifest.counterpartyExchange.emailCapture.provider,
    NOTICE_EMAIL_CAPTURE_CONFIGURED: String(manifest.counterpartyExchange.emailCapture.configured),
    NOTICE_CRM_ENABLED: String(manifest.crm.provider !== "none"),
    NOTICE_CRM_PROVIDER: manifest.crm.provider,
    NOTICE_CRM_CONFIGURED: String(manifest.crm.provider !== "none" && manifest.crm.configured),
    NOTICE_RETENTION_PURGE_GRACE_DAYS: String(manifest.retention.purgeGraceDays),
    NOTICE_OUTBOX_CRON: manifest.schedules.outbox,
    NOTICE_RETENTION_CRON: manifest.schedules.retention,
  };

  if (manifest.identity.mode === "cloudflare-access") {
    vars.NOTICE_ACCESS_TEAM_DOMAIN = manifest.identity.teamDomain;
    vars.NOTICE_ACCESS_AUDIENCE = manifest.identity.audience;
  }
  if (manifest.docuseal.enabled) {
    vars.NOTICE_DOCUSEAL_DEPLOYMENT = manifest.docuseal.deployment;
    vars.NOTICE_DOCUSEAL_API_BASE_URL = manifest.docuseal.apiBaseUrl;
    vars.NOTICE_DOCUSEAL_TEMPLATE_ID = String(manifest.docuseal.templateId);
    vars.NOTICE_DOCUSEAL_VALIDATED_RELEASE = manifest.docuseal.validatedRelease;
    vars.NOTICE_DOCUSEAL_API_CLIENT_CONTRACT = manifest.docuseal.apiClientContract;
    vars.NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED = String(manifest.docuseal.htmlSubmissionsEntitled);
    vars.NOTICE_DOCUSEAL_EXPIRATION_HOURS = String(manifest.docuseal.expirationHours);
    vars.NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED = String(manifest.docuseal.email2faRequired);
    vars.NOTICE_DOCUSEAL_MCP_ENABLED = String(manifest.docuseal.mcp.enabled);
    if (manifest.docuseal.mcp.enabled) {
      vars.NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION = manifest.docuseal.mcp.protocolVersion;
      vars.NOTICE_DOCUSEAL_MCP_SERVER_VERSION = manifest.docuseal.mcp.serverVersion;
    }
  }
  if (manifest.scanner.enabled) {
    vars.NOTICE_SCAN_GATEWAY_URL = manifest.scanner.gatewayUrl;
    if (manifest.scanner.ocr.enabled) {
      vars.NOTICE_SCAN_OCR_MODEL_ID = manifest.scanner.ocr.modelId;
      vars.NOTICE_SCAN_OCR_PROFILE_ID = manifest.scanner.ocr.profileId;
    }
  }
  if (manifest.mail.enabled) vars.NOTICE_DELIVERY_GATEWAY_URL = manifest.mail.gatewayUrl;
  if (manifest.counterpartyExchange.emailCapture.enabled) {
    vars.NOTICE_INBOUND_EMAIL_DOMAIN = manifest.counterpartyExchange.emailCapture.inboundDomain;
  }
  if (manifest.crm.provider !== "none") {
    vars.NOTICE_CRM_GATEWAY_URL = manifest.crm.gatewayUrl;
    vars.NOTICE_CRM_MAPPING_VERSION = manifest.crm.mappingVersion;
  }

  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    account_id: manifest.accountId,
    name: manifest.workerName,
    main: "../dist/server/index.js",
    compatibility_date: DEPLOYMENT_WRANGLER_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    no_bundle: true,
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: manifest.customDomain, custom_domain: true }],
    assets: {
      directory: "../dist/client",
      not_found_handling: "none",
      binding: "ASSETS",
    },
    d1_databases: [{ binding: "DB", migrations_dir: "../drizzle" }],
    r2_buckets: [{ binding: "DOCUMENTS" }],
    vars,
    secrets: { required: requiredSecretNames(manifest) },
    triggers: { crons: [manifest.schedules.outbox, manifest.schedules.retention] },
    observability: { enabled: true },
  } as const;
}

export function serializeWranglerConfiguration(manifest: DeploymentManifest): string {
  return `${JSON.stringify(renderWranglerConfiguration(manifest), null, 2)}\n`;
}

function quoted(argument: string): string {
  return JSON.stringify(argument);
}

export function createDeploymentPlan(
  manifest: DeploymentManifest,
  sourceManifestPath = `.wrangler/notice.deployment.${manifest.environment}.json`,
): DeploymentPlan {
  const configPath = generatedWranglerPath(manifest);
  const secretFile = `.dev.vars.${manifest.environment}`;
  const healthUrl = `https://${manifest.customDomain}/api/health?mode=ready`;
  return Object.freeze({
    schemaVersion: DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    action: "plan",
    environment: manifest.environment,
    workerName: manifest.workerName,
    customDomain: manifest.customDomain,
    workspaceId: manifest.workspace.id,
    bootstrap: Object.freeze({
      enabled: manifest.workspace.bootstrap.enabled,
      administratorCount: manifest.workspace.bootstrap.adminEmails.length,
    }),
    identityMode: manifest.identity.mode,
    integrations: Object.freeze({
      docuseal: providerState(manifest.docuseal),
      scanner: providerState(manifest.scanner),
      mail: providerState(manifest.mail),
      negotiationMail: manifest.counterpartyExchange.automatedDeliveryAccepted ? "accepted" : "locked",
      emailCapture: providerState(manifest.counterpartyExchange.emailCapture),
      crm: crmState(manifest.crm),
    }),
    generatedConfig: configPath,
    requiredSecretNames: Object.freeze(requiredSecretNames(manifest)),
    preconditions: Object.freeze([
      "This command sequence is only for a confirmed empty environment; existing environments require the reviewed maintenance-window upgrade procedure.",
      "The Cloudflare account, zone, custom domain, and staging/production ownership are approved.",
      manifest.identity.mode === "cloudflare-access"
        ? "A Cloudflare Access self-hosted application protects user routes for this exact hostname; the team domain and AUD match this manifest."
        : "The trusted identity edge blocks direct origin access, strips caller identity headers, and injects only verified canonical identity.",
      "Provider accounts and harmless live-test endpoints are ready; configured=true is used only after a retained passing diagnostic.",
      ...(manifest.docuseal.enabled ? [
        manifest.docuseal.htmlSubmissionsEntitled
          ? `DocuSeal release ${DOCUSEAL_VALIDATED_RELEASE}, API client contract ${DOCUSEAL_API_CLIENT_CONTRACT_VERSION}, and /submissions/html entitlement are explicitly approved; any self-hosted MCP probe remains non-mutating.`
          : "DocuSeal /submissions/html entitlement is not yet attested; confirm Pro or Developer Sandbox access before running or promoting the integration diagnostic.",
      ] : []),
      ...(manifest.scanner.enabled && manifest.scanner.ocr.enabled ? [
        `The scanner gateway resolves only customer-hosted OCR model ${manifest.scanner.ocr.modelId} with profile ${manifest.scanner.ocr.profileId}; it rejects an unavailable or mismatched selection and never falls back to another model or external endpoint.`,
      ] : []),
      manifest.counterpartyExchange.automatedDeliveryAccepted
        ? "The separate automated counterparty-delivery acceptance proves exact secure-link rendering, explicit recipients, no invented attachments, and optional Reply-To behavior."
        : "Automated counterparty delivery remains locked; the accepted operating procedure uses reviewed manual delivery.",
      ...(manifest.counterpartyExchange.portal.enabled ? [
        "The identity edge bypasses interactive user authentication only for /api/exchange/*; the scoped bearer URL is excluded from logs/analytics, and broader API, document, and application paths remain protected.",
      ] : []),
      ...(manifest.counterpartyExchange.emailCapture.enabled ? [
        "The inbound mail gateway computes the lowercase SHA-256 of the exact unmodified request body, signs the documented timestamp-and-digest material, routes only generated round aliases, and has an exact identity-edge bypass for /api/webhooks/email.",
      ] : []),
      ...(manifest.crm.provider === "none" ? [] : [
        "The Notice and CRM gateway manifests select the same provider and mapping version; the signed live diagnostic must prove both values.",
      ]),
      `Every required secret name is populated in the owner-only ignored ${secretFile} file exported from the deployment secret manager; no secret is stored in this manifest.`,
    ]),
    nextCommands: Object.freeze([
      "npm ci",
      "npm test",
      `node --import tsx scripts/deployment-kit.mjs render ${quoted(sourceManifestPath)}`,
      `npm run deploy -- --config ${configPath} --secrets-file ${secretFile} --confirm-empty-environment --confirm-workers-paid-plan`,
      `curl --fail --silent --show-error ${quoted(healthUrl)}`,
    ]),
  });
}

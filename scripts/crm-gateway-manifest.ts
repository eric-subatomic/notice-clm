import { z } from "zod";
import { MAPPABLE_FIELDS, buildFieldMapping } from "../integrations/crm-gateway/src/providers/mapping.ts";
import { isValidCronSchedule } from "./deployment-manifest.ts";

export const CRM_GATEWAY_MANIFEST_SCHEMA_VERSION = "1.0" as const;
export const CRM_GATEWAY_WRANGLER_COMPATIBILITY_DATE = "2026-05-22" as const;

const forbiddenSecretKey = /(?:secret|password|credential|private[-_]?key|api[-_]?(?:key|token)|access[-_]?token|refresh[-_]?token|client[-_]?(?:id|secret|token)|token$)/i;
const privateMaterial = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
// Match the main manifest's resource-safe limit for Wrangler auto-provisioning.
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{1,51}[a-z0-9])$/;
const environmentPattern = /^[a-z][a-z0-9-]{1,31}$/;
const mappingVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const cloudflareAccountIdPattern = /^[a-f0-9]{32}$/;
const sourceRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hostnameLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const placeholderPattern = /(?:^|[-_. ])(?:change[-_ ]?me|example|replace(?:[-_ ]?me)?|placeholder|todo|tbd|unset|your)(?:$|[-_. ])/i;
const reservedHostnameSuffixes = [
  ".example",
  ".invalid",
  ".internal",
  ".local",
  ".localhost",
  ".test",
] as const;
const directPlatformSuffixes = ["workers.dev", "pages.dev"] as const;
const mappableFieldSet = new Set<string>(MAPPABLE_FIELDS);

export class CrmGatewayManifestError extends Error {
  readonly code = "CRM_GATEWAY_MANIFEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CrmGatewayManifestError";
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
      throw new CrmGatewayManifestError(
        `${manifestPath(path)} contains private key material. CRM gateway manifests must never contain secrets.`,
      );
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenSecretKey.test(key)) {
      throw new CrmGatewayManifestError(
        `${manifestPath([...path, key])} is a secret-bearing field. Put secret values only in the deployment secret store.`,
      );
    }
    rejectSecretMaterial(child, [...path, key]);
  }
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0
    || placeholderPattern.test(normalized)
    || normalized.includes("<")
    || normalized.includes(">")
    || normalized.includes("${");
}

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isSafePublicHostname(hostname: string, allowPlatformHostname: boolean): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized.length > 253
    || !normalized.includes(".")
    || normalized.includes(":")
    || isIpv4(normalized)
    || isPlaceholder(normalized)
    || reservedHostnameSuffixes.some((suffix) => normalized.endsWith(suffix))
    || (!allowPlatformHostname && directPlatformSuffixes.some(
      (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
    ))
  ) return false;
  return normalized.split(".").every((label) => hostnameLabelPattern.test(label));
}

function canonicalHttpsEndpoint(
  value: string,
  options: Readonly<{
    originOnly: boolean;
    allowedHostname?: (hostname: string) => boolean;
  }>,
): string | null {
  try {
    const endpoint = new URL(value.trim());
    const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
    if (
      endpoint.protocol !== "https:"
      || endpoint.username !== ""
      || endpoint.password !== ""
      || endpoint.port !== ""
      || endpoint.hash !== ""
      || endpoint.search !== ""
      || !isSafePublicHostname(hostname, true)
      || (options.allowedHostname !== undefined && !options.allowedHostname(hostname))
      || (options.originOnly && endpoint.pathname !== "/")
    ) return null;
    return options.originOnly ? endpoint.origin : endpoint.toString();
  } catch {
    return null;
  }
}

function isHubSpotHostname(hostname: string): boolean {
  return hostname === "api.hubapi.com" || /^api-[a-z0-9-]+\.hubapi\.com$/.test(hostname);
}

function isSalesforceHostname(hostname: string): boolean {
  return hostname === "salesforce.com"
    || hostname.endsWith(".salesforce.com")
    || hostname === "salesforce.mil"
    || hostname.endsWith(".salesforce.mil");
}

const environmentSchema = z.string().trim().superRefine((value, context) => {
  if (!environmentPattern.test(value) || isPlaceholder(value)) {
    context.addIssue({ code: "custom", message: "must be a lowercase non-placeholder environment name of 2-32 letters, digits, or hyphens" });
  }
});

const workerNameSchema = z.string().trim().superRefine((value, context) => {
  if (!workerNamePattern.test(value) || isPlaceholder(value)) {
    context.addIssue({ code: "custom", message: "must be a non-placeholder lowercase Worker name of 3-63 letters, digits, or hyphens" });
  }
});

const publicHostnameSchema = z.string().trim().superRefine((value, context) => {
  if (value !== value.toLowerCase() || !isSafePublicHostname(value, false)) {
    context.addIssue({ code: "custom", message: "must be a real lowercase public hostname, not an IP, preview, reserved, or placeholder hostname" });
  }
});

const mappingVersionSchema = z.string().trim().superRefine((value, context) => {
  if (!mappingVersionPattern.test(value) || isPlaceholder(value)) {
    context.addIssue({ code: "custom", message: "must be a non-placeholder mapping version of 1-64 letters, digits, dots, underscores, or hyphens" });
  }
});

const fieldMappingSchema = z.record(z.string(), z.string().min(1).max(100)).superRefine((value, context) => {
  for (const [key, target] of Object.entries(value)) {
    if (!mappableFieldSet.has(key)) {
      context.addIssue({ code: "custom", path: [key], message: "is not a supported canonical CRM field" });
    }
    if (isPlaceholder(target)) {
      context.addIssue({ code: "custom", path: [key], message: "must be a non-placeholder destination field name" });
    }
  }
});

const cronSchema = z.string().trim().transform((value) => value.toLowerCase().replace(/\s+/g, " ")).superRefine((value, context) => {
  if (!isValidCronSchedule(value)) {
    context.addIssue({ code: "custom", message: "must be a five-field Cloudflare cron using the supported *, list, range, and step syntax" });
  }
});

function httpsOriginSchema(allowedHostname: (hostname: string) => boolean) {
  return z.string().trim().transform((value, context) => {
    const endpoint = canonicalHttpsEndpoint(value, { originOnly: true, allowedHostname });
    if (!endpoint) {
      context.addIssue({ code: "custom", message: "must be an approved HTTPS origin without credentials, port, path, query, fragment, IP, or placeholder hostname" });
      return z.NEVER;
    }
    return endpoint;
  });
}

const httpsWebhookSchema = z.string().trim().transform((value, context) => {
  const endpoint = canonicalHttpsEndpoint(value, { originOnly: false });
  if (!endpoint) {
    context.addIssue({ code: "custom", message: "must be a safe public HTTPS endpoint without credentials, port, query, fragment, IP, or placeholder hostname" });
    return z.NEVER;
  }
  return endpoint;
});

const mappingFields = {
  mappingVersion: mappingVersionSchema,
  fieldMapping: fieldMappingSchema,
} as const;

function nonPlaceholderFieldSchema(schema: z.ZodString, description: string) {
  return schema.superRefine((value, context) => {
    if (isPlaceholder(value)) context.addIssue({ code: "custom", message: `must be a non-placeholder ${description}` });
  });
}

const hubSpotProviderSchema = z.object({
  type: z.literal("hubspot"),
  ...mappingFields,
  apiBaseUrl: httpsOriginSchema(isHubSpotHostname),
  objectType: nonPlaceholderFieldSchema(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "must be a valid HubSpot object type"),
    "HubSpot object type",
  ),
  idProperty: nonPlaceholderFieldSchema(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/, "must be a valid HubSpot unique-value property"),
    "HubSpot unique-value property",
  ),
}).strict();

const salesforceProviderSchema = z.object({
  type: z.literal("salesforce"),
  ...mappingFields,
  loginUrl: httpsOriginSchema(isSalesforceHostname),
  object: nonPlaceholderFieldSchema(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, "must be a valid Salesforce object API name"),
    "Salesforce object API name",
  ),
  externalIdField: nonPlaceholderFieldSchema(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, "must be a valid Salesforce External ID field API name"),
    "Salesforce External ID field API name",
  ),
  apiVersion: z.string().regex(/^v(?:[3-9]\d)\.0$/, "must be a supported Salesforce REST API version such as v65.0"),
}).strict();

const customProviderSchema = z.object({
  type: z.literal("custom"),
  ...mappingFields,
  url: httpsWebhookSchema,
  externalIdField: nonPlaceholderFieldSchema(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/, "must be a valid custom destination field name"),
    "custom destination field name",
  ),
}).strict();

const providerSchema = z.discriminatedUnion("type", [
  hubSpotProviderSchema,
  salesforceProviderSchema,
  customProviderSchema,
]).superRefine((value, context) => {
  const externalIdField = value.type === "hubspot" ? value.idProperty : value.externalIdField;
  try {
    buildFieldMapping(value.type, JSON.stringify(value.fieldMapping), externalIdField);
  } catch {
    context.addIssue({
      code: "custom",
      path: ["fieldMapping"],
      message: "must use valid, unique destination field names and keep externalId equal to the configured external ID field",
    });
  }
});

const crmGatewayManifestSchema = z.object({
  schemaVersion: z.literal(CRM_GATEWAY_MANIFEST_SCHEMA_VERSION),
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
  workerName: workerNameSchema,
  customDomain: publicHostnameSchema,
  provider: providerSchema,
  schedules: z.object({
    recovery: cronSchema,
  }).strict(),
  retention: z.object({
    terminalPayloadDays: z.number().int().min(1).max(3_650),
    terminalMetadataDays: z.number().int().min(1).max(3_650),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.retention.terminalMetadataDays < value.retention.terminalPayloadDays) {
    context.addIssue({
      code: "custom",
      path: ["retention", "terminalMetadataDays"],
      message: "must be greater than or equal to terminalPayloadDays",
    });
  }
});

export type CrmGatewayManifest = z.infer<typeof crmGatewayManifestSchema>;
export type CrmGatewayProvider = CrmGatewayManifest["provider"]["type"];
export type RenderedCrmGatewayWranglerConfiguration = ReturnType<typeof renderCrmGatewayWranglerConfiguration>;

export type CrmGatewayDeploymentPlan = Readonly<{
  schemaVersion: "1.0";
  action: "plan";
  environment: string;
  workerName: string;
  customDomain: string;
  provider: CrmGatewayProvider;
  mappingVersion: string;
  mappedFieldOverrides: number;
  retention: Readonly<{
    terminalPayloadDays: number;
    terminalMetadataDays: number;
  }>;
  generatedConfig: string;
  database: Readonly<{
    binding: "CRM_DB";
    provisioning: "automatic-on-isolated-bootstrap";
    migrationsDirectory: string;
  }>;
  requiredSecretNames: readonly string[];
  optionalRotationSecretNames: readonly string[];
  preconditions: readonly string[];
  nextCommands: readonly string[];
}>;

export function parseCrmGatewayManifest(input: unknown): CrmGatewayManifest {
  rejectSecretMaterial(input);
  const result = crmGatewayManifestSchema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${manifestPath(issue.path)}: ${issue.message}`)
    .sort()
    .join("; ");
  throw new CrmGatewayManifestError(details);
}

export function requiredCrmGatewaySecretNames(manifest: CrmGatewayManifest): string[] {
  const names = ["NOTICE_INGRESS_SECRET", "NOTICE_OPERATIONS_SECRET"];
  if (manifest.provider.type === "hubspot") names.push("NOTICE_CRM_HUBSPOT_ACCESS_TOKEN");
  if (manifest.provider.type === "salesforce") {
    names.push("NOTICE_CRM_SALESFORCE_CLIENT_ID", "NOTICE_CRM_SALESFORCE_CLIENT_SECRET");
  }
  if (manifest.provider.type === "custom") names.push("NOTICE_CRM_CUSTOM_SECRET");
  return names.sort();
}

export function optionalCrmGatewayRotationSecretNames(): string[] {
  return ["NOTICE_INGRESS_PREVIOUS_SECRET"];
}

export function generatedCrmGatewayWranglerPath(manifest: CrmGatewayManifest): string {
  return `.wrangler/notice-crm-gateway-${manifest.environment}.json`;
}

function sortedMappingJson(mapping: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right))));
}

export function renderCrmGatewayWranglerConfiguration(manifest: CrmGatewayManifest) {
  const vars: Record<string, string> = {
    NOTICE_RELEASE_REVISION: manifest.sourceRevision,
    NOTICE_CRM_PROVIDER: manifest.provider.type,
    NOTICE_CRM_MAPPING_VERSION: manifest.provider.mappingVersion,
    NOTICE_CRM_TERMINAL_PAYLOAD_RETENTION_DAYS: String(manifest.retention.terminalPayloadDays),
    NOTICE_CRM_TERMINAL_METADATA_RETENTION_DAYS: String(manifest.retention.terminalMetadataDays),
  };
  if (Object.keys(manifest.provider.fieldMapping).length > 0) {
    vars.NOTICE_CRM_FIELD_MAPPING_JSON = sortedMappingJson(manifest.provider.fieldMapping);
  }
  if (manifest.provider.type === "hubspot") {
    vars.NOTICE_CRM_HUBSPOT_API_BASE_URL = manifest.provider.apiBaseUrl;
    vars.NOTICE_CRM_HUBSPOT_OBJECT_TYPE = manifest.provider.objectType;
    vars.NOTICE_CRM_HUBSPOT_ID_PROPERTY = manifest.provider.idProperty;
  } else if (manifest.provider.type === "salesforce") {
    vars.NOTICE_CRM_SALESFORCE_LOGIN_URL = manifest.provider.loginUrl;
    vars.NOTICE_CRM_SALESFORCE_OBJECT = manifest.provider.object;
    vars.NOTICE_CRM_SALESFORCE_EXTERNAL_ID_FIELD = manifest.provider.externalIdField;
    vars.NOTICE_CRM_SALESFORCE_API_VERSION = manifest.provider.apiVersion;
  } else {
    vars.NOTICE_CRM_CUSTOM_URL = manifest.provider.url;
    vars.NOTICE_CRM_CUSTOM_EXTERNAL_ID_FIELD = manifest.provider.externalIdField;
  }

  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    account_id: manifest.accountId,
    name: manifest.workerName,
    main: "../integrations/crm-gateway/src/index.ts",
    compatibility_date: CRM_GATEWAY_WRANGLER_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: manifest.customDomain, custom_domain: true }],
    observability: { enabled: true },
    d1_databases: [{
      binding: "CRM_DB",
      migrations_dir: "../integrations/crm-gateway/migrations",
    }],
    triggers: { crons: [manifest.schedules.recovery] },
    vars,
    secrets: { required: requiredCrmGatewaySecretNames(manifest) },
  } as const;
}

export function serializeCrmGatewayWranglerConfiguration(manifest: CrmGatewayManifest): string {
  return `${JSON.stringify(renderCrmGatewayWranglerConfiguration(manifest), null, 2)}\n`;
}

function quoted(argument: string): string {
  return JSON.stringify(argument);
}

export function createCrmGatewayDeploymentPlan(
  manifest: CrmGatewayManifest,
  sourceManifestPath = `.wrangler/crm-gateway.deployment.${manifest.environment}.json`,
): CrmGatewayDeploymentPlan {
  const configPath = generatedCrmGatewayWranglerPath(manifest);
  const secretFile = `.dev.vars.crm-${manifest.environment}`;
  const healthUrl = `https://${manifest.customDomain}/healthz`;
  return Object.freeze({
    schemaVersion: CRM_GATEWAY_MANIFEST_SCHEMA_VERSION,
    action: "plan",
    environment: manifest.environment,
    workerName: manifest.workerName,
    customDomain: manifest.customDomain,
    provider: manifest.provider.type,
    mappingVersion: manifest.provider.mappingVersion,
    mappedFieldOverrides: Object.keys(manifest.provider.fieldMapping).length,
    retention: Object.freeze({ ...manifest.retention }),
    generatedConfig: configPath,
    database: Object.freeze({
      binding: "CRM_DB",
      provisioning: "automatic-on-isolated-bootstrap",
      migrationsDirectory: "integrations/crm-gateway/migrations",
    }),
    requiredSecretNames: Object.freeze(requiredCrmGatewaySecretNames(manifest)),
    optionalRotationSecretNames: Object.freeze(optionalCrmGatewayRotationSecretNames()),
    preconditions: Object.freeze([
      "This command sequence is only for a confirmed empty environment; existing environments require the reviewed maintenance-window upgrade procedure.",
      "The Cloudflare account, zone, custom domain, and staging/production ownership are approved.",
      "The CRM object and every default or overridden destination field already exist with compatible field types.",
      "The provider credential is least-privileged and assigned to a dedicated integration identity.",
      `Every required secret name is populated in the owner-only ignored ${secretFile} file exported from the deployment secret manager; no secret is stored in this manifest.`,
      "NOTICE_INGRESS_SECRET has the same value as NOTICE_CRM_GATEWAY_SECRET in the paired Notice deployment.",
      "NOTICE_OPERATIONS_SECRET is a distinct randomly generated value of at least 32 characters and is restricted to authorized operators.",
    ]),
    nextCommands: Object.freeze([
      "npm ci",
      "npm test",
      `node --import tsx scripts/crm-gateway-kit.mjs render ${quoted(sourceManifestPath)}`,
      `npm run crm:gateway:deploy -- --config ${configPath} --secrets-file ${secretFile} --confirm-empty-environment --confirm-workers-paid-plan`,
      `curl --fail --silent --show-error ${quoted(healthUrl)}`,
    ]),
  });
}

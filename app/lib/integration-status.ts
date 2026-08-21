import {
  hasConfiguredDeploymentValue,
  isProductionSecretValue,
  isSafeDeploymentEndpoint,
} from "./deployment-values";
import {
  DOCUSEAL_API_CLIENT_CONTRACT_VERSION,
  DOCUSEAL_MAX_EXPIRATION_HOURS,
  DOCUSEAL_MCP_PROTOCOL_VERSION,
  DOCUSEAL_VALIDATED_RELEASE,
  docuSealDeployments,
  normalizeDocuSealApiBaseUrl,
  type DocuSealDeployment,
} from "./docuseal";
import { isValidCustomerHostedOcrIdentifier } from "./document-security";

export const integrationIds = ["docuseal", "scanner", "delivery", "crm"] as const;
const crmProviders = new Set(["hubspot", "salesforce", "custom"]);

export type IntegrationId = (typeof integrationIds)[number];
export type IntegrationStatusSource = Record<string, unknown>;

export type IntegrationLiveTest = Readonly<{
  status: "passed" | "failed";
  testedAt: string;
  detail: string;
}>;

export type IntegrationSummary = Readonly<{
  id: IntegrationId;
  label: string;
  provider: string;
  configured: boolean;
  required: boolean;
  testable: boolean;
  detail: string;
  lastTest: IntegrationLiveTest | null;
  selectedOcrProfile: Readonly<{
    execution: "customer-hosted-scanner-gateway";
    modelId: string;
    profileId: string;
  }> | null;
}>;

type IntegrationDefinition = {
  id: IntegrationId;
  label: string;
  required: boolean;
  enabled: boolean;
  provider: string;
  providerReady: boolean;
  attested: boolean;
  requirements: Array<{ label: string; ready: boolean }>;
  selectedOcrProfile?: IntegrationSummary["selectedOcrProfile"];
  configurationDetail?: string;
};

function value(source: IntegrationStatusSource, name: string): string {
  const candidate = source[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function flag(source: IntegrationStatusSource, name: string): boolean {
  return value(source, name) === "true";
}

function safeProvider(valueToCheck: string): string {
  return /^[a-z][a-z0-9_-]{1,63}$/.test(valueToCheck) ? valueToCheck : "none";
}

function isPositiveInteger(valueToCheck: string): boolean {
  const parsed = Number(valueToCheck);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function isMappingVersion(valueToCheck: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(valueToCheck);
}

function isExplicitBoolean(valueToCheck: string): boolean {
  return valueToCheck === "true" || valueToCheck === "false";
}

function isDocuSealExpiration(valueToCheck: string): boolean {
  const parsed = Number(valueToCheck);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= DOCUSEAL_MAX_EXPIRATION_HOURS;
}

function isDocuSealWebhookSecret(valueToCheck: string): boolean {
  return isProductionSecretValue(valueToCheck)
    && valueToCheck.length <= 4_096
    && /^whsec_[A-Za-z0-9+/_=-]+$/.test(valueToCheck);
}

function isDocuSealApiBaseUrl(valueToCheck: string, deployment: string): boolean {
  if (!docuSealDeployments.includes(deployment as DocuSealDeployment) || !isSafeDeploymentEndpoint(valueToCheck)) {
    return false;
  }
  try {
    return normalizeDocuSealApiBaseUrl(valueToCheck, deployment as DocuSealDeployment) === valueToCheck.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function asSummary(definition: IntegrationDefinition): IntegrationSummary {
  const missing = definition.requirements.filter((requirement) => !requirement.ready).map((requirement) => requirement.label);
  const testable = definition.enabled && definition.providerReady && missing.length === 0;
  const configured = testable && definition.attested;
  let detail: string;

  if (!definition.enabled && !definition.required) {
    detail = `${definition.label} is explicitly disabled; no connection is required.`;
  } else if (!definition.enabled) {
    detail = `${definition.label} is not enabled.`;
  } else if (!definition.providerReady) {
    detail = `The selected provider does not match the repository's ${definition.label} adapter.`;
  } else if (missing.length > 0) {
    detail = `Missing or invalid configuration: ${missing.join(", ")}.`;
  } else if (!definition.attested) {
    detail = "Connection settings are present and ready for a live test; production attestation is not yet enabled.";
  } else {
    detail = "Production configuration is complete; run a live test to verify current access.";
  }

  if (definition.configurationDetail) detail = `${detail} ${definition.configurationDetail}`;

  return Object.freeze({
    id: definition.id,
    label: definition.label,
    provider: definition.provider,
    configured,
    required: definition.required,
    testable,
    detail,
    lastTest: null,
    selectedOcrProfile: definition.selectedOcrProfile ?? null,
  });
}

/**
 * Produce admin-safe integration metadata. Presence is reported, but endpoint
 * addresses, tokens, signing secrets, template IDs, and account data are never
 * copied into the returned object. The explicitly non-secret deployment-level
 * OCR model/profile identifiers are returned so administrators can verify the
 * selected customer-hosted execution profile.
 */
export function getIntegrationSummaries(source: IntegrationStatusSource): IntegrationSummary[] {
  const esignProvider = safeProvider(value(source, "NOTICE_ESIGN_PROVIDER"));
  const scanProvider = safeProvider(value(source, "NOTICE_SCAN_PROVIDER"));
  const mailProvider = safeProvider(value(source, "NOTICE_MAIL_PROVIDER"));
  const crmProvider = safeProvider(value(source, "NOTICE_CRM_PROVIDER"));
  const crmEnabled = flag(source, "NOTICE_CRM_ENABLED");
  const crmEndpoint = value(source, "NOTICE_CRM_GATEWAY_URL");
  const crmSecret = value(source, "NOTICE_CRM_GATEWAY_SECRET");
  const docuSealDeployment = value(source, "NOTICE_DOCUSEAL_DEPLOYMENT");
  const docuSealApiBaseUrl = value(source, "NOTICE_DOCUSEAL_API_BASE_URL");
  const docuSealApiToken = value(source, "NOTICE_DOCUSEAL_API_TOKEN");
  const docuSealMcpEnabledValue = value(source, "NOTICE_DOCUSEAL_MCP_ENABLED");
  const docuSealMcpEnabled = docuSealMcpEnabledValue === "true";
  const docuSealMcpToken = value(source, "NOTICE_DOCUSEAL_MCP_TOKEN");
  const ocrEnabledValue = value(source, "NOTICE_SCAN_OCR_ENABLED");
  const ocrEnabled = ocrEnabledValue === "true";
  const ocrModelId = value(source, "NOTICE_SCAN_OCR_MODEL_ID");
  const ocrProfileId = value(source, "NOTICE_SCAN_OCR_PROFILE_ID");
  const validOcrProfile = ocrEnabled
    && isValidCustomerHostedOcrIdentifier(ocrModelId)
    && isValidCustomerHostedOcrIdentifier(ocrProfileId);
  const selectedOcrProfile = validOcrProfile
    ? Object.freeze({
        execution: "customer-hosted-scanner-gateway" as const,
        modelId: ocrModelId,
        profileId: ocrProfileId,
      })
    : null;

  return [
    asSummary({
      id: "docuseal",
      label: "DocuSeal e-signature",
      required: true,
      enabled: flag(source, "NOTICE_ESIGN_ENABLED"),
      provider: esignProvider,
      providerReady: esignProvider === "docuseal",
      attested: flag(source, "NOTICE_ESIGN_CONFIGURED"),
      requirements: [
        { label: "deployment type and matching API base URL", ready: isDocuSealApiBaseUrl(docuSealApiBaseUrl, docuSealDeployment) },
        { label: "validated DocuSeal release 3.2.1", ready: value(source, "NOTICE_DOCUSEAL_VALIDATED_RELEASE") === DOCUSEAL_VALIDATED_RELEASE },
        { label: "official API client contract 1.0.24", ready: value(source, "NOTICE_DOCUSEAL_API_CLIENT_CONTRACT") === DOCUSEAL_API_CLIENT_CONTRACT_VERSION },
        { label: "API token", ready: hasConfiguredDeploymentValue(docuSealApiToken) && docuSealApiToken.length <= 4_096 },
        { label: "HMAC-tab whsec_ webhook signing secret", ready: isDocuSealWebhookSecret(value(source, "NOTICE_DOCUSEAL_WEBHOOK_SECRET")) },
        { label: "template ID", ready: isPositiveInteger(value(source, "NOTICE_DOCUSEAL_TEMPLATE_ID")) },
        { label: "/submissions/html Pro or Developer Sandbox entitlement attestation", ready: flag(source, "NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED") },
        { label: `expiration policy (1-${DOCUSEAL_MAX_EXPIRATION_HOURS} hours)`, ready: isDocuSealExpiration(value(source, "NOTICE_DOCUSEAL_EXPIRATION_HOURS")) },
        { label: "explicit email 2FA policy", ready: isExplicitBoolean(value(source, "NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED")) },
        { label: "explicit MCP selection", ready: isExplicitBoolean(docuSealMcpEnabledValue) },
        {
          label: "self-hosted same-origin MCP with pinned protocol/server and separate Bearer token",
          ready: !docuSealMcpEnabled || (
            docuSealDeployment === "self-hosted"
            && value(source, "NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION") === DOCUSEAL_MCP_PROTOCOL_VERSION
            && value(source, "NOTICE_DOCUSEAL_MCP_SERVER_VERSION") === DOCUSEAL_VALIDATED_RELEASE
            && hasConfiguredDeploymentValue(docuSealMcpToken)
            && docuSealMcpToken.length <= 4_096
            && docuSealMcpToken !== docuSealApiToken
          ),
        },
      ],
    }),
    asSummary({
      id: "scanner",
      label: "Document scanning",
      required: true,
      enabled: flag(source, "NOTICE_SCAN_ENABLED"),
      provider: scanProvider,
      providerReady: scanProvider === "scan-gateway",
      attested: flag(source, "NOTICE_SCAN_CONFIGURED"),
      requirements: [
        { label: "HTTPS gateway URL", ready: isSafeDeploymentEndpoint(value(source, "NOTICE_SCAN_GATEWAY_URL")) },
        { label: "gateway signing secret (32+ characters)", ready: isProductionSecretValue(value(source, "NOTICE_SCAN_GATEWAY_SECRET")) },
        { label: "explicit customer-hosted OCR selection", ready: isExplicitBoolean(ocrEnabledValue) },
        {
          label: "bounded OCR model/profile identifiers, or no stale identifiers when disabled",
          ready: validOcrProfile || (ocrEnabledValue === "false" && !ocrModelId && !ocrProfileId),
        },
      ],
      selectedOcrProfile,
      configurationDetail: selectedOcrProfile
        ? `Customer-hosted OCR model ${selectedOcrProfile.modelId} with profile ${selectedOcrProfile.profileId} is selected at deployment level and can receive bytes only through this signed gateway.`
        : ocrEnabledValue === "false"
          ? "Customer-hosted OCR is explicitly disabled at deployment level."
          : undefined,
    }),
    asSummary({
      id: "delivery",
      label: "Mail delivery",
      required: true,
      enabled: flag(source, "NOTICE_MAIL_ENABLED"),
      provider: mailProvider,
      providerReady: mailProvider === "delivery-gateway",
      attested: flag(source, "NOTICE_MAIL_CONFIGURED"),
      requirements: [
        { label: "HTTPS gateway URL", ready: isSafeDeploymentEndpoint(value(source, "NOTICE_DELIVERY_GATEWAY_URL")) },
        { label: "gateway signing secret (32+ characters)", ready: isProductionSecretValue(value(source, "NOTICE_DELIVERY_GATEWAY_SECRET")) },
      ],
    }),
    asSummary({
      id: "crm",
      label: "CRM synchronization",
      required: crmEnabled,
      enabled: crmEnabled,
      provider: crmProvider,
      providerReady: crmProviders.has(crmProvider),
      attested: flag(source, "NOTICE_CRM_CONFIGURED"),
      requirements: [
        { label: "HTTPS gateway URL", ready: isSafeDeploymentEndpoint(crmEndpoint) },
        { label: "gateway signing secret (32+ characters)", ready: isProductionSecretValue(crmSecret) },
        { label: "stable mapping version", ready: isMappingVersion(value(source, "NOTICE_CRM_MAPPING_VERSION")) },
      ],
    }),
  ];
}

export function getIntegrationSummary(
  source: IntegrationStatusSource,
  id: IntegrationId,
): IntegrationSummary {
  const summary = getIntegrationSummaries(source).find((candidate) => candidate.id === id);
  if (!summary) throw new Error(`Unknown integration: ${id}`);
  return summary;
}

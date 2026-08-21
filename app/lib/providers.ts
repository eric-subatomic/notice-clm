import { env } from "cloudflare:workers";
import { NoticeConfigurationError } from "./config";
import { isPlaceholderHostname } from "./deployment-values";
import { type ScannerConfiguration } from "./document-security";
import { scannerConfigurationFromSource } from "./scanner-configuration";
export { scannerConfigurationFromSource } from "./scanner-configuration";
import {
  DOCUSEAL_API_CLIENT_CONTRACT_VERSION,
  DOCUSEAL_MAX_EXPIRATION_HOURS,
  DOCUSEAL_MCP_PROTOCOL_VERSION,
  DOCUSEAL_VALIDATED_RELEASE,
  docuSealDeployments,
  normalizeDocuSealApiBaseUrl,
  type DocuSealConfiguration,
  type DocuSealDeployment,
} from "./docuseal";

type ProviderEnv = Record<string, unknown>;

export const crmProviders = ["hubspot", "salesforce", "custom"] as const;
export type CrmProvider = (typeof crmProviders)[number];
export type CrmGatewayConfiguration = Readonly<{
  endpoint: string;
  secret: string;
  provider: CrmProvider;
  mappingVersion: string;
}>;

export type CounterpartyExchangeConfiguration = Readonly<{
  portalEnabled: boolean;
  portalTtlHours: number;
  inboundEmail: Readonly<{
    domain: string;
    secret: string;
  }> | null;
}>;

function binding(name: string): string | null {
  const value = (env as unknown as ProviderEnv)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function enabled(name: string): boolean {
  return binding(name) === "true";
}

function productionSecret(name: string): string | null {
  const secret = binding(name);
  return secret && secret.length >= 32 ? secret : null;
}

function validMailDomain(candidate: string | null): candidate is string {
  if (!candidate) return false;
  const domain = candidate.toLowerCase().replace(/\.$/, "");
  const reservedSuffixes = [".example", ".invalid", ".local", ".localhost", ".test"];
  const directPlatformSuffixes = ["workers.dev", "pages.dev"];
  const placeholderLabel = /^(?:change-?me|replace(?:-|$)|todo|tbd|unset|your(?:-|$))/;
  if (
    domain !== candidate
    || isPlaceholderHostname(domain)
    || reservedSuffixes.some((suffix) => domain.endsWith(suffix))
    || directPlatformSuffixes.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))
    || domain.split(".").some((label) => placeholderLabel.test(label))
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)
    || domain.length > 253
    || !domain.includes(".")
  ) return false;
  return domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/**
 * Counterparty exchange is intentionally split into two independent controls.
 * The scoped portal can be enabled without mail routing; inbound aliases are
 * exposed only after the HMAC gateway, domain, and attestation are complete.
 */
export function getCounterpartyExchangeConfiguration(): CounterpartyExchangeConfiguration {
  const evaluation = binding("NOTICE_APP_MODE") === "evaluation";
  const portalEnabled = evaluation || enabled("NOTICE_COUNTERPARTY_PORTAL_ENABLED");
  const configuredTtlValue = binding("NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS");
  const configuredTtl = Number(configuredTtlValue ?? (evaluation ? "72" : ""));
  if (!Number.isSafeInteger(configuredTtl) || configuredTtl < 1 || configuredTtl > 336) {
    throw new NoticeConfigurationError("NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS must be a whole number from 1 to 336.");
  }

  const emailEnabled = enabled("NOTICE_EMAIL_CAPTURE_ENABLED");
  if (!emailEnabled) {
    return Object.freeze({ portalEnabled, portalTtlHours: configuredTtl, inboundEmail: null });
  }
  if (binding("NOTICE_EMAIL_CAPTURE_PROVIDER") !== "inbound-gateway" || !enabled("NOTICE_EMAIL_CAPTURE_CONFIGURED")) {
    throw new NoticeConfigurationError("Email redline capture is enabled but the inbound gateway is not selected and attested.");
  }
  const domain = binding("NOTICE_INBOUND_EMAIL_DOMAIN");
  const secret = productionSecret("NOTICE_INBOUND_EMAIL_SECRET");
  const secretBytes = secret ? new TextEncoder().encode(secret).byteLength : 0;
  if (!validMailDomain(domain) || !secret || secretBytes > 4_096) {
    throw new NoticeConfigurationError("Email redline capture requires a real inbound domain and a managed signing secret of 32 to 4096 bytes.");
  }
  return Object.freeze({
    portalEnabled,
    portalTtlHours: configuredTtl,
    inboundEmail: Object.freeze({ domain, secret }),
  });
}

export function getScannerConfiguration(): ScannerConfiguration {
  return scannerConfigurationFromSource(env as unknown as ProviderEnv);
}

export function getDocuSealConfiguration(): DocuSealConfiguration {
  return docuSealConfigurationFromSource(env as unknown as ProviderEnv, true);
}

/** Build the same strict provider profile for the pre-attestation live test. */
export function getDocuSealDiagnosticConfiguration(source: ProviderEnv): DocuSealConfiguration {
  return docuSealConfigurationFromSource(source, false);
}

function sourceBinding(source: ProviderEnv, name: string): string | null {
  const value = source[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceFlag(source: ProviderEnv, name: string): boolean | null {
  const value = sourceBinding(source, name);
  return value === "true" ? true : value === "false" ? false : null;
}

function validDocuSealWebhookSecret(value: string | null): value is string {
  return Boolean(value && value.length >= 32 && value.length <= 4_096 && /^whsec_[A-Za-z0-9+/_=-]+$/.test(value));
}

function docuSealConfigurationFromSource(source: ProviderEnv, requireAttestation: boolean): DocuSealConfiguration {
  if (
    sourceFlag(source, "NOTICE_ESIGN_ENABLED") !== true
    || sourceBinding(source, "NOTICE_ESIGN_PROVIDER") !== "docuseal"
    || (requireAttestation && sourceFlag(source, "NOTICE_ESIGN_CONFIGURED") !== true)
  ) {
    throw new NoticeConfigurationError("The DocuSeal production adapter is not enabled and attested.");
  }
  const deployment = sourceBinding(source, "NOTICE_DOCUSEAL_DEPLOYMENT");
  if (!deployment || !docuSealDeployments.includes(deployment as DocuSealDeployment)) {
    throw new NoticeConfigurationError("NOTICE_DOCUSEAL_DEPLOYMENT must identify global Cloud, EU Cloud, or self-hosted DocuSeal.");
  }
  let apiBaseUrl: string;
  try {
    apiBaseUrl = normalizeDocuSealApiBaseUrl(
      sourceBinding(source, "NOTICE_DOCUSEAL_API_BASE_URL") ?? "",
      deployment as DocuSealDeployment,
    );
  } catch {
    throw new NoticeConfigurationError("The DocuSeal API base URL does not match the selected deployment type.");
  }
  const apiToken = sourceBinding(source, "NOTICE_DOCUSEAL_API_TOKEN");
  const webhookSecret = sourceBinding(source, "NOTICE_DOCUSEAL_WEBHOOK_SECRET");
  const templateId = Number(sourceBinding(source, "NOTICE_DOCUSEAL_TEMPLATE_ID"));
  const expirationHours = Number(sourceBinding(source, "NOTICE_DOCUSEAL_EXPIRATION_HOURS"));
  const email2faRequired = sourceFlag(source, "NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED");
  const htmlSubmissionsEntitled = sourceFlag(source, "NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED");
  if (
    !apiToken
    || apiToken.length > 4_096
    || !validDocuSealWebhookSecret(webhookSecret)
    || !Number.isSafeInteger(templateId)
    || templateId <= 0
    || !Number.isSafeInteger(expirationHours)
    || expirationHours < 1
    || expirationHours > DOCUSEAL_MAX_EXPIRATION_HOURS
    || email2faRequired === null
    || htmlSubmissionsEntitled !== true
  ) {
    throw new NoticeConfigurationError("DocuSeal credentials, HMAC-tab secret, template, entitlement, expiration, and email 2FA policy must be configured.");
  }
  if (
    sourceBinding(source, "NOTICE_DOCUSEAL_VALIDATED_RELEASE") !== DOCUSEAL_VALIDATED_RELEASE
    || sourceBinding(source, "NOTICE_DOCUSEAL_API_CLIENT_CONTRACT") !== DOCUSEAL_API_CLIENT_CONTRACT_VERSION
  ) {
    throw new NoticeConfigurationError("DocuSeal must be attested to the repository's validated release and API client contract.");
  }

  const mcpEnabled = sourceFlag(source, "NOTICE_DOCUSEAL_MCP_ENABLED");
  if (mcpEnabled === null) throw new NoticeConfigurationError("NOTICE_DOCUSEAL_MCP_ENABLED must be explicitly true or false.");
  let mcp: DocuSealConfiguration["mcp"] = null;
  if (mcpEnabled) {
    const token = sourceBinding(source, "NOTICE_DOCUSEAL_MCP_TOKEN");
    if (
      deployment !== "self-hosted"
      || !token
      || token.length > 4_096
      || token === apiToken
      || sourceBinding(source, "NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION") !== DOCUSEAL_MCP_PROTOCOL_VERSION
      || sourceBinding(source, "NOTICE_DOCUSEAL_MCP_SERVER_VERSION") !== DOCUSEAL_VALIDATED_RELEASE
    ) {
      throw new NoticeConfigurationError("Self-hosted DocuSeal MCP requires the pinned protocol/server versions and a separate Bearer token.");
    }
    mcp = {
      token,
      protocolVersion: DOCUSEAL_MCP_PROTOCOL_VERSION,
      serverVersion: DOCUSEAL_VALIDATED_RELEASE,
    };
  }
  return Object.freeze({
    deployment: deployment as DocuSealDeployment,
    apiBaseUrl,
    apiToken,
    webhookSecret,
    templateId,
    validatedRelease: DOCUSEAL_VALIDATED_RELEASE,
    apiClientContractVersion: DOCUSEAL_API_CLIENT_CONTRACT_VERSION,
    htmlSubmissionsEntitled: true,
    expirationHours,
    email2faRequired,
    mcp,
  });
}

export function getDeliveryConfiguration(): { endpoint: string; secret: string } {
  if (!isDeliveryGatewayConfigured()) {
    throw new NoticeConfigurationError("The notification delivery adapter is not enabled and attested.");
  }
  const endpoint = binding("NOTICE_DELIVERY_GATEWAY_URL");
  const secret = productionSecret("NOTICE_DELIVERY_GATEWAY_SECRET");
  if (!endpoint || !secret) throw new NoticeConfigurationError("Notification delivery gateway credentials are not configured.");
  return { endpoint, secret };
}

export function isDeliveryGatewayConfigured(): boolean {
  return enabled("NOTICE_MAIL_ENABLED")
    && binding("NOTICE_MAIL_PROVIDER") === "delivery-gateway"
    && enabled("NOTICE_MAIL_CONFIGURED")
    && Boolean(binding("NOTICE_DELIVERY_GATEWAY_URL"))
    && Boolean(productionSecret("NOTICE_DELIVERY_GATEWAY_SECRET"));
}

export function isNegotiationMailAccepted(): boolean {
  return isDeliveryGatewayConfigured() && enabled("NOTICE_NEGOTIATION_MAIL_ACCEPTED");
}

export function getNegotiationDeliveryConfiguration(): { endpoint: string; secret: string } {
  if (!isNegotiationMailAccepted()) {
    throw new NoticeConfigurationError("Automated counterparty delivery has not passed its separate acceptance gate.");
  }
  return getDeliveryConfiguration();
}

export function isCrmDeliveryEnabled(): boolean {
  return enabled("NOTICE_CRM_ENABLED");
}

/**
 * Runtime CRM fan-out is deliberately separate from notification delivery.
 * Diagnostics and production therefore exercise the same endpoint, and a
 * successful mail request can never be mistaken for an accepted CRM event.
 */
export function getCrmConfiguration(): CrmGatewayConfiguration | null {
  if (!isCrmDeliveryEnabled()) return null;
  if (!enabled("NOTICE_CRM_CONFIGURED")) {
    throw new NoticeConfigurationError("The CRM adapter is enabled but has not been tested and attested.");
  }
  const provider = binding("NOTICE_CRM_PROVIDER");
  if (!provider || !crmProviders.includes(provider as CrmProvider)) {
    throw new NoticeConfigurationError("NOTICE_CRM_PROVIDER must select hubspot, salesforce, or custom.");
  }
  const endpoint = binding("NOTICE_CRM_GATEWAY_URL");
  const secret = productionSecret("NOTICE_CRM_GATEWAY_SECRET");
  const mappingVersion = binding("NOTICE_CRM_MAPPING_VERSION");
  if (!endpoint || !secret) throw new NoticeConfigurationError("CRM gateway credentials are not configured.");
  if (!mappingVersion || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(mappingVersion)) {
    throw new NoticeConfigurationError("NOTICE_CRM_MAPPING_VERSION must identify the exact deployed CRM field mapping.");
  }
  return { endpoint, secret, provider: provider as CrmProvider, mappingVersion };
}

export function getJobRunnerSecret(): string {
  const secret = productionSecret("NOTICE_JOB_RUNNER_SECRET");
  if (!secret) throw new NoticeConfigurationError("The scheduled job runner secret must contain at least 32 characters.");
  return secret;
}

export function getAuditSigningKey(required: boolean): string | null {
  const configured = binding("NOTICE_AUDIT_SIGNING_KEY");
  if (!configured && !required) return null;
  const key = productionSecret("NOTICE_AUDIT_SIGNING_KEY");
  if (!key) throw new NoticeConfigurationError("The audit signing key must contain at least 32 characters.");
  return key;
}

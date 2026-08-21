import {
  type IntegrationId,
  type IntegrationLiveTest,
  type IntegrationStatusSource,
  type IntegrationSummary,
} from "./integration-status";
import type { ProductionReadiness, ReadinessCheck } from "./readiness";

const configurationFields: Record<IntegrationId, readonly string[]> = {
  docuseal: [
    "NOTICE_ESIGN_ENABLED",
    "NOTICE_ESIGN_PROVIDER",
    "NOTICE_DOCUSEAL_DEPLOYMENT",
    "NOTICE_DOCUSEAL_API_BASE_URL",
    "NOTICE_DOCUSEAL_API_TOKEN",
    "NOTICE_DOCUSEAL_VALIDATED_RELEASE",
    "NOTICE_DOCUSEAL_API_CLIENT_CONTRACT",
    "NOTICE_DOCUSEAL_WEBHOOK_SECRET",
    "NOTICE_DOCUSEAL_TEMPLATE_ID",
    "NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED",
    "NOTICE_DOCUSEAL_EXPIRATION_HOURS",
    "NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED",
    "NOTICE_DOCUSEAL_MCP_ENABLED",
    "NOTICE_DOCUSEAL_MCP_TOKEN",
    "NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION",
    "NOTICE_DOCUSEAL_MCP_SERVER_VERSION",
  ],
  scanner: [
    "NOTICE_SCAN_ENABLED",
    "NOTICE_SCAN_PROVIDER",
    "NOTICE_SCAN_GATEWAY_URL",
    "NOTICE_SCAN_GATEWAY_SECRET",
    "NOTICE_SCAN_OCR_ENABLED",
    "NOTICE_SCAN_OCR_MODEL_ID",
    "NOTICE_SCAN_OCR_PROFILE_ID",
  ],
  delivery: [
    "NOTICE_MAIL_ENABLED",
    "NOTICE_MAIL_PROVIDER",
    "NOTICE_DELIVERY_GATEWAY_URL",
    "NOTICE_DELIVERY_GATEWAY_SECRET",
  ],
  crm: [
    "NOTICE_CRM_ENABLED",
    "NOTICE_CRM_PROVIDER",
    "NOTICE_CRM_GATEWAY_URL",
    "NOTICE_CRM_GATEWAY_SECRET",
    "NOTICE_CRM_MAPPING_VERSION",
  ],
};

export const INTEGRATION_DIAGNOSTIC_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export function isCurrentIntegrationDiagnostic(testedAt: string, now = Date.now()): boolean {
  const testedAtMs = Date.parse(testedAt);
  return Number.isFinite(testedAtMs)
    && testedAtMs <= now + MAX_CLOCK_SKEW_MS
    && now - testedAtMs <= INTEGRATION_DIAGNOSTIC_MAX_AGE_MS;
}

function sourceValue(source: IntegrationStatusSource, name: string): string {
  const candidate = source[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

export async function integrationConfigurationFingerprint(
  source: IntegrationStatusSource,
  id: IntegrationId,
): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(
    configurationFields[id].map((name) => [name, sourceValue(source, name)]),
  ));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type CurrentIntegrationDiagnostics = Partial<Record<IntegrationId, IntegrationLiveTest>>;

export function attachCurrentIntegrationDiagnostics(
  summaries: readonly IntegrationSummary[],
  diagnostics: CurrentIntegrationDiagnostics,
): IntegrationSummary[] {
  return summaries.map((summary) => Object.freeze({
    ...summary,
    lastTest: diagnostics[summary.id] ?? null,
  }));
}

/** Add runtime-only evidence gates to the protected readiness endpoint. */
export function requireCurrentIntegrationDiagnostics(
  readiness: ProductionReadiness,
  summaries: readonly IntegrationSummary[],
): ProductionReadiness {
  const liveChecks: ReadinessCheck[] = summaries.map((summary) => {
    if (!summary.required) {
      return {
        id: `customer.${summary.id}.live_diagnostic`,
        area: "integrations",
        label: `${summary.label} live diagnostic`,
        owner: "customer",
        required: false,
        status: "not_required",
        message: `${summary.label} is not required for this deployment.`,
      };
    }
    const passed = summary.lastTest?.status === "passed";
    return {
      id: `customer.${summary.id}.live_diagnostic`,
      area: "integrations",
      label: `${summary.label} live diagnostic`,
      owner: "customer",
      required: true,
      status: passed ? "pass" : "fail",
      message: passed
        ? `A successful live diagnostic is retained for the current ${summary.label.toLowerCase()} configuration.`
        : `No successful live diagnostic is retained for the current ${summary.label.toLowerCase()} configuration.`,
      remediation: passed
        ? undefined
        : "Run the authenticated connection test after every endpoint, credential, provider, template, or mapping change.",
    };
  });
  const customerChecks = [...readiness.customer.checks, ...liveChecks];
  const customerReady = customerChecks.every((check) => check.status !== "fail");
  const checks = [...readiness.code.checks, ...customerChecks];
  return {
    ...readiness,
    readyForProduction: readiness.code.ready && customerReady,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === "pass").length,
      failed: checks.filter((check) => check.status === "fail").length,
      notRequired: checks.filter((check) => check.status === "not_required").length,
    },
    customer: { ready: customerReady, checks: customerChecks },
  };
}

import vinext from "vinext";
import { defineConfig } from "vite";
import {
  LOCAL_SCHEMA_BOOTSTRAP_BINDING,
  LOCAL_SCHEMA_BOOTSTRAP_VALUE,
} from "./db/schema-guard.ts";

const LOCAL_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";
const isExplicitLocalEvaluation = process.env.NOTICE_LOCAL_EVALUATION === "true";
const isExplicitLocalProductionEvidence = process.env.NOTICE_LOCAL_PRODUCTION_EVIDENCE === "true";

const LOCAL_EVIDENCE_JOB_SECRET = "local-only-production-evidence-job-secret-0001";
const LOCAL_EVIDENCE_DELIVERY_SECRET = "local-only-production-evidence-delivery-secret-0001";
const LOCAL_EVIDENCE_CRM_SECRET = "local-only-production-evidence-crm-secret-000000001";
const LOCAL_EVIDENCE_WEBHOOK_SECRET = `whsec_${"e".repeat(32)}`;
const LOCAL_EVIDENCE_SCAN_SECRET = "local-only-production-evidence-scan-secret-0001";
const LOCAL_EVIDENCE_AUDIT_KEY = "local-only-production-evidence-audit-key-0001";
const LOCAL_EVIDENCE_ACCESS_TEAM_DOMAIN = "https://notice-production-evidence-fixture.cloudflareaccess.com";
const LOCAL_EVIDENCE_ACCESS_AUDIENCE = "a".repeat(64);

function productionEvidenceVars(): Record<string, string> {
  const deliveryGatewayUrl = process.env.NOTICE_EVIDENCE_DELIVERY_GATEWAY_URL?.trim();
  if (!deliveryGatewayUrl) throw new Error("NOTICE_EVIDENCE_DELIVERY_GATEWAY_URL is required for the local production evidence suite.");
  const delivery = new URL(deliveryGatewayUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(delivery.hostname) || !["http:", "https:"].includes(delivery.protocol)) {
    throw new Error("The local production evidence gateway must use a loopback URL.");
  }
  if (delivery.username || delivery.password) throw new Error("The local production evidence gateway URL must not contain credentials.");
  const crmGatewayUrl = process.env.NOTICE_EVIDENCE_CRM_GATEWAY_URL?.trim();
  if (!crmGatewayUrl) throw new Error("NOTICE_EVIDENCE_CRM_GATEWAY_URL is required for the local production evidence suite.");
  const crm = new URL(crmGatewayUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(crm.hostname) || !["http:", "https:"].includes(crm.protocol)) {
    throw new Error("The local production evidence CRM gateway must use a loopback URL.");
  }
  if (crm.username || crm.password) throw new Error("The local production evidence CRM gateway URL must not contain credentials.");
  const accessJwksUrl = process.env.NOTICE_EVIDENCE_ACCESS_JWKS_URL?.trim();
  if (!accessJwksUrl) throw new Error("NOTICE_EVIDENCE_ACCESS_JWKS_URL is required for the local production evidence suite.");
  const accessJwks = new URL(accessJwksUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(accessJwks.hostname) || !["http:", "https:"].includes(accessJwks.protocol)) {
    throw new Error("The local production evidence JWKS endpoint must use a loopback URL.");
  }
  if (accessJwks.username || accessJwks.password) throw new Error("The local production evidence JWKS URL must not contain credentials.");

  return {
    NOTICE_APP_MODE: "production",
    NOTICE_DEPLOYMENT_MODEL: "self-hosted",
    NOTICE_WORKSPACE_ID: process.env.NOTICE_EVIDENCE_WORKSPACE_ID?.trim() || "production-evidence",
    NOTICE_WORKSPACE_NAME: "Notice production evidence",
    NOTICE_PUBLIC_BASE_URL: "https://production-evidence.notice.test",
    NOTICE_BOOTSTRAP_ENABLED: "true",
    NOTICE_BOOTSTRAP_ADMIN_EMAILS:
      process.env.NOTICE_EVIDENCE_ADMIN_EMAILS?.trim()
      || "admin@production-evidence.notice.test,backup-admin@production-evidence.notice.test",
    NOTICE_AUTH_MODE: "cloudflare-access",
    NOTICE_TRUST_IDENTITY_HEADERS: "false",
    NOTICE_ACCESS_TEAM_DOMAIN: LOCAL_EVIDENCE_ACCESS_TEAM_DOMAIN,
    NOTICE_ACCESS_AUDIENCE: LOCAL_EVIDENCE_ACCESS_AUDIENCE,
    NOTICE_INTERNAL_ACCESS_JWKS_URL: accessJwks.toString(),
    NOTICE_JOB_RUNNER_SECRET: LOCAL_EVIDENCE_JOB_SECRET,
    NOTICE_OUTBOX_CRON: "*/5 * * * *",
    NOTICE_RETENTION_CRON: "15 2 * * *",
    NOTICE_AUDIT_SIGNING_KEY: LOCAL_EVIDENCE_AUDIT_KEY,
    NOTICE_RETENTION_PURGE_GRACE_DAYS: "30",
    NOTICE_MAIL_ENABLED: "true",
    NOTICE_MAIL_PROVIDER: "delivery-gateway",
    NOTICE_MAIL_CONFIGURED: "true",
    NOTICE_DELIVERY_GATEWAY_URL: delivery.toString(),
    NOTICE_DELIVERY_GATEWAY_SECRET: LOCAL_EVIDENCE_DELIVERY_SECRET,
    // The production-evidence fixture proves the secure baseline: operators
    // may prepare a scoped portal round and record a reviewed manual delivery,
    // but Notice cannot emit an external counterparty email until the separate
    // negotiation-specific acceptance has been promoted after validation.
    NOTICE_NEGOTIATION_MAIL_ACCEPTED: "false",
    NOTICE_COUNTERPARTY_PORTAL_ENABLED: "true",
    NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS: "72",
    NOTICE_EMAIL_CAPTURE_ENABLED: "false",
    NOTICE_EMAIL_CAPTURE_PROVIDER: "none",
    NOTICE_EMAIL_CAPTURE_CONFIGURED: "false",
    NOTICE_CRM_ENABLED: "true",
    NOTICE_CRM_PROVIDER: "custom",
    NOTICE_CRM_MAPPING_VERSION: "v1",
    NOTICE_CRM_CONFIGURED: "true",
    NOTICE_CRM_GATEWAY_URL: crm.toString(),
    NOTICE_CRM_GATEWAY_SECRET: LOCAL_EVIDENCE_CRM_SECRET,
    NOTICE_ESIGN_ENABLED: "true",
    NOTICE_ESIGN_PROVIDER: "docuseal",
    NOTICE_ESIGN_CONFIGURED: "true",
    NOTICE_DOCUSEAL_DEPLOYMENT: "self-hosted",
    NOTICE_DOCUSEAL_API_BASE_URL: new URL("/api", delivery.origin).toString(),
    NOTICE_DOCUSEAL_API_TOKEN: "local-only-synthetic-docuseal-token",
    NOTICE_DOCUSEAL_WEBHOOK_SECRET: LOCAL_EVIDENCE_WEBHOOK_SECRET,
    NOTICE_DOCUSEAL_TEMPLATE_ID: "1",
    NOTICE_DOCUSEAL_VALIDATED_RELEASE: "3.2.1",
    NOTICE_DOCUSEAL_API_CLIENT_CONTRACT: "1.0.24",
    NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "true",
    NOTICE_DOCUSEAL_EXPIRATION_HOURS: "168",
    NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED: "true",
    NOTICE_DOCUSEAL_MCP_ENABLED: "false",
    NOTICE_SCAN_ENABLED: "true",
    NOTICE_SCAN_PROVIDER: "scan-gateway",
    NOTICE_SCAN_CONFIGURED: "true",
    NOTICE_SCAN_GATEWAY_URL: new URL("/scan", delivery.origin).toString(),
    NOTICE_SCAN_GATEWAY_SECRET: LOCAL_EVIDENCE_SCAN_SECRET,
    NOTICE_SCAN_OCR_ENABLED: "false",
    [LOCAL_SCHEMA_BOOTSTRAP_BINDING]: LOCAL_SCHEMA_BOOTSTRAP_VALUE,
  };
}

export default defineConfig(async ({ command }) => {
  if (isExplicitLocalEvaluation && isExplicitLocalProductionEvidence) {
    throw new Error("Choose either local evaluation or local production evidence mode, not both.");
  }
  if (command !== "serve" && (isExplicitLocalEvaluation || isExplicitLocalProductionEvidence)) {
    throw new Error("Local Notice test modes may only be used with the Vite development server.");
  }

  const localVars: Record<string, string> = isExplicitLocalEvaluation
    ? { NOTICE_APP_MODE: "evaluation", NOTICE_SCAN_OCR_ENABLED: "false" }
    : isExplicitLocalProductionEvidence
      ? productionEvidenceVars()
      : {};
  const localPersistPath = isExplicitLocalProductionEvidence
    ? process.env.NOTICE_LOCAL_PERSIST_PATH?.trim()
    : undefined;
  const localBindingConfig = {
    main: "vinext/server/app-router-entry",
    // These switches are intentionally limited to local Vite validation. A
    // deployment receives no fallback bindings and continues to fail closed.
    vars: localVars,
    d1_databases: [
      {
        binding: "DB",
        database_name: "notice-local-d1",
        database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
      },
    ],
    r2_buckets: [
      {
        binding: "DOCUMENTS",
        bucket_name: "notice-local-documents",
      },
    ],
  };

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        ...(isExplicitLocalEvaluation || isExplicitLocalProductionEvidence
          ? { config: localBindingConfig }
          : {}),
        persistState: localPersistPath ? { path: localPersistPath } : true,
      }),
    ],
  };
});

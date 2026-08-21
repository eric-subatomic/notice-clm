import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createDeploymentPlan,
  generatedWranglerPath,
  isValidCronSchedule,
  parseDeploymentManifest,
  renderWranglerConfiguration,
  requiredSecretNames,
  serializeWranglerConfiguration,
} from "../scripts/deployment-manifest.ts";

// Production validation deliberately rejects RFC-reserved documentation domains.
// This syntactically public fixture stays beneath invalid.iana.org, and these tests
// never resolve it, send mail to it, or perform network I/O against it.
const INERT_PRODUCTION_FIXTURE_ZONE = "notice-fixture.invalid.iana.org";
const INERT_ACCESS_TEAM_ORIGIN = "https://notice-fixture-invalid-iana-org.cloudflareaccess.com";

function validManifestInput(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "staging",
    deploymentModel: "hosted",
    workerName: "notice-fixture-staging",
    customDomain: `app.${INERT_PRODUCTION_FIXTURE_ZONE}`,
    workspace: {
      id: "fixture-staging",
      name: "Fixture Organization staging",
      bootstrap: {
        enabled: true,
        adminEmails: [
          `Admin.One@${INERT_PRODUCTION_FIXTURE_ZONE}`,
          `admin.two@${INERT_PRODUCTION_FIXTURE_ZONE}`,
        ],
      },
    },
    identity: {
      mode: "cloudflare-access",
      teamDomain: INERT_ACCESS_TEAM_ORIGIN,
      audience: "4f6d44b1e5d94df69a28c7f30aa95f2f3ad11b1f8e224f89b56afd24ec98bb54",
    },
    docuseal: {
      enabled: true,
      configured: false,
      deployment: "cloud-global",
      apiBaseUrl: "https://api.docuseal.com",
      templateId: 42,
      validatedRelease: "3.2.1",
      apiClientContract: "1.0.24",
      htmlSubmissionsEntitled: true,
      expirationHours: 168,
      email2faRequired: true,
      mcp: { enabled: false },
    },
    scanner: {
      enabled: true,
      configured: false,
      gatewayUrl: `https://scanner.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/scan`,
      ocr: {
        enabled: true,
        modelId: "acme-vision-v2",
        profileId: "contracts-en-v1",
      },
    },
    mail: {
      enabled: true,
      configured: false,
      gatewayUrl: `https://delivery.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/events`,
    },
    counterpartyExchange: {
      automatedDeliveryAccepted: false,
      portal: { enabled: true, ttlHours: 72 },
      emailCapture: {
        enabled: true,
        configured: false,
        provider: "inbound-gateway",
        inboundDomain: `redlines.${INERT_PRODUCTION_FIXTURE_ZONE}`,
      },
    },
    crm: {
      provider: "hubspot",
      mappingVersion: "mapping-v1",
      configured: false,
      gatewayUrl: `https://crm-gateway.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/events`,
    },
    retention: { purgeGraceDays: 30 },
    schedules: {
      outbox: "*/5 * * * *",
      retention: "15 2 * * *",
    },
  };
}

function cloneInput(): Record<string, unknown> {
  return structuredClone(validManifestInput());
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${key} must be an object in the test fixture`);
  return value as Record<string, unknown>;
}

test("deployment manifest parser normalizes safe non-secret customer configuration", () => {
  const manifest = parseDeploymentManifest(validManifestInput());
  assert.equal(manifest.schemaVersion, "1.0");
  assert.deepEqual(manifest.workspace.bootstrap.adminEmails, [
    `admin.one@${INERT_PRODUCTION_FIXTURE_ZONE}`,
    `admin.two@${INERT_PRODUCTION_FIXTURE_ZONE}`,
  ]);
  assert.equal(manifest.identity.mode, "cloudflare-access");
  assert.equal(manifest.docuseal.enabled && manifest.docuseal.apiBaseUrl, "https://api.docuseal.com");
  assert.equal(
    manifest.scanner.enabled && manifest.scanner.gatewayUrl,
    `https://scanner.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/scan`,
  );
  assert.deepEqual(manifest.scanner.enabled && manifest.scanner.ocr, {
    enabled: true,
    modelId: "acme-vision-v2",
    profileId: "contracts-en-v1",
  });
  assert.equal(manifest.schedules.outbox, "*/5 * * * *");
});

test("the tracked example deliberately fails until every placeholder is replaced", () => {
  const example = JSON.parse(readFileSync(new URL("../deploy/notice.deployment.example.json", import.meta.url), "utf8"));
  assert.throws(
    () => parseDeploymentManifest(example),
    /non-placeholder|real lowercase public hostname|positive/i,
  );
});

test("deployment manifests reject secret-bearing fields and private key material at any depth", () => {
  const apiToken = cloneInput();
  objectAt(apiToken, "docuseal").apiToken = "must-not-be-here";
  assert.throws(() => parseDeploymentManifest(apiToken), /secret-bearing field/);

  const nestedClientSecret = cloneInput();
  objectAt(nestedClientSecret, "identity").clientSecret = "must-not-be-here";
  assert.throws(() => parseDeploymentManifest(nestedClientSecret), /secret-bearing field/);

  const privateKey = cloneInput();
  objectAt(privateKey, "workspace").name = "-----BEGIN PRIVATE KEY-----";
  assert.throws(() => parseDeploymentManifest(privateKey), /private key material/);
});

test("unknown top-level and nested keys fail closed", () => {
  const topLevel = cloneInput();
  topLevel.unreviewedTarget = "not-part-of-the-manifest";
  assert.throws(() => parseDeploymentManifest(topLevel), /Unrecognized key/);

  const nested = cloneInput();
  objectAt(nested, "workspace").region = "eu";
  assert.throws(() => parseDeploymentManifest(nested), /Unrecognized key/);
});

test("workspace, bootstrap, worker, and hostname placeholders or unsafe values are rejected", () => {
  const placeholderWorker = cloneInput();
  placeholderWorker.workerName = "replace-with-worker";
  assert.throws(() => parseDeploymentManifest(placeholderWorker), /non-placeholder lowercase Worker name/);

  const previewHost = cloneInput();
  previewHost.customDomain = "notice.workers.dev";
  assert.throws(() => parseDeploymentManifest(previewHost), /real lowercase public hostname/);

  const reservedHost = cloneInput();
  reservedHost.customDomain = "notice.example.com";
  assert.throws(() => parseDeploymentManifest(reservedHost), /real lowercase public hostname/);

  const duplicateAdmins = cloneInput();
  objectAt(objectAt(duplicateAdmins, "workspace"), "bootstrap").adminEmails = [
    `admin@${INERT_PRODUCTION_FIXTURE_ZONE}`,
    `ADMIN@${INERT_PRODUCTION_FIXTURE_ZONE}`,
  ];
  assert.throws(() => parseDeploymentManifest(duplicateAdmins), /duplicate email/);

  const singleAdmin = cloneInput();
  objectAt(objectAt(singleAdmin, "workspace"), "bootstrap").adminEmails = [`admin@${INERT_PRODUCTION_FIXTURE_ZONE}`];
  assert.throws(() => parseDeploymentManifest(singleAdmin), /at least two distinct verified administrators/);

  const retiredBootstrap = cloneInput();
  objectAt(objectAt(retiredBootstrap, "workspace"), "bootstrap").enabled = false;
  assert.throws(() => parseDeploymentManifest(retiredBootstrap), /must be empty when bootstrap is disabled/);
});

test("identity modes are exact and reject incomplete or unsafe Cloudflare Access configuration", () => {
  const trusted = cloneInput();
  trusted.identity = { mode: "trusted-headers" };
  assert.equal(parseDeploymentManifest(trusted).identity.mode, "trusted-headers");

  const missingAudience = cloneInput();
  delete objectAt(missingAudience, "identity").audience;
  assert.throws(() => parseDeploymentManifest(missingAudience), /audience/);

  const unsafeTeam = cloneInput();
  objectAt(unsafeTeam, "identity").teamDomain = `https://login.${INERT_PRODUCTION_FIXTURE_ZONE}`;
  assert.throws(() => parseDeploymentManifest(unsafeTeam), /cloudflareaccess\.com/);

  const pathScopedTeam = cloneInput();
  objectAt(pathScopedTeam, "identity").teamDomain = `${INERT_ACCESS_TEAM_ORIGIN}/path`;
  assert.throws(() => parseDeploymentManifest(pathScopedTeam), /HTTPS origin/);

  const portScopedTeam = cloneInput();
  objectAt(portScopedTeam, "identity").teamDomain = `${INERT_ACCESS_TEAM_ORIGIN}:8443`;
  assert.throws(() => parseDeploymentManifest(portScopedTeam), /cloudflareaccess\.com origin/);

  const extraTrustedSetting = cloneInput();
  extraTrustedSetting.identity = { mode: "trusted-headers", audience: "not-applicable" };
  assert.throws(() => parseDeploymentManifest(extraTrustedSetting), /Unrecognized key/);
});

test("provider combinations and endpoints fail closed", () => {
  const configuredDisabledScanner = cloneInput();
  configuredDisabledScanner.scanner = { enabled: false, configured: true };
  assert.throws(() => parseDeploymentManifest(configuredDisabledScanner), /Invalid input/);

  const disabledWithEndpoint = cloneInput();
  disabledWithEndpoint.mail = {
    enabled: false,
    configured: false,
    gatewayUrl: `https://delivery.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/events`,
  };
  assert.throws(() => parseDeploymentManifest(disabledWithEndpoint), /Unrecognized key/);

  const prematureNegotiationMailAcceptance = cloneInput();
  objectAt(prematureNegotiationMailAcceptance, "counterpartyExchange").automatedDeliveryAccepted = true;
  assert.throws(() => parseDeploymentManifest(prematureNegotiationMailAcceptance), /only after the mail gateway is attested/);

  const acceptedNegotiationMail = cloneInput();
  objectAt(acceptedNegotiationMail, "mail").configured = true;
  objectAt(acceptedNegotiationMail, "counterpartyExchange").automatedDeliveryAccepted = true;
  assert.equal(parseDeploymentManifest(acceptedNegotiationMail).counterpartyExchange.automatedDeliveryAccepted, true);

  const unsafeScanner = cloneInput();
  objectAt(unsafeScanner, "scanner").gatewayUrl = `http://scanner.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/scan`;
  assert.throws(() => parseDeploymentManifest(unsafeScanner), /safe HTTPS endpoint/);

  const unsafeOcrIdentifier = cloneInput();
  objectAt(objectAt(unsafeOcrIdentifier, "scanner"), "ocr").modelId = "https://external-model.invalid";
  assert.throws(() => parseDeploymentManifest(unsafeOcrIdentifier), /bounded non-placeholder model\/profile identifier/);

  const disabledOcrWithStaleProfile = cloneInput();
  objectAt(disabledOcrWithStaleProfile, "scanner").ocr = {
    enabled: false,
    modelId: "stale-model",
    profileId: "stale-profile",
  };
  assert.throws(() => parseDeploymentManifest(disabledOcrWithStaleProfile), /Unrecognized key/);

  const docuSealPath = cloneInput();
  objectAt(docuSealPath, "docuseal").apiBaseUrl = "https://api.docuseal.com/v1";
  assert.throws(() => parseDeploymentManifest(docuSealPath), /global Cloud must use/);

  const unattestedEntitlement = cloneInput();
  objectAt(unattestedEntitlement, "docuseal").configured = true;
  objectAt(unattestedEntitlement, "docuseal").htmlSubmissionsEntitled = false;
  assert.throws(() => parseDeploymentManifest(unattestedEntitlement), /must be attested/);

  const crmNoneWithGateway = cloneInput();
  crmNoneWithGateway.crm = { provider: "none", gatewayUrl: `https://crm.${INERT_PRODUCTION_FIXTURE_ZONE}/events` };
  assert.throws(() => parseDeploymentManifest(crmNoneWithGateway), /Unrecognized key/);

  const crmMissingGateway = cloneInput();
  crmMissingGateway.crm = { provider: "salesforce", mappingVersion: "mapping-v1", configured: false };
  assert.throws(() => parseDeploymentManifest(crmMissingGateway), /gatewayUrl/);

  const crmInvalidMapping = cloneInput();
  objectAt(crmInvalidMapping, "crm").mappingVersion = "replace-me";
  assert.throws(() => parseDeploymentManifest(crmInvalidMapping), /stable non-placeholder CRM mapping version/);

  const unsupportedCrm = cloneInput();
  objectAt(unsupportedCrm, "crm").provider = "dynamics";
  assert.throws(() => parseDeploymentManifest(unsupportedCrm), /Invalid discriminator|Invalid input/);
});

test("self-hosted DocuSeal preserves its API prefix and gates same-origin MCP", () => {
  const input = cloneInput();
  input.docuseal = {
    enabled: true,
    configured: false,
    deployment: "self-hosted",
    apiBaseUrl: `https://signatures.${INERT_PRODUCTION_FIXTURE_ZONE}/tenant/api/`,
    templateId: 42,
    validatedRelease: "3.2.1",
    apiClientContract: "1.0.24",
    htmlSubmissionsEntitled: true,
    expirationHours: 72,
    email2faRequired: true,
    mcp: { enabled: true, protocolVersion: "2025-11-25", serverVersion: "3.2.1" },
  };
  const manifest = parseDeploymentManifest(input);
  assert.equal(manifest.docuseal.enabled && manifest.docuseal.apiBaseUrl, `https://signatures.${INERT_PRODUCTION_FIXTURE_ZONE}/tenant/api`);
  const rendered = renderWranglerConfiguration(manifest);
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_DEPLOYMENT, "self-hosted");
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_MCP_ENABLED, "true");
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION, "2025-11-25");
  assert.ok(rendered.secrets.required.includes("NOTICE_DOCUSEAL_MCP_TOKEN"));

  const cloudMcp = cloneInput();
  objectAt(cloudMcp, "docuseal").mcp = { enabled: true, protocolVersion: "2025-11-25", serverVersion: "3.2.1" };
  assert.throws(() => parseDeploymentManifest(cloudMcp), /only for self-hosted/);

  const missingApiPrefix = cloneInput();
  objectAt(missingApiPrefix, "docuseal").deployment = "self-hosted";
  objectAt(missingApiPrefix, "docuseal").apiBaseUrl = `https://signatures.${INERT_PRODUCTION_FIXTURE_ZONE}`;
  assert.throws(() => parseDeploymentManifest(missingApiPrefix), /must end with \/api/);
});

test("cron validation accepts the documented portable subset and rejects ambiguous schedules", () => {
  for (const cron of ["*/5 * * * *", "15 2 * * *", "0 7 * * mon-fri", "0,30 8-18 * jan-dec mon-fri"]) {
    assert.equal(isValidCronSchedule(cron), true, cron);
  }
  for (const cron of ["* * * *", "61 * * * *", "0 0 * * 0", "0 0 L * *", "*/0 * * * *", "5-2 * * * *"]) {
    assert.equal(isValidCronSchedule(cron), false, cron);
  }

  const duplicate = cloneInput();
  const schedules = objectAt(duplicate, "schedules");
  schedules.retention = schedules.outbox;
  assert.throws(() => parseDeploymentManifest(duplicate), /must be distinct/);
});

test("renderer produces a portable, ignored, secret-name-only Wrangler deployment config", () => {
  const manifest = parseDeploymentManifest(validManifestInput());
  const rendered = renderWranglerConfiguration(manifest);
  assert.equal(generatedWranglerPath(manifest), ".wrangler/notice-deployment-staging.json");
  assert.equal(rendered.main, "../dist/server/index.js");
  assert.equal(rendered.workers_dev, false);
  assert.equal(rendered.preview_urls, false);
  assert.deepEqual(rendered.routes, [{ pattern: `app.${INERT_PRODUCTION_FIXTURE_ZONE}`, custom_domain: true }]);
  assert.deepEqual(rendered.d1_databases, [{ binding: "DB", migrations_dir: "../drizzle" }]);
  assert.deepEqual(rendered.r2_buckets, [{ binding: "DOCUMENTS" }]);
  assert.equal("database_id" in rendered.d1_databases[0], false);
  assert.equal("bucket_name" in rendered.r2_buckets[0], false);
  assert.equal(rendered.vars.NOTICE_AUTH_MODE, "cloudflare-access");
  assert.equal(rendered.vars.NOTICE_TRUST_IDENTITY_HEADERS, "false");
  assert.equal(rendered.vars.NOTICE_CRM_PROVIDER, "hubspot");
  assert.equal(rendered.vars.NOTICE_CRM_MAPPING_VERSION, "mapping-v1");
  assert.equal(rendered.vars.NOTICE_NEGOTIATION_MAIL_ACCEPTED, "false");
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_VALIDATED_RELEASE, "3.2.1");
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_API_CLIENT_CONTRACT, "1.0.24");
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED, "true");
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED, "true");
  assert.equal(rendered.vars.NOTICE_DOCUSEAL_MCP_ENABLED, "false");
  assert.equal(rendered.vars.NOTICE_SCAN_OCR_ENABLED, "true");
  assert.equal(rendered.vars.NOTICE_SCAN_OCR_MODEL_ID, "acme-vision-v2");
  assert.equal(rendered.vars.NOTICE_SCAN_OCR_PROFILE_ID, "contracts-en-v1");
  assert.deepEqual(rendered.triggers.crons, ["*/5 * * * *", "15 2 * * *"]);
  assert.deepEqual(rendered.secrets.required, [
    "NOTICE_AUDIT_SIGNING_KEY",
    "NOTICE_CRM_GATEWAY_SECRET",
    "NOTICE_DELIVERY_GATEWAY_SECRET",
    "NOTICE_DOCUSEAL_API_TOKEN",
    "NOTICE_DOCUSEAL_WEBHOOK_SECRET",
    "NOTICE_INBOUND_EMAIL_SECRET",
    "NOTICE_JOB_RUNNER_SECRET",
    "NOTICE_SCAN_GATEWAY_SECRET",
  ]);
  assert.equal(JSON.stringify(rendered).includes("must-not-be-here"), false);
  assert.equal(serializeWranglerConfiguration(manifest), serializeWranglerConfiguration(manifest));
});

test("renderer selects only the secrets required by enabled providers", () => {
  const input = cloneInput();
  input.identity = { mode: "trusted-headers" };
  input.docuseal = { enabled: false, configured: false };
  input.scanner = { enabled: false, configured: false };
  input.mail = { enabled: false, configured: false };
  input.counterpartyExchange = {
    automatedDeliveryAccepted: false,
    portal: { enabled: true, ttlHours: 72 },
    emailCapture: { enabled: false, configured: false, provider: "none" },
  };
  input.crm = { provider: "none" };
  const manifest = parseDeploymentManifest(input);
  const rendered = renderWranglerConfiguration(manifest);
  assert.deepEqual(requiredSecretNames(manifest), [
    "NOTICE_AUDIT_SIGNING_KEY",
    "NOTICE_JOB_RUNNER_SECRET",
  ]);
  assert.equal(rendered.vars.NOTICE_TRUST_IDENTITY_HEADERS, "true");
  assert.equal("NOTICE_ACCESS_TEAM_DOMAIN" in rendered.vars, false);
  assert.equal("NOTICE_DOCUSEAL_API_BASE_URL" in rendered.vars, false);
  assert.equal("NOTICE_CRM_MAPPING_VERSION" in rendered.vars, false);
  assert.equal(rendered.vars.NOTICE_SCAN_OCR_ENABLED, "false");
  assert.equal("NOTICE_SCAN_OCR_MODEL_ID" in rendered.vars, false);
  assert.equal("NOTICE_SCAN_OCR_PROFILE_ID" in rendered.vars, false);
});

test("deployment plan is deterministic, redacted, and delegates installation to the fail-closed wrapper", () => {
  const manifest = parseDeploymentManifest(validManifestInput());
  const plan = createDeploymentPlan(manifest, ".wrangler/notice.deployment.staging.json");
  assert.deepEqual(plan, createDeploymentPlan(manifest, ".wrangler/notice.deployment.staging.json"));
  assert.equal(plan.bootstrap.administratorCount, 2);
  assert.equal(plan.integrations.crm, "awaiting-live-test");
  assert.equal(plan.integrations.negotiationMail, "locked");
  assert.equal(plan.integrations.emailCapture, "awaiting-live-test");
  assert.equal(plan.nextCommands[2], "node --import tsx scripts/deployment-kit.mjs render \".wrangler/notice.deployment.staging.json\"");
  assert.ok(plan.nextCommands.includes(
    "npm run deploy -- --config .wrangler/notice-deployment-staging.json --secrets-file .dev.vars.staging --confirm-empty-environment --confirm-workers-paid-plan",
  ));
  assert.equal(plan.nextCommands.some((command) => command.includes("migrations apply")), false);
  assert.equal(plan.nextCommands.some((command) => command.startsWith("npx wrangler deploy")), false);
  assert.equal(plan.preconditions.some((condition) => condition.includes("confirmed empty environment")), true);
  assert.equal(plan.preconditions.some((condition) => condition.includes("only for /api/exchange/*")), true);
  assert.equal(plan.preconditions.some((condition) => condition.includes("exact identity-edge bypass for /api/webhooks/email")), true);
  const output = JSON.stringify(plan);
  assert.equal(output.includes(`admin.one@${INERT_PRODUCTION_FIXTURE_ZONE}`), false);
  assert.equal(output.includes("4f6d44b1e5d94df69a28c7f30aa95f2f"), false);
  assert.equal(output.includes(`scanner.${INERT_PRODUCTION_FIXTURE_ZONE}`), false);
  assert.equal(output.includes("templateId"), false);
});

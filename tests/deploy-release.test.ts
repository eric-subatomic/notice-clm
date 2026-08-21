import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { NOTICE_SCHEMA_VERSION } from "../db/schema-guard";
import {
  mainFirstInstallMutationCommands,
  mainFirstInstallResumeMutationCommands,
  mainPromotionMutationCommands,
  mainReleaseModePlan,
  parseDeployArguments,
  requireBootstrapForEmptyMainRelease,
  isolatedMainBootstrapConfiguration,
  resolvedMainConfiguration,
  validateBootstrapAdminContinuity,
  validateGeneratedConfigPath,
  validateGeneratedConfiguration,
  validateSecretsFileContents,
} from "../scripts/deploy-release.mjs";
import {
  parseDeploymentManifest,
  renderWranglerConfiguration,
} from "../scripts/deployment-manifest.ts";
import {
  parseCrmGatewayManifest,
  renderCrmGatewayWranglerConfiguration,
} from "../scripts/crm-gateway-manifest.ts";
import {
  autoProvisionedResourceName,
  isolatedBootstrapTag,
  loadValidatedGeneratedConfiguration,
  loadValidatedSecretsInput,
  readStableDeploymentVersion,
  releaseSourceTag,
  rejectInternalReleaseEnvironment,
  validateConfigurationPromotion,
  validateD1ResourceAbsent,
  validateD1SchemaMarker,
  validateIsolatedBootstrapVersion,
  validateProvisionedD1Identity,
  validateR2ResourceAbsent,
  validateReleaseCheckout,
  validateStableDeployment,
  validateWorkerAbsent,
  validateWranglerAccountIdentity,
} from "../scripts/release-utils.mjs";
import {
  crmFirstInstallMutationCommands,
  crmFirstInstallResumeMutationCommands,
  crmPromotionMutationCommands,
  crmReleaseModePlan,
  isolatedCrmBootstrapConfiguration,
  parseCrmGatewayDeployArguments,
  resolvedCrmConfiguration,
  validateCrmGatewayGeneratedConfigPath,
  validateCrmGatewayGeneratedConfiguration,
} from "../scripts/deploy-crm-gateway-release.mjs";

const strong = (label: string) => `${label}-${"x".repeat(48)}`;
const accountId = "a".repeat(32);
const sourceRevision = "1".repeat(40);
const workerVersion = "123e4567-e89b-42d3-a456-426614174000";

// Production validation rejects RFC-reserved documentation domains by design.
// This syntactically public fixture remains beneath invalid.iana.org; the command
// tests mock Wrangler output and never resolve or contact the host.
const INERT_PRODUCTION_FIXTURE_ZONE = "notice-fixture.invalid.iana.org";

function generatedConfiguration(options: { negotiationDelivery?: boolean; docuseal?: boolean } = {}) {
  const negotiationDelivery = options.negotiationDelivery ?? false;
  const docuseal = options.docuseal ?? false;
  return structuredClone(renderWranglerConfiguration(parseDeploymentManifest({
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "production",
    deploymentModel: "self-hosted",
    workerName: "notice-customer-production",
    customDomain: `app.${INERT_PRODUCTION_FIXTURE_ZONE}`,
    workspace: {
      id: "customer-production",
      name: "Customer production",
      bootstrap: { enabled: false, adminEmails: [] },
    },
    identity: { mode: "trusted-headers" },
    docuseal: docuseal
      ? {
          enabled: true,
          configured: true,
          deployment: "cloud-global",
          apiBaseUrl: "https://api.docuseal.com",
          templateId: 42,
          validatedRelease: "3.2.1",
          apiClientContract: "1.0.24",
          htmlSubmissionsEntitled: true,
          expirationHours: 168,
          email2faRequired: true,
          mcp: { enabled: false },
        }
      : { enabled: false, configured: false },
    scanner: { enabled: false, configured: false },
    mail: negotiationDelivery
      ? {
          enabled: true,
          configured: true,
          gatewayUrl: `https://delivery.${INERT_PRODUCTION_FIXTURE_ZONE}/events`,
        }
      : { enabled: false, configured: false },
    counterpartyExchange: {
      automatedDeliveryAccepted: negotiationDelivery,
      portal: { enabled: true, ttlHours: 72 },
      emailCapture: { enabled: false, configured: false, provider: "none" },
    },
    crm: { provider: "none" },
    retention: { purgeGraceDays: 30 },
    schedules: { outbox: "*/5 * * * *", retention: "15 2 * * *" },
  })));
}

function generatedCrmConfiguration() {
  return structuredClone(renderCrmGatewayWranglerConfiguration(parseCrmGatewayManifest({
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "production",
    workerName: "notice-customer-crm-production",
    customDomain: `crm.${INERT_PRODUCTION_FIXTURE_ZONE}`,
    provider: {
      type: "salesforce",
      mappingVersion: "v1",
      fieldMapping: {},
      loginUrl: "https://login.salesforce.com",
      object: "Agreement__c",
      externalIdField: "Notice_External_Id__c",
      apiVersion: "v65.0",
    },
    schedules: { recovery: "*/5 * * * *" },
    retention: { terminalPayloadDays: 90, terminalMetadataDays: 365 },
  })));
}

function inspectedVersion(
  configuration: ReturnType<typeof generatedConfiguration> | ReturnType<typeof generatedCrmConfiguration>,
  options: {
    id?: string;
    tag?: string;
    variableOverrides?: Record<string, string>;
    resources: Array<{ type: string; name: string; [key: string]: unknown }>;
  },
) {
  const variables = { ...configuration.vars, ...options.variableOverrides };
  return JSON.stringify({
    id: options.id ?? workerVersion,
    annotations: { "workers/tag": options.tag ?? releaseSourceTag(sourceRevision) },
    resources: {
      bindings: [
        ...Object.entries(variables).map(([name, text]) => ({ type: "plain_text", name, text })),
        ...configuration.secrets.required.map((name) => ({ type: "secret_text", name })),
        ...options.resources,
      ],
    },
  });
}

test("release deployment modes require explicit scope and Workers Paid confirmation", () => {
  const arguments_ = [
    "first-install",
    "--config", ".wrangler/notice-deployment-production.json",
    "--secrets-file", ".dev.vars.production",
    "--confirm-empty-environment",
    "--confirm-workers-paid-plan",
  ];
  assert.deepEqual(parseDeployArguments(arguments_), {
    mode: "first-install",
    config: ".wrangler/notice-deployment-production.json",
    secretsFile: ".dev.vars.production",
    confirmedEmptyEnvironment: true,
    confirmedWorkersPaidPlan: true,
  });
  assert.deepEqual(parseCrmGatewayDeployArguments(arguments_), parseDeployArguments(arguments_));
  assert.throws(() => parseDeployArguments([]), /Choose the explicit/);
  assert.throws(
    () => parseDeployArguments(["first-install", "--config", ".wrangler/notice-deployment-production.json"]),
    /secrets file is required/,
  );
  assert.throws(
    () => parseDeployArguments([
      "first-install",
      "--config", ".wrangler/notice-deployment-production.json",
      "--secrets-file", ".dev.vars.production",
      "--confirm-workers-paid-plan",
    ]),
    /confirm-empty-environment/,
  );
  const withoutPaidConfirmation = arguments_.filter((argument) => argument !== "--confirm-workers-paid-plan");
  assert.throws(() => parseDeployArguments(withoutPaidConfirmation), /confirm-workers-paid-plan/);
  assert.throws(() => parseDeployArguments([...arguments_, "--upgrade"]), /Only first-install/);

  const promotion = [
    "configuration-promotion",
    "--config", ".wrangler/notice-deployment-production.json",
    "--expected-current-version", workerVersion,
    "--confirm-configuration-only",
    "--confirm-workers-paid-plan",
  ];
  assert.deepEqual(parseDeployArguments(promotion), {
    mode: "configuration-promotion",
    config: ".wrangler/notice-deployment-production.json",
    expectedCurrentVersion: workerVersion,
    confirmedConfigurationOnly: true,
    confirmedWorkersPaidPlan: true,
  });
  assert.throws(
    () => parseDeployArguments([...promotion, "--secrets-file", ".dev.vars.production"]),
    /secret files are forbidden/,
  );

  const resume = [
    "first-install-resume",
    "--config", ".wrangler/notice-deployment-production.json",
    "--secrets-file", ".dev.vars.production",
    "--expected-bootstrap-version", workerVersion,
    "--confirm-stranded-first-install",
    "--confirm-workers-paid-plan",
  ];
  assert.deepEqual(parseDeployArguments(resume), {
    mode: "first-install-resume",
    config: ".wrangler/notice-deployment-production.json",
    secretsFile: ".dev.vars.production",
    expectedBootstrapVersion: workerVersion,
    confirmedStrandedFirstInstall: true,
    confirmedWorkersPaidPlan: true,
  });
  assert.throws(
    () => rejectInternalReleaseEnvironment({ NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP: "true" }),
    /environment settings are forbidden/,
  );
});

test("release deployment cannot escape or substitute the ignored generated-config directory", () => {
  const cwd = "/srv/notice";
  assert.equal(
    validateGeneratedConfigPath(".wrangler/notice-deployment-production.json", cwd),
    "/srv/notice/.wrangler/notice-deployment-production.json",
  );
  assert.equal(
    validateCrmGatewayGeneratedConfigPath(".wrangler/notice-crm-gateway-production.json", cwd),
    "/srv/notice/.wrangler/notice-crm-gateway-production.json",
  );
  assert.throws(() => validateGeneratedConfigPath("wrangler.jsonc", cwd), /inside the ignored .wrangler directory/);
  assert.throws(() => validateGeneratedConfigPath(".wrangler/arbitrary.json", cwd), /filename is not a generated Notice/);
  assert.throws(
    () => validateCrmGatewayGeneratedConfigPath(".wrangler/notice-deployment-production.json", cwd),
    /filename is not a generated Notice/,
  );
});

test("exact main and CRM deployment-kit outputs retain their semantics when pinned", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "notice-release-valid-staging-"));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const ignoredRoot = join(temporaryRoot, ".wrangler");
  await mkdir(ignoredRoot, { mode: 0o700 });
  const profiles = [
    {
      filename: "notice-deployment-production.json",
      prefix: "test-main-config",
      configuration: generatedConfiguration(),
      validate: (candidate: Record<string, unknown>) => validateGeneratedConfiguration(candidate, "production"),
    },
    {
      filename: "notice-crm-gateway-production.json",
      prefix: "test-crm-config",
      configuration: generatedCrmConfiguration(),
      validate: (candidate: Record<string, unknown>) => validateCrmGatewayGeneratedConfiguration(candidate, "production"),
    },
  ];

  for (const profile of profiles) {
    const inputPath = join(ignoredRoot, profile.filename);
    await writeFile(inputPath, `${JSON.stringify(profile.configuration, null, 2)}\n`, { mode: 0o600 });
    const staged = await loadValidatedGeneratedConfiguration(
      inputPath,
      profile.prefix,
      profile.validate,
      temporaryRoot,
    );
    assert.equal(dirname(staged.path), ignoredRoot);
    assert.deepEqual(staged.configuration, profile.configuration);
    await assert.rejects(readFile(staged.path, "utf8"), /ENOENT/);
    assert.deepEqual(staged.validation, profile.validate(profile.configuration));
  }
});

test("main release validates the exact production profile and required secret-name set", () => {
  assert.deepEqual(validateGeneratedConfiguration(generatedConfiguration(), "production"), {
    workerName: "notice-customer-production",
    workspaceId: "customer-production",
    bootstrapEnabled: false,
    accountId,
    sourceRevision,
    requiredSecretNames: ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
  });
  for (const unsafe of [
    { workers_dev: true },
    { preview_urls: true },
    { main: "../worker.ts" },
    { routes: [] },
    { vars: { ...generatedConfiguration().vars, NOTICE_APP_MODE: "evaluation" } },
    { triggers: { crons: [] } },
  ]) {
    assert.throws(
      () => validateGeneratedConfiguration({ ...generatedConfiguration(), ...unsafe }, "production"),
      /deployment config|manifest/i,
    );
  }

  const omitted = generatedConfiguration();
  omitted.secrets.required.pop();
  assert.throws(() => validateGeneratedConfiguration(omitted, "production"), /exact fail-closed output/);
  const undeclared = generatedConfiguration();
  undeclared.secrets.required.push("NOTICE_CRM_GATEWAY_SECRET");
  assert.throws(() => validateGeneratedConfiguration(undeclared, "production"), /exact fail-closed output/);

  const internalBootstrap = generatedConfiguration();
  Object.assign(internalBootstrap.vars, { NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP: "true" });
  assert.throws(
    () => validateGeneratedConfiguration(internalBootstrap, "production"),
    /NOTICE_INTERNAL_\* settings are forbidden/,
  );
  const internalJwks = generatedConfiguration();
  Object.assign(internalJwks.vars, { NOTICE_INTERNAL_ACCESS_JWKS_URL: "https://attacker.invalid/jwks" });
  assert.throws(
    () => validateGeneratedConfiguration(internalJwks, "production"),
    /NOTICE_INTERNAL_\* settings are forbidden/,
  );
  const arbitraryVar = generatedConfiguration();
  Object.assign(arbitraryVar.vars, { NOTICE_UNREVIEWED_FLAG: "true" });
  assert.throws(() => validateGeneratedConfiguration(arbitraryVar, "production"), /exact fail-closed output/);
  const arbitraryBinding = { ...generatedConfiguration(), kv_namespaces: [{ binding: "UNREVIEWED" }] };
  assert.throws(() => validateGeneratedConfiguration(arbitraryBinding, "production"), /exact fail-closed output/);
  const internalSecretDeclaration = generatedConfiguration();
  internalSecretDeclaration.secrets.required.push("NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP");
  assert.throws(
    () => validateGeneratedConfiguration(internalSecretDeclaration, "production"),
    /NOTICE_INTERNAL_\* settings are forbidden/,
  );
  const arbitrarySecretDeclaration = generatedConfiguration();
  arbitrarySecretDeclaration.secrets.required.push("NOTICE_UNREVIEWED_SECRET");
  assert.throws(
    () => validateGeneratedConfiguration(arbitrarySecretDeclaration, "production"),
    /exact fail-closed output/,
  );
});

test("empty main installation requires bootstrap and retirement requires durable administrator continuity", () => {
  assert.throws(
    () => requireBootstrapForEmptyMainRelease("first-install", false),
    /requires workspace bootstrap with at least two verified administrators/,
  );
  assert.throws(
    () => requireBootstrapForEmptyMainRelease("first-install-resume", false),
    /requires workspace bootstrap with at least two verified administrators/,
  );
  assert.doesNotThrow(() => requireBootstrapForEmptyMainRelease("first-install", true));
  assert.doesNotThrow(() => requireBootstrapForEmptyMainRelease("configuration-promotion", false));

  const exactEvidence = JSON.stringify([{ results: [{
    workspace_id: "customer-production",
    active_admin_count: 2,
  }] }]);
  assert.deepEqual(validateBootstrapAdminContinuity(exactEvidence, "customer-production"), {
    workspaceId: "customer-production",
    activeAdministratorCount: 2,
  });
  assert.throws(
    () => validateBootstrapAdminContinuity(JSON.stringify([{ results: [{
      workspace_id: "other-workspace",
      active_admin_count: 4,
    }] }]), "customer-production"),
    /exact Notice workspace/,
  );
  assert.throws(
    () => validateBootstrapAdminContinuity(JSON.stringify([{ results: [{
      workspace_id: "customer-production",
      active_admin_count: 1,
    }] }]), "customer-production"),
    /at least two distinct active administrator memberships/,
  );
  assert.throws(
    () => validateBootstrapAdminContinuity(JSON.stringify([{ results: [{
      workspace_id: "customer-production",
      active_admin_count: "2",
    }] }]), "customer-production"),
    /at least two distinct active administrator memberships/,
  );
  assert.throws(
    () => validateBootstrapAdminContinuity(JSON.stringify([
      { results: [{ workspace_id: "customer-production", active_admin_count: 2 }] },
      { results: [{ workspace_id: "customer-production", active_admin_count: 2 }] },
    ]), "customer-production"),
    /one exact administrator-continuity result/,
  );
  assert.throws(
    () => validateBootstrapAdminContinuity(JSON.stringify([{
      results: { workspace_id: "customer-production", active_admin_count: 2 },
    }]), "customer-production"),
    /one exact administrator-continuity result/,
  );
  assert.throws(
    () => validateBootstrapAdminContinuity(exactEvidence, "customer-production'; SELECT 1; --"),
    /exact valid Notice workspace identifier/,
  );
  assert.throws(
    () => validateBootstrapAdminContinuity("not-json", "customer-production"),
    /did not return valid JSON/,
  );
});

test("CRM release validates its generated profile and provider-specific secret names", () => {
  assert.deepEqual(validateCrmGatewayGeneratedConfiguration(generatedCrmConfiguration(), "production"), {
    workerName: "notice-customer-crm-production",
    provider: "salesforce",
    accountId,
    sourceRevision,
    requiredSecretNames: [
      "NOTICE_CRM_SALESFORCE_CLIENT_ID",
      "NOTICE_CRM_SALESFORCE_CLIENT_SECRET",
      "NOTICE_INGRESS_SECRET",
      "NOTICE_OPERATIONS_SECRET",
    ],
  });
  assert.throws(
    () => validateCrmGatewayGeneratedConfiguration({
      ...generatedCrmConfiguration(),
      main: "../integrations/crm-gateway/wrangler.jsonc",
    }, "production"),
    /exact fail-closed output/,
  );
  const wrongProvider = generatedCrmConfiguration();
  wrongProvider.vars.NOTICE_CRM_PROVIDER = "hubspot";
  assert.throws(() => validateCrmGatewayGeneratedConfiguration(wrongProvider, "production"), /missing NOTICE_CRM_HUBSPOT/);
  const unsupported = generatedCrmConfiguration();
  unsupported.vars.NOTICE_CRM_PROVIDER = "dynamics";
  assert.throws(() => validateCrmGatewayGeneratedConfiguration(unsupported, "production"), /unsupported provider/);
  const internal = generatedCrmConfiguration();
  Object.assign(internal.vars, { NOTICE_INTERNAL_LOCAL_SCHEMA_BOOTSTRAP: "true" });
  assert.throws(
    () => validateCrmGatewayGeneratedConfiguration(internal, "production"),
    /NOTICE_INTERNAL_\* settings are forbidden/,
  );
  const arbitraryVar = generatedCrmConfiguration();
  Object.assign(arbitraryVar.vars, { NOTICE_UNREVIEWED_FLAG: "true" });
  assert.throws(() => validateCrmGatewayGeneratedConfiguration(arbitraryVar, "production"), /exact fail-closed output/);
  const arbitraryBinding = { ...generatedCrmConfiguration(), queues: { producers: [{ binding: "UNREVIEWED" }] } };
  assert.throws(() => validateCrmGatewayGeneratedConfiguration(arbitraryBinding, "production"), /exact fail-closed output/);
  const internalSecretDeclaration = generatedCrmConfiguration();
  internalSecretDeclaration.secrets.required.push("NOTICE_INTERNAL_ACCESS_JWKS_URL");
  assert.throws(
    () => validateCrmGatewayGeneratedConfiguration(internalSecretDeclaration, "production"),
    /NOTICE_INTERNAL_\* settings are forbidden/,
  );
});

test("remote target preflights fail closed on identity, inventory, deployment, and revision drift", () => {
  assert.deepEqual(
    validateWranglerAccountIdentity(JSON.stringify({
      loggedIn: true,
      accounts: [{ id: accountId, name: "Customer" }],
    }), accountId),
    { accountIdSuffix: "aaaaaa" },
  );
  assert.throws(
    () => validateWranglerAccountIdentity(JSON.stringify({ loggedIn: true, accounts: [] }), accountId),
    /not authorized for the pinned Cloudflare account/,
  );
  assert.equal(validateReleaseCheckout("", `${sourceRevision}\n`, sourceRevision), sourceRevision);
  assert.throws(() => validateReleaseCheckout(" M worker.ts\n", sourceRevision, sourceRevision), /clean checkout/);
  assert.throws(() => validateReleaseCheckout("", "2".repeat(40), sourceRevision), /does not match/);

  assert.equal(validateWorkerAbsent({ code: 1, stdout: "", stderr: "[code: 10090]" }), true);
  assert.throws(() => validateWorkerAbsent({ code: 0, stdout: "[]", stderr: "" }), /already exists/);
  assert.throws(
    () => validateWorkerAbsent({ code: 1, stdout: "", stderr: "network unavailable" }),
    /could not be proven/,
  );

  const d1Name = autoProvisionedResourceName("notice-customer-production", "DB");
  assert.equal(d1Name, "notice-customer-production-db");
  assert.equal(validateD1ResourceAbsent(JSON.stringify([{ name: "unrelated" }]), d1Name), true);
  assert.throws(
    () => validateD1ResourceAbsent(JSON.stringify([{ name: d1Name }]), d1Name),
    /requires absent auto-provision target/,
  );
  assert.equal(
    validateProvisionedD1Identity(
      JSON.stringify([{ name: d1Name, uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]),
      d1Name,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  assert.throws(
    () => validateProvisionedD1Identity(
      JSON.stringify([{ name: d1Name, uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]),
      d1Name,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    /not pinned to the expected newly provisioned database/,
  );
  const r2Name = autoProvisionedResourceName("notice-customer-production", "DOCUMENTS");
  assert.equal(r2Name, "notice-customer-production-documents");
  assert.equal(validateR2ResourceAbsent({ code: 1, stdout: "", stderr: "[code: 10006]" }, r2Name), true);
  assert.throws(
    () => validateR2ResourceAbsent({ code: 0, stdout: "{}", stderr: "" }, r2Name),
    /requires absent auto-provision target/,
  );
  assert.throws(
    () => validateR2ResourceAbsent({ code: 1, stdout: "", stderr: "permission denied" }, r2Name),
    /could not be proven/,
  );

  const deployment = JSON.stringify({ versions: [{ version_id: workerVersion, percentage: 100 }] });
  assert.equal(readStableDeploymentVersion(deployment), workerVersion);
  assert.equal(validateStableDeployment(deployment, workerVersion), workerVersion);
  assert.throws(
    () => validateStableDeployment(JSON.stringify({ versions: [
      { version_id: workerVersion, percentage: 50 },
      { version_id: "223e4567-e89b-42d3-a456-426614174000", percentage: 50 },
    ] }), workerVersion),
    /one stable Worker version/,
  );
});

test("schema marker assertions require exactly the caller-supplied main and CRM versions before activation", () => {
  assert.equal(
    validateD1SchemaMarker(
      JSON.stringify([{ results: [{ version: NOTICE_SCHEMA_VERSION }] }]),
      "version",
      NOTICE_SCHEMA_VERSION,
    ),
    NOTICE_SCHEMA_VERSION,
  );
  assert.equal(
    validateD1SchemaMarker(JSON.stringify([{ results: [{ schema_version: 2 }] }]), "schema_version", 2),
    2,
  );
  assert.throws(
    () => validateD1SchemaMarker(
      JSON.stringify([{ results: [{ version: NOTICE_SCHEMA_VERSION - 1 }] }]),
      "version",
      NOTICE_SCHEMA_VERSION,
    ),
    new RegExp(`required version=${NOTICE_SCHEMA_VERSION}`),
  );
  assert.throws(
    () => validateD1SchemaMarker(JSON.stringify([{ results: [] }]), "schema_version", 2),
    /required schema_version=2/,
  );
  assert.throws(
    () => validateD1SchemaMarker(JSON.stringify([
      { results: [{ version: 16 }] },
      { results: [{ version: 16 }] },
    ]), "version", 16),
    /mismatch/,
  );
});

test("configuration promotion permits only attestation and bootstrap retirement on the same source", () => {
  const desired = generatedConfiguration();
  const resources = [
    { type: "assets", name: "ASSETS" },
    { type: "d1", name: "DB", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { type: "r2_bucket", name: "DOCUMENTS", bucket_name: "notice-customer-production-documents" },
  ];
  const current = inspectedVersion(desired, {
    resources,
    variableOverrides: {
      NOTICE_BOOTSTRAP_ENABLED: "true",
      NOTICE_BOOTSTRAP_ADMIN_EMAILS: `admin@${INERT_PRODUCTION_FIXTURE_ZONE}`,
    },
  });
  assert.deepEqual(validateConfigurationPromotion(current, desired, {
    sourceRevision,
    attestationNames: [
      "NOTICE_ESIGN_CONFIGURED",
      "NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED",
      "NOTICE_SCAN_CONFIGURED",
      "NOTICE_MAIL_CONFIGURED",
      "NOTICE_NEGOTIATION_MAIL_ACCEPTED",
      "NOTICE_EMAIL_CAPTURE_CONFIGURED",
      "NOTICE_CRM_CONFIGURED",
    ],
    resourceBindings: [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", identityField: "id" },
      { type: "r2_bucket", name: "DOCUMENTS", identityField: "bucket_name" },
    ],
  }), {
    sourceRevision,
    bootstrapRetirement: true,
    resourceIdentities: {
      DB: { type: "d1", field: "id", value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      DOCUMENTS: {
        type: "r2_bucket",
        field: "bucket_name",
        value: "notice-customer-production-documents",
      },
    },
  });

  const changedEndpoint = inspectedVersion(desired, {
    resources,
    variableOverrides: { NOTICE_PUBLIC_BASE_URL: `https://other.${INERT_PRODUCTION_FIXTURE_ZONE}` },
  });
  assert.throws(
    () => validateConfigurationPromotion(changedEndpoint, desired, {
      sourceRevision,
      attestationNames: [],
      resourceBindings: resources.map(({ type, name }) => ({ type, name })),
    }),
    /cannot change NOTICE_PUBLIC_BASE_URL/,
  );

  const wrongSource = inspectedVersion(desired, { resources, tag: releaseSourceTag("2".repeat(40)) });
  assert.throws(
    () => validateConfigurationPromotion(wrongSource, desired, {
      sourceRevision,
      attestationNames: [],
      resourceBindings: resources.map(({ type, name }) => ({ type, name })),
    }),
    /not tagged with the manifest's exact source revision/,
  );

  const extraBinding = JSON.parse(inspectedVersion(desired, { resources }));
  extraBinding.resources.bindings.push({ type: "kv_namespace", name: "UNREVIEWED", namespace_id: "id" });
  assert.throws(
    () => validateConfigurationPromotion(JSON.stringify(extraBinding), desired, {
      sourceRevision,
      attestationNames: [],
      resourceBindings: resources.map(({ type, name }) => ({ type, name })),
    }),
    /exact existing variable, secret, and resource binding set/,
  );
});

test("configuration promotion independently gates automated negotiation delivery acceptance", () => {
  const desired = generatedConfiguration({ negotiationDelivery: true });
  const resources = [
    { type: "assets", name: "ASSETS" },
    { type: "d1", name: "DB", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { type: "r2_bucket", name: "DOCUMENTS", bucket_name: "notice-customer-production-documents" },
  ];
  const promotionOptions = {
    sourceRevision,
    attestationNames: [
      "NOTICE_MAIL_CONFIGURED",
      "NOTICE_NEGOTIATION_MAIL_ACCEPTED",
    ],
    resourceBindings: [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", identityField: "id" },
      { type: "r2_bucket", name: "DOCUMENTS", identityField: "bucket_name" },
    ],
  };
  const beforeAcceptance = inspectedVersion(desired, {
    resources,
    variableOverrides: {
      NOTICE_MAIL_CONFIGURED: "false",
      NOTICE_NEGOTIATION_MAIL_ACCEPTED: "false",
    },
  });

  assert.deepEqual(validateConfigurationPromotion(beforeAcceptance, desired, promotionOptions), {
    sourceRevision,
    bootstrapRetirement: false,
    resourceIdentities: {
      DB: { type: "d1", field: "id", value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      DOCUMENTS: {
        type: "r2_bucket",
        field: "bucket_name",
        value: "notice-customer-production-documents",
      },
    },
  });

  const missingGatewayAttestation = structuredClone(desired);
  missingGatewayAttestation.vars.NOTICE_MAIL_CONFIGURED = "false";
  const unsafeCurrent = inspectedVersion(missingGatewayAttestation, {
    resources,
    variableOverrides: { NOTICE_NEGOTIATION_MAIL_ACCEPTED: "false" },
  });
  assert.throws(
    () => validateConfigurationPromotion(unsafeCurrent, missingGatewayAttestation, promotionOptions),
    /cannot accept automated negotiation delivery/,
  );

  const missingPortal = structuredClone(desired);
  missingPortal.vars.NOTICE_COUNTERPARTY_PORTAL_ENABLED = "false";
  const unsafePortalCurrent = inspectedVersion(missingPortal, {
    resources,
    variableOverrides: { NOTICE_NEGOTIATION_MAIL_ACCEPTED: "false" },
  });
  assert.throws(
    () => validateConfigurationPromotion(unsafePortalCurrent, missingPortal, promotionOptions),
    /cannot accept automated negotiation delivery/,
  );
});

test("DocuSeal entitlement must be promoted before its live-tested configuration", () => {
  const desired = generatedConfiguration({ docuseal: true });
  const resources = [
    { type: "assets", name: "ASSETS" },
    { type: "d1", name: "DB", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { type: "r2_bucket", name: "DOCUMENTS", bucket_name: "notice-customer-production-documents" },
  ];
  const current = inspectedVersion(desired, {
    resources,
    variableOverrides: {
      NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED: "false",
      NOTICE_ESIGN_CONFIGURED: "false",
    },
  });
  const promotionOptions = {
    sourceRevision,
    attestationNames: [
      "NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED",
      "NOTICE_ESIGN_CONFIGURED",
    ],
    resourceBindings: [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", identityField: "id" },
      { type: "r2_bucket", name: "DOCUMENTS", identityField: "bucket_name" },
    ],
  };
  assert.throws(
    () => validateConfigurationPromotion(current, desired, promotionOptions),
    /must attest DocuSeal \/submissions\/html entitlement before a separate promotion/,
  );

  const entitlementOnly = structuredClone(desired);
  entitlementOnly.vars.NOTICE_ESIGN_CONFIGURED = "false";
  assert.equal(
    validateConfigurationPromotion(current, entitlementOnly, promotionOptions).bootstrapRetirement,
    false,
  );
  const entitledButUntested = inspectedVersion(desired, {
    resources,
    variableOverrides: { NOTICE_ESIGN_CONFIGURED: "false" },
  });
  assert.equal(
    validateConfigurationPromotion(entitledButUntested, desired, promotionOptions).bootstrapRetirement,
    false,
  );
});

test("first-install resume is bound to the exact isolated bootstrap deployment", () => {
  const desired = generatedConfiguration();
  const databaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const bucketName = "notice-customer-production-documents";
  const resources = [
    { type: "assets", name: "ASSETS" },
    { type: "d1", name: "DB", id: databaseId },
    { type: "r2_bucket", name: "DOCUMENTS", bucket_name: bucketName },
  ];
  const bootstrap = inspectedVersion(desired, {
    resources,
    id: workerVersion,
    tag: isolatedBootstrapTag("notice-customer-production", sourceRevision),
  });
  assert.deepEqual(validateIsolatedBootstrapVersion(bootstrap, desired, {
    expectedVersion: workerVersion,
    workerName: "notice-customer-production",
    sourceRevision,
    resourceBindings: [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", identityField: "id" },
      { type: "r2_bucket", name: "DOCUMENTS", identityField: "bucket_name" },
    ],
  }), {
    expectedVersion: workerVersion,
    sourceRevision,
    resourceIdentities: {
      DB: { type: "d1", field: "id", value: databaseId },
      DOCUMENTS: { type: "r2_bucket", field: "bucket_name", value: bucketName },
    },
  });
  assert.throws(
    () => validateIsolatedBootstrapVersion(bootstrap, desired, {
      expectedVersion: "223e4567-e89b-42d3-a456-426614174000",
      workerName: "notice-customer-production",
      sourceRevision,
      resourceBindings: resources.map(({ type, name }) => ({ type, name })),
    }),
    /does not match --expected-bootstrap-version/,
  );
  const changed = generatedConfiguration();
  changed.vars.NOTICE_RETENTION_PURGE_GRACE_DAYS = "31";
  assert.throws(
    () => validateIsolatedBootstrapVersion(bootstrap, changed, {
      expectedVersion: workerVersion,
      workerName: "notice-customer-production",
      sourceRevision,
      resourceBindings: resources.map(({ type, name }) => ({ type, name })),
    }),
    /cannot change NOTICE_RETENTION_PURGE_GRACE_DAYS/,
  );

  const isolatedMain = isolatedMainBootstrapConfiguration(desired);
  assert.deepEqual(isolatedMain.routes, []);
  assert.deepEqual(isolatedMain.triggers.crons, []);
  assert.equal(isolatedMain.workers_dev, false);
  assert.equal(isolatedMain.preview_urls, false);
  assert.notDeepEqual(desired.routes, []);
  assert.notDeepEqual(desired.triggers.crons, []);
  const isolatedCrm = isolatedCrmBootstrapConfiguration(generatedCrmConfiguration());
  assert.deepEqual(isolatedCrm.routes, []);
  assert.deepEqual(isolatedCrm.triggers.crons, []);
  assert.equal(isolatedCrm.workers_dev, false);
  assert.equal(isolatedCrm.preview_urls, false);

  const resolvedMain = resolvedMainConfiguration(desired, {
    DB: { type: "d1", field: "id", value: databaseId },
    DOCUMENTS: { type: "r2_bucket", field: "bucket_name", value: bucketName },
  });
  assert.deepEqual(resolvedMain.d1_databases, [{
    binding: "DB",
    migrations_dir: "../drizzle",
    database_name: "notice-customer-production-db",
    database_id: databaseId,
  }]);
  assert.deepEqual(resolvedMain.r2_buckets, [{ binding: "DOCUMENTS", bucket_name: bucketName }]);
  const crmDesired = generatedCrmConfiguration();
  const resolvedCrm = resolvedCrmConfiguration(crmDesired, {
    CRM_DB: { type: "d1", field: "id", value: databaseId },
  });
  assert.deepEqual(resolvedCrm.d1_databases, [{
    binding: "CRM_DB",
    migrations_dir: "../integrations/crm-gateway/migrations",
    database_name: "notice-customer-crm-production-crm-db",
    database_id: databaseId,
  }]);
});

test("release command sequences gate activation behind migrations, exact schema, and concurrency rechecks", () => {
  const secrets = ["--secrets-file", ".dev.vars.production"];
  const hasArgument = (step: object | undefined, argument: string) => (
    step !== undefined
    && "args" in step
    && Array.isArray(step.args)
    && step.args.includes(argument)
  );
  const mainFirst = mainFirstInstallMutationCommands(
    "npx", "main.json", secrets, "notice-main", sourceRevision,
    "main-bootstrap.json", "main-activation.json",
  );
  const crmFirst = crmFirstInstallMutationCommands(
    "npx", "crm.json", secrets, "notice-crm", sourceRevision,
    "crm-bootstrap.json", "crm-activation.json",
  );
  assert.deepEqual(mainFirst.map((step) => step.id), [
    "isolated-bootstrap-deploy", "bootstrap-proof", "isolation-reset", "migration-list",
    "migration-apply", "schema-marker", "isolation-final-reset", "bootstrap-stable", "activate",
  ]);
  assert.deepEqual(crmFirst.map((step) => step.id), [
    "isolated-bootstrap-deploy", "bootstrap-proof", "isolation-reset", "migration-list",
    "migration-apply", "schema-marker", "isolation-final-reset", "bootstrap-stable", "activate",
  ]);

  const mainResume = mainFirstInstallResumeMutationCommands(
    "npx", "main.json", secrets, sourceRevision, "main-bootstrap.json", "main-activation.json",
  );
  const crmResume = crmFirstInstallResumeMutationCommands(
    "npx", "crm.json", secrets, sourceRevision, "crm-bootstrap.json", "crm-activation.json",
  );
  assert.deepEqual(mainResume.map((step) => step.id), [
    "isolation-reset", "migration-list", "migration-apply", "schema-marker",
    "isolation-final-reset", "bootstrap-stable", "activate",
  ]);
  assert.deepEqual(crmResume.map((step) => step.id), [
    "isolation-reset", "migration-list", "migration-apply", "schema-marker",
    "isolation-final-reset", "bootstrap-stable", "activate",
  ]);
  const plannedMainResume = mainReleaseModePlan(
    "first-install-resume", "npx", "main.json", secrets, "notice-main", sourceRevision,
    "main-bootstrap.json", "main-activation.json",
  );
  const plannedCrmResume = crmReleaseModePlan(
    "first-install-resume", "npx", "crm.json", secrets, "notice-crm", sourceRevision,
    "crm-bootstrap.json", "crm-activation.json",
  );
  assert.equal(plannedMainResume.preflight, "isolated-bootstrap");
  assert.equal(plannedCrmResume.preflight, "isolated-bootstrap");
  for (const plan of [plannedMainResume, plannedCrmResume]) {
    assert.equal(plan.mutations[0].id, "isolation-reset");
  }

  const mainPromotion = mainPromotionMutationCommands("npx", "main.json", sourceRevision);
  const crmPromotion = crmPromotionMutationCommands("npx", "crm.json", sourceRevision);
  assert.deepEqual(mainPromotion.map((step) => step.id), [
    "schema-marker", "stable-deployment", "activate",
  ]);
  assert.deepEqual(crmPromotion.map((step) => step.id), [
    "schema-marker", "stable-deployment", "activate",
  ]);
  for (const sequence of [mainPromotion, crmPromotion]) {
    assert.ok(sequence.findIndex((step) => step.id === "schema-marker") < sequence.findIndex((step) => step.id === "activate"));
    assert.ok(sequence.findIndex((step) => step.id === "stable-deployment") < sequence.findIndex((step) => step.id === "activate"));
    assert.equal(sequence.some((step) => hasArgument(step, "--secrets-file")), false);
  }
  for (const sequence of [mainFirst, crmFirst]) {
    assert.equal(hasArgument(sequence[0], "--x-provision"), true);
    assert.equal(hasArgument(sequence[0], "versions"), false);
    assert.equal(hasArgument(sequence.at(-1), "--x-provision"), false);
  }
  for (const sequence of [mainResume, crmResume]) {
    assert.equal(hasArgument(sequence.at(-1), "--x-provision"), false);
  }
  for (const [sequence, bootstrapConfig, activationConfig] of [
    [mainFirst, "main-bootstrap.json", "main-activation.json"],
    [crmFirst, "crm-bootstrap.json", "crm-activation.json"],
    [mainResume, "main-bootstrap.json", "main-activation.json"],
    [crmResume, "crm-bootstrap.json", "crm-activation.json"],
  ] as const) {
    for (const step of sequence.filter((candidate) => [
      "isolation-reset", "migration-list", "migration-apply", "isolation-final-reset",
    ].includes(candidate.id))) {
      assert.equal(hasArgument(step, bootstrapConfig), true);
      assert.equal(hasArgument(step, activationConfig), false);
    }
    assert.equal(hasArgument(sequence.at(-1), activationConfig), true);
  }

  const runnerMarker = Object.freeze({ kind: "pinned-wrangler-runner" });
  const plans = [
    mainReleaseModePlan(
      "first-install", runnerMarker, "main.json", secrets, "notice-main", sourceRevision,
      "main-bootstrap.json", "main-activation.json",
    ),
    mainReleaseModePlan(
      "first-install-resume", runnerMarker, "main.json", secrets, "notice-main", sourceRevision,
      "main-bootstrap.json", "main-activation.json",
    ),
    mainReleaseModePlan(
      "configuration-promotion", runnerMarker, "main-promotion.json", [], "notice-main", sourceRevision,
      "main-promotion.json", "main-promotion.json",
    ),
    crmReleaseModePlan(
      "first-install", runnerMarker, "crm.json", secrets, "notice-crm", sourceRevision,
      "crm-bootstrap.json", "crm-activation.json",
    ),
    crmReleaseModePlan(
      "first-install-resume", runnerMarker, "crm.json", secrets, "notice-crm", sourceRevision,
      "crm-bootstrap.json", "crm-activation.json",
    ),
    crmReleaseModePlan(
      "configuration-promotion", runnerMarker, "crm-promotion.json", [], "notice-crm", sourceRevision,
      "crm-promotion.json", "crm-promotion.json",
    ),
  ];
  for (const plan of plans) {
    const commands = plan.mutations.filter((step) => "command" in step);
    assert.ok(commands.length > 0);
    assert.equal(commands.every((step) => step.command === runnerMarker), true);
  }
});

test("secret-file validation checks required keys and strength without returning or exposing values", () => {
  const audit = strong("audit");
  const jobs = strong("jobs");
  const result = validateSecretsFileContents(
    `NOTICE_AUDIT_SIGNING_KEY=${audit}\nNOTICE_JOB_RUNNER_SECRET=${jobs}\n`,
    ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
  );
  assert.deepEqual(result, {
    requiredSecretNames: ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    suppliedSecretNames: ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
  });
  assert.equal(JSON.stringify(result).includes(audit), false);
  assert.equal(JSON.stringify(result).includes(jobs), false);

  const reused = strong("reused-purpose-secret");
  let reusedMessage = "";
  try {
    validateSecretsFileContents(
      `NOTICE_AUDIT_SIGNING_KEY=${reused}\nNOTICE_JOB_RUNNER_SECRET=${reused}\n`,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    );
  } catch (error) {
    reusedMessage = error instanceof Error ? error.message : String(error);
  }
  assert.match(reusedMessage, /must contain distinct values/);
  assert.equal(reusedMessage.includes(reused), false);

  const missingValue = strong("sensitive-never-print");
  let message = "";
  try {
    validateSecretsFileContents(
      `NOTICE_AUDIT_SIGNING_KEY=${missingValue}\n`,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /NOTICE_JOB_RUNNER_SECRET/);
  assert.equal(message.includes(missingValue), false);
  assert.throws(
    () => validateSecretsFileContents(
      "NOTICE_AUDIT_SIGNING_KEY=short\nNOTICE_JOB_RUNNER_SECRET=also-short\n",
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    ),
    /NOTICE_AUDIT_SIGNING_KEY does not meet/,
  );
  assert.throws(
    () => validateSecretsFileContents(JSON.stringify({
      NOTICE_AUDIT_SIGNING_KEY: ` ${"x".repeat(30)} `,
      NOTICE_JOB_RUNNER_SECRET: jobs,
    }), ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"]),
    /must not contain leading\/trailing whitespace/,
  );
  const whitespaceCollision = strong("runtime-collision");
  let whitespaceCollisionMessage = "";
  try {
    validateSecretsFileContents(JSON.stringify({
      NOTICE_AUDIT_SIGNING_KEY: whitespaceCollision,
      NOTICE_JOB_RUNNER_SECRET: `${whitespaceCollision} `,
    }), ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"]);
  } catch (error) {
    whitespaceCollisionMessage = error instanceof Error ? error.message : String(error);
  }
  assert.match(whitespaceCollisionMessage, /must not contain leading\/trailing whitespace/);
  assert.equal(whitespaceCollisionMessage.includes(whitespaceCollision), false);
  assert.throws(
    () => validateSecretsFileContents(JSON.stringify({
      NOTICE_AUDIT_SIGNING_KEY: `${audit}\n`,
      NOTICE_JOB_RUNNER_SECRET: jobs,
    }), ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"]),
    /control characters/,
  );
  assert.throws(
    () => validateSecretsFileContents(
      `NOTICE_AUDIT_SIGNING_KEY=${audit}\nNOTICE_AUDIT_SIGNING_KEY=${strong("duplicate")}\nNOTICE_JOB_RUNNER_SECRET=${jobs}\n`,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    ),
    /declares NOTICE_AUDIT_SIGNING_KEY more than once/,
  );
  assert.throws(
    () => validateSecretsFileContents(
      `NOTICE_AUDIT_SIGNING_KEY=${audit}\nNOTICE_JOB_RUNNER_SECRET=${jobs}\nNOTICE_UNREVIEWED_SECRET=${strong("extra")}\n`,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    ),
    /undeclared key NOTICE_UNREVIEWED_SECRET/,
  );
  assert.throws(
    () => validateSecretsFileContents(
      `NOTICE_AUDIT_SIGNING_KEY=${audit}\nNOTICE_JOB_RUNNER_SECRET=${jobs}\nNOTICE_INTERNAL_ACCESS_JWKS_URL=${strong("internal")}\n`,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    ),
    /NOTICE_INTERNAL_\* settings are forbidden/,
  );
  assert.throws(
    () => validateSecretsFileContents(
      `NOTICE_AUDIT_SIGNING_KEY=${audit}\nNOTICE_JOB_RUNNER_SECRET=${jobs}\nOPTIONAL_ROTATION_TOKEN="unterminated\n`,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    ),
    /not valid dotenv syntax/,
  );
});

test("JSON secret files support explicitly reviewed rotation while first-install sets stay exact", () => {
  const ingress = strong("ingress");
  const operations = strong("operations");
  const previous = strong("previous-ingress");
  assert.deepEqual(
    validateSecretsFileContents(JSON.stringify({
      NOTICE_INGRESS_SECRET: ingress,
      NOTICE_INGRESS_PREVIOUS_SECRET: previous,
      NOTICE_OPERATIONS_SECRET: operations,
      NOTICE_CRM_CUSTOM_SECRET: strong("custom"),
    }), ["NOTICE_INGRESS_SECRET", "NOTICE_OPERATIONS_SECRET", "NOTICE_CRM_CUSTOM_SECRET"], [
      "NOTICE_INGRESS_PREVIOUS_SECRET",
    ]),
    {
      requiredSecretNames: ["NOTICE_CRM_CUSTOM_SECRET", "NOTICE_INGRESS_SECRET", "NOTICE_OPERATIONS_SECRET"],
      suppliedSecretNames: [
        "NOTICE_CRM_CUSTOM_SECRET",
        "NOTICE_INGRESS_PREVIOUS_SECRET",
        "NOTICE_INGRESS_SECRET",
        "NOTICE_OPERATIONS_SECRET",
      ],
    },
  );
  assert.throws(
    () => validateSecretsFileContents(JSON.stringify({
      NOTICE_INGRESS_SECRET: ingress,
      NOTICE_INGRESS_PREVIOUS_SECRET: previous,
      NOTICE_OPERATIONS_SECRET: operations,
      NOTICE_CRM_CUSTOM_SECRET: strong("custom"),
    }), ["NOTICE_INGRESS_SECRET", "NOTICE_OPERATIONS_SECRET", "NOTICE_CRM_CUSTOM_SECRET"]),
    /undeclared key NOTICE_INGRESS_PREVIOUS_SECRET/,
  );
  assert.throws(
    () => validateSecretsFileContents(JSON.stringify({
      NOTICE_INGRESS_SECRET: ingress,
      NOTICE_OPERATIONS_SECRET: ingress,
      NOTICE_CRM_CUSTOM_SECRET: strong("custom"),
    }), ["NOTICE_INGRESS_SECRET", "NOTICE_OPERATIONS_SECRET", "NOTICE_CRM_CUSTOM_SECRET"]),
    /must contain distinct values/,
  );
  assert.throws(
    () => validateSecretsFileContents(JSON.stringify({
      NOTICE_INGRESS_SECRET: ingress,
      NOTICE_OPERATIONS_SECRET: operations,
      NOTICE_CRM_CUSTOM_SECRET: strong("custom"),
      NOTICE_CRM_HUBSPOT_ACCESS_TOKEN: strong("wrong-provider"),
    }), ["NOTICE_INGRESS_SECRET", "NOTICE_OPERATIONS_SECRET", "NOTICE_CRM_CUSTOM_SECRET"], [
      "NOTICE_INGRESS_PREVIOUS_SECRET",
    ]),
    /undeclared key NOTICE_CRM_HUBSPOT_ACCESS_TOKEN/,
  );
  const invalidOperations = `${"x".repeat(24)} ${"y".repeat(24)}`;
  let invalidOperationsMessage = "";
  try {
    validateSecretsFileContents(JSON.stringify({
      NOTICE_INGRESS_SECRET: ingress,
      NOTICE_OPERATIONS_SECRET: invalidOperations,
      NOTICE_CRM_CUSTOM_SECRET: strong("custom"),
    }), ["NOTICE_INGRESS_SECRET", "NOTICE_OPERATIONS_SECRET", "NOTICE_CRM_CUSTOM_SECRET"]);
  } catch (error) {
    invalidOperationsMessage = error instanceof Error ? error.message : String(error);
  }
  assert.match(invalidOperationsMessage, /visible ASCII characters only/);
  assert.equal(invalidOperationsMessage.includes(invalidOperations), false);
});

test("every signing, HMAC, and bearer purpose requires an independent first-install secret", () => {
  const names = [
    "NOTICE_AUDIT_SIGNING_KEY",
    "NOTICE_CRM_CUSTOM_SECRET",
    "NOTICE_CRM_GATEWAY_SECRET",
    "NOTICE_DELIVERY_GATEWAY_SECRET",
    "NOTICE_DOCUSEAL_API_TOKEN",
    "NOTICE_DOCUSEAL_MCP_TOKEN",
    "NOTICE_DOCUSEAL_WEBHOOK_SECRET",
    "NOTICE_INGRESS_PREVIOUS_SECRET",
    "NOTICE_INGRESS_SECRET",
    "NOTICE_INBOUND_EMAIL_SECRET",
    "NOTICE_JOB_RUNNER_SECRET",
    "NOTICE_OPERATIONS_SECRET",
    "NOTICE_SCAN_GATEWAY_SECRET",
  ];
  const values = Object.fromEntries(names.map((name, index) => [name, strong(`purpose-${index}`)]));
  values.NOTICE_DOCUSEAL_WEBHOOK_SECRET = `whsec_${"a".repeat(32)}`;
  assert.doesNotThrow(() => validateSecretsFileContents(JSON.stringify(values), names));
  assert.throws(
    () => validateSecretsFileContents(
      JSON.stringify({ NOTICE_INBOUND_EMAIL_SECRET: "é".repeat(3_000) }),
      ["NOTICE_INBOUND_EMAIL_SECRET"],
    ),
    /maximum byte length/,
  );

  for (const name of names.slice(1)) {
    const reused = name === "NOTICE_DOCUSEAL_WEBHOOK_SECRET"
      ? `whsec_${"r".repeat(32)}`
      : strong(`reused-${name.toLowerCase()}`);
    const candidate = { ...values, NOTICE_AUDIT_SIGNING_KEY: reused, [name]: reused };
    let message = "";
    try {
      validateSecretsFileContents(JSON.stringify(candidate), names);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /must contain distinct values/);
    assert.equal(message.includes(reused), false);
  }
});

test("release wrappers reject broad-permission and symlinked secret files", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX file-mode and symlink assertions do not apply on Windows.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "notice-release-secrets-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, ".wrangler"), { recursive: true, mode: 0o700 });
  const secretsPath = join(directory, ".dev.vars.production");
  await writeFile(
    secretsPath,
    `NOTICE_AUDIT_SIGNING_KEY=${strong("audit")}\nNOTICE_JOB_RUNNER_SECRET=${strong("jobs")}\n`,
    { mode: 0o644 },
  );
  await assert.rejects(
    loadValidatedSecretsInput(
      secretsPath,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
      [],
      workspace,
    ),
    /permissions are too broad/,
  );
  await chmod(secretsPath, 0o600);
  const stagedSecrets = await loadValidatedSecretsInput(
    secretsPath,
    ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    [],
    workspace,
  );
  assert.notEqual(stagedSecrets.path, secretsPath);
  assert.deepEqual(JSON.parse(stagedSecrets.canonicalBytes.toString("utf8")), {
    NOTICE_AUDIT_SIGNING_KEY: strong("audit"),
    NOTICE_JOB_RUNNER_SECRET: strong("jobs"),
  });
  await assert.rejects(readFile(stagedSecrets.path, "utf8"), /ENOENT/);

  const linkedPath = join(directory, ".dev.vars.linked");
  await symlink(secretsPath, linkedPath);
  await assert.rejects(
    loadValidatedSecretsInput(
      linkedPath,
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
      [],
      workspace,
    ),
    /regular file, not a symlink/,
  );

  const checkoutDirectory = await mkdtemp(join(process.cwd(), "notice-release-nonignored-"));
  context.after(async () => rm(checkoutDirectory, { recursive: true, force: true }));
  const nonIgnoredPath = join(checkoutDirectory, "secrets.env");
  await writeFile(
    nonIgnoredPath,
    `NOTICE_AUDIT_SIGNING_KEY=${strong("audit")}`
      + `\nNOTICE_JOB_RUNNER_SECRET=${strong("jobs")}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    loadValidatedSecretsInput(nonIgnoredPath, ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"]),
    /must be covered by a Git ignore rule/,
  );

  const checkoutAlias = join(directory, "checkout-alias");
  await symlink(checkoutDirectory, checkoutAlias, "dir");
  await assert.rejects(
    loadValidatedSecretsInput(
      join(checkoutAlias, "secrets.env"),
      ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"],
    ),
    /must be covered by a Git ignore rule/,
  );
});

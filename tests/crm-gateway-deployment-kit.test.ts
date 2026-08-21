import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createCrmGatewayDeploymentPlan,
  generatedCrmGatewayWranglerPath,
  optionalCrmGatewayRotationSecretNames,
  parseCrmGatewayManifest,
  renderCrmGatewayWranglerConfiguration,
  requiredCrmGatewaySecretNames,
  serializeCrmGatewayWranglerConfiguration,
} from "../scripts/crm-gateway-manifest.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Production validation deliberately rejects RFC-reserved documentation domains.
// This syntactically public fixture stays beneath invalid.iana.org, and these tests
// never resolve it, send mail to it, or perform network I/O against it.
const INERT_PRODUCTION_FIXTURE_ZONE = "notice-fixture.invalid.iana.org";
const credentialedHttpsUrl = (host: string, path = "") =>
  `https://${["user", "password"].join(":")}@${host}${path}`;

function validHubSpotInput(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "staging",
    workerName: "notice-fixture-crm-staging",
    customDomain: `crm-gateway.${INERT_PRODUCTION_FIXTURE_ZONE}`,
    provider: {
      type: "hubspot",
      mappingVersion: "2026-08-02.1",
      fieldMapping: { party: "notice_counterparty" },
      apiBaseUrl: "https://api.hubapi.com",
      objectType: "2-1234567",
      idProperty: "notice_external_id",
    },
    schedules: { recovery: "*/5 * * * *" },
    retention: { terminalPayloadDays: 90, terminalMetadataDays: 365 },
  };
}

function cloneInput(): Record<string, unknown> {
  return structuredClone(validHubSpotInput());
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${key} must be an object in the test fixture`);
  return value as Record<string, unknown>;
}

test("CRM gateway manifest normalizes safe HubSpot, Salesforce, and custom configurations", () => {
  const hubspot = parseCrmGatewayManifest(validHubSpotInput());
  assert.equal(hubspot.provider.type, "hubspot");
  assert.equal(hubspot.provider.apiBaseUrl, "https://api.hubapi.com");
  assert.equal(hubspot.schedules.recovery, "*/5 * * * *");

  const salesforceInput = cloneInput();
  salesforceInput.provider = {
    type: "salesforce",
    mappingVersion: "release-7",
    fieldMapping: { party: "Counterparty__c" },
    loginUrl: "https://login.salesforce.com",
    object: "Agreement__c",
    externalIdField: "Notice_External_Id__c",
    apiVersion: "v65.0",
  };
  const salesforce = parseCrmGatewayManifest(salesforceInput);
  assert.equal(salesforce.provider.type, "salesforce");
  assert.equal(salesforce.provider.loginUrl, "https://login.salesforce.com");

  const customInput = cloneInput();
  customInput.provider = {
    type: "custom",
    mappingVersion: "release-7",
    fieldMapping: { party: "counterparty_name" },
    url: `https://integrations.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/notice/crm`,
    externalIdField: "externalId",
  };
  const custom = parseCrmGatewayManifest(customInput);
  assert.equal(custom.provider.type, "custom");
  assert.equal(custom.provider.url, `https://integrations.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/notice/crm`);
});

test("the tracked CRM gateway example deliberately fails until placeholders are replaced", () => {
  const example = JSON.parse(readFileSync(
    new URL("../deploy/crm-gateway.deployment.example.json", import.meta.url),
    "utf8",
  ));
  assert.throws(
    () => parseCrmGatewayManifest(example),
    /non-placeholder|real lowercase public hostname|HubSpot object type/i,
  );
});

test("manifests reject secret-bearing keys, credentials, private keys, and unknown fields", () => {
  const token = cloneInput();
  objectAt(token, "provider").accessToken = "must-not-be-here";
  assert.throws(() => parseCrmGatewayManifest(token), /secret-bearing field/);

  const clientId = cloneInput();
  objectAt(clientId, "provider").clientId = "must-not-be-here";
  assert.throws(() => parseCrmGatewayManifest(clientId), /secret-bearing field/);

  const privateKey = cloneInput();
  objectAt(privateKey, "provider").objectType = "-----BEGIN PRIVATE KEY-----";
  assert.throws(() => parseCrmGatewayManifest(privateKey), /private key material/);

  const unknown = cloneInput();
  unknown.unreviewedTarget = "not-part-of-the-manifest";
  assert.throws(() => parseCrmGatewayManifest(unknown), /Unrecognized key/);
});

test("worker, route, upstream endpoint, and cron validation fail closed", () => {
  const worker = cloneInput();
  worker.workerName = "replace-with-worker";
  assert.throws(() => parseCrmGatewayManifest(worker), /non-placeholder lowercase Worker name/);

  const preview = cloneInput();
  preview.customDomain = "notice-crm.workers.dev";
  assert.throws(() => parseCrmGatewayManifest(preview), /real lowercase public hostname/);

  const unsafeCustom = cloneInput();
  unsafeCustom.provider = {
    type: "custom",
    mappingVersion: "v1",
    fieldMapping: {},
    url: credentialedHttpsUrl(`crm.${INERT_PRODUCTION_FIXTURE_ZONE}`, "/events"),
    externalIdField: "externalId",
  };
  assert.throws(() => parseCrmGatewayManifest(unsafeCustom), /safe public HTTPS endpoint/);

  const hubspotImpostor = cloneInput();
  objectAt(hubspotImpostor, "provider").apiBaseUrl = "https://api.hubapi.example.net";
  assert.throws(() => parseCrmGatewayManifest(hubspotImpostor), /approved HTTPS origin/);

  const placeholderObject = cloneInput();
  objectAt(placeholderObject, "provider").objectType = "replace-with-object-type";
  assert.throws(() => parseCrmGatewayManifest(placeholderObject), /non-placeholder HubSpot object type/);

  const badCron = cloneInput();
  objectAt(badCron, "schedules").recovery = "*/0 * * * *";
  assert.throws(() => parseCrmGatewayManifest(badCron), /five-field Cloudflare cron/);

  const unsafeRetention = cloneInput();
  objectAt(unsafeRetention, "retention").terminalMetadataDays = 30;
  assert.throws(() => parseCrmGatewayManifest(unsafeRetention), /greater than or equal to terminalPayloadDays/);
});

test("field mappings reject unknown, provider-invalid, duplicate, and mismatched external ID targets", () => {
  const unknown = cloneInput();
  objectAt(objectAt(unknown, "provider"), "fieldMapping").notCanonical = "notice_unknown";
  assert.throws(() => parseCrmGatewayManifest(unknown), /supported canonical CRM field/);

  const invalidName = cloneInput();
  objectAt(objectAt(invalidName, "provider"), "fieldMapping").party = "not-valid-for-hubspot!";
  assert.throws(() => parseCrmGatewayManifest(invalidName), /valid, unique destination field names/);

  const duplicate = cloneInput();
  objectAt(objectAt(duplicate, "provider"), "fieldMapping").party = "notice_agreement_type";
  assert.throws(() => parseCrmGatewayManifest(duplicate), /valid, unique destination field names/);

  const externalId = cloneInput();
  objectAt(objectAt(externalId, "provider"), "fieldMapping").externalId = "different_external_id";
  assert.throws(() => parseCrmGatewayManifest(externalId), /keep externalId equal/);
});

test("required secret output is exact and provider-specific", () => {
  const hubspot = parseCrmGatewayManifest(validHubSpotInput());
  assert.deepEqual(requiredCrmGatewaySecretNames(hubspot), [
    "NOTICE_CRM_HUBSPOT_ACCESS_TOKEN",
    "NOTICE_INGRESS_SECRET",
    "NOTICE_OPERATIONS_SECRET",
  ]);

  const salesforceInput = cloneInput();
  salesforceInput.provider = {
    type: "salesforce",
    mappingVersion: "v1",
    fieldMapping: {},
    loginUrl: "https://login.salesforce.com",
    object: "Agreement__c",
    externalIdField: "Notice_External_Id__c",
    apiVersion: "v65.0",
  };
  assert.deepEqual(requiredCrmGatewaySecretNames(parseCrmGatewayManifest(salesforceInput)), [
    "NOTICE_CRM_SALESFORCE_CLIENT_ID",
    "NOTICE_CRM_SALESFORCE_CLIENT_SECRET",
    "NOTICE_INGRESS_SECRET",
    "NOTICE_OPERATIONS_SECRET",
  ]);

  const customInput = cloneInput();
  customInput.provider = {
    type: "custom",
    mappingVersion: "v1",
    fieldMapping: {},
    url: `https://integrations.${INERT_PRODUCTION_FIXTURE_ZONE}/crm/events`,
    externalIdField: "externalId",
  };
  assert.deepEqual(requiredCrmGatewaySecretNames(parseCrmGatewayManifest(customInput)), [
    "NOTICE_CRM_CUSTOM_SECRET",
    "NOTICE_INGRESS_SECRET",
    "NOTICE_OPERATIONS_SECRET",
  ]);
  assert.deepEqual(optionalCrmGatewayRotationSecretNames(), ["NOTICE_INGRESS_PREVIOUS_SECRET"]);
});

test("renderer emits unresolved D1, exact route and vars, and secret names without values", () => {
  const manifest = parseCrmGatewayManifest(validHubSpotInput());
  const rendered = renderCrmGatewayWranglerConfiguration(manifest);
  assert.equal(generatedCrmGatewayWranglerPath(manifest), ".wrangler/notice-crm-gateway-staging.json");
  assert.equal(rendered.main, "../integrations/crm-gateway/src/index.ts");
  assert.deepEqual(rendered.compatibility_flags, ["nodejs_compat"]);
  assert.equal(rendered.workers_dev, false);
  assert.equal(rendered.preview_urls, false);
  assert.deepEqual(rendered.routes, [{ pattern: `crm-gateway.${INERT_PRODUCTION_FIXTURE_ZONE}`, custom_domain: true }]);
  assert.deepEqual(rendered.d1_databases, [{
    binding: "CRM_DB",
    migrations_dir: "../integrations/crm-gateway/migrations",
  }]);
  assert.equal("database_id" in rendered.d1_databases[0], false);
  assert.equal("database_name" in rendered.d1_databases[0], false);
  assert.equal(rendered.vars.NOTICE_CRM_PROVIDER, "hubspot");
  assert.equal(rendered.vars.NOTICE_CRM_MAPPING_VERSION, "2026-08-02.1");
  assert.equal(rendered.vars.NOTICE_CRM_TERMINAL_PAYLOAD_RETENTION_DAYS, "90");
  assert.equal(rendered.vars.NOTICE_CRM_TERMINAL_METADATA_RETENTION_DAYS, "365");
  assert.equal(rendered.vars.NOTICE_CRM_FIELD_MAPPING_JSON, '{"party":"notice_counterparty"}');
  assert.deepEqual(rendered.triggers.crons, ["*/5 * * * *"]);
  assert.deepEqual(rendered.secrets.required, [
    "NOTICE_CRM_HUBSPOT_ACCESS_TOKEN",
    "NOTICE_INGRESS_SECRET",
    "NOTICE_OPERATIONS_SECRET",
  ]);
  const output = serializeCrmGatewayWranglerConfiguration(manifest);
  assert.equal(output.includes("must-not-be-here"), false);
  assert.equal(output, serializeCrmGatewayWranglerConfiguration(manifest));
});

test("deployment plan delegates first installation to the fail-closed CRM wrapper", () => {
  const manifest = parseCrmGatewayManifest(validHubSpotInput());
  const plan = createCrmGatewayDeploymentPlan(manifest, ".wrangler/crm-gateway.staging.json");
  assert.deepEqual(plan, createCrmGatewayDeploymentPlan(manifest, ".wrangler/crm-gateway.staging.json"));
  assert.equal(plan.database.provisioning, "automatic-on-isolated-bootstrap");
  assert.equal(plan.requiredSecretNames.includes("NOTICE_INGRESS_SECRET"), true);
  assert.equal(plan.requiredSecretNames.includes("NOTICE_OPERATIONS_SECRET"), true);
  assert.equal(plan.preconditions.some((condition) => condition.includes("at least 32 characters")), true);
  assert.equal(plan.nextCommands.includes(
    "npm run crm:gateway:deploy -- --config .wrangler/notice-crm-gateway-staging.json --secrets-file .dev.vars.crm-staging --confirm-empty-environment --confirm-workers-paid-plan",
  ), true);
  assert.equal(plan.nextCommands.some((command) => command.includes("migrations apply")), false);
  assert.equal(plan.nextCommands.some((command) => command.startsWith("npx wrangler deploy")), false);
  assert.equal(plan.preconditions.some((condition) => condition.includes("confirmed empty environment")), true);
  const output = JSON.stringify(plan);
  assert.equal(output.includes("notice_counterparty"), false);
  assert.equal(output.includes("api.hubapi.com"), false);
});

test("CLI dry-run validates and plans without rendering a deployment config", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "notice-crm-kit-"));
  const manifestPath = join(temporaryDirectory, "manifest.json");
  const input = cloneInput();
  input.environment = "qa-dryrun";
  input.workerName = "notice-fixture-crm-qa-dryrun";
  input.customDomain = `crm-gateway-qa-dryrun.${INERT_PRODUCTION_FIXTURE_ZONE}`;
  writeFileSync(manifestPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
  const generatedPath = resolve(repositoryRoot, ".wrangler/notice-crm-gateway-qa-dryrun.json");
  const existedBefore = existsSync(generatedPath);
  try {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/crm-gateway-kit.mjs",
      "dry-run",
      manifestPath,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { action?: unknown; requiredSecretNames?: unknown };
    assert.equal(output.action, "dry-run");
    assert.deepEqual(output.requiredSecretNames, [
      "NOTICE_CRM_HUBSPOT_ACCESS_TOKEN",
      "NOTICE_INGRESS_SECRET",
      "NOTICE_OPERATIONS_SECRET",
    ]);
    assert.equal(existsSync(generatedPath), existedBefore);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CLI render writes only the ignored deployment config with restrictive permissions", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "notice-crm-render-"));
  const manifestPath = join(temporaryDirectory, "manifest.json");
  const environment = `qa-${process.pid}`;
  const input = cloneInput();
  input.environment = environment;
  input.workerName = `notice-fixture-crm-${environment}`;
  input.customDomain = `crm-gateway-${environment}.${INERT_PRODUCTION_FIXTURE_ZONE}`;
  writeFileSync(manifestPath, JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
  const generatedPath = resolve(repositoryRoot, `.wrangler/notice-crm-gateway-${environment}.json`);
  assert.equal(existsSync(generatedPath), false, `refusing to overwrite pre-existing ${generatedPath}`);
  try {
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "scripts/crm-gateway-kit.mjs",
      "render",
      manifestPath,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { action?: unknown; output?: unknown; secretFieldsAccepted?: unknown };
    assert.equal(output.action, "render");
    assert.equal(output.output, `.wrangler/notice-crm-gateway-${environment}.json`);
    assert.equal(output.secretFieldsAccepted, false);
    assert.equal(statSync(generatedPath).mode & 0o777, 0o600);
    const rendered = JSON.parse(readFileSync(generatedPath, "utf8")) as {
      d1_databases?: Array<Record<string, unknown>>;
      secrets?: { required?: unknown };
    };
    assert.equal(rendered.d1_databases?.[0]?.database_id, undefined);
    assert.deepEqual(rendered.secrets?.required, [
      "NOTICE_CRM_HUBSPOT_ACCESS_TOKEN",
      "NOTICE_INGRESS_SECRET",
      "NOTICE_OPERATIONS_SECRET",
    ]);
  } finally {
    rmSync(generatedPath, { force: true });
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

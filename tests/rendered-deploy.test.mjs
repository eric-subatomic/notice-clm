import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  parseDeploymentManifest,
  serializeWranglerConfiguration,
} from "../scripts/deployment-manifest.ts";
import {
  parseCrmGatewayManifest,
  serializeCrmGatewayWranglerConfiguration,
} from "../scripts/crm-gateway-manifest.ts";
import {
  isolatedMainBootstrapConfiguration,
  resolvedMainConfiguration,
  validateGeneratedConfiguration,
} from "../scripts/deploy-release.mjs";
import {
  isolatedCrmBootstrapConfiguration,
  resolvedCrmConfiguration,
  validateCrmGatewayGeneratedConfiguration,
} from "../scripts/deploy-crm-gateway-release.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDirectory = resolve(repositoryRoot, ".wrangler");
const mainConfigPath = resolve(generatedDirectory, "notice-deployment-release-gate.json");
const crmConfigPath = resolve(generatedDirectory, "notice-crm-gateway-release-gate.json");
const resolvedMainConfigPath = resolve(generatedDirectory, "notice-resolved-main-release-gate.json");
const resolvedCrmConfigPath = resolve(generatedDirectory, "notice-resolved-crm-release-gate.json");

// Production validation rejects RFC-reserved documentation domains by design.
// This syntactically public fixture remains beneath invalid.iana.org; this smoke
// test renders and inspects local files only and never resolves or contacts it.
const INERT_PRODUCTION_FIXTURE_ZONE = "notice-fixture.invalid.iana.org";

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: resolve(generatedDirectory, "wrangler.log"),
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) rejectRun(new Error(`${command} exited after signal ${signal}.`));
      else if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with status ${code ?? "unknown"}.`));
    });
  });
}

function mainManifest() {
  return parseDeploymentManifest({
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "release-gate",
    deploymentModel: "self-hosted",
    workerName: "notice-release-gate",
    customDomain: `app.${INERT_PRODUCTION_FIXTURE_ZONE}`,
    workspace: {
      id: "release-gate",
      name: "Notice release gate",
      bootstrap: {
        enabled: true,
        adminEmails: [
          `admin-one@${INERT_PRODUCTION_FIXTURE_ZONE}`,
          `admin-two@${INERT_PRODUCTION_FIXTURE_ZONE}`,
        ],
      },
    },
    identity: { mode: "trusted-headers" },
    docuseal: { enabled: false, configured: false },
    scanner: { enabled: false, configured: false },
    mail: { enabled: false, configured: false },
    counterpartyExchange: {
      automatedDeliveryAccepted: false,
      portal: { enabled: true, ttlHours: 72 },
      emailCapture: { enabled: false, configured: false, provider: "none" },
    },
    crm: {
      provider: "custom",
      mappingVersion: "release-gate-v1",
      configured: false,
      gatewayUrl: `https://crm.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/events`,
    },
    retention: { purgeGraceDays: 30 },
    schedules: { outbox: "*/5 * * * *", retention: "15 2 * * *" },
  });
}

function crmManifest() {
  return parseCrmGatewayManifest({
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "release-gate",
    workerName: "notice-crm-release-gate",
    customDomain: `crm-gateway.${INERT_PRODUCTION_FIXTURE_ZONE}`,
    provider: {
      type: "custom",
      mappingVersion: "release-gate-v1",
      fieldMapping: {},
      url: `https://receiver.${INERT_PRODUCTION_FIXTURE_ZONE}/v1/events`,
      externalIdField: "externalId",
    },
    schedules: { recovery: "*/5 * * * *" },
    retention: { terminalPayloadDays: 90, terminalMetadataDays: 365 },
  });
}

async function removeFixture(path) {
  await rm(path, { force: true });
}

async function main() {
  await mkdir(generatedDirectory, { recursive: true, mode: 0o700 });
  await removeFixture(mainConfigPath);
  await removeFixture(crmConfigPath);
  await removeFixture(resolvedMainConfigPath);
  await removeFixture(resolvedCrmConfigPath);
  try {
    const renderedMain = JSON.parse(serializeWranglerConfiguration(mainManifest()));
    const renderedCrm = JSON.parse(serializeCrmGatewayWranglerConfiguration(crmManifest()));
    validateGeneratedConfiguration(renderedMain, "release-gate");
    validateCrmGatewayGeneratedConfiguration(renderedCrm, "release-gate");
    const databaseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const resolvedMain = resolvedMainConfiguration(renderedMain, {
      DB: { value: databaseId },
      DOCUMENTS: { value: "notice-release-gate-documents" },
    });
    const resolvedCrm = resolvedCrmConfiguration(renderedCrm, { CRM_DB: { value: databaseId } });
    await writeFile(
      mainConfigPath,
      `${JSON.stringify(isolatedMainBootstrapConfiguration(renderedMain), null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      crmConfigPath,
      `${JSON.stringify(isolatedCrmBootstrapConfiguration(renderedCrm), null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(resolvedMainConfigPath, `${JSON.stringify(resolvedMain, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(resolvedCrmConfigPath, `${JSON.stringify(resolvedCrm, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    await run(npm, ["run", "build"]);

    const profiles = [
      ["isolated main bootstrap", ".wrangler/notice-deployment-release-gate.json", true],
      ["isolated CRM bootstrap", ".wrangler/notice-crm-gateway-release-gate.json", true],
      ["resource-pinned main activation", ".wrangler/notice-resolved-main-release-gate.json", false],
      ["resource-pinned CRM activation", ".wrangler/notice-resolved-crm-release-gate.json", false],
    ];
    for (const [label, configPath, provision] of profiles) {
      const provisionArguments = provision ? ["--x-provision"] : [];
      process.stdout.write(`Dry-running rendered ${label} versions upload: ${configPath}\n`);
      await run(npx, [
        "wrangler", "versions", "upload", "--dry-run", "--strict", ...provisionArguments,
        "--config", configPath,
      ]);
      process.stdout.write(`Dry-running rendered ${label} deploy: ${configPath}\n`);
      await run(npx, [
        "wrangler", "deploy", "--dry-run", "--strict", ...provisionArguments, "--config", configPath,
      ]);
    }
    assert.equal(renderedMain.main, "../dist/server/index.js");
    assert.equal(renderedCrm.main, "../integrations/crm-gateway/src/index.ts");
    process.stdout.write("Rendered main and CRM deployment profiles passed both Wrangler dry-run paths.\n");
  } finally {
    await removeFixture(mainConfigPath);
    await removeFixture(crmConfigPath);
    await removeFixture(resolvedMainConfigPath);
    await removeFixture(resolvedCrmConfigPath);
  }
}

await main();

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const deploymentKit = resolve(repositoryRoot, "scripts/deployment-kit.mjs");
const crmGatewayKit = resolve(repositoryRoot, "scripts/crm-gateway-kit.mjs");
const fixtureZone = "notice-fixture.invalid.iana.org";

function noticeManifest(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "staging",
    deploymentModel: "hosted",
    workerName: "notice-fixture-staging",
    customDomain: `app.${fixtureZone}`,
    workspace: {
      id: "fixture-staging",
      name: "Fixture Organization staging",
      bootstrap: {
        enabled: true,
        adminEmails: [`admin.one@${fixtureZone}`, `admin.two@${fixtureZone}`],
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
    crm: { provider: "none" },
    retention: { purgeGraceDays: 30 },
    schedules: { outbox: "*/5 * * * *", retention: "15 2 * * *" },
  };
}

function crmManifest(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    accountId: "a".repeat(32),
    sourceRevision: "1".repeat(40),
    environment: "staging",
    workerName: "notice-fixture-crm-staging",
    customDomain: `crm-gateway.${fixtureZone}`,
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

function runRender(script: string, workspace: string, manifest: Record<string, unknown>) {
  const manifestPath = join(workspace, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  return spawnSync(process.execPath, ["--import", tsxLoader, script, "render", manifestPath], {
    cwd: workspace,
    encoding: "utf8",
    env: process.env,
  });
}

const kits = [
  {
    name: "Notice deployment kit",
    script: deploymentKit,
    manifest: noticeManifest,
    outputName: "notice-deployment-staging.json",
  },
  {
    name: "CRM gateway deployment kit",
    script: crmGatewayKit,
    manifest: crmManifest,
    outputName: "notice-crm-gateway-staging.json",
  },
] as const;

for (const kit of kits) {
  test(`${kit.name} renders atomically with owner-only directory and file permissions`, (context) => {
    if (process.platform === "win32") {
      context.skip("POSIX-mode assertions are covered on POSIX runners.");
      return;
    }

    const temporaryRoot = mkdtempSync(join(tmpdir(), "notice-kit-safe-render-"));
    const workspace = join(temporaryRoot, "workspace");
    const ignoredRoot = join(workspace, ".wrangler");
    const generatedTarget = join(ignoredRoot, kit.outputName);
    mkdirSync(workspace, { mode: 0o755 });

    try {
      const first = runRender(kit.script, workspace, kit.manifest());
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.equal(statSync(ignoredRoot).mode & 0o777, 0o700);
      assert.equal(statSync(generatedTarget).mode & 0o777, 0o600);
      const rendered = readFileSync(generatedTarget, "utf8");

      chmodSync(ignoredRoot, 0o755);
      chmodSync(generatedTarget, 0o644);
      const replacement = runRender(kit.script, workspace, kit.manifest());
      assert.equal(replacement.status, 0, `${replacement.stdout}\n${replacement.stderr}`);
      assert.equal(readFileSync(generatedTarget, "utf8"), rendered);
      assert.equal(statSync(ignoredRoot).mode & 0o777, 0o700);
      assert.equal(statSync(generatedTarget).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(ignoredRoot), [kit.outputName]);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test(`${kit.name} rejects a symlinked .wrangler directory before writing`, (context) => {
    if (process.platform === "win32") {
      context.skip("Directory-symlink and POSIX-mode assertions are covered on POSIX runners.");
      return;
    }

    const temporaryRoot = mkdtempSync(join(tmpdir(), "notice-kit-symlink-root-"));
    const workspace = join(temporaryRoot, "workspace");
    const outside = join(temporaryRoot, "outside");
    mkdirSync(workspace, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(workspace, ".wrangler"), "dir");

    try {
      const result = runRender(kit.script, workspace, kit.manifest());
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Refusing to render: \.wrangler must be a real directory.*symbolic link/i);
      assert.equal(existsSync(join(outside, kit.outputName)), false);
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test(`${kit.name} rejects a symlinked output target without changing its referent`, (context) => {
    if (process.platform === "win32") {
      context.skip("File-symlink and POSIX-mode assertions are covered on POSIX runners.");
      return;
    }

    const temporaryRoot = mkdtempSync(join(tmpdir(), "notice-kit-symlink-target-"));
    const workspace = join(temporaryRoot, "workspace");
    const ignoredRoot = join(workspace, ".wrangler");
    const outsideTarget = join(temporaryRoot, "outside.json");
    const generatedTarget = join(ignoredRoot, kit.outputName);
    const sentinel = "outside-file-must-not-change\n";
    mkdirSync(ignoredRoot, { recursive: true, mode: 0o700 });
    writeFileSync(outsideTarget, sentinel, { encoding: "utf8", mode: 0o600 });
    symlinkSync(outsideTarget, generatedTarget, "file");

    try {
      const result = runRender(kit.script, workspace, kit.manifest());
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Refusing to render: .*configuration target is a symbolic link/i);
      assert.equal(readFileSync(outsideTarget, "utf8"), sentinel);
      assert.equal(lstatSync(generatedTarget).isSymbolicLink(), true);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
}

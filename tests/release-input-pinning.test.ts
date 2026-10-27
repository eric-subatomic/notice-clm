import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  createGuardedReleaseEnvironments,
  createPinnedWranglerRunner,
  displayPath,
  loadValidatedGeneratedConfiguration,
  loadValidatedSecretsInput,
  runCapturedReleaseCommand,
  runPinnedReleaseBuild,
  validateSecretsFileContents,
} from "../scripts/release-utils.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardedVinextPreloadPath = resolve(repositoryRoot, "scripts/guarded-vinext-preload.cjs");
const preloadPath = resolve(repositoryRoot, "scripts/pinned-wrangler-preload.cjs");
const vinextCliPath = resolve(repositoryRoot, "node_modules/vinext/dist/cli.js");
const requiredSecretNames = ["NOTICE_AUDIT_SIGNING_KEY", "NOTICE_JOB_RUNNER_SECRET"];
const MAX_CAPSULE_BYTES = 2_097_152;

function capsuleEntry(path: string, source: string) {
  const bytes = Buffer.from(source, "utf8");
  return {
    path,
    bytes: bytes.length,
    data: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function serializedCapsule(configPath: string, configSource: string, secretsPath: string, secretsSource: string) {
  return `${JSON.stringify({
    schemaVersion: "1.0",
    nonce: randomUUID(),
    configuration: capsuleEntry(configPath, configSource),
    secrets: capsuleEntry(secretsPath, secretsSource),
  })}\n`;
}

async function runPreload(capsule: string, script = "process.stdout.write('loaded')", environment = process.env) {
  const child = spawn(
    process.execPath,
    ["--require", preloadPath, "--input-type=module", "--eval", script],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  const capsuleInput = child.stdio[3];
  const attestationOutput = child.stdio[4];
  if (!child.stdout || !child.stderr || !capsuleInput || !("end" in capsuleInput) || !attestationOutput) {
    child.kill("SIGTERM");
    throw new Error("The preload regression child did not expose its expected pipes.");
  }
  let stdout = "";
  let stderr = "";
  let attestation = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  attestationOutput.on("data", (chunk) => { attestation += String(chunk); });
  capsuleInput.on("error", () => undefined);
  capsuleInput.end(capsule);

  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolveChild, rejectChild) => {
        child.once("error", rejectChild);
        child.once("close", (code, signal) => resolveChild({ code: code ?? 1, signal }));
      }),
      new Promise<never>((_resolve, rejectTimeout) => {
        timeout = setTimeout(() => {
          child.kill("SIGTERM");
          rejectTimeout(new Error("The preload regression child did not exit."));
        }, 10_000);
      }),
    ]);
    return { ...result, stdout, stderr, attestation };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runRawCaptured(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd = repositoryRoot,
) {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return await new Promise<{ code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("close", (code, signal) => resolveChild({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      }));
    },
  );
}

test("validated release config and secret bytes survive source-path replacement", async (context) => {
  if (process.platform === "win32") {
    context.skip("The exact-inode and POSIX permission assertions apply to POSIX release hosts.");
    return;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "notice-release-input-staging-"));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const workspace = join(temporaryRoot, "workspace");
  const ignoredRoot = join(workspace, ".wrangler");
  await mkdir(ignoredRoot, { recursive: true, mode: 0o700 });

  const configPath = join(ignoredRoot, "notice-deployment-staging.json");
  const originalConfigPath = join(temporaryRoot, "validated-original.json");
  const validatedConfiguration = {
    name: "validated-worker",
    vars: { NOTICE_RELEASE_REVISION: "1".repeat(40) },
  };
  const substitutedConfiguration = {
    name: "attacker-worker",
    vars: { NOTICE_RELEASE_REVISION: "2".repeat(40) },
  };
  await writeFile(configPath, `${JSON.stringify(validatedConfiguration)}\n`, { mode: 0o600 });

  const stagedConfig = await loadValidatedGeneratedConfiguration(
    configPath,
    "test-config",
    async (candidate: Record<string, unknown>) => {
      assert.deepEqual(candidate, validatedConfiguration);
      await rename(configPath, originalConfigPath);
      await writeFile(configPath, `${JSON.stringify(substitutedConfiguration)}\n`, { mode: 0o600 });
      return Object.freeze({ accepted: true });
    },
    workspace,
  );

  assert.deepEqual(stagedConfig.validation, { accepted: true });
  assert.deepEqual(stagedConfig.configuration, validatedConfiguration);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), substitutedConfiguration);
  await assert.rejects(readFile(stagedConfig.path, "utf8"), /ENOENT/);

  const secretsPath = join(temporaryRoot, ".dev.vars.staging");
  const validatedSecrets = `NOTICE_AUDIT_SIGNING_KEY=audit-${"a".repeat(48)}\n`
    + `NOTICE_JOB_RUNNER_SECRET=jobs-${"b".repeat(48)}\n`;
  const substitutedSecrets = `NOTICE_AUDIT_SIGNING_KEY=attacker-${"c".repeat(48)}\n`
    + `NOTICE_JOB_RUNNER_SECRET=attacker-${"d".repeat(48)}\n`;
  await writeFile(secretsPath, validatedSecrets, { mode: 0o600 });
  const stagedSecrets = await loadValidatedSecretsInput(secretsPath, requiredSecretNames, [], workspace);
  await writeFile(secretsPath, substitutedSecrets, { mode: 0o600 });

  assert.deepEqual(JSON.parse(stagedSecrets.canonicalBytes.toString("utf8")), {
    NOTICE_AUDIT_SIGNING_KEY: `audit-${"a".repeat(48)}`,
    NOTICE_JOB_RUNNER_SECRET: `jobs-${"b".repeat(48)}`,
  });
  assert.notEqual(stagedSecrets.canonicalBytes.toString("utf8"), await readFile(secretsPath, "utf8"));
  assert.doesNotThrow(() => validateSecretsFileContents(validatedSecrets, requiredSecretNames));
  await assert.rejects(readFile(stagedSecrets.path, "utf8"), /ENOENT/);
});

test("release input loading rejects mutable permissions and symbolic-link substitution", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX file-mode and no-follow assertions do not apply on Windows.");
    return;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "notice-release-input-rejection-"));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const workspace = join(temporaryRoot, "workspace");
  const ignoredRoot = join(workspace, ".wrangler");
  await mkdir(ignoredRoot, { recursive: true, mode: 0o700 });
  const configPath = join(ignoredRoot, "notice-deployment-staging.json");
  await writeFile(configPath, "{}\n", { mode: 0o644 });

  await assert.rejects(
    loadValidatedGeneratedConfiguration(configPath, "test-config", () => true, workspace),
    /permissions are too broad/,
  );
  await chmod(configPath, 0o600);
  const linkedPath = join(ignoredRoot, "notice-deployment-linked.json");
  await symlink(configPath, linkedPath);
  await assert.rejects(
    loadValidatedGeneratedConfiguration(linkedPath, "test-config", () => true, workspace),
    /regular file, not a symlink/,
  );
});

test("the preload serves only exact pipe-cached paths with stable readFileSync semantics", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "notice-release-preload-"));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const guardedRoot = join(temporaryRoot, ".wrangler");
  const displacedRoot = join(temporaryRoot, ".wrangler-validated");
  await mkdir(guardedRoot, { mode: 0o700 });
  const configPath = join(guardedRoot, "config.json");
  const secretsPath = join(guardedRoot, "secrets.env");
  const configSource = "{\"identity\":\"validated-config\"}\n";
  const secretsSource = "SAFE_PIPE_SECRET=validated-secret\n";
  await writeFile(configPath, configSource, { mode: 0o600 });
  await writeFile(secretsPath, secretsSource, { mode: 0o600 });
  const capsule = serializedCapsule(configPath, configSource, secretsPath, secretsSource);

  await rename(guardedRoot, displacedRoot);
  await mkdir(guardedRoot, { mode: 0o700 });
  await writeFile(configPath, "{\"identity\":\"attacker-config\"}\n", { mode: 0o600 });
  await writeFile(secretsPath, "SAFE_PIPE_SECRET=changed\n", { mode: 0o600 });
  const environment = {
    ...process.env,
    TEST_PINNED_CONFIG_PATH: configPath,
    TEST_PINNED_SECRETS_PATH: secretsPath,
  };
  const result = await runPreload(capsule, `
    import fs, { readFileSync as esmReadFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const configPath = process.env.TEST_PINNED_CONFIG_PATH;
    const secretsPath = process.env.TEST_PINNED_SECRETS_PATH;
    const first = fs.readFileSync(configPath);
    const firstText = first.toString("utf8");
    first.fill(0);
    const evidence = {
      firstWasBuffer: Buffer.isBuffer(first),
      configReads: [
        firstText,
        fs.readFileSync(Buffer.from(configPath), "utf8"),
        fs.readFileSync(pathToFileURL(configPath), { encoding: "utf8" }),
        esmReadFileSync(configPath, "utf8"),
      ],
      secretReads: [
        fs.readFileSync(secretsPath).toString("utf8"),
        fs.readFileSync(Buffer.from(secretsPath), { encoding: "utf8" }),
        esmReadFileSync(pathToFileURL(secretsPath), "utf8"),
      ],
    };
    process.stdout.write(JSON.stringify(evidence));
  `, environment);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.firstWasBuffer, true);
  assert.deepEqual(evidence.configReads, Array(4).fill(configSource));
  assert.deepEqual(evidence.secretReads, Array(3).fill(secretsSource));
  const attestation = JSON.parse(result.attestation);
  assert.equal(attestation.complete, true);
  assert.equal(attestation.configuration.reads, 4);
  assert.equal(attestation.secrets.reads, 3);
  assert.equal(attestation.configuration.sha256, capsuleEntry(configPath, configSource).sha256);
  assert.equal(attestation.secrets.sha256, capsuleEntry(secretsPath, secretsSource).sha256);
});

test("the preload fails closed for missing, partial, and oversized capsules", async () => {
  const malformedCapsules = [
    "",
    "{\"schemaVersion\":\"1.0\"",
    "x".repeat(MAX_CAPSULE_BYTES + 1),
  ];
  for (const capsule of malformedCapsules) {
    const result = await runPreload(capsule);
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.attestation, "");
    assert.match(result.stderr, /pinned Wrangler input capsule/i);
  }
});

test("actual pinned Wrangler consumes validated config and JSON/dotenv secrets after a directory swap", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "notice-release-wrangler-swap-"));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const workspace = join(temporaryRoot, "workspace");
  const guardedRoot = join(workspace, ".wrangler");
  await mkdir(guardedRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, "src"), { mode: 0o700 });
  await writeFile(
    join(workspace, "src/validated-worker.mjs"),
    "export default { fetch() { return new Response('validated-pipe-worker'); } };\n",
  );
  const configuration = {
    name: "notice-validated-pipe-worker",
    main: "../src/validated-worker.mjs",
    compatibility_date: "2026-05-22",
    workers_dev: false,
    preview_urls: false,
  };
  const configSourcePath = join(guardedRoot, "validated-input.json");
  await writeFile(configSourcePath, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  const stagedConfig = await loadValidatedGeneratedConfiguration(
    configSourcePath,
    "actual-wrangler-config",
    (candidate: unknown) => {
      assert.deepEqual(candidate, configuration);
      return true;
    },
    workspace,
  );

  const secretsSources = [
    { name: "json", source: `${JSON.stringify({ SAFE_PIPE_SECRET: "validated-json-secret" })}\n` },
    { name: "dotenv", source: "SAFE_PIPE_SECRET=validated-dotenv-secret\n" },
  ];
  const stagedSecrets = [];
  for (const candidate of secretsSources) {
    const sourcePath = join(temporaryRoot, `.secrets-${candidate.name}`);
    await writeFile(sourcePath, candidate.source, { mode: 0o600 });
    const staged = await loadValidatedSecretsInput(sourcePath, ["SAFE_PIPE_SECRET"], [], workspace);
    const rawTransportPath = join(guardedRoot, `.notice-release-raw-${candidate.name}-${randomUUID()}.env`);
    stagedSecrets.push({ ...candidate, sourcePath, staged, rawTransportPath });
  }

  const runner = createPinnedWranglerRunner(workspace);
  context.after(() => runner.destroy());
  runner.pinConfiguration(stagedConfig.path, stagedConfig.configuration);
  for (const candidate of stagedSecrets) {
    runner.pinSecrets(candidate.staged.path, candidate.staged.canonicalBytes);
    candidate.staged.canonicalBytes.fill(0);
    runner.pinSecrets(candidate.rawTransportPath, candidate.source);
  }

  const positiveEnvironment = createGuardedReleaseEnvironments(process.env, {
    WRANGLER_LOG_PATH: join(workspace, "wrangler-positive-control.log"),
  }).wrangler;

  const positiveOutputPath = join(workspace, "bundle-positive-control.mjs");
  const positive = await runCapturedReleaseCommand(
    runner,
    [
      "wrangler", "deploy", "--dry-run", "--strict",
      "--outfile", positiveOutputPath,
      "--config", displayPath(stagedConfig.path, workspace),
      "--secrets-file", displayPath(stagedSecrets[0].staged.path, workspace),
    ],
    positiveEnvironment,
  );
  assert.equal(positive.code, 0, positive.stderr);
  assert.match(await readFile(positiveOutputPath, "utf8"), /validated-pipe-worker/);

  await rename(guardedRoot, join(workspace, ".wrangler-before-attacker-swap"));
  await mkdir(guardedRoot, { mode: 0o700 });
  await writeFile(
    stagedConfig.path,
    `${JSON.stringify({ ...configuration, main: "../src/attacker-worker-does-not-exist.mjs" })}\n`,
    { mode: 0o600 },
  );
  for (const candidate of stagedSecrets) {
    await writeFile(candidate.sourcePath, "SAFE_PIPE_SECRET=changed\n", { mode: 0o600 });
    await writeFile(candidate.staged.path, "this is not valid dotenv syntax\n", { mode: 0o600 });
    await writeFile(candidate.rawTransportPath, "this is not valid dotenv syntax\n", { mode: 0o600 });
  }

  for (const candidate of stagedSecrets) {
    for (const transport of [
      { name: "canonical", path: candidate.staged.path },
      { name: "raw", path: candidate.rawTransportPath },
    ]) {
      const outputPath = join(workspace, `bundle-${candidate.name}-${transport.name}.mjs`);
      const environment = createGuardedReleaseEnvironments({
        ...process.env,
        NODE_OPTIONS: "--require=attacker-loader-that-does-not-exist.cjs",
        NODE_PATH: join(temporaryRoot, "attacker-node-path"),
      }, {
        WRANGLER_LOG_PATH: join(workspace, `wrangler-${candidate.name}-${transport.name}.log`),
      }).wrangler;
      const result = await runCapturedReleaseCommand(
        runner,
        [
          "wrangler", "deploy", "--dry-run", "--strict",
          "--outfile", outputPath,
          "--config", displayPath(stagedConfig.path, workspace),
          "--secrets-file", displayPath(transport.path, workspace),
        ],
        environment,
      );
      assert.equal(result.code, 0, `${candidate.name}/${transport.name}: ${result.stderr}`);
      assert.equal(result.signal, null);
      assert.match(await readFile(outputPath, "utf8"), /validated-pipe-worker/);
    }
  }
});

test("the direct pinned production build rejects Node and npm lifecycle loader injection", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "notice-release-build-boundary-"));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const probeRoot = join(temporaryRoot, "npm-probe");
  const poisonPath = join(temporaryRoot, "poison.cjs");
  const markerPath = join(temporaryRoot, "poison-loaded.txt");
  const esbuildMarkerPath = join(temporaryRoot, "esbuild-loaded.txt");
  const maliciousEsbuildPath = join(temporaryRoot, "malicious-esbuild");
  const maliciousNapiPath = join(temporaryRoot, "malicious-napi.cjs");
  const napiMarkerPath = join(temporaryRoot, "napi-loaded.txt");
  const maliciousViteRunnerPath = join(temporaryRoot, "malicious-vite-runner.cjs");
  const viteRunnerMarkerPath = join(temporaryRoot, "vite-runner-loaded.txt");
  const userConfigPath = join(temporaryRoot, "poison.npmrc");
  const nodeOptions = `--require=${JSON.stringify(poisonPath)}`;
  await mkdir(probeRoot, { mode: 0o700 });
  await writeFile(
    poisonPath,
    "require('node:fs').appendFileSync(process.env.NOTICE_TEST_POISON_MARKER, 'loaded\\n');\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(probeRoot, "package.json"),
    `${JSON.stringify({ private: true, scripts: { probe: "node -e \"process.stdout.write('probe-ok')\"" } })}\n`,
    { mode: 0o600 },
  );
  await writeFile(userConfigPath, `node-options=${nodeOptions}\n`, { mode: 0o600 });
  await writeFile(
    maliciousEsbuildPath,
    "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.NOTICE_TEST_ESBUILD_MARKER, 'loaded\\n');\nprocess.exit(1);\n",
    { mode: 0o700 },
  );
  await writeFile(
    maliciousNapiPath,
    "require('node:fs').writeFileSync(process.env.NOTICE_TEST_NAPI_MARKER, 'loaded\\n');\nmodule.exports = {};\n",
    { mode: 0o600 },
  );
  await writeFile(
    maliciousViteRunnerPath,
    "require('node:fs').writeFileSync(process.env.NOTICE_TEST_VITE_RUNNER_MARKER, 'loaded\\n');\nprocess.exit(86);\n",
    { mode: 0o600 },
  );

  const npm = "npm";
  const baseProbeEnvironment = {
    ...createGuardedReleaseEnvironments(process.env, {
      NOTICE_TEST_POISON_MARKER: markerPath,
    }).command,
  };
  for (const name of [
    "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE",
    "NPM_CONFIG_NODE_OPTIONS", "npm_config_node_options",
  ]) {
    delete baseProbeEnvironment[name];
  }
  const poisonChannels = [
    { NODE_OPTIONS: nodeOptions },
    { npm_config_node_options: nodeOptions },
    { NPM_CONFIG_USERCONFIG: userConfigPath },
  ];
  if (process.platform !== "win32") {
    for (const poisonEnvironment of poisonChannels) {
      await rm(markerPath, { force: true });
      const probe = await runRawCaptured(
        npm,
        ["--prefix", probeRoot, "run", "probe"],
        {
          ...baseProbeEnvironment,
          ...poisonEnvironment,
          NOTICE_TEST_POISON_MARKER: markerPath,
        } as unknown as NodeJS.ProcessEnv,
      );
      assert.equal(probe.code, 0, probe.stderr);
      assert.match(probe.stdout, /probe-ok/);
      assert.match(await readFile(markerPath, "utf8"), /loaded/);
    }

    const esbuildProbe = await runRawCaptured(
      process.execPath,
      ["--eval", "require('esbuild').transformSync('let releaseProbe = true')"],
      {
        ...baseProbeEnvironment,
        ESBUILD_BINARY_PATH: maliciousEsbuildPath,
        NOTICE_TEST_ESBUILD_MARKER: esbuildMarkerPath,
      } as unknown as NodeJS.ProcessEnv,
    );
    assert.notEqual(esbuildProbe.code, 0);
    assert.match(await readFile(esbuildMarkerPath, "utf8"), /loaded/);
  }

  const napiProbe = await runRawCaptured(
    process.execPath,
    [vinextCliPath, "build"],
    {
      ...baseProbeEnvironment,
      NAPI_RS_NATIVE_LIBRARY_PATH: maliciousNapiPath,
      NOTICE_TEST_NAPI_MARKER: napiMarkerPath,
    } as unknown as NodeJS.ProcessEnv,
  );
  assert.notEqual(napiProbe.code, 0);
  assert.match(await readFile(napiMarkerPath, "utf8"), /loaded/);

  const viteRunnerProbe = await runRawCaptured(
    process.execPath,
    [vinextCliPath, "build"],
    {
      ...baseProbeEnvironment,
      VP_RUN_NODE_CLIENT_PATH: maliciousViteRunnerPath,
      NOTICE_TEST_VITE_RUNNER_MARKER: viteRunnerMarkerPath,
    } as unknown as NodeJS.ProcessEnv,
  );
  assert.notEqual(viteRunnerProbe.code, 0);
  assert.match(await readFile(viteRunnerMarkerPath, "utf8"), /loaded/);

  await rm(markerPath, { force: true });
  const guardedBuildEnvironment = createGuardedReleaseEnvironments(
    {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      npm_config_node_options: nodeOptions,
      NPM_CONFIG_USERCONFIG: userConfigPath,
      __VINEXT_SHARED_REVALIDATE_SECRET: "attacker-controlled-revalidation-secret",
    },
    {
      NOTICE_TEST_POISON_MARKER: markerPath,
    },
  ).command;
  assert.equal(guardedBuildEnvironment.NODE_OPTIONS, "");
  assert.equal(guardedBuildEnvironment.NODE_PATH, "");
  assert.equal(guardedBuildEnvironment.npm_config_node_options, "");
  assert.equal(guardedBuildEnvironment.ESBUILD_BINARY_PATH, "");
  assert.equal(guardedBuildEnvironment.LD_PRELOAD, "");
  assert.equal(guardedBuildEnvironment.DYLD_INSERT_LIBRARIES, "");
  assert.equal(guardedBuildEnvironment.NAPI_RS_NATIVE_LIBRARY_PATH, "");
  assert.equal(guardedBuildEnvironment.VP_RUN_NODE_CLIENT_PATH, "");
  assert.equal(guardedBuildEnvironment.NODE_ENV, "production");
  assert.equal(guardedBuildEnvironment.VITE_USER_NODE_ENV, "");
  assert.equal(guardedBuildEnvironment.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  assert.equal(guardedBuildEnvironment.__VINEXT_SHARED_REVALIDATE_SECRET, "");
  assert.equal("NPM_CONFIG_USERCONFIG" in guardedBuildEnvironment, false);
  await runPinnedReleaseBuild(guardedBuildEnvironment, repositoryRoot);
  await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);

  await writeFile(
    join(temporaryRoot, ".env.production"),
    [
      `NODE_OPTIONS=${nodeOptions}`,
      `NODE_PATH=${join(temporaryRoot, "attacker-node-path")}`,
      `ESBUILD_BINARY_PATH=${maliciousEsbuildPath}`,
      `LD_PRELOAD=${poisonPath}`,
      `DYLD_INSERT_LIBRARIES=${poisonPath}`,
      `NAPI_RS_NATIVE_LIBRARY_PATH=${maliciousNapiPath}`,
      `VP_RUN_NODE_CLIENT_PATH=${maliciousViteRunnerPath}`,
      "NODE_ENV=development",
      "VITE_USER_NODE_ENV=development",
      "NODE_TLS_REJECT_UNAUTHORIZED=0",
      `NODE_EXTRA_CA_CERTS=${poisonPath}`,
      `OPENSSL_CONF=${poisonPath}`,
      "__VINEXT_SHARED_REVALIDATE_SECRET=attacker-controlled-revalidation-secret",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const vinextDotenvUrl = pathToFileURL(
    join(repositoryRoot, "node_modules/vinext/dist/config/dotenv.js"),
  ).href;
  await assert.rejects(
    runPinnedReleaseBuild(guardedBuildEnvironment, temporaryRoot),
    /vinext build exited with status 1/,
  );
  const { loadDotenv } = await import(vinextDotenvUrl);
  const dotenvEnvironment = { ...guardedBuildEnvironment };
  loadDotenv({ root: temporaryRoot, mode: "production", processEnv: dotenvEnvironment });
  assert.equal(dotenvEnvironment.NODE_OPTIONS, "");
  assert.equal(dotenvEnvironment.NODE_PATH, "");
  assert.equal(dotenvEnvironment.ESBUILD_BINARY_PATH, "");
  assert.equal(dotenvEnvironment.LD_PRELOAD, "");
  assert.equal(dotenvEnvironment.DYLD_INSERT_LIBRARIES, "");
  assert.equal(dotenvEnvironment.NAPI_RS_NATIVE_LIBRARY_PATH, "");
  assert.equal(dotenvEnvironment.VP_RUN_NODE_CLIENT_PATH, "");
  assert.equal(dotenvEnvironment.NODE_ENV, "production");
  assert.equal(dotenvEnvironment.VITE_USER_NODE_ENV, "");
  assert.equal(dotenvEnvironment.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  assert.equal(dotenvEnvironment.NODE_EXTRA_CA_CERTS, "");
  assert.equal(dotenvEnvironment.OPENSSL_CONF, "");
  assert.equal(dotenvEnvironment.__VINEXT_SHARED_REVALIDATE_SECRET, "");

  const lateDotenvRoot = join(temporaryRoot, "late-dotenv");
  await mkdir(lateDotenvRoot, { mode: 0o700 });
  const lateDotenvProbe = await runRawCaptured(
    process.execPath,
    [
      "--require",
      guardedVinextPreloadPath,
      "--eval",
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync('.env.production', 'NODE_OPTIONS=attacker\\n');",
        "fs.writeFileSync('.dev.vars', 'ATTACKER_SECRET=attacker\\n');",
        "let code = 'readable';",
        "try { fs.readFileSync('.env.production'); } catch (error) { code = error.code; }",
        "let devVarsCode = 'readable';",
        "try { fs.readFileSync('.dev.vars'); } catch (error) { devVarsCode = error.code; }",
        "process.stdout.write(`${fs.existsSync('.env.production')}:${code}:${fs.existsSync('.dev.vars')}:${devVarsCode}`);",
      ].join(" "),
    ],
    guardedBuildEnvironment as NodeJS.ProcessEnv,
    lateDotenvRoot,
  );
  assert.equal(lateDotenvProbe.code, 0, lateDotenvProbe.stderr);
  assert.equal(lateDotenvProbe.stdout, "false:ENOENT:false:ENOENT");

  const devVarsRoot = join(temporaryRoot, "preexisting-dev-vars");
  await mkdir(devVarsRoot, { mode: 0o700 });
  await writeFile(join(devVarsRoot, ".dev.vars"), "ATTACKER_SECRET=attacker\n", { mode: 0o600 });
  await assert.rejects(
    runPinnedReleaseBuild(guardedBuildEnvironment, devVarsRoot),
    /vinext build exited with status 1/,
  );
  await assert.rejects(readFile(join(devVarsRoot, "dist/.dev.vars"), "utf8"), /ENOENT/);
  const grandchild = await runRawCaptured(
    process.execPath,
    ["--eval", "process.stdout.write('guarded-grandchild')"],
    dotenvEnvironment as NodeJS.ProcessEnv,
  );
  assert.equal(grandchild.code, 0, grandchild.stderr);
  assert.equal(grandchild.stdout, "guarded-grandchild");
  await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
});

test("release environments fail closed on inherited Wrangler controls and isolate credentials", async () => {
  const sourceBackedControls = [
    "CLOUDFLARE_API_BASE_URL",
    "CF_API_BASE_URL",
    "WRANGLER_API_ENVIRONMENT",
    "CLOUDFLARE_COMPLIANCE_REGION",
    "WRANGLER_CI_OVERRIDE_NAME",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_ACCOUNT_ID",
    "CLOUDFLARE_ENV",
    "CLOUDFLARE_INCLUDE_PROCESS_ENV",
    "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV",
    "WRANGLER_BUILD_CONDITIONS",
    "WRANGLER_BUILD_PLATFORM",
    "WRANGLER_AUTH_URL",
    "WRANGLER_TOKEN_URL",
  ];
  const wranglerSource = await readFile(
    join(repositoryRoot, "node_modules/wrangler/wrangler-dist/cli.js"),
    "utf8",
  );
  for (const name of sourceBackedControls) {
    assert.match(wranglerSource, new RegExp(name));
    assert.throws(
      () => createGuardedReleaseEnvironments({ ...process.env, [name.toLowerCase()]: "attacker" }),
      /forbids inherited Wrangler control setting/,
    );
  }
  assert.throws(
    () => createGuardedReleaseEnvironments({ ...process.env, WrAnGlEr_FuTuRe_Override: "attacker" }),
    /forbids inherited Wrangler control setting/,
  );
  for (const name of [
    "LD_PRELOAD",
    "dyld_insert_libraries",
    "ESBUILD_BINARY_PATH",
    "NAPI_RS_NATIVE_LIBRARY_PATH",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "VP_RUN_NODE_CLIENT_PATH",
  ]) {
    assert.throws(
      () => createGuardedReleaseEnvironments({ ...process.env, [name]: "attacker" }),
      /forbids inherited subprocess control setting/,
    );
  }

  const buildNamespaceEnvironment = createGuardedReleaseEnvironments({
    ...process.env,
    NEXT_PUBLIC_RELEASE_CONTROL: "attacker",
    __NEXT_PRIVATE_RUNTIME_TYPE: "attacker",
    VINEXT_PRECOMPRESS: "1",
    __VINEXT_SHARED_REVALIDATE_SECRET: "attacker",
    VERCEL_ENV: "attacker",
    VITE_USER_NODE_ENV: "development",
    MINIFLARE_REGISTRY_PATH: "attacker",
    CLOUDFLARED_PATH: "attacker",
    DOTENV_CONFIG_PATH: "attacker",
    NOTICE_LOCAL_VITE: "1",
    NOTICE_EVIDENCE_MODE: "1",
  }).command;
  for (const name of [
    "NEXT_PUBLIC_RELEASE_CONTROL",
    "__NEXT_PRIVATE_RUNTIME_TYPE",
    "VINEXT_PRECOMPRESS",
    "VERCEL_ENV",
    "MINIFLARE_REGISTRY_PATH",
    "CLOUDFLARED_PATH",
    "DOTENV_CONFIG_PATH",
    "NOTICE_LOCAL_VITE",
    "NOTICE_EVIDENCE_MODE",
  ]) assert.equal(name in buildNamespaceEnvironment, false);
  assert.equal(buildNamespaceEnvironment.__VINEXT_SHARED_REVALIDATE_SECRET, "");
  assert.equal(buildNamespaceEnvironment.VITE_USER_NODE_ENV, "");

  const logPath = join(repositoryRoot, ".wrangler/release-environment-test.log");
  const environments = createGuardedReleaseEnvironments(
    {
      ...process.env,
      CLOUDFLARE_API_TOKEN: "test-token-never-sent",
      HTTPS_PROXY: "http://proxy.invalid:8080",
    },
    { WRANGLER_LOG_PATH: logPath },
  );
  assert.equal(environments.authentication, "api-token");
  assert.equal("CLOUDFLARE_API_TOKEN" in environments.command, false);
  assert.equal("WRANGLER_LOG_PATH" in environments.command, false);
  assert.equal(environments.command.HTTPS_PROXY, "http://proxy.invalid:8080");
  assert.equal(environments.wrangler.CLOUDFLARE_API_TOKEN, "test-token-never-sent");
  assert.equal(environments.wrangler.CLOUDFLARE_AUTH_USE_KEYRING, "false");
  assert.equal(environments.wrangler.WRANGLER_API_ENVIRONMENT, "production");
  assert.equal(environments.wrangler.CLOUDFLARE_COMPLIANCE_REGION, "public");
  assert.equal(environments.wrangler.CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
  assert.equal(environments.wrangler.WRANGLER_LOG_SANITIZE, "true");
  assert.equal(environments.wrangler.WRANGLER_SEND_METRICS, "false");
  assert.equal(environments.wrangler.WRANGLER_SEND_ERROR_REPORTS, "false");
  assert.equal(environments.wrangler.WRANGLER_LOG_PATH, logPath);
  const credentialProbe = await runCapturedReleaseCommand(
    process.execPath,
    ["--eval", "process.stdout.write(process.env.CLOUDFLARE_API_TOKEN ?? 'absent')"],
    environments.command,
  );
  assert.equal(credentialProbe.code, 0, credentialProbe.stderr);
  assert.equal(credentialProbe.stdout, "absent");

  const storedLoginEnvironment = createGuardedReleaseEnvironments({ HOME: "/trusted-release-home" });
  assert.equal(storedLoginEnvironment.authentication, "stored-login");
  assert.equal("CLOUDFLARE_API_TOKEN" in storedLoginEnvironment.wrangler, false);
  assert.equal("CLOUDFLARE_AUTH_USE_KEYRING" in storedLoginEnvironment.wrangler, false);
  await assert.rejects(
    runPinnedReleaseBuild({ ...environments.command } as NodeJS.ProcessEnv, repositoryRoot),
    /requires its guarded least-privilege environment/,
  );

  let controlPlaneRequests = 0;
  const controlPlaneProbe = createServer((_request, response) => {
    controlPlaneRequests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    controlPlaneProbe.once("error", rejectListen);
    controlPlaneProbe.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = controlPlaneProbe.address();
    assert(address && typeof address === "object");
    assert.throws(
      () => createGuardedReleaseEnvironments({
        ...process.env,
        CLOUDFLARE_API_TOKEN: "test-token-never-sent",
        CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${address.port}`,
      }),
      /forbids inherited Wrangler control setting/,
    );
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    assert.equal(controlPlaneRequests, 0);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      controlPlaneProbe.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "notice-release-git-environment-"));
  const fakeCheckout = join(temporaryRoot, "fake-checkout");
  try {
    await mkdir(fakeCheckout, { mode: 0o700 });
    const rawEnvironment = environments.command as NodeJS.ProcessEnv;
    for (const args of [
      ["init", "--quiet", fakeCheckout],
      ["-C", fakeCheckout, "config", "user.name", "Release test"],
      ["-C", fakeCheckout, "config", "user.email", "release-test@example.invalid"],
    ]) {
      const result = await runRawCaptured("git", args, rawEnvironment);
      assert.equal(result.code, 0, result.stderr);
    }
    await writeFile(join(fakeCheckout, "tracked.txt"), "fake release source\n", { mode: 0o600 });
    for (const args of [
      ["-C", fakeCheckout, "add", "tracked.txt"],
      ["-C", fakeCheckout, "commit", "--quiet", "--message", "fake release source"],
    ]) {
      const result = await runRawCaptured("git", args, rawEnvironment);
      assert.equal(result.code, 0, result.stderr);
    }
    const realRevision = await runRawCaptured("git", ["rev-parse", "HEAD"], rawEnvironment);
    const redirectedRevision = await runRawCaptured(
      "git",
      ["rev-parse", "HEAD"],
      {
        ...rawEnvironment,
        GIT_DIR: join(fakeCheckout, ".git"),
        GIT_WORK_TREE: fakeCheckout,
      },
    );
    assert.equal(realRevision.code, 0, realRevision.stderr);
    assert.equal(redirectedRevision.code, 0, redirectedRevision.stderr);
    assert.notEqual(redirectedRevision.stdout.trim(), realRevision.stdout.trim());
    const guardedRedirectEnvironment = createGuardedReleaseEnvironments({
      ...process.env,
      GIT_DIR: join(fakeCheckout, ".git"),
      git_work_tree: fakeCheckout,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      GIT_CONFIG_VALUE_0: "attacker-pager",
    }).command;
    assert.equal(Object.keys(guardedRedirectEnvironment).some(
      (name) => name.toUpperCase().replaceAll("-", "_").startsWith("GIT_"),
    ), false);
    const guardedRevision = await runRawCaptured(
      "git",
      ["rev-parse", "HEAD"],
      guardedRedirectEnvironment as NodeJS.ProcessEnv,
    );
    assert.equal(guardedRevision.code, 0, guardedRevision.stderr);
    assert.equal(guardedRevision.stdout.trim(), realRevision.stdout.trim());
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the guarded runner rejects unpinned and cross-wired command inputs before launch", async () => {
  const runner = createPinnedWranglerRunner(repositoryRoot);
  const environment = createGuardedReleaseEnvironments().wrangler;
  const configPath = join(repositoryRoot, `.wrangler/.notice-release-test-${randomUUID()}.json`);
  const secretsPath = join(repositoryRoot, `.wrangler/.notice-release-test-${randomUUID()}.json`);
  runner.pinConfiguration(configPath, { name: "validated" });
  runner.pinSecrets(secretsPath, "{\"SAFE_PIPE_SECRET\":\"validated-secret\"}\n");

  await assert.rejects(
    runCapturedReleaseCommand(
      runner, ["wrangler", "deploy", "--config", ".wrangler/not-pinned.json"], environment,
    ),
    /configuration input is not pinned/,
  );
  await assert.rejects(
    runCapturedReleaseCommand(
      runner, ["wrangler", "deploy", "--config", displayPath(secretsPath)], environment,
    ),
    /configuration input is not pinned/,
  );
  await assert.rejects(
    runCapturedReleaseCommand(
      runner, ["wrangler", "deploy", `--config=${displayPath(configPath)}`], environment,
    ),
    /at most one separate --config argument/,
  );
  await assert.rejects(
    runCapturedReleaseCommand(
      runner, ["npx", "wrangler", "deploy", "--config", displayPath(configPath)], environment,
    ),
    /accepts only explicit Wrangler commands/,
  );
  runner.destroy();
  runner.destroy();
  assert.throws(
    () => runner.pinConfiguration(configPath, { name: "late" }),
    /has been destroyed/,
  );
  await assert.rejects(
    runCapturedReleaseCommand(
      runner, ["wrangler", "deploy", "--config", displayPath(configPath)], environment,
    ),
    /invalid or destroyed/,
  );
});

test("both release wrappers pin all external and derived Wrangler inputs in memory", async () => {
  const wrappers = await Promise.all([
    readFile(new URL("../scripts/deploy-release.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy-crm-gateway-release.mjs", import.meta.url), "utf8"),
  ]);

  for (const source of wrappers) {
    assert.match(source, /const environments = createGuardedReleaseEnvironments\(process\.env,/);
    assert.match(source, /const environment = environments\.command;/);
    assert.match(source, /const wranglerEnvironment = environments\.wrangler;/);
    assert.match(source, /wrangler = createPinnedWranglerRunner\(\);/);
    assert.match(source, /wrangler\.pinConfiguration\(validatedConfig\.path, validatedConfig\.configuration\);/);
    assert.match(source, /wrangler\.pinSecrets\(validatedSecrets\.path, validatedSecrets\.canonicalBytes\);/);
    assert.match(source, /validatedSecrets\.canonicalBytes\.fill\(0\);/);
    assert.match(source, /const npx = wrangler;/);
    assert.match(source, /const configArgument = displayPath\(validatedConfig\.path\);/);
    assert.match(source, /\["--secrets-file", displayPath\(validatedSecrets\.path\)\]/);
    assert.match(source, /updateFirstInstallConfigurationVariants/);
    assert.doesNotMatch(source, /displayPath\(configPath\)/);
    assert.match(source, /finally \{\s+wrangler\?\.destroy\(\);\s+\}/);
    assert.doesNotMatch(source, /writeFile|internalConfigPaths|rm\(/);
  }
});

test("the release runtime and lock retain the exact local Wrangler CLI pin", async () => {
  const [manifest, lock, installed, installedVinext] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "package-lock.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "node_modules/wrangler/package.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "node_modules/vinext/package.json"), "utf8").then(JSON.parse),
  ]);
  const cliPath = fileURLToPath(import.meta.resolve("wrangler"));
  assert.equal(manifest.devDependencies.wrangler, "4.152.0");
  assert.equal(lock.packages[""].devDependencies.wrangler, "4.152.0");
  assert.equal(lock.packages["node_modules/wrangler"].version, "4.152.0");
  assert.equal(installed.version, "4.152.0");
  assert.equal(cliPath, join(repositoryRoot, "node_modules/wrangler/wrangler-dist/cli.js"));
  assert.equal(manifest.devDependencies.vinext, "1.3.1");
  assert.equal(lock.packages[""].devDependencies.vinext, "1.3.1");
  assert.equal(lock.packages["node_modules/vinext"].version, "1.3.1");
  assert.equal(installedVinext.version, "1.3.1");
  assert.equal(installedVinext.bin.vinext, "dist/cli.js");
});

test("the pinned child boundary is shell-free and does not depend on POSIX descriptor paths", async () => {
  const source = await readFile(join(repositoryRoot, "scripts/release-utils.mjs"), "utf8");
  assert.match(source, /spawn\(\s+process\.execPath,/);
  assert.match(source, /stdio: \[\.\.\.baseStdio, "pipe", "pipe"\]/);
  assert.match(source, /shell: false/);
  assert.match(source, /guardedReleaseWranglerEnvironments\.has\(environment\)/);
  assert.match(source, /\["--require", guardedVinextPreloadPath, vinextCliPath, "build"\]/);
  assert.match(source, /for \(const entry of inputs\.values\(\)\) entry\.content\.fill\(0\);\s+inputs\.clear\(\);/);
  assert.match(source, /serializedCapsule\.fill\(0\);/);
  assert.doesNotMatch(source, /\/dev\/fd|\/proc\/self\/fd|npx(?:\.cmd)?/);
});

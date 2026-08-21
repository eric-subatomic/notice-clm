#!/usr/bin/env -S node --import tsx

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import {
  createDeploymentPlan,
  generatedWranglerPath,
  parseDeploymentManifest,
  serializeWranglerConfiguration,
} from "./deployment-manifest.ts";

const usage = `Notice non-secret deployment kit

Usage:
  node --import tsx scripts/deployment-kit.mjs plan <manifest.json>
  node --import tsx scripts/deployment-kit.mjs render <manifest.json>

Commands:
  plan    Validate the manifest and print a deterministic, redacted plan.
  render  Validate the manifest and write its generated Wrangler JSON under .wrangler/.

This tool never contacts Cloudflare, executes a deployment command, accepts a
secret value, or writes outside the ignored .wrangler directory.
`;

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n\n${usage}`);
  process.exitCode = exitCode;
}

function displayPath(candidate) {
  const path = relative(process.cwd(), candidate) || ".";
  return path.split(sep).join("/");
}

async function loadManifest(candidate) {
  let source;
  try {
    source = await readFile(candidate, "utf8");
  } catch {
    throw new Error(`Manifest could not be read: ${displayPath(candidate)}`);
  }

  let input;
  try {
    input = JSON.parse(source);
  } catch {
    throw new Error(`Manifest is not valid JSON: ${displayPath(candidate)}`);
  }
  return parseDeploymentManifest(input);
}

function hasErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unsafeRenderLocation(message) {
  return new Error(`Refusing to render: ${message}`);
}

async function lstatIfPresent(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, identity, requireOwnerOnlyMode = true) {
  const status = await lstatIfPresent(ignoredRoot);
  if (!status || status.isSymbolicLink() || !status.isDirectory()) {
    throw unsafeRenderLocation(".wrangler must be a real directory inside the current workspace, not a symbolic link.");
  }
  if (!sameFile(status, identity)) {
    throw unsafeRenderLocation("the .wrangler directory changed while the configuration was being prepared.");
  }

  let canonical;
  try {
    canonical = await realpath(ignoredRoot);
  } catch {
    throw unsafeRenderLocation("the .wrangler directory could not be resolved safely.");
  }
  if (canonical !== canonicalIgnoredRoot) {
    throw unsafeRenderLocation(".wrangler resolves outside the current workspace.");
  }
  if (requireOwnerOnlyMode && process.platform !== "win32" && (status.mode & 0o777) !== 0o700) {
    throw unsafeRenderLocation(".wrangler does not have the required owner-only permissions (0700).");
  }
}

async function assertTrustedFile(candidate, canonicalCandidate, identity, description) {
  const status = await lstatIfPresent(candidate);
  if (!status || status.isSymbolicLink() || !status.isFile()) {
    throw unsafeRenderLocation(`${description} is not a regular file owned by this render operation.`);
  }
  if (!sameFile(status, identity)) {
    throw unsafeRenderLocation(`${description} changed while the configuration was being prepared.`);
  }

  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw unsafeRenderLocation(`${description} could not be resolved safely.`);
  }
  if (canonical !== canonicalCandidate) {
    throw unsafeRenderLocation(`${description} resolves outside the .wrangler directory.`);
  }
  if (process.platform !== "win32" && (status.mode & 0o777) !== 0o600) {
    throw unsafeRenderLocation(`${description} does not have the required owner-only permissions (0600).`);
  }
}

async function assertSafeDestination(candidate) {
  const status = await lstatIfPresent(candidate);
  if (!status) return;
  if (status.isSymbolicLink()) {
    throw unsafeRenderLocation("the generated deployment configuration target is a symbolic link.");
  }
  if (!status.isFile()) {
    throw unsafeRenderLocation("the generated deployment configuration target is not a regular file.");
  }
}

async function writeGeneratedConfiguration(resolvedOutput, rendered) {
  const workspacePath = resolve(process.cwd());
  let canonicalWorkspace;
  try {
    canonicalWorkspace = await realpath(workspacePath);
  } catch {
    throw unsafeRenderLocation("the current workspace could not be resolved safely.");
  }

  const ignoredRoot = resolve(workspacePath, ".wrangler");
  const canonicalIgnoredRoot = resolve(canonicalWorkspace, ".wrangler");
  if (dirname(resolvedOutput) !== ignoredRoot) {
    throw new Error("Generated deployment configuration must remain directly under the ignored .wrangler directory.");
  }

  let rootStatus = await lstatIfPresent(ignoredRoot);
  if (!rootStatus) {
    try {
      await mkdir(ignoredRoot, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw unsafeRenderLocation("the .wrangler directory could not be created safely.");
      }
    }
    rootStatus = await lstatIfPresent(ignoredRoot);
  }
  if (!rootStatus || rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw unsafeRenderLocation(".wrangler must be a real directory inside the current workspace, not a symbolic link.");
  }
  await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootStatus, false);

  let rootHandle = null;
  let rootIdentity = rootStatus;
  let temporaryHandle = null;
  let temporaryPath = null;
  let temporaryIdentity = null;
  try {
    // Node has no portable openat/renameat API. Keep the directory descriptor
    // open and recheck its inode and canonical path around every path-based step.
    if (process.platform !== "win32") {
      try {
        rootHandle = await open(
          ignoredRoot,
          constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
        );
      } catch {
        throw unsafeRenderLocation(".wrangler could not be opened without following symbolic links.");
      }
      rootIdentity = await rootHandle.stat();
      if (!rootIdentity.isDirectory()) {
        throw unsafeRenderLocation(".wrangler is not a directory.");
      }
      await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootIdentity, false);
      await rootHandle.chmod(0o700);
    }
    await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootIdentity);
    await assertSafeDestination(resolvedOutput);

    temporaryPath = resolve(ignoredRoot, `.notice-render-${process.pid}-${randomUUID()}.tmp`);
    try {
      temporaryHandle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch {
      throw unsafeRenderLocation("a private temporary configuration file could not be created safely.");
    }
    temporaryIdentity = await temporaryHandle.stat();
    if (!temporaryIdentity.isFile()) {
      throw unsafeRenderLocation("the private temporary configuration is not a regular file.");
    }
    if (process.platform !== "win32") await temporaryHandle.chmod(0o600);

    const canonicalTemporaryPath = resolve(canonicalIgnoredRoot, basename(temporaryPath));
    await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootIdentity);
    await assertTrustedFile(temporaryPath, canonicalTemporaryPath, temporaryIdentity, "the private temporary configuration");

    await temporaryHandle.writeFile(rendered, { encoding: "utf8" });
    await temporaryHandle.sync();
    await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootIdentity);
    await assertTrustedFile(temporaryPath, canonicalTemporaryPath, temporaryIdentity, "the private temporary configuration");
    await assertSafeDestination(resolvedOutput);

    await temporaryHandle.close();
    temporaryHandle = null;
    await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootIdentity);
    await assertTrustedFile(temporaryPath, canonicalTemporaryPath, temporaryIdentity, "the private temporary configuration");
    // rename replaces a racing destination symlink itself; it never opens that
    // symlink's referent. The postcondition below then checks the exact inode.
    await rename(temporaryPath, resolvedOutput);
    temporaryPath = null;

    await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootIdentity);
    await assertTrustedFile(
      resolvedOutput,
      resolve(canonicalIgnoredRoot, basename(resolvedOutput)),
      temporaryIdentity,
      "the generated deployment configuration",
    );
  } finally {
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
    if (temporaryPath && temporaryIdentity) {
      try {
        await assertTrustedDirectory(ignoredRoot, canonicalIgnoredRoot, rootIdentity);
        await assertTrustedFile(
          temporaryPath,
          resolve(canonicalIgnoredRoot, basename(temporaryPath)),
          temporaryIdentity,
          "the private temporary configuration",
        );
        await unlink(temporaryPath);
      } catch {
        // If the directory or file identity changed, leaving the random temporary
        // name behind is safer than risking an unlink through an attacker-controlled path.
      }
    }
    if (rootHandle) await rootHandle.close().catch(() => undefined);
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(usage);
} else if (args.length !== 2 || !["plan", "render"].includes(args[0])) {
  fail("Expected exactly one plan or render command and one JSON manifest path.");
} else {
  const [command, rawManifestPath] = args;
  const manifestPath = resolve(process.cwd(), rawManifestPath);
  try {
    const manifest = await loadManifest(manifestPath);
    if (command === "plan") {
      const plan = createDeploymentPlan(manifest, displayPath(manifestPath));
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      const outputPath = generatedWranglerPath(manifest);
      const resolvedOutput = resolve(process.cwd(), outputPath);
      const rendered = serializeWranglerConfiguration(manifest);
      await writeGeneratedConfiguration(resolvedOutput, rendered);
      process.stdout.write(`${JSON.stringify({
        schemaVersion: "1.0",
        action: "render",
        environment: manifest.environment,
        output: outputPath,
        bytes: Buffer.byteLength(rendered),
        secretFieldsAccepted: false,
      }, null, 2)}\n`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Deployment manifest validation failed.", 1);
  }
}

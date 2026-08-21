"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Node must load this security preload synchronously with --require before Wrangler. */

const crypto = require("node:crypto");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const CAPSULE_FD = 3;
const ATTESTATION_FD = 4;
const MAX_CAPSULE_BYTES = 2_097_152;
const MAX_INPUT_BYTES = 1_048_576;

function boundedDescriptorBytes(fd) {
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(65_536);
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_CAPSULE_BYTES) {
        chunk.fill(0);
        throw new Error("The pinned Wrangler input capsule is too large.");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  }
  if (total === 0) throw new Error("The pinned Wrangler input capsule is empty.");
  const result = Buffer.concat(chunks, total);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

function exactKeys(candidate, expected, description) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`${description} must be an object.`);
  }
  const actual = Object.keys(candidate).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${description} has unexpected fields.`);
  }
}

function decodedEntry(candidate, description) {
  exactKeys(candidate, ["bytes", "data", "path", "sha256"], description);
  if (typeof candidate.path !== "string" || !path.isAbsolute(candidate.path)) {
    throw new Error(`${description} path must be absolute.`);
  }
  if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0 || candidate.bytes > MAX_INPUT_BYTES) {
    throw new Error(`${description} has an invalid byte length.`);
  }
  if (typeof candidate.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.data)) {
    throw new Error(`${description} is not canonical base64.`);
  }
  const bytes = Buffer.from(candidate.data, "base64");
  if (bytes.length !== candidate.bytes || bytes.toString("base64") !== candidate.data) {
    throw new Error(`${description} byte length does not match its encoding.`);
  }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (candidate.sha256 !== digest) throw new Error(`${description} digest does not match its bytes.`);
  return { path: path.resolve(candidate.path), bytes, digest, reads: 0 };
}

let capsuleBytes;
try {
  capsuleBytes = boundedDescriptorBytes(CAPSULE_FD);
} finally {
  try {
    fs.closeSync(CAPSULE_FD);
  } catch {
    // A malformed or prematurely closed capsule still fails in the parser.
  }
}

let capsule;
try {
  capsule = JSON.parse(capsuleBytes.toString("utf8"));
} catch {
  throw new Error("The pinned Wrangler input capsule is not valid JSON.");
} finally {
  capsuleBytes.fill(0);
}
exactKeys(capsule, ["configuration", "nonce", "schemaVersion", "secrets"], "The pinned Wrangler input capsule");
if (capsule.schemaVersion !== "1.0" || typeof capsule.nonce !== "string"
  || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(capsule.nonce)) {
  throw new Error("The pinned Wrangler input capsule has an invalid identity.");
}
let configuration;
let secrets;
try {
  configuration = decodedEntry(capsule.configuration, "The pinned Wrangler configuration");
  secrets = capsule.secrets === null
    ? null
    : decodedEntry(capsule.secrets, "The pinned Wrangler secrets");
} catch (error) {
  configuration?.bytes.fill(0);
  throw error;
}
const capsuleNonce = capsule.nonce;
capsule.configuration.data = "";
if (capsule.secrets) capsule.secrets.data = "";
capsule = null;
if (secrets && secrets.path === configuration.path) {
  configuration.bytes.fill(0);
  secrets.bytes.fill(0);
  throw new Error("Pinned Wrangler configuration and secrets paths must be distinct.");
}

const originalReadFileSync = fs.readFileSync;
function normalizedCandidate(candidate) {
  if (candidate instanceof URL) return path.resolve(fileURLToPath(candidate));
  if (typeof candidate === "string" || Buffer.isBuffer(candidate)) return path.resolve(String(candidate));
  return null;
}
function selectedEntry(candidate) {
  const normalized = normalizedCandidate(candidate);
  if (normalized === configuration.path) return configuration;
  if (secrets && normalized === secrets.path) return secrets;
  return null;
}
fs.readFileSync = function pinnedReadFileSync(candidate, options) {
  const entry = selectedEntry(candidate);
  if (!entry) return originalReadFileSync.apply(this, arguments);
  entry.reads += 1;
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding ? entry.bytes.toString(encoding) : Buffer.from(entry.bytes);
};
syncBuiltinESMExports();

process.once("exit", (code) => {
  const complete = configuration.reads > 0 && (secrets === null || secrets.reads > 0);
  const attestation = {
    schemaVersion: "1.0",
    nonce: capsuleNonce,
    configuration: { reads: configuration.reads, sha256: configuration.digest },
    secrets: secrets === null ? null : { reads: secrets.reads, sha256: secrets.digest },
    complete,
  };
  let wroteAttestation = true;
  try {
    fs.writeFileSync(ATTESTATION_FD, `${JSON.stringify(attestation)}\n`);
    fs.closeSync(ATTESTATION_FD);
  } catch {
    wroteAttestation = false;
    if (code === 0) process.exitCode = 1;
  } finally {
    configuration.bytes.fill(0);
    secrets?.bytes.fill(0);
  }
  if (!wroteAttestation) return;
  if (!complete && code === 0) process.exitCode = 1;
});

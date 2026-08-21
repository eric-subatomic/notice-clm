"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- Node must install this guard synchronously before Vinext loads dotenv or Vite. */

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const protectedBuildInputNames = new Set([
  ".dev.vars",
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
]);
const initialRoot = path.resolve(process.cwd());

function normalizedPath(candidate) {
  let value;
  if (candidate instanceof URL) value = fileURLToPath(candidate);
  else if (typeof candidate === "string" || Buffer.isBuffer(candidate)) value = String(candidate);
  else return null;
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rootPath(root, name) {
  const resolved = path.resolve(root, name);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const initialProtectedPaths = new Set(
  [...protectedBuildInputNames].map((name) => rootPath(initialRoot, name)),
);
for (const candidate of initialProtectedPaths) {
  try {
    const metadata = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (metadata) {
      throw new Error("The guarded production build forbids project-root .env and .dev.vars files; use the validated deployment manifest instead.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
}

function isProtectedBuildInput(candidate) {
  const normalized = normalizedPath(candidate);
  if (normalized === null) return false;
  if (initialProtectedPaths.has(normalized)) return true;
  let currentRoot;
  try {
    currentRoot = path.resolve(process.cwd());
  } catch {
    return false;
  }
  return [...protectedBuildInputNames].some((name) => normalized === rootPath(currentRoot, name));
}

function missingBuildInputError(candidate, syscall) {
  const selectedPath = normalizedPath(candidate) ?? String(candidate);
  const error = new Error(`ENOENT: no such file or directory, ${syscall} '${selectedPath}'`);
  Object.assign(error, { code: "ENOENT", errno: -2, path: selectedPath, syscall });
  return error;
}

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalOpenSync = fs.openSync;
const originalStatSync = fs.statSync;
const originalLstatSync = fs.lstatSync;
const originalPromisesReadFile = fsPromises.readFile;
const originalPromisesOpen = fsPromises.open;
const originalPromisesStat = fsPromises.stat;
const originalPromisesLstat = fsPromises.lstat;

fs.existsSync = function guardedExistsSync(candidate) {
  if (isProtectedBuildInput(candidate)) return false;
  return originalExistsSync.apply(this, arguments);
};
fs.readFileSync = function guardedReadFileSync(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "open");
  return originalReadFileSync.apply(this, arguments);
};
fs.openSync = function guardedOpenSync(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "open");
  return originalOpenSync.apply(this, arguments);
};
fs.statSync = function guardedStatSync(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "stat");
  return originalStatSync.apply(this, arguments);
};
fs.lstatSync = function guardedLstatSync(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "lstat");
  return originalLstatSync.apply(this, arguments);
};
fsPromises.readFile = async function guardedReadFile(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "open");
  return await originalPromisesReadFile.apply(this, arguments);
};
fsPromises.open = async function guardedOpen(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "open");
  return await originalPromisesOpen.apply(this, arguments);
};
fsPromises.stat = async function guardedStat(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "stat");
  return await originalPromisesStat.apply(this, arguments);
};
fsPromises.lstat = async function guardedLstat(candidate) {
  if (isProtectedBuildInput(candidate)) throw missingBuildInputError(candidate, "lstat");
  return await originalPromisesLstat.apply(this, arguments);
};
syncBuiltinESMExports();

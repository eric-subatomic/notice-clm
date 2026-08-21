#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const separator = process.argv.indexOf("--", 2);
if (separator < 2 || separator === process.argv.length - 1) {
  process.stderr.write("Usage: node scripts/run-with-env.mjs NAME=value [NAME=value ...] -- command [args ...]\n");
  process.exit(2);
}

const environment = { ...process.env };
for (const assignment of process.argv.slice(2, separator)) {
  const equals = assignment.indexOf("=");
  const name = assignment.slice(0, equals);
  if (equals < 1 || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    process.stderr.write(`Invalid environment assignment: ${assignment}\n`);
    process.exit(2);
  }
  environment[name] = assignment.slice(equals + 1);
}

const [command, ...args] = process.argv.slice(separator + 1);
const child = spawn(command, args, {
  env: environment,
  stdio: "inherit",
  shell: process.platform === "win32",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

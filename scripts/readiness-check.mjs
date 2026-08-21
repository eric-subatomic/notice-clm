#!/usr/bin/env -S node --import tsx

import process from "node:process";
import { evaluateProductionReadiness } from "../app/lib/readiness.ts";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  process.stdout.write(`Notice production-readiness preflight

Usage:
  npm run readiness -- [--json]

Options:
  --json   Write the complete machine-readable report to stdout.
  --help   Show this help text.

Exit status is 0 only when both maintainer code gates and customer
configuration gates pass. Configuration values and secrets are never printed.
`);
  process.exit(0);
}

const unsupported = [...args].filter((argument) => argument !== "--json");
if (unsupported.length > 0) {
  process.stderr.write(`Unknown option: ${unsupported.join(", ")}\nUse --help for usage.\n`);
  process.exit(2);
}

const readiness = evaluateProductionReadiness(process.env);

if (args.has("--json")) {
  process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
} else {
  const icon = (status) => status === "pass" ? "PASS" : status === "not_required" ? "N/A " : "FAIL";
  process.stdout.write(`Notice production readiness: ${readiness.readyForProduction ? "READY" : "NOT READY"}\n`);
  process.stdout.write(`Mode: ${readiness.appMode}\n`);
  process.stdout.write(`Checks: ${readiness.summary.passed} passed, ${readiness.summary.failed} failed, ${readiness.summary.notRequired} not required\n\n`);

  for (const [heading, section] of [["Maintainer code gates", readiness.code], ["Customer configuration", readiness.customer]]) {
    process.stdout.write(`${heading}: ${section.ready ? "READY" : "NOT READY"}\n`);
    for (const item of section.checks) {
      process.stdout.write(`  ${icon(item.status)}  ${item.id} — ${item.message}\n`);
      if (item.status === "fail" && item.remediation) process.stdout.write(`        Next: ${item.remediation}\n`);
    }
    process.stdout.write("\n");
  }
}

process.exitCode = readiness.readyForProduction ? 0 : 1;

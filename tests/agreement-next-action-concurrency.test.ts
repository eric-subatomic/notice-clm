import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const appRoot = new URL("../app/", import.meta.url);

async function sourceFiles(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) return sourceFiles(url);
    return /\.tsx?$/.test(entry.name) ? [url] : [];
  }));
  return nested.flat();
}

function relativeName(file: URL): string {
  return `app/${path.relative(appRoot.pathname, file.pathname)}`;
}

test("every existing-version agreement writer fences the server-derived next action", async () => {
  const files = await sourceFiles(appRoot);
  const snapshotCalls = new Map<string, number>();
  const agreementUpdates = new Map<string, number>();
  const missingFences: string[] = [];

  for (const file of files) {
    const name = relativeName(file);
    const contents = await readFile(file, "utf8");
    const source = ts.createSourceFile(name, contents, ts.ScriptTarget.Latest, true);
    const patchHandlerStart = name === "app/api/agreements/route.ts"
      ? contents.indexOf("export async function PATCH")
      : -1;

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression)
          && node.expression.text === "prepareAgreementSnapshot"
          && name !== "app/lib/persistence.ts"
          && !(name === "app/api/agreements/route.ts" && node.getStart(source) < patchHandlerStart)
        ) {
          snapshotCalls.set(name, (snapshotCalls.get(name) ?? 0) + 1);
        }

        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "where") {
          const update = node.getText(source);
          if (
            update.includes("update(agreements)")
            && update.includes("eq(agreements.version")
          ) {
            agreementUpdates.set(name, (agreementUpdates.get(name) ?? 0) + 1);
            if (!update.includes("eq(agreements.nextAction")) {
              const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
              missingFences.push(`${name}:${line + 1}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source);
  }

  assert.deepEqual(Object.fromEntries([...snapshotCalls].sort()), {
    "app/api/admin/integrations/resync/route.ts": 2,
    "app/api/admin/retention/route.ts": 1,
    "app/api/agreements/[id]/versions/route.ts": 1,
    "app/api/agreements/route.ts": 2,
    "app/api/agreements/transition/route.ts": 1,
    "app/api/documents/import/route.ts": 1,
    "app/api/intake/submissions/[id]/convert/route.ts": 1,
    "app/api/jobs/retention/route.ts": 1,
    "app/api/operations/route.ts": 3,
    "app/api/signatures/route.ts": 3,
    "app/lib/approval-routing-service.ts": 1,
    "app/lib/docuseal-reconciliation.ts": 4,
    "app/lib/negotiation-service.ts": 5,
  });
  assert.equal([...snapshotCalls.values()].reduce((total, count) => total + count, 0), 26);
  assert.deepEqual(Object.fromEntries([...agreementUpdates].sort()), {
    "app/api/admin/integrations/resync/route.ts": 2,
    "app/api/admin/retention/route.ts": 1,
    "app/api/agreements/[id]/versions/route.ts": 1,
    "app/api/agreements/route.ts": 2,
    "app/api/agreements/transition/route.ts": 1,
    "app/api/documents/import/route.ts": 6,
    "app/api/jobs/outbox/route.ts": 1,
    "app/api/jobs/retention/route.ts": 1,
    "app/api/operations/route.ts": 3,
    "app/api/signatures/route.ts": 4,
    "app/lib/approval-routing-service.ts": 1,
    "app/lib/docuseal-reconciliation.ts": 7,
    "app/lib/negotiation-service.ts": 9,
  });
  assert.deepEqual(missingFences, [], `missing nextAction CAS fences: ${missingFences.join(", ")}`);
});

test("saving reviewed paper invalidates risk evidence and requires a fresh governed assessment", async () => {
  const versionRoute = await readFile(new URL("../app/api/agreements/[id]/versions/route.ts", import.meta.url), "utf8");
  assert.match(versionRoute, /const nextAction = "Assess risk for the updated working paper"/);
  assert.match(versionRoute, /risk: "Unassessed",[\s\S]*riskDisposition: null,[\s\S]*riskBasisHash: null/);
  assert.match(versionRoute, /approvalStatus: "Required",[\s\S]*signatureStatus: "Not sent"/);
});

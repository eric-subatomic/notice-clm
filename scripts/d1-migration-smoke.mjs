import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const persistence = await mkdtemp(join(tmpdir(), "notice-d1-migrations-"));

async function run(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CI: "true",
        NO_COLOR: "1",
        MINIFLARE_REGISTRY_PATH: join(persistence, "miniflare-registry"),
        WRANGLER_LOG_PATH: join(persistence, "wrangler.log"),
        WRANGLER_WRITE_LOGS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", rejectRun);
    child.once("exit", (code) => code === 0
      ? resolveRun(output)
      : rejectRun(new Error(`Wrangler exited ${code}.\n${output}`)));
  });
}

try {
  await run(["d1", "migrations", "apply", "DB", "--local", "--persist-to", persistence]);
  const result = await run([
    "d1", "execute", "DB", "--local", "--persist-to", persistence,
    "--command", "SELECT version FROM notice_schema_state WHERE id = 'primary'", "--json",
  ]);
  const parsed = JSON.parse(result);
  const rows = Array.isArray(parsed) ? parsed.flatMap((entry) => entry?.results ?? []) : [];
  assert.equal(
    rows.length,
    1,
    `D1 migration smoke must produce one schema marker row. Wrangler returned: ${result}`,
  );
  assert.equal(rows[0]?.version, 21, "D1 migrations must reach schema marker 21");
  process.stdout.write("Wrangler D1 migration smoke passed at schema marker 21.\n");
} finally {
  await rm(persistence, { recursive: true, force: true });
}

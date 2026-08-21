import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launchers = [
  ["playwright.config.ts", "127.0.0.1"],
  ["tests/e2e/production/harness.mjs", "127.0.0.1"],
  ["tests/local-api-smoke.mjs", "localhost"],
  ["tests/production-api-evidence.mjs", "localhost"],
] as const;

test("vinext test launchers use its supported hostname option", async () => {
  for (const [file, expectedHost] of launchers) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const tokens = source.split(/[\s"'`,\[\]]+/).filter(Boolean);
    assert.ok(
      tokens.some((token, index) => token === "--hostname" && tokens[index + 1] === expectedHost),
      `${file} must bind the expected hostname ${expectedHost}`,
    );
    assert.equal(tokens.includes("--host"), false, `${file} must not use Vite's ignored --host option`);
    assert.equal(tokens.includes("--strictPort"), false, `${file} must not use Vite's ignored --strictPort option`);
  }
});

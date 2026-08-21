import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as {
  engines: { node: string; npm: string };
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const packageLock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, { dev?: boolean } | undefined> };
const npmConfig = await readFile(
  new URL("../.npmrc", import.meta.url),
  "utf8",
);

test("the release toolchain stays aligned with the supported Node and Next runtimes", () => {
  assert.equal(packageJson.engines.node, ">=22.13.0 <23");
  assert.equal(packageJson.engines.npm, ">=11.3.0 <12");
  assert.equal(packageJson.packageManager, "npm@11.3.0");
  assert.match(npmConfig, /^engine-strict=true$/m);
  assert.match(npmConfig, /^strict-peer-deps=true$/m);
  assert.match(packageJson.devDependencies["@types/node"], /^22\./);
  assert.match(packageJson.devDependencies.eslint, /^9\./);
  assert.match(packageJson.devDependencies.typescript, /^6\./);
  assert.match(packageJson.devDependencies.vite, /^8\./);
  assert.equal(packageJson.dependencies.next, undefined);
  assert.equal(
    packageJson.devDependencies.next,
    packageJson.devDependencies["eslint-config-next"],
  );
  assert.equal(packageLock.packages["node_modules/next"]?.dev, true);
  assert.equal(packageJson.dependencies.react, packageJson.dependencies["react-dom"]);
  assert.equal(
    packageJson.dependencies.react,
    packageJson.devDependencies["react-server-dom-webpack"],
  );
});

test("Dependabot groups compatible updates without hiding breaking majors", async () => {
  const source = await readFile(
    new URL("../.github/dependabot.yml", import.meta.url),
    "utf8",
  );
  const lines = source.split("\n");

  for (const group of [
    "next-compatibility-lint",
    "react-runtime",
    "drizzle-toolchain",
    "cloudflare-toolchain",
    "vite-toolchain",
    "compatible-production-dependencies",
    "compatible-development-dependencies",
  ]) {
    const start = lines.indexOf(`      ${group}:`);
    assert.notEqual(start, -1, `missing Dependabot group ${group}`);
    const nextGroup = lines.findIndex(
      (line, index) => index > start && /^      [a-z][a-z0-9-]*:$/.test(line),
    );
    const block = lines
      .slice(start, nextGroup === -1 ? lines.length : nextGroup)
      .join("\n");
    assert.match(block, /applies-to: version-updates/);
    assert.match(block, /update-types:\n          - minor\n          - patch/);
    assert.doesNotMatch(block, /          - major/);
  }
});

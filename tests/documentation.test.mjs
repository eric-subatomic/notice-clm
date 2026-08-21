import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = path.join(repositoryRoot, "docs", "how-to", "index.html");
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), "utf8");

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

function localReferences(source, pattern) {
  return [...source.matchAll(pattern)]
    .map((match) => match[1])
    .filter((reference) => !/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(reference));
}

async function assertReferencesExist(source, sourcePath, pattern) {
  const sourceDirectory = path.dirname(sourcePath);
  for (const reference of localReferences(source, pattern)) {
    if (!reference || reference.startsWith("#")) continue;
    const cleanReference = decodeURIComponent(reference.split("#", 1)[0].split("?", 1)[0]);
    if (!cleanReference) continue;
    const target = path.resolve(sourceDirectory, cleanReference);
    assert.ok(
      target === repositoryRoot || target.startsWith(`${repositoryRoot}${path.sep}`),
      `Reference escapes the repository: ${reference}`,
    );
    await assert.doesNotReject(access(target), `Missing local reference: ${reference}`);
  }
}

test("the HTML how-to is self-contained, accessible, and complete", async () => {
  const html = await readFile(guidePath, "utf8");

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html\b[^>]*\blang="en"/i);
  assert.match(html, /<title>[^<]*Notice[^<]*how-to[^<]*<\/title>/i);
  assert.match(html, /<a\b[^>]*class="skip-link"[^>]*href="#main-content"/i);
  assert.match(html, /<main\b[^>]*id="main-content"/i);
  assert.match(html, /<nav\b[^>]*aria-label=/i);
  assert.match(html, /aria-live="polite"/i);
  assert.match(html, /<noscript>/i);
  assert.match(html, /@media\s+print/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i, "Guide must not load external JavaScript");
  assert.doesNotMatch(html, /<link\b[^>]*\brel=["']stylesheet["']/i, "Guide must not load external stylesheets");

  const ids = [...html.matchAll(/\bid=(["'])(.*?)\1/gi)].map((match) => match[2]);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  const idSet = new Set(ids);

  for (const anchor of localReferences(html, /\bhref=["']([^"']+)["']/gi).filter((item) => item.startsWith("#"))) {
    assert.ok(idSet.has(anchor.slice(1)), `Internal link has no target: ${anchor}`);
  }

  const requiredSections = [
    "start",
    "orientation",
    "first-contract",
    "workspace",
    "redlines",
    "approvals",
    "signature",
    "obligations",
    "find-reuse",
    "history",
    "errors",
    "implementation",
    "troubleshooting",
    "quick-reference",
    "glossary",
  ];
  for (const section of requiredSections) {
    assert.ok(idSet.has(section), `Guide is missing section #${section}`);
  }

  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1, "Guide must have exactly one h1");
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    assert.ok(attribute(tag, "alt")?.trim(), `Image is missing useful alt text: ${tag}`);
    assert.ok(attribute(tag, "width"), `Image is missing intrinsic width: ${tag}`);
    assert.ok(attribute(tag, "height"), `Image is missing intrinsic height: ${tag}`);
  }

  assert.match(html, /does not parse Word Track Changes/i);
  assert.match(html, /one active round/i);
  assert.match(html, /human-reviewed text/i);
  assert.match(html, /not legal[^<]*advice/i);
  assert.match(html, /portal submitter types an email address/i);
  assert.match(html, /not authenticated identity or proof of mailbox control/i);
  assert.match(html, /queued or processing[\s\S]*blocks rotation, closure, and promotion/i);
  assert.doesNotMatch(
    html,
    /images\/user-guide/i,
    "The pre-PR11 annotated screenshots must not be presented as the current interface",
  );

  await assertReferencesExist(html, guidePath, /\b(?:href|src)=["']([^"']+)["']/gi);
});

test("the README gives a safe, simple route into current documentation", async () => {
  const readme = await read("README.md");
  const readmePath = path.join(repositoryRoot, "README.md");

  assert.match(readme, /\[HTML how-to(?: guide)?\]\(\.\/docs\/how-to\/index\.html\)/i);
  assert.match(readme, /\[Documentation index\]\(\.\/docs\/README\.md\)/i);
  assert.ok(readme.indexOf("npm ci") < readme.indexOf("npm run dev:evaluation"));
  assert.match(readme, /synthetic (?:evaluation|agreement) records/i);
  assert.match(readme, /Do not deploy production directly from it/i);
  assert.match(readme, /does not parse Word Track Changes/i);
  assert.match(readme, /scanner and outbound delivery gateway[^\n]*external customer implementations/i);
  assert.match(readme, /Negotiation -> \[risk \+ approval gate\] -> Signature/i);
  assert.match(readme, /\[Governed agent API\]\(\.\/docs\/AGENT_API\.md\)/);
  assert.match(readme, /npm run test:e2e\s+npm run test:e2e:production/);
  assert.doesNotMatch(readme, /images\/user-guide/i);

  await assertReferencesExist(readme, readmePath, /\[[^\]]+\]\(([^)]+)\)/g);
});

test("first-run guides explain how to satisfy the reviewed npm version", async () => {
  const sources = await Promise.all([
    read("README.md"),
    read("CONTRIBUTING.md"),
    read("docs/PUBLIC_RELEASE.md"),
    read("docs/DEPLOYMENT_QUICKSTART.md"),
  ]);

  for (const source of sources) {
    assert.match(source, /node --version/);
    assert.match(source, /npm --version/);
    assert.match(source, /npm install --global npm@11\.3\.0/);
    assert.match(source, /Some Node 22 installers still bundle npm 10/i);
    assert.match(source, /do not use `sudo` in the project checkout/i);
  }
});

test("the GitHub documentation index routes every audience to the maintained guides", async () => {
  const documentationIndex = await read("docs/README.md");
  const documentationIndexPath = path.join(repositoryRoot, "docs", "README.md");

  assert.match(documentationIndex, /\[Complete user guide\]\(\.\/USER_GUIDE\.md\)/i);
  assert.match(documentationIndex, /\[Self-contained HTML how-to\]\(\.\/how-to\/index\.html\)/i);
  assert.match(documentationIndex, /\[DocuSeal 3\.2\.1 integration profile\]\(\.\/DOCUSEAL\.md\)/i);
  assert.match(documentationIndex, /\[Customer-hosted OCR and bring-your-own model\]\(\.\/CUSTOMER_HOSTED_OCR\.md\)/i);
  assert.match(documentationIndex, /GitHub-native operating manual/i);

  await assertReferencesExist(documentationIndex, documentationIndexPath, /\[[^\]]+\]\(([^)]+)\)/g);
});

test("deployment documentation tracks the runtime schema marker", async () => {
  const schemaGuard = await read("db/schema-guard.ts");
  const marker = schemaGuard.match(/NOTICE_SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
  assert.ok(marker, "Runtime schema marker must be readable from db/schema-guard.ts");

  const deployment = await read("docs/DEPLOYMENT.md");
  const quickstart = await read("docs/DEPLOYMENT_QUICKSTART.md");
  const productionSetup = await read("docs/PRODUCTION_SETUP.md");
  assert.match(deployment, new RegExp(`requires main marker \\x60${marker}\\x60`));
  assert.match(quickstart, new RegExp(`main schema marker \\x60${marker}\\x60`));
  assert.match(productionSetup, new RegExp(`exact marker version \\*\\*${marker}\\*\\*`));
  assert.match(productionSetup, new RegExp(`NOTICE_SCHEMA_VERSION=${marker}`));
  assert.match(productionSetup, new RegExp(`\\x60${marker.padStart(4, "0")}\\x60[^\\n]*exact marker`));
});

test("the Markdown user guide reflects the current recovery and identity boundaries", async () => {
  const userGuide = await read("docs/USER_GUIDE.md");
  const userGuidePath = path.join(repositoryRoot, "docs", "USER_GUIDE.md");

  assert.doesNotMatch(userGuide, /images\/user-guide/i);
  assert.match(userGuide, /there is no general administrator recovery action in the product UI/i);
  assert.match(userGuide, /portal submitter types an email address/i);
  assert.match(userGuide, /not authenticated identity or proof of mailbox control/i);
  assert.match(userGuide, /names need not be unique, but normalized signer emails must be/i);
  assert.match(userGuide, /ordinary import dialog does not expose a rescan action/i);
  assert.match(userGuide, /becomes eligible for guarded cleanup after seven days/i);
  assert.match(userGuide, /Conversion does not create working paper/i);
  assert.match(userGuide, /Save current view/i);
  assert.match(userGuide, /Parent-only creation is rejected/i);
  assert.match(userGuide, /OCR is an environment-level deployment choice/i);
  assert.match(userGuide, /DocuSeal \*\*3\.2\.1\*\*[\s\S]*API contract \*\*1\.0\.24\*\*/i);
  assert.match(userGuide, /## 15\. Recover safely/i);
  assert.match(userGuide, /## 16\. First-contract checklists/i);
  assert.match(userGuide, /## 17\. Glossary and deeper documentation/i);

  await assertReferencesExist(userGuide, userGuidePath, /\[[^\]]+\]\(([^)]+)\)/g);
});

test("security-sensitive operating contracts stay aligned with the shipped hardening", async () => {
  const readme = await read("README.md");
  const api = await read("docs/API.md");
  const agentApi = await read("docs/AGENT_API.md");
  const operations = await read("docs/OPERATIONS.md");
  const security = await read("SECURITY.md");
  const userGuide = await read("docs/USER_GUIDE.md");
  const howTo = await read("docs/how-to/index.html");
  const workspaceUi = await read("app/page.tsx");

  for (const source of [readme, api, operations, security]) {
    assert.match(source, /10 (?:admitted )?upload(?: attempts|s|s total)/i);
    assert.match(source, /(?:4 accepted|at most 4 may be accepted)/i);
    assert.match(source, /6 rejected(?: or |\/)failed/i);
    assert.match(source, /96 MiB/i);
    assert.match(source, /(?:20 download|downloads?[^.\n]{0,40}(?:20 attempts|capped at 20))/i);
    assert.match(source, /256 MiB/i);
    assert.match(source, /(?:rotation|rotate)[^\n]*does not reset|does not reset[^\n]*(?:rotation|rotate|portal token)|replacing a portal token does not reset/i);
  }

  assert.match(readme, /sponsor cannot approve or reject/i);
  assert.match(agentApi, /grant sponsor cannot approve \*\*or reject\*\*/i);
  assert.match(agentApi, /claim and result-commit independently recheck/i);
  assert.match(api, /complete bounded file/i);
  assert.match(api, /malicious result[^\n]*dominates a concurrent clean result/i);
  assert.doesNotMatch(
    `${readme}\n${api}\n${operations}\n${security}\n${userGuide}\n${howTo}\n${workspaceUi}`,
    /one-time portal (?:or outbound )?credential/i,
  );
  assert.match(userGuide, /round token itself is not single-use/i);
});

test("public release guidance separates private-state controls from an irreversible public cutover", async () => {
  const publicRelease = await read("docs/PUBLIC_RELEASE.md");
  const security = await read("SECURITY.md");
  const codeOfConduct = await read("CODE_OF_CONDUCT.md");

  assert.match(publicRelease, /public access begins immediately and cannot be recalled/i);
  assert.doesNotMatch(publicRelease, /reversible cutover/i);
  assert.match(publicRelease, /before changing visibility, enable the dependency graph, dependency alerts\/security updates/i);
  assert.match(publicRelease, /non-maintainer submits separate synthetic security and conduct reports/i);
  assert.match(publicRelease, /restore private visibility to contain further access, record the public interval as a disclosure event/i);
  assert.match(publicRelease, /protect `main` with required pull requests/i);
  assert.match(publicRelease, /dispatch the existing custom CodeQL workflow/i);
  assert.match(publicRelease, /do not also enable default setup/i);
  assert.match(security, /controlled first-public cutover therefore remains unannounced/i);
  assert.match(codeOfConduct, /controlled visibility cutover remains unannounced/i);
});

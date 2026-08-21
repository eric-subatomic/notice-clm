import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the public project has complete maintainer, contribution, support, and conduct entry points", () => {
  const readme = read("../README.md");
  const docs = read("../docs/README.md");
  const contributing = read("../CONTRIBUTING.md");
  const governance = read("../GOVERNANCE.md");
  const support = read("../SUPPORT.md");
  const security = read("../SECURITY.md");
  const changelog = read("../CHANGELOG.md");
  const conduct = read("../CODE_OF_CONDUCT.md");
  const license = read("../LICENSE");

  for (const target of [
    "./CONTRIBUTING.md", "./GOVERNANCE.md", "./SUPPORT.md", "./SECURITY.md",
    "./CODE_OF_CONDUCT.md", "./CHANGELOG.md", "./LICENSE",
  ]) assert.match(readme, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const target of ["../CONTRIBUTING.md", "../GOVERNANCE.md", "../SUPPORT.md", "../SECURITY.md"]) {
    assert.match(docs, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(contributing, /synthetic, non-sensitive|synthetic data/i);
  assert.match(governance, /accountable maintainer/i);
  assert.match(support, /best effort/i);
  assert.match(security, /Report a vulnerability/i);
  assert.match(security, /Supported versions/i);
  assert.match(changelog, /\[Unreleased\]/);
  assert.match(changelog, /## \[0\.1\.0\] - 2026-08-21/);
  assert.doesNotMatch(changelog, /No public release has been tagged/i);
  assert.match(conduct, /Contributor Covenant/);
  assert.match(conduct, /private report form/);
  assert.match(conduct, /Code of Conduct.*title/i);
  assert.match(license, /MIT License/);
});

test("issue forms and the pull-request template route sensitive reports away from public issues", () => {
  const bug = read("../.github/ISSUE_TEMPLATE/bug_report.yml");
  const feature = read("../.github/ISSUE_TEMPLATE/feature_request.yml");
  const config = read("../.github/ISSUE_TEMPLATE/config.yml");
  const pullRequest = read("../.github/PULL_REQUEST_TEMPLATE.md");
  const owners = read("../.github/CODEOWNERS");

  for (const form of [bug, feature]) {
    assert.match(form, /^name: .+/m);
    assert.match(form, /^description: .+/m);
    assert.match(form, /^body:/m);
    assert.match(form, /synthetic/i);
    assert.match(form, /sensitive|customer/i);
  }
  assert.match(bug, /not a vulnerability report/i);
  assert.match(config, /blank_issues_enabled: false/);
  assert.match(config, /security\/advisories\/new/);
  assert.match(config, /Report a Code of Conduct concern privately/);
  assert.doesNotMatch(config, /mailto:/i);
  assert.match(pullRequest, /Security and data review/);
  assert.match(pullRequest, /npm run test:e2e:production/);
  assert.match(owners, /^\* @ericwithac$/m);
});

test("repository text and generated artifacts have explicit line-ending and ownership policy", () => {
  const editorConfig = read("../.editorconfig");
  const attributes = read("../.gitattributes");
  const ignore = read("../.gitignore");
  assert.match(editorConfig, /^root = true$/m);
  assert.match(editorConfig, /^end_of_line = lf$/m);
  assert.match(editorConfig, /^insert_final_newline = true$/m);
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^drizzle\/meta\/\*\.json linguist-generated=true$/m);
  assert.match(ignore, /^\/notice-sbom\.cdx\.json$/m);
});

test("GitHub workflows use immutable actions and do not persist checkout credentials", () => {
  const workflows = [read("../.github/workflows/ci.yml"), read("../.github/workflows/codeql.yml")];
  for (const workflow of workflows) {
    for (const action of workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
      assert.match(action[1] ?? "", /^[^@\s]+@[0-9a-f]{40}$/, `Action must use an immutable commit: ${action[1]}`);
    }
    const checkouts = workflow.split(/\n(?=\s*- name: )/).filter((step) => step.includes("actions/checkout@"));
    for (const checkout of checkouts) assert.match(checkout, /persist-credentials: false/);
  }
  assert.match(workflows[1] ?? "", /github\.event\.repository\.private == false/);
  assert.match(workflows[1] ?? "", /queries: security-extended/);
});

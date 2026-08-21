# Public release and adopter handoff

This document governs publication of the reusable Notice source and the first handoff to an adopter. Notice can be released as an off-the-shelf **deployable CLM foundation**: the application, storage model, migrations, authorization, provider contracts, operational routes, and automated evidence are included. A checkout is not a production service by itself. Customer identity, provider accounts, gateways, policy decisions, infrastructure, and staging acceptance remain mandatory before real data is admitted.

Public source release and customer production acceptance are separate decisions:

| Decision | What can be approved from this repository | What still requires an owner outside the repository |
| --- | --- | --- |
| Public source release | Reviewed source snapshot, license, documentation, dependency inventory, passing clean-install/CI evidence, security intake, and history review | Repository visibility change and release announcement |
| Deployable foundation | Worker package, D1 migrations through exact marker 21, R2 contract, governed enterprise/intake/approval records, fail-closed configuration, identity/provider interfaces, diagnostics, jobs, and test harnesses | Cloudflare resources, explicit route, secrets, protected identity edge, customer governance data, scanner/delivery implementations, and observability |
| Customer production use | Reusable technical acceptance checklist and redacted readiness report | Customer policy, provider/vendor acceptance, backup/restore, penetration test, staging evidence, risk acceptance, and permission to use real data |

Do not describe a public source tag as “production approved,” “turnkey,” or “compliant.” The accurate claim is: **release-ready deployable foundation; production use requires the documented customer implementation and acceptance gates.**

## Evaluation quickstart

Supported development runtime:

- Node.js `>=22.13.0 <23`
- npm `>=11.3.0 <12`

Use the current security-patched Node 22 LTS release for release builds. CI runs the full release gate on Node `22.23.2`, checks the declared `22.13.0` engine floor separately, and uses the repository-pinned npm `11.3.0` for reproducible lockfile and SBOM evidence.

From a clean checkout:

```bash
node --version
npm --version
# If npm is older than 11.3.0:
npm install --global npm@11.3.0
npm --version
npm ci
npm run dev:evaluation
```

Some Node 22 installers still bundle npm 10. Upgrade npm before installation rather than using an older client against the reviewed lockfile. If the global npm location is not writable, use a Node version manager or another user-owned installation; do not use `sudo` in the project checkout.

Open the loopback URL printed by the development server. Evaluation mode is loopback-only, creates a synthetic administrator and demonstration records, and must contain synthetic documents only. Its signing action is a local simulation: it does not embed an external form, contact DocuSeal, send invitations, or create production evidence. Plain `npm run dev` keeps the production-default fail-closed behavior.

## Public-source release gates

Complete every private-state gate below before changing repository visibility or publishing an archive. GitHub makes some required controls—including private vulnerability reporting and branch protection on a free personal repository—available only after the repository is public. Treat that change as an unannounced, attended cutover: public access begins immediately and cannot be recalled, even if visibility is later restored to private. Enable and verify the public-only controls immediately, and do not announce, tag, accept contributions, or distribute the source until every post-visibility check passes.

### 1. Publish a reviewed source snapshot, not unreviewed history

Making a repository public discloses every reachable commit and object, including deleted files, prior configuration, author email addresses, old deployment URLs/identifiers, and abandoned experiments. A clean current tree does not make historical objects safe.

Before publication:

1. inventory the complete Git history and all reachable objects for secrets, personal information, customer content, internal URLs/identifiers, and third-party material;
2. retain the audit result and the exact reviewed source revision;
3. if any historical object is unnecessary or unsuitable for public disclosure, publish a new repository or new root history from the reviewed source snapshot instead of exposing or rewriting the private collaboration repository in place;
4. replace every source-project locator in `package.json` (`repository`, `homepage`, and `bugs`) with the disclosure-reviewed public repository, then verify the SBOM VCS reference is derived from that public `repository.url` and contains no private engineering locator;
5. search the complete snapshot for the private repository owner/name and any prior source or deployment URL, retaining an explicit allowlist only for references the release owner has approved for disclosure;
6. verify the public snapshot contains the expected license, attribution, lockfile, migrations, documentation, CI, and no generated customer configuration; and
7. verify the public repository includes issue forms, a pull-request template, CODEOWNERS, governance, support, security, contribution, conduct, and changelog files with working links; and
8. obtain explicit release-owner approval before changing visibility.

Keep the original private repository as the controlled engineering/audit record when policy requires it. Do not copy issues, pull-request discussion, Actions logs, releases, or deployment metadata into the public project without a separate disclosure review.

### 2. Establish private security and conduct intake before launch

Enable and test GitHub private vulnerability reporting (or an equally private repository advisory path) before announcing a public release. GitHub exposes repository private vulnerability reporting only for public repositories, so a private staging repository cannot prove that path in advance. During the controlled visibility cutover, enable it immediately, verify that the public **Security** page exposes **Report a vulnerability**, and keep the project unannounced while a non-maintainer submits separate synthetic security and conduct reports. The current project routes both through the private advisory form with a distinct `Code of Conduct` title prefix; only repository security managers may receive it. The maintainer must prove receipt, private discussion, routing, and closure for both reports. If enablement or either test fails, restore private visibility to contain further access, record the public interval as a disclosure event, and stop the release; restoring privacy cannot retract copies, caches, or observations made during that interval.

The project currently makes no guaranteed response-time or long-term maintenance promise. A release owner must record the supported release line, triage owner, response targets, disclosure process, and upgrade policy before offering a supported production service. See [Security](../SECURITY.md).

### 3. Retain a complete revision-bound validation record

Run from a clean checkout with the supported Node/npm versions:

```bash
npm ci
npm test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:production
npm run audit:production
npm run audit:all
npm run audit:signatures
npm run sbom -- --output notice-sbom.cdx.json
npm run sbom:validate -- --input notice-sbom.cdx.json
git diff --check
```

`npm test` includes the D1 migration smoke test, unit/security tests, type checking, lint, `vinext check`, production build, Wrangler dry run, rendered-output checks, and isolated evaluation/production API evidence. The Playwright suites add real-browser lifecycle, responsive, keyboard, automated accessibility, and signed production-identity/mutation evidence. Together they still do not prove the live identity edge, live providers, backup/restore, manual assistive-technology acceptance, target-estate load behavior, or customer workflow acceptance.

The SBOM command derives the complete dependency inventory from the committed lockfile, fixes the root identity to `notice-clm@0.1.0`, derives its VCS location from the validated credential-free HTTPS `package.json` repository URL, and records the exact checked-out Git revision in both the root properties and VCS reference. Its timestamp and serial number are deterministic for that revision, and validation rejects empty inventories, identity/revision mismatches, and local filesystem paths. CI additionally requires a clean checkout and retains the validated CycloneDX artifact under a revision-qualified artifact name. A clean public snapshot is not release-ready until its package metadata and generated SBOM point to that public snapshot rather than this private engineering repository.

The release gate is zero known production dependency advisories at the configured audit threshold and no unaccepted high/critical finding in the complete tree. If a future lockfile reports a development-only advisory through a build or migration tool, do not use `npm audit fix --force` or downgrade tooling merely to hide it. Record the exact advisory output, confirm it is absent from the deployed production dependency tree, limit the affected tool to trusted input, track the upstream fix, and obtain an explicit time-bounded risk acceptance. The `postcss` and `sharp` overrides are deliberate security holds; review and remove them only when the framework resolves to equally safe compatible versions.

`vinext` remains an evolving compatibility layer. A passing `vinext check`, build, dry run, and automated API evidence are necessary, but they are not a stability warranty. Pin the reviewed versions, test the built Worker in a production-equivalent staging environment, and record any accepted platform risk for each release.

### 4. Protect the public project

Before changing visibility, enable the dependency graph, dependency alerts/security updates, automatic merged-branch deletion, read-only workflow tokens, and the reviewed full-SHA Actions allowlist available in the private repository. Before announcement, configure the source host to require reviewed pull requests and passing checks for the default branch, restrict release/environment credentials, enable the remaining public-only secret/code security controls, and document maintainer/release ownership. Confirm that package publication remains disabled intentionally by `"private": true`; that field does not control source visibility.

The source host is part of the control: enable automatic deletion of merged branches, restrict Actions to reviewed publishers, require immutable action references where supported, enable private vulnerability reporting, and test the issue/PR templates from a non-maintainer account. CODEOWNERS requests review but does not replace an enforced branch rule.

For a GitHub free personal repository, perform the public-only portion as one attended maintenance window after every private-state gate and explicit release-owner approval:

1. change only the disclosure-reviewed clean staging repository to public, recognizing that this immediately discloses its reachable contents;
2. immediately enable private vulnerability reporting and secret scanning with push protection, then dispatch the existing custom CodeQL workflow and verify successful SARIF upload and code-scanning readback; do not also enable default setup;
3. immediately protect `main` with required pull requests, passing CI, resolved conversations, stale-approval dismissal, and force-push/deletion blocks;
4. verify those settings by API and from a non-maintainer browser session, then submit and close the two synthetic private reports;
5. run CodeQL and the complete revision-bound release gate against the exact public revision; and
6. if any control or test fails, restore private visibility to contain further access, record the disclosure interval, and stop; this does not undo access that already occurred. Announce and tag only after the full readback is retained.

## Production implementation checklist

The following work is repeatable for every adopter. It is not evidence that the shared product is incomplete, but it cannot be safely prefilled with customer values.

1. Provision separate staging and production Workers, private D1 databases, and private R2 buckets; apply every committed migration in order through `0021` (including `0018`–`0021`), verify exact marker 21, and test restore.
2. Route the Worker only through the customer’s identity-aware edge. The tracked `wrangler.jsonc` deliberately sets `workers_dev: false` and `preview_urls: false`; create an explicit protected route and keep direct origin access unavailable.
3. Set `NOTICE_PUBLIC_BASE_URL` to the exact canonical HTTPS origin. Notice uses it for metadata and provider completion redirects and will fail closed when it is missing, unsafe, or a placeholder.
4. Prefer Cloudflare Access mode and prove Notice rejects missing/tampered/wrong-audience JWTs plus direct-origin and alternate-host bypass. If the compatibility header mode is explicitly selected, prove the edge strips caller-provided `x-notice-identity-*` headers, injects verified values only after authentication, and blocks direct-origin bypass before setting `NOTICE_TRUST_IDENTITY_HEADERS=true`.
5. Start onboarding with `NOTICE_BOOTSTRAP_ENABLED=true` and a minimal verified `NOTICE_BOOTSTRAP_ADMIN_EMAILS` list. After at least two durable administrators and recovery/access-review procedures are verified, set `NOTICE_BOOTSTRAP_ENABLED=false` and clear `NOTICE_BOOTSTRAP_ADMIN_EMAILS`. Re-enable only through an approved recovery change.
6. Configure and independently publish the customer-approved legal entities, counterparties, manual groups, typed custom fields, self-contained governed templates, workflows, intake forms, and playbooks. Create direct-user/group approval authority for each lane in the exact currency and optional minor-unit ceiling, and test the narrow no-authority-history compatibility fallback. Governed template versions must keep `languageBlockIds` empty until immutable block content/version snapshots and deterministic composition exist; approved-language insertion remains a separate reviewed editor action.
7. Connect the customer’s pinned DocuSeal 3.2.1 account and `/submissions/html` entitlement, validate the non-public/non-archived template and required field for every ordered role, configure expiration/email 2FA and the HMAC-tab `whsec_...` secret, and test provider email delivery without returning or embedding signer bearer URLs. Optional self-hosted MCP is a diagnostic only: `initialize` → `notifications/initialized` with exact HTTP 202 → `tools/list` → one read-only `load_template` cross-check; no mutation/open-world tool may run.
8. Deploy conforming malware-scanner and mail-delivery gateways using [Gateway conformance](./GATEWAY_CONFORMANCE.md). Prove complete format-structure rejection, one exact leased rescan, and malicious-verdict dominance over a concurrent clean result. When CRM is enabled, deploy the included durable CRM gateway and select its HubSpot, Salesforce, or signed custom adapter; supply the customer-approved account, credentials, object/fields, and mapping version.
9. Keep PDF/DOCX rendering, text extraction, and content interpretation out of the application Worker in production. Before scanning, Notice performs complete bounded structural parsing for supported text/RTF/PDF/DOCX bytes, including PDF xref/reference and DOCX container/required-OOXML-part structure; that is not semantic validation, CDR, or malware proof. After a clean scan, Notice stores those source files and records metadata. Linking either invokes one deployment-selected customer-hosted OCR model/profile through the same signed scanner gateway, with exact provenance/output limits and no fallback, or uses the explicitly disabled authorized human-reviewed-text path. Production can extract bounded plain text/RTF in process. Local evaluation may heuristically parse PDF/DOCX files up to 5 MiB, which is not production evidence.
10. If repository intelligence is used, connect an approved extractor that registers fragments against an immutable working-document ID/version/hash. Treat its source-text digest, offsets, and content as caller-asserted, require humans to compare every citation with the protected working paper, retain each proposal's UUID idempotency key, and confirm that accepting a proposal still cannot mutate agreement/custom-field data or make a legal verdict. Bounded ingestion is inventory, not bulk upload, OCR, or repository migration.
11. Configure authenticated obligation/outbox delivery and retention schedules, monitoring, alerts, backup/restore, incident response, retention/hold handling, and evidence custody. The application enforces durable per-round portal limits across token rotation—10 uploads total (at most 4 accepted, 6 rejected/failed, 96 MiB multipart bytes), one five-minute upload/scan lease, and 20 downloads/256 MiB—but the deployment still needs WAF/distributed limits for cross-round/IP/tenant aggregates.
12. Run redacted readiness, live provider diagnostics, negative identity/tenant tests, synthetic governed intake conversion, workflow/authority/currency, agent sponsor/reviewer separation plus authority-revocation races, work-item/portfolio, repository, portal count/byte/lease exhaustion and token-rotation non-reset, complete document-structure/rescan races, end-to-end lifecycle, restore, security, and customer-policy acceptance in staging. Only the customer’s accountable release authority can admit real data.

## What an implementation partner needs from the customer

- the canonical public hostname, Cloudflare account/region decisions, and environment owners;
- at least two verified administrators plus identity/MFA/access-lifecycle policy;
- approved legal entities, counterparties, groups, typed custom fields, structured relationship taxonomy, exact template/workflow/intake/playbook versions, approved language, and direct/group lane/currency/minor-unit authority;
- DocuSeal 3.2.1 entitlement/template/signer/expiration/email-2FA policy and credentials, plus scanner, mail, optional customer-hosted OCR model/profile/license/weights/capacity, and optional CRM provider choices, accounts, regions, terms, and mappings;
- retention, legal-hold, backup, restore, offboarding, RTO/RPO, monitoring, incident, and support decisions; and
- security, privacy, legal, accessibility, vendor-risk, penetration-test, and residual-risk approval.

If the customer accepts the supplied provider and workflow boundaries, the remaining work is a bounded installation and acceptance project. Additional product engineering includes a different identity model or actual SCIM/IdP-group synchronization; an unsupported provider adapter or interactive OAuth installation; governed-template composition of approved-language IDs before immutable block snapshots exist; a bundled OCR/CDR engine (the exact customer-hosted gateway contract is supported), semantic extraction, or automatic proposal application/legal verdicts; bulk repository migration beyond bounded ingestion inventory; analytics and cursor coverage beyond the paged register/work items/repository search and per-currency portfolio report; a general replay/operations console; or independently retained WORM evidence.

## Handoff evidence

The implementation partner returns the exact source/tag and artifact identity, CI and dependency evidence, migration/restore record, non-secret configuration inventory, secret owners/rotation dates, identity-edge negative tests, provider diagnostics, scheduled-job evidence, readiness report, synthetic workflow results, monitoring/runbooks, records/offboarding evidence, and the named customer approvers for every accepted residual risk.

Continue with [Implementation handoff](./IMPLEMENTATION_HANDOFF.md), [Production setup](./PRODUCTION_SETUP.md), [Deployment](./DEPLOYMENT.md), and [Operations](./OPERATIONS.md).

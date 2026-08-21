# Implementation handoff

This is the shortest path from the reusable Notice repository to a customer-owned, accepted CLM deployment. It is written for a business sponsor and an implementation partner.

The key distinction is:

- **Product engineering** belongs in this repository and must work before handoff.
- **Repeatable installation** provisions the customer's environment and connects the supplied interfaces.
- **Customer authority** supplies names, policies, accounts, credentials, and approvals that no shared product can safely invent.

A customer should not have to design another CLM product. They do have to decide how their business governs contracts and authorize an operator to install it.

The fastest first step is the [15-minute staging deployment plan](./DEPLOYMENT_QUICKSTART.md). It renders strict, non-secret configurations for the main Notice Worker and, when selected, the included CRM gateway. The material below explains what the adopter must decide before that staging installation can become a customer-accepted production service.

The repository is suitable for public release as a deployable foundation only after the gates in [Public release and adopter handoff](./PUBLIC_RELEASE.md) are complete. Public source availability does not waive the customer implementation or acceptance work in this guide.

## Release evidence required

This repository contains the reusable product and implementation material. A customer handoff still needs revision-bound release evidence and the customer-owned deployment inputs below. Do not place mutable repository, branch, or demo-deployment status in this reusable guide.

| Item | Evidence required for each release |
| --- | --- |
| Application source and migrations | Exact reviewed source revision and matching migration inventory |
| Source repository and publication boundary | Reviewed current snapshot; complete-history disclosure review before any public release; authenticated visibility/access evidence when private source is required |
| `"private": true` in `package.json` | Prevents accidental npm publication only; it does **not** make a GitHub repository private |
| CI and release evidence | Passing remote checks, dependency/security evidence, artifact identity, and approvals bound to that exact revision |
| Customer deployment | Isolated Worker/D1/R2 inventory, identity edge, configuration, providers, acceptance evidence, and deployed revision |

## Required handoff artifacts

| Required artifact | Repository contribution | Implementation/customer completion |
| --- | --- | --- |
| Versioned application source | Source, lockfile, CI definition, SBOM command, public-release gates, and release procedure | Publish the disclosure-reviewed snapshot to the approved public or private repository, protect releases, and pin one reviewed revision |
| D1 schema and ordered migrations | Schema plus migrations through marker version 21, including the hardened lifecycle/provider/agent/obligation records, enterprise entities and relationships, versioned templates/workflows/intake, direct/group lane authority, minor-unit currency values, repository fragments/playbooks/cited proposals, bounded ingestion records, atomic governed-configuration creation receipts, and durable per-round portal-transfer budgets | Apply in order to isolated staging and production before the matching application release |
| R2 document model | Private logical `DOCUMENTS` binding, workspace-owned key rules, fail-closed production PDF/DOCX boundary, and optional exact-profile customer-hosted OCR through the signed scanner gateway | Provision the private bucket, access, backup, residency, recovery controls, and either a pinned private OCR model/profile or reviewed human text-version process |
| Corporate SSO, roles, and groups | Notice validates signed Cloudflare Access application JWTs, supports an explicit trusted-header compatibility mode, enforces five generic workspace roles, and stores manually managed workspace groups separately from approval lanes | Connect the existing IdP to Access (or prove the compatibility edge), name authorized people, approve joiner/mover/leaver controls, and maintain groups; the repository does not perform SCIM synchronization |
| Governed agreement workflow | Versioned published templates, deterministic rendering, structured version-pinned intake with atomic conversion, published approval-workflow snapshots, direct/group lane authority, drafting, immutable working versions, signature, evidence, and obligations | Approve the exact template/workflow/intake/playbook versions, condition logic, group membership, lane/currency/amount authority, and any use of the compatibility policy |
| Enterprise records and intelligence | Legal entities, counterparties, typed custom fields, saved views, structured parties/relationships, per-currency portfolio aggregates, paged work items, extractor-registered fragments pinned to immutable document version/hash and caller-supplied source-text digest, cited extraction proposals, and bounded ingestion inventory | Approve taxonomy/dedupe, configure reference data, select/assess the optional customer-hosted OCR profile and any repository extractor, require human source verification, and commission a governed application executor before a reviewed proposal may alter agreement data |
| Counterparty negotiation | Hash-bound immutable rounds, expiring portal tokens whose round rows retain only hashes, durable round-scoped transfer budgets across token rotation, one upload/scan lease, bounded pending-mail URL retention/scrubbing, per-round aliases, structurally inspected/scanned returns, replay state, human-reviewed text provenance, and explicit promotion | Select an explicit portal TTL; configure narrow edge paths plus aggregate WAF controls; prove upload/download count/byte exhaustion and lease recovery; keep automated mail locked until its separate rendered-link/recipient/reply acceptance is approved; optionally connect a dedicated inbound-email domain/gateway; approve sender-authentication, Word-review, decision, and escalation procedures |
| Provider adapters and protocols | Pinned DocuSeal 3.2.1 profile, exact ordered-role/field validation, expiration/email-2FA policy, provider-email delivery with no production bearer-link exposure, create/archive recovery, HMAC webhook reconciliation, and optional non-mutating self-hosted MCP diagnostic; exact scanner/mail contracts plus signed customer-hosted OCR operation; and an included durable CRM gateway with HubSpot, Salesforce, and signed custom-webhook adapters | Supply approved accounts/credentials and `/submissions/html` entitlement, template roles/order, signer-address policy, mail/scanner gateways, optional OCR model/profile/private capacity, CRM object/fields and mapping; deploy the included CRM gateway when enabled; run live acceptance |
| Production preflight | Redacted readiness report and protected live integration diagnostics | Run them in the protected environment and retain the results with the release |
| Operations package | Native scheduled jobs, bearer-protected compatibility routes, retention/hold controls, exports, audit evidence, and runbooks | Configure Cron expressions, monitoring, backup/restore, incident, and evidence custody systems |
| Acceptance evidence suite | Unit, type, lint, build, rendered, evaluation API, and production-mode API checks | Run the exact revision plus protected-edge, live-provider, restore, and customer acceptance tests |

## What is installation, not missing product work

The implementation partner performs these steps for every customer:

1. create customer-specific staging and production Worker deployments;
2. provision and bind private D1 and R2 resources, an explicit protected route, and the canonical `NOTICE_PUBLIC_BASE_URL`;
3. apply the committed migrations in order through exact main marker 21;
4. connect the existing corporate IdP through Cloudflare Access and test the signed-token/direct-origin boundary, or prove the trusted-header compatibility edge;
5. enter non-secret configuration and managed secrets, use bootstrap elevation only for initial onboarding, then disable it and clear the bootstrap email list;
6. configure the approved legal entities, counterparties, groups, custom fields, published template/workflow/intake/playbook versions, saved views, and direct/group lane authorities; rehearse exact submitted-intake conversion, workflow re-evaluation, legacy-fallback cutoff, relationship integrity, work-item paging, per-currency reporting, and the repository-intelligence no-mutation boundary with synthetic data;
7. select the counterparty portal TTL, configure only `/api/exchange/*` and optional exact `/api/webhooks/email` as narrow non-human paths, connect DocuSeal 3.2.1 and the customer's scanner/mail gateways, and connect a dedicated signed inbound-email receiver only when selected; if CRM is enabled, deploy/migrate the included gateway and configure its HubSpot, Salesforce, or custom adapter; then verify provider diagnostics, exchange expiry/rotation/replay/quarantine/human promotion, non-resetting per-round upload/download exhaustion and one-work-lease recovery, complete format-structure rejection plus rescan malicious-verdict dominance, agent sponsor/reviewer separation and authority revocation races, mapping, replay/version fencing, synthetic round trips, full-estate cursor paging, and the explicit record-at-a-time administrator projection/tombstone resync controls; rehearse historical cleanup only in a paused maintenance window, with main/gateway/provider reconciliation, the explicit typed confirmation, and mandatory live-profile reprojection before service resumes; verify that a fenced profile cannot be reactivated while another profile remains live; for upgraded data with incomplete destination metadata, inventory every legacy CRM copy, preserve external reconciliation evidence, and verify the separately confirmed, bounded legacy-cleanup attestation workflow without inventing a profile or receipt;
8. configure and verify the supplied native delivery Cron Trigger (obligation materialization/reminders followed by outbox delivery), the separate retention trigger, and the CRM gateway recovery trigger;
9. connect monitoring, backups, restore, and incident processes; and
10. run the supplied technical and business acceptance checklist.

Those are deployment and operations tasks. They should not require changes to the CLM workflow when the customer accepts the supported operating model and provider boundaries. In particular, the implementation partner does not need to invent signature recovery, an SSO token verifier, a CRM receipt/retry service, or HubSpot/Salesforce/custom adapter logic. The customer supplies and approves the IdP policy, provider accounts, object/fields, mappings, approved template roles/order, signer-address policy, credentials, and authorization to use those capabilities.

The repository supports published immutable approval-workflow definitions. The supported schema deterministically evaluates one to twenty unique lanes from agreement side/type, department, risk/disposition, exact currency, and minimum/maximum minor-unit amount, with at least one unconditional lane. Notice snapshots the exact definition digest and evaluated lanes onto the agreement and binds them into approval, risk, and governed-agent bases. Each required lane needs a distinct attributable decider, and no decider may be that request's requester.

Monetary values are canonical non-negative minor units with a three-letter uppercase currency code. Notice supports zero-, two-, and three-decimal currency shapes but performs no FX conversion; reports keep currencies separate. Agreements without a governed workflow use a compatibility rule: every routed agreement requires `Legal`, while High risk, a waiver, USD value above 100,000, or any material non-USD value requires `Finance`.

Lane authority is built in. Active records grant a direct user or active group one lane in one exact currency with an optional amount ceiling. Claim and decision recheck authority at commit time. A lane with no authority history uses only the narrow compatibility mapping (`admin`/`legal` for `Legal`, `admin`/`approver` for `Finance`, and `admin` otherwise); the first active or revoked authority record disables fallback for that lane. The customer owns the actual workflow and authority decisions, while the implementation partner configures and tests them rather than inventing authority from names or departments. The current contract is governed JSON rather than a general visual/no-code designer.

## What only the customer can supply

Before real data is admitted, the customer must approve or provide:

- the canonical HTTPS hostname and identity-aware routing owner;
- the legal entity/workspace name and at least two verified administrators;
- legal entities, counterparties, structured relationship taxonomy, typed custom fields, approved template/workflow/intake/playbook versions, delegated lane/currency/amount authority, and approved DocuSeal role/order and signer-address/delivery policy;
- counterparty portal lifetime, delivery policy, approved reviewer/Word-review process, and optional inbound-email domain/provider/authentication policy;
- DocuSeal 3.2.1 account/entitlement/template/expiration/email-2FA choices and credentials, plus scanner, mail, optional customer-hosted OCR model/profile/license/weights/private capacity, repository extractor, and CRM accounts and credentials;
- data region, subprocessor, retention, legal-hold, backup, and offboarding decisions;
- mail recipient policy plus CRM objects, fields, mappings, tombstone retention, and allowed downstream actions;
- service levels, support contacts, incident escalation, and change authority; and
- security, privacy, legal, records, accessibility, and vendor-risk acceptance.

These inputs are intentionally absent from the repository because pre-populating them would manufacture business or legal authority.

## When customer-specific engineering really is needed

Treat the following as an explicit extension, not ordinary installation:

- an interactive end-user CRM OAuth-install flow or CRM provider/object model outside the included agreement projection and upsert/tombstone adapters;
- automatic SCIM/group synchronization, or an identity model that can use neither Cloudflare Access nor the documented trusted-header compatibility boundary;
- a malware scanner or mail provider with no conforming gateway, or a custom CRM with no approved receiving endpoint;
- a business-friendly no-code approval/template/intake/playbook designer beyond the governed JSON contracts;
- governed-template composition of approved-language IDs until immutable block content/version snapshots and deterministic rendering are implemented;
- a bundled OCR/model provider, semantic/vector retrieval, or governed executor that may apply a human-accepted proposal; Notice supports the exact customer-hosted OCR gateway contract but does not supply its engine or infrastructure;
- very large-estate analytics or bulk migration execution beyond the paged register/work-items/search, aggregate portfolio report, and bounded ingestion inventory;
- an operator-facing dead-letter replay console; or
- regulatory controls beyond the documented current-product boundary.

The sponsor should decide whether to defer, fund, or reject each extension before implementation starts.

## Customer implementation workbook

Copy this table into the implementation record. A row is complete only when its evidence link or artifact is recorded.

| Gate | Accountable owner | Required evidence | Implementation record |
| --- | --- | --- | --- |
| Source release selected | Product/release owner | Public clean-history or approved private-release evidence, release revision, CI result, SBOM, and private security intake | Record evidence link/status |
| Staging/production isolation | Platform owner | Worker/D1/R2 inventory, explicit canonical route/`NOTICE_PUBLIC_BASE_URL`, disabled default/preview URLs, and access review | Record evidence link/status |
| Corporate SSO boundary | Identity/security owner | Access JWT/policy/direct-origin/alternate-host tests, or compatibility-header spoof tests; MFA/session policy; disabled-member and subject-change recovery evidence | Record evidence link/status |
| Administrator bootstrap | Business owner | Two verified admins, last-admin recovery test, then bootstrap disabled and email list cleared | Record evidence link/status |
| Migrations and recovery | Data/platform owner | Applied migration list, backup and restore evidence | Record evidence link/status |
| Approved paper and language | Legal owner | Approved templates, signer roles, playbook/version record | Record evidence link/status |
| Approval authority | Legal/business owner | Published workflow digest/conditions, direct/group lane matrix, exact currency/amount ceilings, fallback-cutoff review, delegates, and segregation-of-duties acceptance | Record evidence link/status |
| Document scanner | Security owner | Passing harmless live test and failure/quarantine test | Record evidence link/status |
| Counterparty exchange | Legal/integration/security owners | Portal TTL plus expiry/rotation/revocation; exact route-policy inventory; email-disabled decision or inbound secret/domain/HMAC/replay/quarantine evidence; authorized Word-review and explicit promotion test | Record evidence link/status |
| DocuSeal | Legal/platform owner | Release 3.2.1/API-contract/entitlement evidence, non-public/non-archived template with required signing field per ordered role, unique signer addresses, expiration/email 2FA, provider email/no production URL exposure, creating/archived recovery, HMAC webhook replay, exact terminal evidence, scanned artifact, and optional MCP 202/tool-inventory/read-only-template-cross-check/no-mutation proof | Record evidence link/status |
| Mail and included CRM gateways | Integration owner | Mail conformance; CRM deployment/migration, provider scope/field mapping, dry run, replay/version fencing, synthetic create/update/tombstone evidence | Record evidence link/status |
| Native scheduled jobs | Operations owner | Obligation/outbox delivery-trigger run, retention run, CRM recovery run, backlog/reminder counters, convergence, and alert evidence | Record evidence link/status |
| Records policy | Records/legal owner | Retention, hold, purge, backup-expiry and offboarding approval | Record evidence link/status |
| Monitoring and incident response | Operations/security owner | Dashboards, alerts, contacts, tested runbook | Record evidence link/status |
| Final readiness | Release owner | `npm test`, both Playwright suites, redacted readiness JSON, live diagnostics | Record evidence link/status |
| Business acceptance | Executive sponsor | Synthetic lifecycle sign-off and authorization for real data | Record evidence link/status |

## Cloudflare installation sequence

1. Select the disclosure-reviewed public snapshot or approved private source release and record its exact revision. Never expose an unreviewed collaboration history; `"private": true` in `package.json` only prevents npm publication.
2. Copy `deploy/notice.deployment.example.json` to an ignored customer/environment manifest and validate it. When CRM is enabled, do the same with `deploy/crm-gateway.deployment.example.json` and confirm both manifests select the same CRM provider. Do not deploy production from the binding-only tracked `wrangler.jsonc`.
3. Protect the main custom domain with a Cloudflare Access self-hosted application connected to the customer's IdP (recommended), or the reviewed trusted-header compatibility edge. Keep access to named implementation users until wider access is approved, and block direct-origin/alternate-host bypass.
4. Put the exact secret names reported by each redacted plan in the environment's managed secret set or ignored Wrangler secret file. Do not commit a filled environment file; provider credentials remain in the appropriate Worker only.
5. Build and render the exact reviewed source. For a genuinely empty Workers Paid environment, keep main workspace bootstrap enabled with at least two verified administrator emails, run the guarded CRM first-install wrapper when enabled (`npm run crm:gateway:deploy -- --config <generated-crm> --secrets-file <ignored-crm-secrets> --confirm-empty-environment --confirm-workers-paid-plan`), then the guarded main wrapper (`npm run deploy -- --config <generated-main> --secrets-file <ignored-main-secrets> --confirm-empty-environment --confirm-workers-paid-plan`). The main wrapper rejects disabled bootstrap for an empty auto-provisioned target. Do not run these first-install commands against an existing environment; Workers Free is evaluation-only and unsupported for staging/production.
6. Let each wrapper pin the Cloudflare account and clean source revision, prove the Worker and exact auto-named resources are absent, run the package dry-run, create a route-less/schedule-less isolated bootstrap, verify and pin its provisioned storage identities, apply the committed migrations, require main schema marker 21 or CRM marker 2, recheck the same sole 100%-traffic bootstrap, and only then activate the route and schedules. If interrupted after bootstrap, use the exact-version `deploy:resume`/`crm:gateway:resume` command in [Deployment](./DEPLOYMENT.md); if provisioning created resources without a bootstrap, stop for evidence-based administrator cleanup. For an upgrade, use the maintenance/roll-forward sequence, not either first-install wrapper.
7. Record the resulting Worker versions, resources, migrations, custom routes, Cron Triggers, wrapper evidence, and health/readiness results.
8. Start with `NOTICE_BOOTSTRAP_ENABLED=true` only long enough for both verified bootstrap users to establish durable administrator memberships; then set it false, clear `NOTICE_BOOTSTRAP_ADMIN_EMAILS`, rerender, and use the same-source `deploy:promote` command with the expected current UUID. Promotion accepts no secret file, cannot rotate secrets, and refuses retirement unless the exact pinned D1 workspace proves at least two distinct active administrator memberships backed by active users both during preflight and immediately before activation. Retest both administrators.
9. Run identity, readiness, provider, job, retention, export, restore, and synthetic lifecycle checks before admitting real records.

## Acceptance sequence

The recommended acceptance order is deliberately fail-closed:

1. **Repository acceptance:** clean install, full tests, dependency evidence, migration review.
2. **Platform acceptance:** isolated resources, protected identity, two administrators, backup/restore.
3. **Provider acceptance:** scanner, signature, delivery, optional inbound email, optional CRM, and scheduled jobs.
4. **Workflow acceptance:** synthetic generate/import, counterparty round and human promotion, review, approval, immutable signing, activation, obligation, hold, export, and retention flows.
5. **Customer acceptance:** policy, templates, authority, mapping, residual risk, and permission to use real data.

Production is not accepted until the protected readiness endpoint returns success and all external evidence rows above have named owners and retained artifacts. Readiness is a technical preflight, not a substitute for customer approval.

## Handoff package

The implementation partner returns:

- the exact source revision, publication/history-review record, and built/deployed version;
- Worker/D1/R2 inventory and access policy;
- migration and recovery-point record;
- redacted configuration inventory and secret ownership/rotation dates;
- identity, role, tenant-isolation, provider, webhook, job, retention, and restore evidence;
- current readiness, test, SBOM, security scan, and signed export artifacts;
- monitoring, incident, change, backup, and offboarding runbooks; and
- customer approvals, accepted limitations, residual risks, and review dates.

Use [Production setup](./PRODUCTION_SETUP.md) for the detailed values and validation steps, [Deployment](./DEPLOYMENT.md) for release sequencing, [Gateway conformance](./GATEWAY_CONFORMANCE.md) for integration contracts, and [Operations](./OPERATIONS.md) for ongoing ownership.

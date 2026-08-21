# Production setup

For the first staging installation, begin with the [15-minute deployment plan](./DEPLOYMENT_QUICKSTART.md). For the business-level scope, responsibility split, adoption workbook, and handoff package, use [Implementation handoff](./IMPLEMENTATION_HANDOFF.md). For source publication, history review, security intake, supported tooling, and adopter-facing claims, use [Public release and adopter handoff](./PUBLIC_RELEASE.md).

This is the production implementation guide. It separates three kinds of work so an adopter can hand the repository to an implementation partner without mistaking installation for missing product engineering.

- **A. Ready in the repository:** reusable CLM workflow, governed versioned templates/workflows/intake forms/playbooks, direct/group approval authority, structured enterprise records, repository-intelligence evidence, authorization, Cloudflare Access JWT validation, tenant boundaries, storage model/migrations, secure counterparty negotiation rounds, provider protocols, native jobs, a durable CRM gateway with HubSpot/Salesforce/custom adapters, diagnostics, retention, evidence, and tests.
- **B. Deployer or implementation-partner steps:** render the supplied deployment manifests, provision resources, apply migrations, connect the corporate IdP through Cloudflare Access or prove the compatibility edge, enter configuration/secrets, apply the narrow counterparty machine-route policies, configure and publish customer-approved governed artifacts and authority records, connect providers, run tests/diagnostics, and assemble acceptance evidence using the supplied routes and guides.
- **C. Customer decisions/data:** organization and administrators, legal entities/counterparties/groups, templates/workflows/intake/playbook content, delegated authority and currency/amount scope, provider accounts/credentials, data region, retention/hold rules, CRM mappings, SLOs, and risk/legal approval.

Bucket B is repeatable installation plus bounded implementation work. It does not require a customer to design another CLM system or write code. Bucket C is intentionally not prefilled because doing so would invent customer authority, policy, or credentials. The repository supplies executable scanner/delivery contracts, the scanner's optional customer-hosted OCR operation, and the inbound-email verification contract, but not a malware engine, OCR model/runtime, outbound mail service, or inbound mail receiver. It does supply the optional CRM gateway and HubSpot, Salesforce, and custom adapters. For those supported CRM paths, creating the customer-approved provider object/fields and credential, choosing the field mapping, deploying the gateway, and accepting a synthetic round trip are configuration and provider-administration work—not a product gap. A custom webhook still needs an approved receiving system.

Do not use real agreements until every required item below has an owner, evidence, and approval.

## Responsibility map

| Area | A. Ready in repository | B. Implementation partner configures/verifies | C. Customer supplies/approves |
| --- | --- | --- | --- |
| Product workflow | Intake-to-Active lifecycle, immutable governed template/workflow/intake versions, atomic submitted-intake conversion, exact workflow snapshots, direct/group lane authority, immutable approval/signature basis, requester/decider separation, claimable unassigned approvals, one-to-ten-signer packets, recurring obligation schedules/occurrences/evidence, approved language, imported-source working versions, reminders, and administration APIs | Load, version, review, and publish customer-approved templates/workflows/intake forms/playbooks; configure lane currency/amount authority; approve obligation recurrence/time-zone/reminder/owner policy | Templates, playbook, intake fields, approval lanes/conditions/thresholds, lane-to-person/group authority matrix, signer roles/policy, business and obligation owners |
| Identity/access | Signed Cloudflare Access application-JWT validation, an explicit trusted-header compatibility mode, invitations, five generic workspace roles/permissions, manual workspace groups, last-admin protection, fail-closed gate | Connect the customer's IdP to Access and test JWT/direct-origin/alternate-host behavior, or prove the compatibility edge; onboard members/groups and verify each approval-capable member's technical and delegated-business scope | Verified administrators, IdP/MFA/conditional-access/session policy, joiner/mover/leaver policy, named delegates, and group membership approval |
| Data | Workspace-scoped D1 schema/R2 key design, migrations, protected retrieval | Provision/bind isolated D1/R2, apply migrations, configure backup/restore/monitoring | Residency, encryption/key posture, RTO/RPO, retention and access decisions |
| Documents | Complete bounded structural format/hash checks, quarantine, scanner protocol, optional exact-profile customer-hosted OCR request, serialized exact-source rescan with malicious-verdict dominance, promotion, downloads, bounded text/RTF extraction, and production PDF/DOCX rendering/text-extraction isolation | Connect/test the scanner; either host one pinned OCR model/profile privately behind it or establish an authorized reviewed-text process | Scanner/OCR infrastructure, model license and weight provenance, GPU/CPU capacity, secrets, region/retention, malware response, patching, rollback, OCR/CDR and human-review policy |
| Repository intelligence | Extractor-registered fragments pinned to immutable document version/hash plus caller-supplied source-text digest/offset/content hashes, literal search, immutable playbook versions, confidence-bearing cited field proposals, human accept/reject evidence, and bounded idempotent ingestion inventory; no automatic source-provenance proof, legal verdict, or data mutation | Connect and assess an approved extractor when desired; require reviewers to compare citations with protected working paper; define the separately governed proposal-application process or keep application disabled; test citation, duplicate, and replay behavior | Extraction/provider account if used, source authorization, playbook content, human review authority, proposal-application policy, and source-inventory approval |
| Counterparty negotiation | Immutable hash-bound rounds, expiring portal tokens whose round rows retain only hashes, durable per-round upload/download budgets that survive rotation, one leased upload/scan workload, bounded pending-mail URL retention/scrubbing, per-round email aliases, replay-safe structurally inspected/scanned returns, and explicit human promotion | Select portal TTL; apply narrow `/api/exchange/*` and optional exact `/api/webhooks/email` edge policies; configure/test an inbound receiver only when email capture is selected; establish Word-review and manual-delivery procedures | Counterparty contact and delivery policy, portal lifetime, inbound mail domain/provider/authentication policy, authorized reviewers, acceptable negotiation positions, capacity/edge controls, and acceptance evidence |
| E-signature | DocuSeal ordered-template-role discovery, exact signer mapping, provider-email submission, webhook/replay/recovery/reconciliation, and artifact ingestion | Configure template/account/callback; verify delivery, recovery, archive, and exact terminal evidence with live/synthetic tests | DocuSeal account/token/webhook secret, approved signer roles/order/addresses/policy, provider contract |
| Notifications/CRM | Durable outbox with independent mail/CRM delivery state; signed event contract; included durable CRM gateway with HubSpot, Salesforce, and custom adapters; retries/dead state; safe diagnostics | Connect the customer's mail gateway; deploy/migrate the included CRM gateway when enabled; configure provider credential and approved mapping; validate idempotency/version fencing/reconciliation | Mail/CRM accounts and credentials, recipients, approved CRM objects/fields/mappings, provider-side policy and acceptance |
| Records governance | Retention/hold API, hold precedence, soft delete, purge grace/job, export manifest | Configure grace/job/alerts, dry-run policy, verify export and downstream procedure | Retention schedule, hold authority, deletion/offboarding approval, evidence custody |
| Operations/security | Health/readiness, request IDs, safe errors, headers, native Worker Cron dispatcher, tests | Configure Cron expressions, WAF, observability/SIEM, backups, alerts, runbooks, release evidence | SLO/support model, job timing, incident contacts, security/privacy/legal/vendor approvals |

## Staged implementation path

1. **Repository acceptance:** run the full test gate; review architecture, threats, generated migrations, and limitations.
2. **Platform installation:** render the manifests; create isolated Worker/D1/R2 resources; apply migrations; connect Cloudflare Access; and onboard two administrators.
3. **Governance and provider setup:** configure and publish approved legal entities, counterparties, groups, custom fields, templates, workflows, intake forms, playbooks, and lane authorities; set an explicit counterparty portal TTL; add managed secrets; run live diagnostics; configure scanner/mail and optional inbound-email capture/extraction; deploy the included CRM gateway when selected; configure Cron Triggers; and enter approved records policy.
4. **Synthetic acceptance:** prove role/workspace isolation, governed intake conversion, workflow/authority/money behavior, repository citations/proposal non-mutation, document/signature/obligation/outbox/webhook/retention/export flows, paged work/reporting, monitoring, and restore.
5. **Customer acceptance:** approve governed artifacts, authority/mappings/policy/residual risk, attest configuration, rerun readiness, and authorize real data.

The deployment is accepted only when `npm test`, `npm run test:e2e`, and `npm run test:e2e:production` pass, `npm run sbom` is retained with the revision, current external security/dependency/license checks are reviewed, migrations and restore are evidenced, required live diagnostics pass, negative identity/role/workspace tests pass, scheduled paths reconcile, signed exports verify, and `GET /api/readiness` returns 200 in the protected production environment.

For synthetic local evaluation, use `npm run dev:evaluation`. That script activates a Vite local-only flag which injects only evaluation mode into the loopback Worker. The signing action is a local simulation: it does not embed an external form, contact DocuSeal, send invitations, or create verified signature evidence. `npm run test:api:production` is a separate automated evidence harness: it first proves that the ordinary production default fails closed, then supplies loopback-only synthetic production bindings to isolated temporary D1/R2 state. It exercises signed Cloudflare Access assertions, bootstrap/invitation/binding, role and disabled access, cross-workspace IDOR denial, immutable content round trips, attributed approval routing/decision separation, exact escaped DocuSeal HTML, ordered template-role validation, production signer-URL non-exposure and provider email delivery, partial and exact terminal signer evidence, recoverable creation, verified completion/replay, scanner HMAC/hash and PDF evidence, retention, native job dispatch, and independent mail/CRM outbox transitions. Neither local mode is a staging/deployment path or a substitute for live Access policy, live-provider, restore, or customer acceptance. Do not assume a shell-prefixed `NOTICE_APP_MODE` reaches Worker bindings.

## 1. Choose the operating model

Record `NOTICE_DEPLOYMENT_MODEL=hosted` when an operator or implementation partner owns the service responsibilities, or `self-hosted` when the customer accepts them. Both use the included Cloudflare Worker/D1/R2 package; the selected operator must supply the environment, identity edge, secret, migration, job, and monitoring configuration.

Use the strict manifest path for every shared environment: copy `deploy/notice.deployment.example.json` into ignored `.wrangler/` state, validate it with `scripts/deployment-kit.mjs`, and deploy only with Wrangler `--config` pointing to the generated file. The tracked `wrangler.jsonc` is a customer-independent binding contract; by design it omits the customer's route, values, secrets, and Cron Triggers and is not a complete production deployment configuration. On a clean install, the guarded wrapper creates a fail-closed isolated bootstrap with no route, Cron Trigger, `workers.dev`, or preview URL, pins the newly provisioned D1/R2 identities, applies and verifies the migrations there, and only then deploys the final protected route and schedules. The [quickstart](./DEPLOYMENT_QUICKSTART.md) gives the exact command order and stranded-install recovery procedure.

Decide and record:

- service owner and support hours;
- data owner, security owner, identity owner, records owner, and integration owner;
- production/staging isolation;
- data residency and subprocessor approvals;
- RTO, RPO, backup/restore, and incident notification commitments; and
- which party can deploy, access storage, rotate secrets, run exports, change holds, and purge data.

## 2. Assign the workspace

One production deployment selects one permanent workspace:

```text
NOTICE_APP_MODE=production
NOTICE_DEPLOYMENT_MODEL=hosted
NOTICE_PUBLIC_BASE_URL=https://<canonical-customer-host>
NOTICE_WORKSPACE_ID=<3-63-lowercase-letters-digits-hyphens>
NOTICE_WORKSPACE_NAME=<customer-approved-name>
NOTICE_BOOTSTRAP_ENABLED=true
NOTICE_BOOTSTRAP_ADMIN_EMAILS=<verified-email[,verified-email]>
```

`NOTICE_PUBLIC_BASE_URL` must be the exact safe HTTPS origin used by browsers and provider completion redirects. It is not inferred from a caller-controlled `Host` header; a missing, placeholder, credential-bearing, or otherwise unsafe value makes production fail closed. The tracked `wrangler.jsonc` disables `workers_dev` and preview URLs, so provision an explicit customer-controlled route for this origin behind Cloudflare Access or the reviewed trusted-header compatibility edge.

The workspace ID must contain 3–63 lowercase letters, digits, or hyphens and begin with a letter or digit. It becomes part of every D1 ownership predicate and R2 prefix. Do not rename/reuse it casually or use the same ID for another customer. Use verified organizational accounts for bootstrap administrators and keep at least two active administrators after onboarding. The guarded first-install and resume modes require bootstrap to remain enabled for their empty auto-provisioned D1 target; they reject a configuration that could create an inaccessible workspace.

Production will not create a synthetic user. While `NOTICE_BOOTSTRAP_ENABLED=true`, a listed bootstrap administrator signs in through the protected identity edge to create the initial workspace/user/membership. Administrators then invite other members by verified email; the first matching sign-in binds the pending account to its verified provider subject. After at least two durable administrators, emergency recovery, and access review are verified, set `NOTICE_BOOTSTRAP_ENABLED=false` and clear `NOTICE_BOOTSTRAP_ADMIN_EMAILS`. The same-source promotion wrapper verifies at least two distinct active administrator memberships backed by active users in the exact pinned workspace database and repeats that check immediately before activation; a malformed or drifting result fails closed. The configuration rejects a nonempty bootstrap list while bootstrap is disabled. Re-enable it only through an approved, monitored recovery change.

## 3. Connect corporate SSO

Use Cloudflare Access unless the deployment has a separately reviewed identity edge:

```text
NOTICE_AUTH_MODE=cloudflare-access
NOTICE_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
NOTICE_ACCESS_AUDIENCE=<64-character-application-aud>
NOTICE_TRUST_IDENTITY_HEADERS=false
```

Create one Access self-hosted application on the canonical Notice hostname and connect the customer's Entra ID, Okta, Google Workspace, generic OIDC, or generic SAML provider. Notice reads `Cf-Access-Jwt-Assertion` and verifies RS256, the exact issuer and application audience, expiration/not-before, application-token type, subject, and email before applying its own D1 membership and role. It does not trust caller identity headers or map directory groups directly to Notice roles. Follow [Corporate SSO](./SSO.md).

Prove missing, malformed, tampered, expired, future, wrong-issuer, wrong-audience, wrong-token-type, disabled, revoked, and wrong-email behavior. Also prove the exact canonical route is Access-protected, no alternate hostname bypass exists, and logout/session/MFA/conditional-access behavior matches customer policy.

`NOTICE_AUTH_MODE=trusted-headers` is a compatibility choice, not a fallback. It additionally requires `NOTICE_TRUST_IDENTITY_HEADERS=true` after the external edge blocks direct origin access, removes caller-supplied `x-notice-identity-*` headers, injects canonical verified identity only after authentication, and owns revocation. Clear the Access team-domain and AUD values in this mode. If either boundary changes, stop production access until it is revalidated.

## 4. Provision D1, R2, and migrations

Create private environment/customer-specific resources for logical bindings:

- `DB` — D1 structured records
- `DOCUMENTS` — R2 original, quarantine, signed-evidence, and version bytes

Apply the committed migrations under `drizzle/` through the platform's reviewed migration workflow. Migration `0005` introduces the application-owned `notice_schema_state` marker. The current application requires exact marker version **21**, matching `NOTICE_SCHEMA_VERSION=21`; later schema migrations must advance both in lockstep. Test a realistic copy first, retain the pre-change recovery point, validate counts/indexes/workspace ownership and the exact marker, and record each applied migration. Ordinary production request handling verifies the marker read-only and returns HTTP 503 when it is absent, older, or newer; it does not create or alter schema.

The current hardening migrations are:

- `0006` — binds approvals and signature packets to the material agreement/document basis and adds one-active-packet uniqueness;
- `0007` — adds durable `purge_jobs` manifests for R2 cleanup after guarded D1 purge;
- `0008` — adds approval requester attribution for requester/decider separation;
- `0009` — adds the CHECK-constrained `mutation_guards` table used to make approval-claim concurrency failure abort its D1 batch;
- `0010` — adds the constrained per-sink outbox delivery ledger so mail and CRM acceptance, retries, and dead state remain independent;
- `0011` — adds workspace-scoped, configuration-bound live integration diagnostics;
- `0012` — binds CRM delivery evidence to immutable provider, mapping-version, and destination fingerprints; and
- `0013` — adds bounded, attributed, payload-digest-bound attestations for externally reconciled legacy CRM events whose original profile is incomplete;
- `0014` — adds negotiation-round, submission, comparison, and document-lineage fields; and
- `0015` — adds governed risk evidence, approval-basis confirmation, service principals, scoped grants, durable plans, human decisions, and execution receipts;
- `0016` — adds CHECK-constrained, indexed agent-plan attribution to approval requests and agreement events; and
- `0017` — adds recurring obligation schedules, immutable occurrence/evidence rules, reminder cursors, retry-safe creation receipts, and agreement-register paging indexes.
- `0018` — adds legal entities, counterparties, workspace groups, typed custom fields/values, saved views, governed template versions, governed workflow definitions, intake forms/submissions, direct/group lane authorities, structured agreement parties/relationships, stable owner/reference fields, and canonical minor-unit currency values.
- `0019` — adds exact workflow snapshots and intake-template-version pins, immutable clause playbook versions, version/hash-pinned registered repository fragments and cited extraction proposals, bounded idempotent ingestion batches/items, stronger tenant/referential/primary-party integrity rules, and advances the exact marker to **19**.
- `0020` — adds immutable, tenant- and administrator-bound creation receipts for atomic, retry-safe governed template and clause playbook creation, then advances the exact marker to **20**.
- `0021` — adds CHECK-constrained per-round portal upload/download budgets and one expiring upload-work reservation, then advances the exact marker to **21**.

Existing approval rows upgraded by `0008` have an intentionally blank legacy requester. They cannot be newly decided or satisfy the current separated-approval policy. During upgrade acceptance, supersede/re-request each item on the current immutable paper so a verified requester and a different decider are recorded. Likewise, legacy approval/signature basis defaults from `0006` are not current authorization; re-route approval and reconcile any in-flight provider submission. Do not invent or backfill an actor or basis from free text.

Configure private access, least privilege, encryption/key-management posture, retention/versioning, backup, restore testing, monitoring, capacity, and residency. The application never needs public R2 bucket access.

### Approval policy adoption

The repository enforces approval policy on the server. A published governed workflow contains one to twenty unique lanes, at least one unconditional lane, and bounded ANDed conditions over agreement side, type, department, risk/disposition, exact currency, and minimum/maximum minor-unit value. Routing snapshots the exact published definition digest and evaluated lanes onto the agreement so a later workflow edit cannot silently change an in-flight basis. Every required lane needs a distinct attributable decider, every decider must differ from that request's requester, and every approval/signature gate is tied to the exact immutable working-document version, SHA-256, and material workflow basis.

When an agreement has no governed workflow, the compatibility starter policy requires `Legal`; it also requires `Finance` for High risk, a recorded waiver, a USD value above 100,000, or any material non-USD value. Notice stores non-negative minor units and an uppercase three-letter currency code with supported zero-, two-, and three-decimal mappings. It performs no FX conversion and never uses a cross-currency total for approval policy. `Required` means policy demands routing but no current request has yet been created; `Pending` means one or more current requests await decisions.

Capitalized lane labels are not the five lowercase workspace identity roles. Claim, assignment, and decision evaluate active direct-user or active-group lane-authority records for the exact currency and optional minor-unit ceiling, and repeat that predicate at commit time. A lane with no authority record at all keeps the narrow compatibility mapping: `admin`/`legal` for `Legal`, `admin`/`approver` for `Finance`, and `admin` for another lane. Creating or revoking any record for a lane disables fallback for that lane; an unmatched user then fails closed. The customer must approve the real matrix and periodically review group membership and revoked history. The administration APIs provide governed JSON definitions and explicit publish/retire actions, not a business-friendly no-code policy designer.

## 5. Add managed secrets

Create these only in the deployment secret manager:

| Secret | Used for |
| --- | --- |
| `NOTICE_DOCUSEAL_API_TOKEN` | Authenticated DocuSeal API requests; strength/format is provider-defined |
| `NOTICE_DOCUSEAL_WEBHOOK_SECRET` | Raw-body callback verification; use only the `whsec_...` value from DocuSeal's webhook HMAC tab |
| `NOTICE_DOCUSEAL_MCP_TOKEN` | Optional self-hosted MCP diagnostic; separate Bearer token that must differ from the REST API token |
| `NOTICE_SCAN_GATEWAY_SECRET` | HMAC-authenticated document scans; at least 32 characters |
| `NOTICE_DELIVERY_GATEWAY_SECRET` | HMAC-signed canonical event delivery; at least 32 characters |
| `NOTICE_INBOUND_EMAIL_SECRET` | Optional inbound counterparty-email raw-body digest HMAC; required only when email capture is enabled; at least 32 characters and at most 4096 UTF-8 bytes |
| `NOTICE_CRM_GATEWAY_SECRET` | HMAC between the main Worker and included CRM gateway; required when CRM is enabled; at least 32 characters |
| `NOTICE_JOB_RUNNER_SECRET` | Bearer authentication for the obligation, outbox, and retention job routes dispatched by the two Cron triggers; at least 32 characters |
| `NOTICE_AUDIT_SIGNING_KEY` | HMAC signature on production audit/offboarding envelopes; at least 32 characters |

Use independent high-entropy values where purposes differ. Define owner, scope, creation/rotation/revocation date, emergency rotation procedure, and provider-side counterpart. Never copy values into `.env.example`, Git, browser configuration, logs, tickets, or readiness reports.

When CRM is enabled, its gateway has a separate secret inventory: `NOTICE_INGRESS_SECRET` matches the main Worker's `NOTICE_CRM_GATEWAY_SECRET`; the selected adapter additionally requires the HubSpot access token, Salesforce client ID/client secret, or custom webhook secret listed by the CRM deployment plan. Keep those provider credentials out of the main Worker.

## 6. Connect required providers

The safe sequence is: configure values -> enable -> live-test while unattested -> retain evidence -> attest configured -> redeploy -> retest.

### DocuSeal

```text
NOTICE_ESIGN_ENABLED=true
NOTICE_ESIGN_PROVIDER=docuseal
NOTICE_ESIGN_CONFIGURED=false
NOTICE_DOCUSEAL_DEPLOYMENT=cloud-global
NOTICE_DOCUSEAL_API_BASE_URL=https://api.docuseal.com
NOTICE_DOCUSEAL_VALIDATED_RELEASE=3.2.1
NOTICE_DOCUSEAL_API_CLIENT_CONTRACT=1.0.24
NOTICE_DOCUSEAL_TEMPLATE_ID=<positive-template-id>
NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED=true
NOTICE_DOCUSEAL_EXPIRATION_HOURS=168
NOTICE_DOCUSEAL_EMAIL_2FA_REQUIRED=true
NOTICE_DOCUSEAL_MCP_ENABLED=false
```

For DocuSeal Cloud, select `cloud-global` with `https://api.docuseal.com` or `cloud-eu` with `https://api.docuseal.eu`. A self-hosted deployment uses an approved HTTPS URL ending in `/api`; Notice preserves that prefix for every REST call. Signed-artifact downloads may use HTTPS siblings only within the configured Cloud zone; cross-zone and unrelated hosts are rejected, and the API token is sent only to the exact configured API origin. Follow [DocuSeal integration](./DOCUSEAL.md) for the pinned release/client contract, explicit Pro/Developer Sandbox `/submissions/html` entitlement, template profile, expiration/email-2FA behavior, HMAC-tab secret, and optional same-origin MCP diagnostic.

Add the REST token and the webhook HMAC-tab `whsec_...` secret, then register `/api/webhooks/docuseal`. The configured template is the customer-approved signature page/field definition. Notice rejects archived or publicly shared templates, requires one-to-ten ordered unique roles and a required signature/initials field for each, pre-populates that exact order in the production UI, requires one unique signer email per role, and rejects any submitted role/order mismatch. It SHA-256-verifies the exact immutable text/Markdown bytes, decodes and escapes that working text into a one-off HTML document, combines it with the configured template, preserves signing order, requires the configured email 2FA policy, sets the bounded expiration, requests a merged artifact, and asks DocuSeal to deliver every invitation by email.

Production deliberately returns `embedSrc: null`: provider signer URLs are bearer capabilities and are never rendered, returned to the agreement creator, persisted, audited, or exported. Local evaluation uses an entirely local signing simulation and does not contact or embed a provider. Validate the combined payload, exact role/order and unique-address rules, provider email delivery, callback delivery, invalid/stale/replayed callback rejection, provider reconciliation, artifact host restriction, scanner use, superseded-basis behavior, persisted signer evidence, artifact ingestion, and `signature.completed` gateway delivery. Terminal completion must prove the exact expected signer count, a one-to-one provider ID/email match, and `completed` status for every signer before Notice downloads any signed artifact. Then set `NOTICE_ESIGN_CONFIGURED=true`.

Provider submission creation is deliberately recoverable. Once Notice has persisted the `creating` packet and stable recovery key, every provider non-success, malformed response, or transport failure leaves that reservation in `creating` because the provider may have accepted the request. Never retry `POST /api/signatures` in that state. Use `PATCH /api/signatures` with action `reconcile`. Only after at least one hour may a workspace administrator use `abandon_unmapped`; Notice performs a fresh recovery-key lookup and releases the reservation only when the provider returns an exact empty result. A found, ambiguous, mismatched, or failed lookup keeps the reservation.

Mapped `pending`, `partially_signed`, `reconciling`, and `archived` packets use the same `reconcile` action for terminal processing or nonterminal signer refresh. If another fresh reconciliation lease already owns the work, the route returns `202` with `processing: true`; stale leases are restored safely after 15 minutes. DocuSeal `archived_at` is treated as reversible: an archived packet keeps its active reservation and can return to pending/partial when unarchived. If the business must replace it, a workspace administrator uses `supersede_archived`; Notice first re-reads DocuSeal and releases only a provider-confirmed archived pending submission. Later completion of a `superseded` packet is retained as nonactivating `completed_superseded` evidence.

### Document scanner

```text
NOTICE_SCAN_ENABLED=true
NOTICE_SCAN_PROVIDER=scan-gateway
NOTICE_SCAN_CONFIGURED=false
NOTICE_SCAN_GATEWAY_URL=https://<approved-scanner>/scan
NOTICE_SCAN_OCR_ENABLED=false
```

The gateway must verify the Notice HMAC, enforce its own byte/time/decompression controls, return only supported `clean` or `malicious` verdicts, avoid leaking document content into logs, and meet customer region/retention requirements. Scanner failure leaves documents quarantined. After a harmless connection test passes, set `NOTICE_SCAN_CONFIGURED=true`.

Implement and test the exact multipart, hash-recomputation, signature, freshness, response, and rescan contract in [Gateway conformance](./GATEWAY_CONFORMANCE.md). The supplied local kit needs no scanner account or customer document.

Production parses only a bounded structural subset of PDF and DOCX inside the application Worker: PDF header/trailer/xref and referenced-object structure, and DOCX ZIP/container plus required-OOXML-part structure. It does not render these formats, extract their document text, or interpret their content or tracked changes there. Deployment administrators have two explicit choices:

- keep `NOTICE_SCAN_OCR_ENABLED=false`; linking stores the clean source without a text working version until an authorized human supplies reviewed text; or
- select one customer-hosted model/profile in the manifest. Linking then sends the exact immutable source only to the same signed scanner gateway, requires an exact hash/profile bounded result, and creates working version 1. An unavailable result restores the prior clean state for retry; an uncorrelated or malformed clean result remains quarantined and unreadable; and an exact-correlated malicious verdict rejects the source under a policy-only target agreement association. Known uncommitted persistence failures clean staging, while ambiguous final D1 outcomes are read back before release. Notice never falls back or contacts a model endpoint directly.

For the second choice, add the non-secret identifiers to the manifest's `scanner.ocr` object, deploy the pinned model/weights and parser privately behind the gateway, run the synthetic v2 live test while `configured=false`, retain evidence, and only then promote `configured=true`. Follow [Customer-hosted OCR](./CUSTOMER_HOSTED_OCR.md) for exact hosting, model licensing/provenance, GPU/CPU capacity, patching, rollback, network isolation/no-egress, response-limit, readiness, and acceptance requirements. Production may still extract bounded plain text/RTF in process. Local evaluation may heuristically parse PDF/DOCX files no larger than 5 MiB, but that path is not production evidence.

### Delivery and mail

```text
NOTICE_MAIL_ENABLED=true
NOTICE_MAIL_PROVIDER=delivery-gateway
NOTICE_MAIL_CONFIGURED=false
NOTICE_NEGOTIATION_MAIL_ACCEPTED=false
NOTICE_DELIVERY_GATEWAY_URL=https://<customer-gateway>/events
```

The gateway verifies `x-notice-event-id`, timestamp, and HMAC signature, deduplicates, and durably classifies every supported Notice event. The three `notification.*` topics and `negotiation.round_requested` contain explicit recipients and are required mail actions; supported non-recipient lifecycle topics may be accepted as approved no-op receipts or explicitly approved non-CRM actions, never turned into inferred-recipient email. A negotiation delivery must use the explicit recipient, render the scoped portal URL as the secure download/upload link, describe the outbound document only from authenticated hash metadata, never claim an attachment exists, and use the exact Reply-To alias only when optional inbound capture supplied one, under the bearer-minimization rules in [Gateway conformance](./GATEWAY_CONFORMANCE.md). Without inbound capture it must not invent a Notice alias; portal return remains the response path. CRM has its own sink. The mail gateway owns mail credentials, recipient rules, least-privilege scopes, provider retries, reconciliation, and data minimization. Set `NOTICE_MAIL_CONFIGURED=true` only after the general signed dry-run test passes. Keep `NOTICE_NEGOTIATION_MAIL_ACCEPTED=false` until the separate counterparty-message acceptance proves the exact rendered link, explicit recipient, no-invented-attachment behavior, and optional Reply-To behavior; then set it true, rerender, retain readiness evidence, and repeat one harmless end-to-end delivery.

Use [Gateway conformance](./GATEWAY_CONFORMANCE.md) for the exact raw-body signing input, version 1.0 envelope/topic catalogue, response and idempotency rules, collision handling, no-side-effect diagnostic, golden vector, and executable local verifier.

### Counterparty portal and optional inbound email

Choose the scoped portal policy explicitly:

```text
NOTICE_COUNTERPARTY_PORTAL_ENABLED=true
NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS=72
```

The TTL is required in production and must be a whole number from 1 through 336. Each prepared round binds an immutable outbound document SHA-256 to one active agreement round. The random portal token is carried in the issued URL; the negotiation-round row stores its SHA-256 hash. Automated mail delivery necessarily retains the scoped plaintext URL in the protected durable outbox while delivery is pending, then replaces it with a redaction marker and SHA-256 on accepted or terminal-dead state. Rotation replaces the round hash and revokes the prior link, but it does **not** reset the round's durable transfer counters. Closing or resolving the round revokes the link. A terminally failed send cannot be queued again from that outbound round: close it, prepare a new round from the current immutable working draft, and send the new round. Counterparty routes under `/api/exchange/*` use possession of that expiring token instead of a corporate user session, so give only that path a narrow Cloudflare Access bypass and never expose a broader `/api/*` pattern.

One round admits at most 10 upload attempts, independently capped at 4 accepted returns, 6 rejected/failed attempts, and 96 MiB of cumulative multipart bytes. The route reserves the 21 MiB request ceiling before reading/scanning and permits only one five-minute upload-work lease. An overlapping request returns `429 exchange_upload_busy` plus `Retry-After: 5`; an expired lease is charged rejected before a replacement proceeds. Downloads are atomically charged before R2 and capped at 20 attempts/256 MiB; failures remain charged. Either upload or download exhaustion returns `429 exchange_*_limit_reached` and requires a new round. The portal exposes only this static policy, never live counters, remaining capacity, or reservation IDs. Keep distributed WAF/rate/cost controls as a separate aggregate layer across rounds, IPs, tenants, and isolates.

Leave optional inbound email disabled unless the deployment operates a conforming mail receiver:

```text
NOTICE_EMAIL_CAPTURE_ENABLED=false
NOTICE_EMAIL_CAPTURE_PROVIDER=none
NOTICE_EMAIL_CAPTURE_CONFIGURED=false
```

To enable it, select `inbound-gateway`, configure a real dedicated lowercase `NOTICE_INBOUND_EMAIL_DOMAIN`, add the independent `NOTICE_INBOUND_EMAIL_SECRET`, and keep `NOTICE_EMAIL_CAPTURE_CONFIGURED=false` during staging. Give only exact `POST /api/webhooks/email` a machine-route Access bypass. The gateway computes lowercase SHA-256 over the exact unmodified HTTP body, then sends a fresh Unix-seconds timestamp and `sha256=<64-lowercase-hex>` HMAC over `<timestamp>.<raw-body-sha256>`. Notice independently recomputes the body digest, enforces a ±300-second window, compares in constant time, validates the generated per-round `reply-<24-lowercase-hex>@<domain>` alias, and applies message replay, attachment, scanner, sender, and round-state controls. See [Gateway conformance](./GATEWAY_CONFORMANCE.md) for the exact request shape before implementing a receiver.

The portal and inbound email decision are independent. Automated negotiation email delivery requires the scoped portal, the attested outbound delivery gateway, and the separate `NOTICE_NEGOTIATION_MAIL_ACCEPTED=true` acceptance; inbound reply capture remains optional. A separate approved mail process can instead be recorded with a bounded manual delivery reference. That reference is operator evidence, not verification that a mail provider delivered the message.

Returned files never become the working paper automatically. A portal submission contains exactly one file; one inbound-email event may contain zero through five attachments. Each file is capped at 20 MiB and the complete multipart request at 21 MiB. Notice inspects the complete bounded structure before scanning: UTF-8/control policy for text, balanced non-binary RTF, PDF header/trailer/xref and referenced-object structure, or canonical bounded DOCX ZIP layout plus required-OOXML-part structure. This is not semantic document proof or CDR. Notice retains immutable hashes and round lineage and separates clean, sender-review, late, quarantined, and rejected outcomes. A returned-file rescan claims one exact source before scanner I/O, and a fresh correlated malicious verdict remains authoritative over a racing clean result. For a returned DOCX, an authorized reviewer downloads the exact file, reviews tracked changes and comments in Word, and supplies the reviewed plain text or Markdown corresponding to exactly one attachment plus a decision note. Notice does **not** parse DOCX redlines or make legal/playbook verdicts. Explicit promotion creates a new immutable working version, resolves the round, revokes the portal token, and invalidates prior approval/signature readiness.

Before attesting email capture, retain wrong-secret, changed-body, stale/future timestamp, wrong-domain/alias, sender/authentication mismatch, duplicate provider-message ID, no-attachment, oversized/too-many attachment, malicious, scanner-unavailable, late-return, and harmless clean-return evidence. Then set `NOTICE_EMAIL_CAPTURE_CONFIGURED=true`, rerender, and repeat the end-to-end round trip.

### Optional CRM

CRM is a separate outbox sink. Leave it explicitly disabled when it is not part of the accepted use case:

```text
NOTICE_CRM_ENABLED=false
NOTICE_CRM_PROVIDER=none
NOTICE_CRM_CONFIGURED=false
```

If approved, deploy the repository's [CRM gateway](../integrations/crm-gateway/README.md) as a second Worker with its own D1 `CRM_DB`, scheduled recovery trigger, and provider secrets. Select exactly one main-Worker slug:

```text
NOTICE_CRM_ENABLED=true
NOTICE_CRM_PROVIDER=hubspot # or salesforce or custom
NOTICE_CRM_CONFIGURED=false
NOTICE_CRM_GATEWAY_URL=https://<customer-crm-gateway>/v1/events
```

Use the supplied `deploy/crm-gateway.deployment.example.json` and `scripts/crm-gateway-kit.mjs` plan/render flow. The gateway includes:

- HubSpot private-app authentication and batch upsert by a stable Notice external ID;
- Salesforce client-credentials authentication and external-ID upsert; and
- a custom HTTPS adapter with HMAC, timestamp, dry-run, and idempotency headers.

The gateway validates and stores the signed Notice event before 2xx, quarantines event-ID collisions, normalizes only `agreement.created`, `agreement.updated`, `agreement.stage_changed`, `signature.completed`, and `agreement.deleted`, fences stale aggregate versions, retries bounded transient failures, and recovers/prunes receipts on its Cron Trigger. The main outbox records mail and CRM independently; mail acceptance cannot mark CRM accepted.

Customer-specific work is still necessary but bounded: create the approved provider object and mapped fields, create a least-privilege provider credential, review any `NOTICE_CRM_FIELD_MAPPING_JSON` override, decide downstream retention for the supplied `deleted=true` tombstone, and retain the connection test plus synthetic create/update/tombstone round trip. The included adapters do not hard-delete provider records. Provider secrets and mappings live only in the CRM gateway deployment. Keep `NOTICE_CRM_CONFIGURED=false` until that evidence passes, then attest true and retest. The custom option additionally requires an approved receiving endpoint.

After first enablement or a provider/mapping cutover, use **Enterprise setup → CRM resync & backfill** (or `GET|POST /api/admin/integrations/resync`) to page through the full estate and queue an explicit `projection` or `tombstone` for each approved record. Every operation is record-at-a-time and requires the exact current version, an audit reason, `NOTICE_CRM_CONFIGURED=true`, and a current passing diagnostic. Notice permits projection only for active records selecting the configured provider. It permits a tombstone only for a matching soft-deleted record or when immutable receipts prove that a fully profile-bound attempt to the exact endpoint/provider/mapping may remain projected. Pending and dead attempts on that exact profile count because response loss is ambiguous; an accepted same-profile tombstone at the same or a later version resolves the requirement.

Provider equality is not profile equality. During a same-provider mapping/endpoint cutover, Notice treats a restored old profile as historical only when that exact profile has a prior projection and another exact profile has a strictly newer accepted projection that is not itself fenced by an accepted tombstone. Newer unbound, pending, dead, or incomplete CRM mutation work blocks the repair choice until the outbox is run and reconciled. A first projection to a never-used profile remains available. A previously used profile already fenced by its accepted tombstone cannot be reactivated through this repair endpoint while another accepted profile remains live. For an approved rollback, create a new immutable mapping-version profile and run a reviewed maintenance migration; do not reuse the fenced profile identity.

Run historical cleanup as a controlled maintenance sequence:

1. pause CRM-bound business changes and the outbox schedule, then drain/reconcile all existing work;
2. reconcile the intended live profile's main receipt, gateway receipt, and current provider state, and retain that evidence;
3. restore and retest the exact historical endpoint/provider/mapping, select its eligible tombstone, check the maintenance acknowledgement, type the displayed confirmation sentence exactly, run the outbox, and reconcile acceptance/provider state;
4. restore and retest the intended live profile immediately, explicitly project every affected active record at its new higher Notice version, run the outbox, and verify current fields plus `deleted=false` at the provider; and
5. resume CRM-bound changes and scheduling only after both profile ledgers and provider state reconcile.

The restoration step is mandatory even when old and new profiles use different mapping versions: they can still address the same provider object and external ID, so the historical tombstone may temporarily mark the shared record deleted. Do not disable or decommission an old CRM path until its required tombstones are accepted, and do not end the maintenance window until the intended live profile has been reprojected and verified.

An upgraded database can also contain pre-profile projection evidence whose original provider/mapping/fingerprint cannot be proven. The UI labels this separately as **Attest legacy cleanup**. Before using it, reconcile the agreement against every possible historical CRM and delete or otherwise resolve all copies outside Notice. The admin must check the explicit acknowledgement, type the displayed confirmation sentence exactly, and provide a reason. Notice records immutable payload-digest evidence in bounded batches of 20; it does not infer a destination, bind a receipt, or call a CRM. Reload and repeat while another batch is reported. A deleted agreement also receives a fresh exact-version canonical tombstone in that guarded transaction. Retain the provider exports, tickets, and approvals supporting the attestation with the deployment's acceptance evidence.

## 7. Run provider diagnostics

An administrator uses:

- `GET /api/admin/integrations` for redacted presence/provider/testability state; and
- `POST /api/admin/integrations` with `docuseal`, `scanner`, `delivery`, or `crm` for a live test.

Diagnostics never return secrets/endpoints/account/template IDs. The protected scanner status deliberately does return the selected non-secret OCR model/profile identifiers. DocuSeal reads and validates the complete non-archived/non-public template profile and the explicit HTML-submission entitlement. Optional self-hosted MCP performs the bounded `initialize` → `notifications/initialized` → `tools/list` handshake, requires the tagged server's exact HTTP 202 acknowledgement for the initialized notification, validates the pinned version/tool annotations, then invokes only read-only `load_template` and requires it to match the REST-selected template and ordered roles. It never invokes a mutation/open-world tool. The scanner receives harmless synthetic text and, when OCR is selected, a generated one-page PDF through the signed v2 extraction contract; no customer source is used and no fallback is permitted. Mail/CRM gateway diagnostics set `x-notice-test: connection` plus `dryRun=true`; those gateways must guarantee the requests do not send mail or mutate CRM.

The API and administrator UI can test complete values while the related `CONFIGURED` flag is false. Set the flag only after a pass. A valid dry run may retain a bounded gateway diagnostic receipt but must not send mail or mutate CRM.

## 8. Configure records policy

Choose and approve:

- retention trigger and duration for each agreement/document class;
- who may set/change dates and legal holds;
- whether agreement retention should cascade to documents;
- purge approval and evidence requirements;
- export/offboarding format, recipient, transfer method, and verification;
- backup/log/export/index/provider deletion timing; and
- exceptions, litigation hold, regulator request, and incident preservation.

Set the additional hard-purge delay:

```text
NOTICE_RETENTION_PURGE_GRACE_DAYS=30
```

Allowed values are 7–365; 30 is the default. Retention expiry first soft-deletes eligible unheld records. Hard purge is later and refuses held/ineligible linked data. `null` retention is indefinite; it is not permission to delete immediately.

Migration `0007` adds the durable workspace-scoped purge manifest. Verify in staging that a lost legal-hold/retention precondition rolls back the D1 batch; that missing, pending, or dead current deletion-tombstone sinks block purge; and that every fully profile-bound CRM projection attempt in any delivery status remains blocked until an accepted same-profile tombstone at an equal or later aggregate version exists. Verify separately that an older non-`None` CRM event with no delivery row or incomplete profile fields remains blocked until an administrator records its payload-bound legacy-cleanup attestation after external reconciliation. These historical gates remain in force after CRM is disabled or changed. Also prove that an injected R2 failure leaves a `storage_pending` job which completes on a later authenticated run. Once the exact current tombstone and all historical CRM cleanup evidence are finalized, the guarded purge deletes their payloads and attestations with the agreement. The `retention.d1_purged` outbox topic records only that guarded D1 deletion committed and includes `storageStatus=storage_pending` plus the `purgeJobId`; it is not evidence that R2 cleanup completed. The retention job response and the matching `purge_jobs` row are authoritative for final storage completion. Monitor blocked records and pending age/attempts; never repair an R2 failure by reconstructing the already-purged D1 parent or deleting an unvalidated bucket prefix.

Use `GET|PATCH /api/admin/retention` to review/change policy with a reason. Use `GET /api/admin/export` for the signed structured offboarding package and artifact manifest. Retrieve binary artifacts separately and verify their SHA-256. Preserve audit/export evidence outside the mutable application environment when policy requires it.

## 9. Configure scheduled work and monitoring

The generated main-Worker configuration declares two distinct Cron Triggers. Set the matching non-secret bindings:

```text
NOTICE_OUTBOX_CRON=*/5 * * * *
NOTICE_RETENTION_CRON=15 2 * * *
```

The native `worker.ts` scheduled handler dispatches each matching trigger internally to:

- `/api/jobs/obligations` and then `/api/jobs/outbox` at the approved delivery interval, attempting both even when one fails; and
- `/api/jobs/retention` at the approved disposition interval.

The bearer-protected HTTP routes remain available only for an explicitly approved external scheduler. Keep the bearer out of URLs and query strings. The obligation job uses bounded schedule/occurrence and reminder batches, active-owner/parent revalidation, compare-and-swap cursors, and deterministic delivery identities; repeated invocations converge. The outbox handles stale locks, independent per-sink retries, provider `Retry-After`, and dead state. The retention job uses bounded batches and may need repeated invocations. The CRM gateway has its own recovery Cron Trigger. Monitor and alert on:

- job authentication/availability failures;
- paused/ended/owner-repair schedule counts, materialization conflicts/backlog, and overdue reminder cursors;
- pending age, per-sink retry count, dead mail/CRM deliveries, gateway receipt backlog, and provider rejection;
- webhook invalid/failed receipts and signature reconciliation delay;
- scanner unavailable/quarantine age/rejection;
- retention failures, eligible backlog, R2 delete failure, and policy conflict;
- D1/R2 readiness, latency, errors, and capacity;
- failed identity/authorization, role changes, bulk download/export, and unusual administrator activity; and
- backup/restore failure and secret expiry.

The repository produces request IDs and safe job results; the customer supplies the log/metric/trace/SIEM destination, dashboards, pager, runbooks, and on-call organization.

## 10. Verify readiness and approve go-live

Run in controlled deployment/CI context with the intended configuration and managed secrets available to the process:

```bash
npm test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:production
npm run readiness
npm run readiness -- --json
```

Then sign in as an administrator and call:

- `GET /api/health?mode=ready`
- `GET /api/readiness`
- `GET /api/admin/integrations`
- live provider tests through `POST /api/admin/integrations`

Readiness separates immutable maintainer code gates from customer deployment configuration/attestation gates. It requires the exact implemented provider slugs, valid required endpoints/IDs, required credential presence, an explicit counterparty portal decision and 1–336 hour TTL, an explicit optional email-capture decision, and—when email capture is enabled—the exact inbound provider, real domain, independent 32-character-minimum/4096-byte-maximum secret, and retained-test attestation. It also requires distinct Cron values, retired bootstrap for go-live, 32+ character job/audit secrets, and a successful live diagnostic from the last 24 hours whose one-way fingerprint matches each current required provider configuration. Rotating an endpoint, credential, provider, template, or CRM mapping automatically invalidates the old evidence. The ready health probe separately verifies exact schema marker 21 plus D1/R2 reachability. These checks print no secret values and return non-success while their gates fail. They do not replace end-to-end workflows, provider-side reconciliation, backup restore, penetration testing, or risk approval.

Minimum synthetic acceptance:

- anonymous/direct-origin/alternate-host requests and invalid Access JWTs (or compatibility-header spoofing) fail;
- each role can do only its intended actions, including requester/decider separation, direct/group lane authority for the exact currency and amount, fail-closed behavior after a lane has any authority history, and the narrow no-record compatibility fallback;
- governed template/workflow/intake publication is immutable, submitted-intake conversion is atomic and replay-safe, and stale form/template/workflow pins fail;
- registered-fragment search returns internally consistent version/hash-pinned citations, caller-asserted source-text provenance is visibly treated as untrusted, reviewers compare every citation with protected working paper, invalid or cross-registration citations fail, proposal UUID exact replay recovers the one committed record while different material conflicts, human proposal decisions append evidence without mutating agreement/custom-field data, and ingestion batches remain bounded idempotent inventories rather than an upload or OCR path;
- cross-workspace identifiers return no record;
- create/edit/version conflict/lifecycle/approval/obligation flows persist authoritative results, including recurrence anchor/time-zone edge cases, idempotent schedule creation, concurrent materialization, reminder catch-up/deduplication, immutable completion evidence, reassignment, pause/end, and owner-offboarding guards;
- clean, malicious, and scanner-unavailable documents follow correct paths; disguised/malformed complete text/RTF/PDF/DOCX structures fail; one exact rescan is leased at a time; and a correlated malicious verdict dominates a concurrent clean result without resurrecting deleted bytes;
- counterparty rounds bind the exact outbound hash, enforce one active round, rotate/expire/revoke portal links without resetting the round budget, reject bad tokens and stale rounds, enforce upload/download count/byte exhaustion plus upload-lease concurrency and recovery, deduplicate inbound provider message IDs, quarantine unsafe or unavailable scans, isolate sender/authentication mismatches, and require an authorized Word review plus explicit promotion before a returned DOCX creates a new working version;
- one-to-ten-signer DocuSeal role discovery/create/status/partial/complete/decline/expiry/archive/replay flows reconcile correctly; the deployment/release/API-contract/entitlement attestations are exact; the template is non-archived/non-public and gives every ordered unique role a required signing field; submitted emails are unique; expiration, merge, provider email, and email 2FA match policy; production exposes no signer URL; optional MCP invokes only read-only `load_template` after its pinned handshake/inventory and matches the REST-selected template; terminal evidence exactly matches every signer; retained `creating`, `202` busy, stale-lock, verified abandonment, and archived supersession paths behave as documented; and a stale basis produces nonactivating `superseded` or `completed_superseded` evidence;
- reminders reach the mail sink, CRM mutation topics independently reach the CRM sink, identical replays deduplicate, stale CRM versions do not overwrite newer state, and failed delivery dead-letters/alerts per sink;
- audit export validates and its HMAC verifies outside Notice;
- holds stop deletion; retention soft-delete/grace/purge work on synthetic records;
- workspace export counts, manifests, artifact bytes, and hashes reconcile; and
- a scoped D1/R2 restore succeeds within the approved RTO/RPO.

## Customer handoff checklist

Copy this table into the customer's controlled implementation record. Replace every blank before real-data use; links should point to evidence, not to unverified statements.

| Item | Suggested accountable owner | Minimum evidence | Evidence link / status |
| --- | --- | --- | --- |
| Operating model, support, RTO/RPO | Service owner | Approved service and recovery record | |
| Workspace identity and two administrators | Identity/customer owner | Named verified admins and access review | |
| Corporate SSO/direct-origin test | Security/identity owner | Access policy and negative JWT/direct-origin/alternate-host results, or compatibility-edge spoof evidence; disabled-member and subject-change recovery evidence | |
| D1/R2 isolation, migrations, backup/restore | Platform owner | Resource inventory, migration log, timed restore | |
| Governed templates/workflows/intake/playbooks and approved language | Legal/business owner | Published immutable versions, exact intake pins, tested workflow lanes/conditions, and proposal-review policy | |
| Legal entities, counterparties, groups, custom fields, saved views, relationships, and lane authority | Legal/business/identity owners | Approved records, membership review, exact currency/minor-unit ceilings, revoked-history behavior, and compatibility-fallback decision | |
| Managed-secret inventory and rotation | Security/platform owner | Redacted inventory, owners, rotation dates | |
| DocuSeal/scanner/delivery diagnostics | Integration owner | Passing live-test evidence and provider scopes | |
| Counterparty portal and inbound email decision | Legal/integration/security owners | Approved TTL; portal rotation/expiry/revocation and non-resetting round-budget test; upload/download count/byte exhaustion and one-lease concurrency evidence; email disabled decision or dedicated domain, narrow Access paths, secret inventory, raw-body HMAC negatives, replay/quarantine evidence, harmless round trip, and authorized Word-review procedure | |
| Optional CRM decision and included gateway | Business/integration owner | Disabled decision or gateway deployment/migration, approved provider fields/mapping/scopes, dry run, replay/version-fence evidence, and synthetic round trip | |
| Cron Triggers, monitoring, alerts, incident runbooks | Operations owner | Native main/CRM job runs, alerts, pager route, exercised runbook | |
| Retention, legal hold, purge, export/offboarding | Records owner | Approved policy plus synthetic hold/purge/export evidence | |
| Full tests, dependency/secret scans, penetration test | Release/security owner | Revision-bound reports and accepted findings | |
| Privacy/legal/compliance/vendor-risk approval | Accountable customer approvers | Signed approval or recorded exceptions | |
| Residual risks, owner, review/expiry date | Release authority | Accepted risk register with expiry dates | |

Only the customer's accountable release authority can accept the completed record and authorize real-data use.

## Deliberate product boundaries

The repository does not hide product extensions inside “customer configuration.” The following are explicit current-product boundaries: automated DOCX tracked-change parsing; governed-template composition of approved-language IDs before immutable block content/version snapshots and deterministic composition exist; a bundled OCR/CDR engine or semantic extractor (the exact customer-hosted scanner-gateway OCR contract is supported); automatic proof that registered fragment text corresponds to canonical working-paper bytes; automatic clause-level playbook/legal verdicts; automatic application of accepted extraction proposals; a business-friendly no-code template/routing designer beyond the governed JSON contracts; an IdP-specific login implementation or SCIM/group-to-role synchronization beyond Cloudflare Access; an interactive end-user OAuth-install UI for CRM or mail; bundled outbound or inbound mail services; distributed rate limiting; cursor coverage and analytics beyond the agreement register, agent-plan inbox, paged work-items, portfolio report, and paged CRM-resync maintenance inventory; an outbox replay console; and independently retained WORM evidence. Production does retain immutable self-contained governed-template bodies and declared-variable rendering, separate human-reviewed approved-language insertion, immutable hash-bound negotiation rounds, returned source files, optional exact-profile customer-hosted OCR provenance, human-reviewed text and comparison provenance, extractor-registered fragments/citations pinned to immutable document version/hash with caller-supplied source-text metadata, reviewed extraction proposals that cannot mutate agreement data, explicit promotion, editable working versions, and attributable review events. Reviewers must compare OCR/registered citations with protected working paper. Bounded ingestion inventories source metadata and exact hashes; it is not a bulk uploader or repository-migration executor. The included CRM adapters support the documented provider-neutral agreement projection and upsert/tombstone flow; a different object model or bidirectional synchronization is an extension. An organization may deploy without the external or extension features only if the recorded use case and risk acceptance support that decision; otherwise they are scoped engineering work before go-live.

# Security policy

## Support and production status

Notice contains the reusable application security controls required by this repository, but a checkout is not automatically a production service. A real deployment is acceptable only after its customer-owned identity, infrastructure, secrets, integrations, records policy, monitoring, backup/restore, and security approvals are complete.

`NOTICE_APP_MODE` defaults to `production`. Production fails closed unless the workspace, canonical `NOTICE_PUBLIC_BASE_URL`, selected identity boundary, and a valid bootstrap lifecycle state are explicitly configured. Recommended Cloudflare Access mode verifies a signed application JWT and rejects the trusted-header flag; the optional compatibility mode requires a separately proven header-sanitizing edge. Bootstrap may be enabled with at least two verified administrators only during controlled onboarding, or disabled with an empty bootstrap list after durable administrators exist. The readiness report is an engineering preflight, not a compliance certification or warranty.

This repository currently has no published security-maintenance SLA. Deployment owners must define supported versions, vulnerability response targets, upgrade policy, and customer communications before offering a production service.

Source-publication and security-intake gates are defined in [Public release and adopter handoff](./docs/PUBLIC_RELEASE.md).

## Supported versions

Before the first public tag, security fixes land on the latest `main` revision only. After a public release, the latest released minor line is the supported open-source line unless a release notice says otherwise; older snapshots and unmodified forks are unsupported. This policy does not create a hosted-service, uptime, or remediation SLA.

| Version | Open-source security updates |
| --- | --- |
| Latest public minor release | Supported on a best-effort basis |
| `main` ahead of the latest release | Development branch; fixes may land here first |
| Older releases, forks, and modified deployments | Not supported unless explicitly announced |

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, screenshot, or shared log.

Use the repository's GitHub **Report a vulnerability** path or private security advisory. GitHub provides that reporter-facing path only after a repository is public. The controlled first-public cutover therefore remains unannounced until an accountable triage owner and a non-maintainer have tested the private path without disclosing the report publicly. If the test fails, the release owner must restore private visibility to contain further access, record the public interval, and stop; that action cannot retract copies, caches, or observations already made. Do not substitute a public issue because no private email address is published. Include:

- the affected revision and environment;
- the route, feature, or component;
- reproduction steps using synthetic data;
- security impact and preconditions;
- redacted logs or screenshots; and
- a suggested mitigation, if known.

Do not test accounts, workspaces, documents, or services without explicit authorization. Do not retain sensitive material or degrade service while investigating.

The current accountable intake owner is the project maintainer named in [GOVERNANCE.md](./GOVERNANCE.md). The project targets an initial human acknowledgement within five business days, but this is a best-effort target rather than a contractual SLA. Remediation and disclosure timing depend on severity, reproducibility, affected releases, downstream coordination, and a safe fix. Reporters will be credited when requested and appropriate.

## Repository security controls

The application currently provides:

- verified edge identity consumption, fail-closed production configuration, active workspace membership, and role permissions;
- tenant predicates on domain queries and workspace-prefixed R2 keys;
- exact-origin browser mutation checks, bounded validation, server-owned IDs/actors/times, optimistic versions, and safe error envelopes;
- workspace-scoped enterprise reference records, immutable published template/workflow/playbook artifacts, exact workflow/template snapshots, typed custom-field validation, structured party/relationship integrity, and minor-unit currency storage without implicit FX;
- registered service principals with exact expiring sponsored grants, canonical digest-bound plans, sponsor/reviewer separation for both outcomes, current active-Admin review authority rechecked at decision commit, and atomic `agreement.read` execution claims/completions that fence the exact current grant, action, resource, policy, expiry, agreement snapshot, and latest working document;
- full-byte format and size inspection—valid controlled UTF-8 text, complete bounded PDF header/trailer/cross-reference and referenced-object linkage, balanced bounded RTF without embedded binary/object content, and canonical DOCX ZIP entry/layout plus required-OOXML-part structure—plus SHA-256 hashes, quarantine, HMAC-authenticated malware scanning, exact five-minute rescan claims, correlated-malicious-verdict dominance, protected downloads, safe response headers, and no production in-Worker PDF/DOCX rendering, text extraction, or content interpretation;
- provider-neutral extractor-registered repository fragments pinned to immutable working-document ID/version/hash plus caller-supplied source-text digest/offset/content hashes, internally consistent citations, UUID-idempotent confidence-bearing extraction proposals, attributable human review, and a deliberate application blocker that prevents proposal review from changing agreement data;
- hash-bound counterparty rounds, random expiring portal capabilities stored only as hashes, no-store/no-referrer self-contained portal responses, exact-origin uploads, durable per-round upload/download attempt-and-byte budgets that survive token rotation, one leased upload/scan at a time, rotatable/revocable links, domain-bound reply aliases, raw-body digest HMAC verification, freshness, durable replay/collision receipts, scanner gates, and explicit authorized human promotion;
- server-created DocuSeal 3.2.1 submissions, fresh HMAC callback verification, durable replay receipts, provider reconciliation, restricted artifact hosts, scanned signed-evidence ingestion, and an optional self-hosted MCP diagnostic that performs `initialize` → `notifications/initialized` (exact HTTP 202) → `tools/list` → one read-only `load_template` call that must match the REST-selected template and ordered roles; mutation/open-world tools are never called;
- durable outbox records, authenticated scheduled processing, stale-lock recovery, bounded exponential retry, dead-letter state, and HMAC-signed delivery payloads;
- gap-checked hash-chained agreement events and single-D1-snapshot HMAC-signed agreement/workspace export envelopes;
- legal-hold precedence, retention dates, soft delete, configurable purge grace, exact current-tombstone sink acceptance, historical CRM profile cleanup or explicit legacy reconciliation attestation, workspace-key validation before R2 deletion, and offboarding manifests;
- CSP and other browser headers, no-store API responses, request correlation IDs, liveness/readiness probes, durable round-scoped portal transfer budgets, and bounded in-process rate limiting; and
- behavioral tests for configuration, role policy, tenant helpers, validation, document security, webhook verification, artifact boundaries, integration status, records governance, and audit-chain integrity.

See [Architecture](./docs/ARCHITECTURE.md) and [Threat model](./docs/THREAT_MODEL.md) for boundaries and data flows.

## Security responsibilities outside the repository

The operator and customer must configure and retain evidence for:

- direct-origin and alternate-host blocking plus exact Cloudflare Access application/audience policy; compatibility mode additionally requires removal of caller-supplied canonical identity headers before the edge injects verified values;
- MFA, conditional access, identity lifecycle, account recovery, access review, and emergency access;
- approval-lane definitions, workflow conditions, and the direct-user/group authority matrix, including exact currency and amount ceilings; populate and review the governed authority records before relying on them, and remember that the narrow role-based compatibility fallback applies only to a lane with no authority record at all;
- production D1/R2 isolation, least privilege, encryption/key-management posture, residency, backup, restore, and disaster recovery;
- an isolated, resource-bounded PDF/DOCX extraction/OCR service or authorized reviewed-text process where those formats must become editable working paper;
- an approved extraction/indexing provider and separately governed proposal-application executor if the deployment needs automatic population; the repository neither supplies those provider credentials nor turns a reviewed proposal into a legal verdict or data mutation;
- managed secrets, credential scope, rotation, revocation, and secret scanning;
- distributed WAF/DDoS and cross-round, verified-user, and IP rate/upload controls plus egress restrictions; these complement rather than replace Notice's durable per-exchange-round portal budgets;
- an explicit counterparty portal TTL, exact `/api/exchange/*` and optional exact `POST /api/webhooks/email` non-human edge policies, canonical-host enforcement, portal-URL exclusion from logs/referrers/analytics/link rewriting, and tested expiry/rotation/close and transfer-budget behavior;
- when inbound email is enabled, a dedicated domain, authenticated provider event source, exact raw-body preservation, sender/alignment policy, alias restrictions, replay/collision handling, returned-file/PII procedure, and authorized Word-review/promotion process;
- scanner, DocuSeal, delivery gateway, mail, and optional CRM provider accounts and contracts;
- native Cron Trigger security, optional external-scheduler bearer custody, job monitoring, dead-letter alerts, webhook failure alerts, and reconciliation;
- protected logs/metrics/traces/SIEM with redaction and retention;
- propagation of holds/deletion to backups, exports, logs, downstream providers, and any search/index service;
- release controls, dependency scanning, artifact provenance, penetration testing, privacy/legal/vendor review, and incident response.

Do not enable `NOTICE_TRUST_IDENTITY_HEADERS=true` until the edge boundary is verified. If the Worker origin can be called directly or client-provided `x-notice-identity-*` headers can reach it unchanged, identity can be spoofed.

## Known limitations and residual risks

- Recommended production mode validates Cloudflare Access application JWTs (issuer, audience, signature, time, type, subject, and email). Notice does not implement a second direct OIDC/SAML login flow or SCIM/group synchronization; the documented trusted-header mode remains an optional compatibility edge.
- A deployment selects one configured workspace. It is not a shared multi-customer control plane.
- Member administration is access-controlled and protects the last administrator. Membership changes use a separate hash-linked workspace access chain rather than an agreement chain; retain and independently anchor both chains together with edge/platform administration logs.
- `Legal`, `Finance`, and customer-defined names are approval lane labels, not workspace identity roles. Active authority records can scope a lane to a direct user or active group for one exact currency and optional minor-unit ceiling. If any active or revoked record exists for a lane, unmatched users fail closed; only a lane with no authority history uses the narrow compatibility default (`admin`/`legal` for `Legal`, `admin`/`approver` for `Finance`, and `admin` for another lane).
- The mutation guard verifies exact browser origin. It does not implement a session-bound CSRF token; the deployer must confirm the selected edge/session model and add one if the cookie/session architecture requires it.
- The in-memory rate limiter is not distributed between Worker isolates. Durable portal transfer budgets still apply to one exchange round across token rotations, but neither control replaces distributed edge limits for cross-round, verified-user, IP, or aggregate abuse.
- The CSP permits inline script for current Next/vinext compatibility. It blocks frames and does not grant browser access to DocuSeal; narrow the remaining inline allowance where platform support permits.
- The counterparty portal is intentionally a bearer-capability boundary. Anyone holding an unexpired current URL can read the scoped round metadata/outbound paper and submit a return; the typed sender field is not identity proof. Each round permits at most 10 upload attempts, of which at most 4 may be accepted and at most 6 rejected/failed, with 96 MiB cumulative multipart bytes; it also permits at most 20 download attempts and 256 MiB cumulative outbound bytes. Only one upload holds the 21 MiB, five-minute work reservation at a time. Rotation does not reset these counters, and exhausted limits require a new round. Current counters remain server-side. Security also depends on entropy, short customer-approved expiry, narrow routing, URL minimization, and prompt rotation/closure.
- Automated negotiation mail temporarily retains the plaintext portal URL while its durable delivery is pending. Rotation, close, and promotion are fenced during pending/processing delivery, and terminal state scrubs the URL, but a downstream mail provider may already have accepted a message; provider reconciliation and incident containment remain operator responsibilities.
- Inbound-email HMAC proves that the configured gateway signed the exact raw request bytes. The gateway must derive sender, recipient, mail-authentication result, identifiers, and attachments from an authenticated provider event; HMAC alone does not prove the human sender's legal identity or make content safe.
- Production limits in-Worker PDF/DOCX parsing to bounded structural admission: PDF header/trailer/xref and referenced-object checks, and DOCX ZIP/container plus required-OOXML-part structure checks. It does not render these formats, extract their document text, interpret their content or tracked changes, or establish semantic OOXML/PDF validity, safe rendering, or absence of hidden content. It stores clean scanned sources for an isolated resource-bounded extraction/OCR service or an authorized human-created text working version. In-process text/RTF extraction and local-evaluation PDF/DOCX heuristics do not provide OCR, sandboxed document rendering, content-disarm/reconstruction, or legal analysis.
- Repository search indexes only fragments an authorized extractor/client explicitly registers against an immutable working-document ID/version/hash. The source-text digest, offsets, and fragment content are caller-supplied; Notice verifies their internal hashes and citation slices but does not derive or compare them with canonical working-paper bytes. Search is literal provider-neutral lookup, not semantic/vector retrieval. Reviewers must open the protected working paper and verify every citation. Extraction confidence and citations are evidence, not correctness; accepting a proposal records review but deliberately leaves agreement and custom-field values unchanged until a separately reviewed governed executor exists.
- Scanner and gateway URLs are configuration-controlled outbound destinations. Restrict who can change them and enforce deployment egress policy; the repository validates HTTPS but is not a full SSRF firewall.
- The repository includes durable Salesforce, HubSpot, and signed custom-webhook CRM adapters, but no bundled mail provider. Customer-controlled gateway deployments hold provider credentials and approved mappings.
- D1, R2, DocuSeal, the scanner, mail gateway, and separately deployed CRM gateway cannot participate in one atomic transaction. Some cleanup is best effort; monitoring and reconciliation are required.
- The outbox dead-letters permanent redirects/other 4xx responses immediately and transient failures after eight attempts. The repository provides audited record-at-a-time CRM projection/tombstone resync. Pre-profile legacy CRM evidence can be closed only through a strongly confirmed, payload-digest-bound attestation after external reconciliation; the action does not infer a destination or receipt. Notice does not page an operator or provide a general replay console.
- Webhook receipt uniqueness supports replay handling, but provider callbacks and concurrent/partial failures still require operational reconciliation.
- Hash chains reveal changes to retained events and gaps inside a chain. Without an independently stored head or WORM export, removal of the latest event cannot be proven from the remaining database alone.
- HMAC export signatures are symmetric. Key custody and independent evidence retention determine their evidentiary strength.
- The workspace export contains structured records and an artifact manifest, not embedded R2 bytes. Offboarding must separately retrieve and verify listed artifacts.
- Retention automation covers Notice primary records and R2 objects only. Backup, log, export, and downstream deletion are external responsibilities.
- Runtime compatibility initialization exists for local/legacy databases, but reviewed Drizzle migrations must be the production schema-change path.
- Health readiness proves D1/R2 reachability, not application correctness, identity correctness, backup viability, or provider health.

## Secrets and sensitive data

Never commit credentials, tokens, webhook secrets, HMAC keys, real agreements, customer exports, database copies, or production `.env` files.

The main Notice Worker managed secret names are:

- `NOTICE_DOCUSEAL_API_TOKEN`
- `NOTICE_DOCUSEAL_WEBHOOK_SECRET`
- `NOTICE_DOCUSEAL_MCP_TOKEN` when the optional read-only DocuSeal MCP capability diagnostic is enabled; never expose it to browser or agent callers
- `NOTICE_SCAN_GATEWAY_SECRET`
- `NOTICE_DELIVERY_GATEWAY_SECRET`
- `NOTICE_INBOUND_EMAIL_SECRET` whenever optional inbound counterparty-email capture is enabled
- `NOTICE_CRM_GATEWAY_SECRET` whenever the independent CRM sink is enabled
- `NOTICE_JOB_RUNNER_SECRET`
- `NOTICE_AUDIT_SIGNING_KEY`

The separately deployed CRM gateway has its own exact secret inventory: `NOTICE_INGRESS_SECRET`, optional rotation-only `NOTICE_INGRESS_PREVIOUS_SECRET`, `NOTICE_OPERATIONS_SECRET`, and one provider credential set—`NOTICE_CRM_HUBSPOT_ACCESS_TOKEN`; `NOTICE_CRM_SALESFORCE_CLIENT_ID` plus `NOTICE_CRM_SALESFORCE_CLIENT_SECRET`; or `NOTICE_CRM_CUSTOM_SECRET`. The main Worker's `NOTICE_CRM_GATEWAY_SECRET` and the gateway's `NOTICE_INGRESS_SECRET` are the same shared ingress key; every other bearer, HMAC, and signing purpose must use a distinct value. See [the gateway deployment inventory](./integrations/crm-gateway/README.md) for provider-specific non-secret configuration and rotation order.

Provider-issued API/OAuth credentials use their provider-defined format and strength. Every application-generated HMAC, signing, and bearer secret—DocuSeal webhook, scanner, delivery, inbound email, CRM ingress, CRM operations, custom CRM signing, job runner, and audit signing—must contain at least 32 characters and be independent by purpose. `NOTICE_INBOUND_EMAIL_SECRET` is additionally bounded to at most 4096 UTF-8 bytes by the application contract.

`.env.example` lists names only. Never place their values in that file, logs, screenshots, support tickets, readiness output, or browser-delivered configuration. Rotate and revoke a secret immediately after suspected exposure, then remove it from current files and repository history. Before public source release, audit the complete reachable history—not only the current tree—for secrets, personal data, internal identifiers, deleted configuration, and third-party material; use a reviewed clean snapshot/new root when historical objects are not suitable for disclosure.

## Required production evidence

Before real-data use, record passing evidence for:

1. anonymous, invalid-identity, disabled-user, cross-role, cross-workspace, IDOR, and mass-assignment tests on every protected route;
2. direct-origin, identity-header spoofing, CSRF/origin, CORS, session expiry/revocation, and redirect tests;
3. malicious, disguised, oversized, malformed, encrypted, parser-exhaustion, complete controlled-UTF-8/PDF/RTF/DOCX structural inspection, scanner-outage, exact rescan-claim serialization/stale recovery, correlated malicious-over-clean race dominance, quarantine, and isolated PDF/DOCX extraction-boundary tests;
4. portal entropy/expiry/rotation/close, URL leakage/referrer/log/link-rewrite, exact public-route policy, per-round upload/download attempt-and-byte exhaustion, token-rotation non-reset, concurrent-upload lease and retry behavior, hidden current counters, pending-delivery revocation fence, raw-body HMAC/freshness, domain/alias/sender alignment, replay/collision, returned-file/PII, and authorized human-promotion tests;
5. DocuSeal 3.2.1 release/entitlement/template checks, webhook forgery, freshness, replay, reconciliation, signed-artifact and provider-outage tests; when self-hosted MCP is enabled, also prove the exact handshake, HTTP 202 notification acknowledgement, tool annotations, the single read-only `load_template` cross-check, and absence of every mutation/open-world tool call;
6. gateway signature, idempotency, least-privilege provider scope, retry/dead-letter, and reconciliation tests;
7. concurrent mutation, partial D1/R2 failure, ordered migration through exact marker 21, enterprise-reference and workflow/template snapshot integrity, retry-safe atomic governed-configuration creation, durable portal-transfer budgets, intake-conversion replay, backup, restore, and data-integrity tests;
8. direct/group lane authority, currency/amount ceiling, group membership, revocation, legacy-fallback cutoff, distinct-decider, stale workflow-basis, agent sponsor/reviewer separation for approve and reject, current active-Admin decision-commit authority, and `agreement.read` claim/completion fencing of exact grant/action/resource/policy/time/agreement/latest-document basis tests;
9. fragment document-version/hash pinning, caller-asserted source-text provenance, internal citation consistency, proposal UUID idempotency replay/conflict, required human working-paper verification, ingestion replay/deduplication, proposal review, and no-mutation blocker tests;
10. legal hold, retention boundary, grace period, purge, export, offboarding, and downstream deletion tests;
11. SAST, dependency and secret scanning, SBOM/provenance, and an independent penetration test; and
12. deployment-specific security, privacy, legal/compliance, vendor-risk, accessibility, and residual-risk approval.

Completion of this list does not itself establish regulatory compliance or fitness for a particular customer.

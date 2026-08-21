# Wealth-management starter implementation profile

This is an opinionated first deployment for a wealth-management business that wants one controlled path for third-party commercial agreements: intake, immutable working paper, counterparty redlines, approval, signature, and renewal/notice obligations. It is designed to make a pilot implementable without pretending that customer policy can be shipped in a public repository.

> [!IMPORTANT]
> This profile is a nonlegal implementation starting point, not legal advice, a regulatory mapping, an approved playbook, or evidence that Notice is suitable for client records. The adopting firm's legal, compliance, information-security, records, privacy, procurement, and delegated-authority owners must approve the scope and replace every placeholder decision before real data is admitted.

Use this profile with the [15-minute staging deployment](./DEPLOYMENT_QUICKSTART.md), [Implementation handoff](./IMPLEMENTATION_HANDOFF.md), [Production setup](./PRODUCTION_SETUP.md), [Security policy](../SECURITY.md), and [Threat model](./THREAT_MODEL.md).

## Opinionated MVP outcome

Start with one legal entity, one Notice workspace, and one centrally managed contracting team. The MVP outcome is:

> A business owner can submit a published request form, use exact governed paper, or upload a vendor or mutual NDA; Legal can exchange one exact version with the counterparty; a named human can review the returned Word file and promote reviewed text; the current paper must pass its governed or compatibility approval gate before DocuSeal signature; and the owner can track renewal or notice work afterward.

Keep the first release deliberately narrow. Notice stores non-negative minor units plus an uppercase three-letter currency code, supports its defined zero-, two-, and three-decimal mappings, and never performs FX conversion or combines currencies into one value total. This profile intentionally limits the baseline pilot to USD so the firm's first delegated-authority and portfolio acceptance can use one currency; that is a customer operating choice, not a product storage limitation. Add another currency only after the firm approves and tests its exact workflow lanes, direct/group authority, amount ceilings, and per-currency reporting.

| Include in the pilot | Defer until separately designed and approved |
| --- | --- |
| Mutual NDAs with business counterparties | Investment-management/advisory agreements with clients |
| Software subscriptions and order forms | Account-opening, brokerage, custody, trading, or transfer instructions |
| Professional and supplier services agreements | Fund subscription documents, side letters, or investor reporting |
| Statements of work and change orders | Regulatory filings, disclosures, books-and-records replacement, or communications supervision |
| Data-processing and security addenda structurally linked to an in-scope vendor agreement | Automatic legal/playbook verdicts, automatic proposal application, a bundled OCR engine (the exact customer-hosted profile contract is supported), or autonomous redline acceptance |

The deferred categories may be possible future implementations, but they carry customer-specific regulatory, records, supervision, data, and authority requirements that this general-purpose starter profile does not establish.

## Agreement catalogue and record conventions

Use the existing Notice types rather than creating a taxonomy project before the pilot:

| Notice agreement type | Typical pilot use | Starting risk treatment |
| --- | --- | --- |
| `Mutual NDA` | Evaluation, partnership, product, or vendor discussions | Standard unless unusual data, publicity, residuals, exclusivity, or regulated-information access is involved |
| `Software Subscription Agreement` | Portfolio/reporting, CRM, planning, research, security, HR, or operations software | High when the provider receives client/personal data, integrates with core systems, or supports a critical process |
| `Professional Services Agreement` | Consulting, implementation, security, marketing, recruiting, or operational support | High when personnel receive privileged access, produce regulated communications, or handle sensitive data |
| `Supplier Services Agreement` | Outsourced operational or facilities service | High when interruption affects client service, books/records, security, or a critical business function |
| `Data Processing Addendum` | Privacy/security terms linked to an in-scope vendor contract | Follow the parent agreement's highest risk and add the structured `dpa_for` relationship plus the review rationale |
| `Order Form` or statement-of-work label | Commercial scope under an approved master agreement | Follow the master agreement's risk; add the structured `order_under` relationship and confirm precedence during review |

Before intake, create the firm's active legal entity, known counterparties, manual approval groups, typed custom-field definitions, published template/workflow/intake versions, and USD lane-authority records in **Setup & access**. At intake, use **Contract details** for the structured counterparty and our-entity references, agreement type/direction, department, USD amount where known, owner, effective/expiration dates, selected workflow, risk, and optional CRM reference. Add party roles and related-contract links in **Parties & related contracts** rather than relying on free-text references. Then add one attributable **History & comments** entry headed `INTAKE CONTEXT` containing the plain-language purpose, governing law if known, precedence context, and facts behind the selected risk. That comment is part of the hash-linked audit trail; it supplements, rather than replaces, structured records. On Contracts, members with agreement-read access can save the current bounded search/filter/sort as a private or shared view; its creator owns it, applying it reloads the live register from page one, and removing the view never deletes a contract.

For this starter profile, treat an agreement as `High` risk for routing when it involves client or employee data, production-system access, a material outsourced service, security monitoring, AI use on firm data, cross-border processing, or meaningful business-continuity dependency. The customer must review and approve that list; Notice does not infer it from the document.

## People and roles

Start with the smallest supportable team and named backups.

| Workspace role | Suggested pilot assignment | Operating constraint |
| --- | --- | --- |
| `admin` | Two people: the platform/service owner and a legal-operations recovery owner | Use for setup, access, holds, diagnostics, and export; do not use a shared account |
| `legal` | At least two contracting counsel or specifically authorized legal/compliance operators | This broad role manages documents, counterparty rounds, approvals, obligations, and language; membership must match actual authority |
| `requester` | Procurement, operations, technology, finance, and business owners who initiate work | Can intake/upload and request approval, but cannot manage or promote working-paper versions |
| `approver` | Named Finance or other reviewers who also receive an exact direct/group lane-authority record | The role supplies technical permission only; the server separately checks lane, USD scope, and optional minor-unit ceiling |
| `viewer` | Read-only information-security, compliance oversight, risk, internal audit, or executive stakeholders | Read access still exposes agreement data; apply least privilege and review membership |

The capitalized `Legal` and `Finance` approval lanes are workflow labels, not lowercase identity roles. Create active direct-user or group authority for each approved lane in USD, with an explicit minor-unit ceiling where appropriate. Claim, assignment, and decision recheck those records at commit. A lane with no authority record at all uses the compatibility mapping—`admin`/`legal` for `Legal`, `admin`/`approver` for `Finance`, and `admin` for another lane—but creating or revoking any record disables fallback for that lane. This profile recommends explicit records so the matrix fails closed. Workspace groups are managed manually; the product does not provide SCIM or automatic IdP-group synchronization.

DocuSeal signer roles are also separate from Notice workspace roles. The firm must approve the signature template's exact ordered roles and decide who may be entered for each transaction under its delegated-authority policy.

## Starter approval shape

Use the compatibility rule below for the pilot unless the firm's legal owner publishes and selects a governed workflow. A governed workflow snapshots its exact definition digest and evaluated lanes onto the agreement; it may use bounded conditions over direction, type, department, risk/disposition, exact currency, and minimum/maximum minor-unit amount.

| Condition | Server-required lane |
| --- | --- |
| Every agreement routed for approval | `Legal` |
| Risk is `High`, assessment was waived, USD value is greater than 100,000, or any material non-USD value is recorded | `Finance` in addition to `Legal` |

Apply these operating rules around that technical gate:

1. The requester supplies the business purpose, commercial owner, value, risk inputs, and intended counterparty; a different authorized person decides each approval request.
2. Legal confirms the exact immutable working version and material metadata before routing.
3. Information Security, Privacy, Compliance, or Vendor Risk review is a documented prerequisite when the firm's policy calls for it. Publish those lanes in a governed workflow when Notice should enforce them; otherwise retain their evidence in the approved customer process rather than claiming that a tag is an approval.
4. Finance review is required by the compatibility gate for High-risk work, a recorded waiver, a USD value above 100,000, or any material non-USD value because Notice has no FX source. The firm must create and review the direct/group USD authority records for the chosen deciders.
5. Any promoted counterparty revision creates a new immutable working version, supersedes current approval requests, returns approval to `Required`, and clears signature readiness. Route the new paper again.
6. Signature begins only when the current working version, SHA-256, material agreement basis, required lanes, signer identities, and delegated authority are all current.

## Word and counterparty-email review procedure

Use the portal as the MVP return channel. Begin with inbound email capture disabled unless the firm already operates a dedicated mail domain and conforming signed gateway.

1. **Freeze the paper.** Legal saves the complete proposed text as an immutable working version and confirms structured parties, agreement type, risk, USD amount, selected workflow, and owner.
2. **Prepare one round.** Legal creates the negotiation round for the exact current paper and verifies the displayed filename and full SHA-256. Only one round may be active.
3. **Confirm the recipient out of band.** Verify the counterparty name and mailbox using the firm's approved contact process. Portal possession is not identity proof.
4. **Issue a 72-hour portal link.** The profile recommends `NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS=72`; the firm may approve another whole-hour value from 1 through 336. Treat the URL as a secret. Do not copy it to CRM notes, ordinary tickets, chat, analytics, or document text.
5. **Send through the approved mailbox.** In the minimum profile, a legal operator sends the link from the firm's approved contracting mailbox and records the bounded provider/message reference in Notice. That reference records the action but does not prove delivery. If automated exchange is enabled later, use the signed outbound gateway and durable outbox; the exact reply alias is added only if the optional inbound gateway is separately attested.
6. **Prefer portal return.** Ask the counterparty to download the exact outbound file and upload exactly one revised file through the same portal. Rotation invalidates the prior URL; close abandons the round. Never resend a terminal outbox record whose URL has been scrubbed.
7. **Quarantine before review.** Notice content-inspects, hashes, and scans the return. Do not open a quarantined, malicious, invalid, or missing object. A sender/authentication mismatch on inbound email requires explicit sender review even when the file is clean.
8. **Review the exact file in an approved environment.** Download by the protected Notice route to a managed workstation or isolated review environment. In Microsoft Word, review tracked changes, comments, headers/footers, schedules, fields, hidden text/content, document properties where policy requires it, and the complete clean rendering. Do not rely only on the change summary.
9. **Create the reviewed text.** For exactly one returned attachment, Legal supplies the complete reviewed plain text or Markdown that should become the next working paper and records a specific decision note. Do not combine attachments or paste text from another source.
10. **Use peer review for elevated cases.** Before promotion, require a second authorized review under the firm's procedure for High risk, client/personal data, critical vendors, or material nonstandard liability/privacy/security positions. Notice's starter permission model does not enforce this second-person step; retain the evidence and owner in the implementation record.
11. **Promote deliberately.** Promotion binds the reviewed text to the immutable returned source/hash, resolves the round, revokes the portal link, creates the next working version, and forces reapproval. Reject or close when the source should not become paper.
12. **Repeat with a new round.** Further counterparty changes start from the newly approved current working version. On suspected link leakage or wrong delivery, follow [Counterparty exchange incidents](./OPERATIONS.md#counterparty-exchange-incidents), not an improvised resend.

If inbound email capture is later enabled, operate a dedicated lowercase domain and generated `reply-<24-lowercase-hex>@<domain>` aliases only. The gateway must HMAC the digest of the exact unmodified raw multipart body, use a fresh timestamp, derive sender/alignment/recipient/IDs/attachments from its authenticated provider event, and preserve identifiers across exact retries. A clean aligned expected-sender attachment may become `ready`; it still never promotes automatically.

## Minimum deployment choices

| Area | Starter choice | Why |
| --- | --- | --- |
| Tenancy | One wealth-management legal entity/workspace per production deployment | Keeps customer and authority boundaries explicit |
| Hosting | Cloudflare Workers Paid, one private D1 database, one private R2 bucket, isolated staging and production | Matches the supported deployment and scheduled-work assumptions |
| Identity | Cloudflare Access application JWT with the firm's IdP, MFA/conditional access, two admins; no trusted-header compatibility mode for the pilot | Minimizes identity-edge implementation risk |
| Enterprise governance | One active legal entity; structured counterparties/relationships; manual groups; approved custom fields; published versioned templates, intake forms, workflows, and playbooks; explicit USD lane authority | Makes paper, intake, routing, and delegation reviewable without inventing customer policy |
| Origin | One canonical custom HTTPS hostname; `workers.dev`, previews, alternate hosts, and direct origin disabled | Prevents bypass and portal-origin ambiguity |
| Portal | Enabled with a 72-hour TTL; only exact `/api/exchange/*` receives the scoped non-human policy | Provides secure external return without a counterparty account |
| Outbound delivery | Required signed `delivery-gateway`, attested for the product's notification/outbox stream; use a manual contracting-mailbox send for the baseline negotiation journey | Satisfies production readiness while keeping automated counterparty delivery out of the first workflow test |
| Inbound email | Disabled for the first pilot; use the portal plus approved manual outbound mailbox | Avoids making a mail-ingress integration a prerequisite |
| Scanner | Required production HMAC gateway with outage quarantine; no scan bypass | Returned Word/PDF files are untrusted input |
| Complex documents | Human Word review in an approved managed/isolated environment; bounded in-Worker structural PDF/DOCX parsing only, with rendering, text extraction, and interpretation isolated | Preserves the current content-processing boundary |
| Repository intelligence | Search may be used after an approved provider registers fragments pinned to an immutable document version/hash and caller-supplied source-text digest; reviewers must compare citations with protected working paper, and proposals remain blocked from mutation | Supports cited review without claiming source-provenance proof, a bundled OCR engine, automatic legal judgment, or migration execution; optional link-time OCR stays a separate signed customer-hosted boundary |
| Signature | DocuSeal 3.2.1 with `/submissions/html` entitlement, one non-public/non-archived approved template, a required signing field per exact ordered role, merged artifact, 1–720-hour expiration, email 2FA, provider email delivery, HMAC-tab `whsec_...` secret, and webhook reconciliation | Completes the MVP without exposing signer bearer URLs |
| CRM | Explicitly disabled until the workflow is accepted | CRM mapping is not needed to prove the contracting outcome |
| Jobs | Native obligation/outbox delivery and retention Cron Triggers with schedule/reminder/queue/quarantine/webhook alerts | Materialization, delivery, and cleanup are durable asynchronous work |
| Records | Customer-approved retention/hold schedule; dry-run before automation; no real-data purge until backup/restore and downstream deletion are proven | The repository cannot choose regulatory or legal retention |
| Evidence | Revision-bound CI, readiness, live provider diagnostics, synthetic acceptance, backup/restore, and signed export retained by the firm | A green UI is not production acceptance |

Recommended initial exchange configuration:

```text
NOTICE_COUNTERPARTY_PORTAL_ENABLED=true
NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS=72
NOTICE_MAIL_ENABLED=true
NOTICE_MAIL_PROVIDER=delivery-gateway
NOTICE_MAIL_CONFIGURED=true
NOTICE_NEGOTIATION_MAIL_ACCEPTED=false
NOTICE_EMAIL_CAPTURE_ENABLED=false
NOTICE_EMAIL_CAPTURE_PROVIDER=none
NOTICE_EMAIL_CAPTURE_CONFIGURED=false
NOTICE_CRM_ENABLED=false
NOTICE_CRM_PROVIDER=none
NOTICE_CRM_CONFIGURED=false
```

Those are go-live values, not permission to self-attest. Keep `NOTICE_MAIL_CONFIGURED=false` during installation, provision `NOTICE_DELIVERY_GATEWAY_URL` plus the independent managed `NOTICE_DELIVERY_GATEWAY_SECRET`, pass the signed gateway conformance and harmless notification round trip, retain the evidence, and only then set it to `true`. Keep the separate `NOTICE_NEGOTIATION_MAIL_ACCEPTED=false` for the baseline journey, which sends its portal URL manually. Only after the negotiation-specific acceptance proves exact secure-link rendering, explicit recipient handling, no invented attachment, and correct optional Reply-To behavior may the operator set that flag to `true`, rerender, and use automated counterparty delivery.

When the firm deliberately adds inbound email, change only after the dedicated domain, gateway, secret, exact edge route, conformance suite, incident procedure, and owner are ready:

```text
NOTICE_EMAIL_CAPTURE_ENABLED=true
NOTICE_EMAIL_CAPTURE_PROVIDER=inbound-gateway
NOTICE_INBOUND_EMAIL_DOMAIN=redlines.<customer-domain>
NOTICE_EMAIL_CAPTURE_CONFIGURED=false
```

Provision `NOTICE_INBOUND_EMAIL_SECRET` as an independent managed secret of 32–4096 UTF-8 bytes. Keep `NOTICE_EMAIL_CAPTURE_CONFIGURED=false` until the live gateway passes the raw-body golden vector, freshness, alias/domain, sender/authentication, replay/collision, attachment, quarantine, and human-promotion tests. Then attest true, rerender the deployment, and repeat the end-to-end test.

## Synthetic acceptance journey

Do not admit real contracts until the exact deployed revision passes this synthetic journey:

1. A requester submits a published synthetic intake form pinned to the approved template/workflow, then a reviewer atomically converts it into one USD software subscription valued above USD 100,000 (more than 10,000,000 minor units); Notice stores it as `Unassessed` with that reviewer as initial owner and no structured firm/counterparty references, and an exact retry returns the same contract. In **Contract details**, reassign the intended business owner and add the structured firm/counterparty references. Then open **History & comments** and append the separate exact `INTAKE CONTEXT` comment before risk assessment or approval routing.
2. Legal uploads or creates the working paper, confirms its full hash, prepares a round, sends the 72-hour portal link manually from the approved synthetic contracting mailbox, and records the bounded provider/message reference without treating it as delivery proof.
3. The counterparty downloads the exact file and returns a harmless synthetic DOCX. Notice records the immutable return and clean scan.
4. Legal reviews the complete Word document, supplies reviewed text for that exact source, records a decision note, and promotes it.
5. Legal or Admin assesses the exact promoted paper as High with a rationale and confirmation against its version, SHA-256, and basis; Notice proves the old link is revoked, the prior approval state is superseded, and both `Legal` and `Finance` lanes are required.
6. Two distinct authorized people other than the requester decide the required Legal and Finance lanes under exact active USD direct/group authority. Wrong-role, wrong-lane, over-limit, revoked, self-decision, reused-decider, stale-version, and unauthorized-promotion attempts fail.
7. DocuSeal 3.2.1 receives the exact approved working paper and ordered synthetic signer addresses under the validated template profile; forged/stale/replayed callbacks and contradictory signer evidence fail, while exact completion stores one scanned merged artifact and stops at human review. Legal/Admin confirms the exact retained artifact and approved basis before Notice makes the agreement Active.
8. The owner records a recurring synthetic renewal or notice schedule, proves unique occurrence materialization and a deduplicated reminder, then completes an occurrence with immutable evidence. Audit and workspace exports verify, and backup/restore reproduces the record, hashes, receipts, schedule, occurrences, and evidence.
9. Baseline negative exchange tests prove expiry, rotation, close, old-link revocation, exact public-route scope, wrong origin, portal URL leakage controls, malicious/quarantined attachment handling, and protected-download boundaries.

### Optional automated-email acceptance

Do not make these tests part of the baseline manual-portal acceptance. Run them only if the firm deliberately enables Notice's automated outbound delivery and/or inbound-email capture:

1. Keep `NOTICE_NEGOTIATION_MAIL_ACCEPTED=false` on the production target and send signed synthetic `negotiation.round_requested` fixtures directly to the already required outbound gateway; prove negotiation-specific acceptance, retry, dead-letter, provider-outage, recipient-mismatch, exact secure-link rendering, no-invented-attachment, and portal-only behavior without customer data.
2. After that gateway-only acceptance passes, set the flag true only in an isolated synthetic staging deployment. Use a Notice round to prove that pending/processing automated delivery fences portal rotation, close, and promotion; terminal accepted/dead state reconciles the active task; and terminalization removes the plaintext portal URL from the durable event while retaining its SHA-256 evidence value.
3. If inbound capture is enabled, prove wrong secret, stale timestamp, changed raw body, wrong domain/alias, sender/alignment review, event/message replay and collision, no-attachment, multi-attachment, malicious/quarantine, and inactive-round behavior.
4. Repeat the complete human Word-review and promotion journey through the enabled channel. Gateway acceptance remains durable handoff evidence, not proof that a human received or accepted the contract.

After both phases of evidence are retained and approved, use same-source configuration promotion to set `NOTICE_NEGOTIATION_MAIL_ACCEPTED=true` on the production target, confirm readiness reports the accepted path, and repeat one harmless synthetic end-to-end delivery before admitting real counterparty data.

## Customer decisions required before real data

The implementation owner must attach approved evidence for:

- in-scope agreement types and expressly deferred client/regulatory documents;
- customer-approved legal entities/counterparties, structured relationships, custom fields, template/workflow/intake/playbook versions, fallback positions, risk criteria, and the use or replacement of the 100,000 USD threshold;
- named administrators, legal operators, requesters, viewers, decision makers, manual groups, exact lane/currency/minor-unit ceilings, signer authority, delegates, and joiner/mover/leaver process;
- whether any lane may use the narrow no-authority-record compatibility fallback or must have explicit direct/group authority;
- counterparty contact verification, portal lifetime, approved mailbox, inbound-email decision, and Word/peer-review procedure;
- identity, scanner, DocuSeal, optional customer-hosted OCR profile/runtime and repository extractor, mail, storage, region, subprocessor, monitoring, incident, backup/restore, and support ownership;
- retention, legal hold, deletion, export, offboarding, and independent evidence policy; and
- security, privacy, legal, compliance, vendor-risk, accessibility, penetration-test, residual-risk, and executive go-live approval.

If those decisions are unavailable, keep the environment synthetic. The remaining work is customer implementation and authority—not permission to infer a wealth-management policy from this repository.

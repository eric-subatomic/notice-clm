# Notice — agreement operations

Updated: 20 August 2026

## Product thesis

Notice is a general-purpose contract lifecycle management workspace for legal and business teams. It keeps sell-side, buy-side, and corporate agreements in one calm operating system: request or import, draft, review, negotiate, approve, sign, and manage the living record.

The product competes with broad CLM platforms such as Ironclad on the essential lifecycle while differentiating through fast time-to-value, visible work queues, document-centered collaboration, and a restrained interface that does not require every user to understand workflow configuration.

## Ideal first customer

- a growing or enterprise business with 100–5,000 employees;
- a lean legal or legal-operations team serving sales, procurement, people, security, finance, and corporate teams;
- contracts moving among email, Word, e-sign tools, CRM attachments, ticketing systems, and shared drives;
- repeatable paper such as NDAs, MSAs, order forms, DPAs, software subscriptions, services agreements, employment agreements, leases, and partnership agreements;
- avoidable delays caused by intake gaps, approval chasing, version confusion, and missed post-signature work.

The economic buyer is the general counsel, COO, or head of legal operations. Daily owners include legal operations, commercial counsel, procurement, revenue operations, and contract managers. Business approvers and counterparties participate only when a task needs them.

## Core job

> When the business needs an agreement, create or ingest the right paper, apply approved language, review material variance, record attributable decisions and signatures, and operate every obligation from one accountable record.

## Product model

Every agreement uses one stable record, one owner, and six explicit stages:

1. Intake
2. Draft
3. Review
4. Negotiation
5. Signature
6. Active

Three lanes cover the common business directions without creating separate products:

- Sell-side: NDAs, master service agreements, order forms, data processing addenda, and statements of work.
- Buy-side: software subscriptions, professional services, security paper, data licenses, and facilities agreements.
- Corporate: employment, recruiting, partnership, financing, entity, lease, and policy agreements.

## Current product workflows

### 1. Operate the day

- A Today view shows agreements by lifecycle stage, high-risk variance, approvals, signature packets, and obligations due.
- Each queue is actionable rather than a decorative dashboard: users can open the source agreement, decide an approval, send for signature, or complete an obligation.
- Global search and a keyboard command menu make the product usable without hunting through navigation.

### 2. Create or import

- Start from a published, immutable governed-template version, submit a published structured intake form, or import PDF, DOCX, RTF, or text.
- Convert a submitted intake to its agreement, initial metadata snapshot, audit event, and outbox event atomically after a human re-confirms the exact form version, template-version pin, workflow pin, owner, counterparty/entity references, money, and reason. Exact retries return the one committed agreement instead of duplicating it.
- Capture CRM reference fields and synchronize approved events through the independent included CRM gateway, with administrator projection/tombstone resync for first enablement and controlled cutovers plus an explicitly confirmed evidence path for externally reconciled pre-profile legacy events.
- Review deterministic metadata suggestions and risk flags, then confirm or correct the record before it enters the managed lifecycle.
- Keep production PDF/DOCX extraction outside the application Worker: use an approved isolated extraction/OCR service or human-created reviewed working text.

### 3. Review and negotiate

- Work in a document-centered agreement room with immutable saved versions and an editable text/Markdown working copy.
- Consult and insert customer-approved Standard, Fallback, and Strict language blocks without leaving the draft; administrators can also govern scoped, immutable clause-playbook versions for evidence and future extraction providers.
- Prepare one hash-bound counterparty round from the exact current paper, issue a rotatable expiring portal link, and record manual delivery or use separately accepted signed outbound/inbound gateways.
- Inspect, hash, and scan every returned file; quarantine unavailable or inconclusive results and reject invalid or malicious content instead of treating either as reviewable paper.
- Bind complete human-reviewed text and a decision note to one exact returned attachment, then explicitly promote, reject, or close the round. Promotion revokes the portal link and forces the new paper through approval again.
- Record attributable comments, round decisions, source hashes, and promotion evidence in the hash-linked activity trail.
- Search provider-neutral extractor-registered fragments pinned to an immutable working-document ID/version/hash plus a caller-supplied source-text digest, offsets, and content hashes. Notice verifies citation consistency inside the registered fragments but does not derive them from canonical working-paper bytes, so reviewers must compare every citation with the protected working paper. Extraction providers can submit confidence-bearing proposals for human acceptance or rejection, but acceptance remains explicitly blocked from changing agreement/custom-field data until a separately governed executor exists.
- Explore structured clause cards and Accept/Reject interactions only on synthetic evaluation records. Production does not parse Word Track Changes, derive clause-level decisions, or make an automated playbook or legal verdict.

### 4. Approve and sign

- Route decisions through an exact published workflow snapshot whose deterministic conditions can use side, agreement type, department, risk/disposition, currency, and minor-unit amount.
- Authorize each lane through active direct-user or group authority in the exact agreement currency and optional amount ceiling. A narrow legacy role default applies only while that lane has no authority record at all; creating or revoking any record for the lane turns off fallback.
- Approvers can approve or request changes directly from their queue.
- Track governed DocuSeal 3.2.1 packet state while production signers use provider email delivery. Evaluation uses an entirely local signing simulation and neither embeds nor contacts DocuSeal.
- Create a packet only when the exact-paper risk and approval gates pass; provider completion retains scanned evidence, and a separate exact Legal/Admin artifact review is required before activation.

### 5. Manage the active record

- Keep core terms, owners, tags, dates, obligations, source documents, and audit events together.
- Attach the agreement to workspace legal entities and counterparties, typed custom fields, structured party roles, and directional relationships such as master, order-under, DPA-for, amendment, renewal, and supersession.
- Store monetary values as canonical non-negative minor units with an ISO-4217-shaped currency code. Portfolio reports group values by currency and never imply an FX conversion or cross-currency total.
- Track recurring and one-time obligation schedules as owned, uniquely numbered occurrences with local-calendar reminders and immutable completion evidence.
- Preserve a searchable activity trail for stage changes, approvals, edits, imports, and completions.
- Surface renewal and expiry risk before it becomes an emergency.
- Use saved views, cursor-paged approvals/signatures/obligations/schedules/events, and a workspace-scoped portfolio report for stage, risk, renewal, work, and per-currency value context.

## Interaction principles

1. Show the next decision before configuration.
2. Keep agreement context visible through every action.
3. Use progressive disclosure: overview first, detail on demand.
4. Make status, ownership, and risk legible without color alone.
5. Let business users finish routine work without becoming CLM administrators.
6. Keep navigation, filters, focus order, dialogs, and keyboard shortcuts consistent across the lifecycle.
7. Surface material variance, not a wall of generated prose.

## Persistence and integration design

- D1 stores agreements, legal entities, counterparties, groups, typed custom fields, structured parties/relationships, versioned templates/workflows/intake/playbooks, document metadata and repository fragments/citations, negotiation rounds/submissions, approved language, risk and approval evidence, service principals and governed plans, obligation schedules/occurrences/evidence, receipts, and audit events.
- R2 stores quarantined uploads, immutable outbound and returned negotiation files, reviewed text, working versions, source documents, and signed artifacts.
- Indexed lifecycle, lane, owner, status, and due-date fields support queue and reporting reads.
- Notice emits versioned canonical events to independently durable, HMAC-signed mail and CRM sinks. The repository includes a separately deployed CRM gateway with durable receipts, HubSpot private-app and Salesforce client-credentials/external-ID adapters, plus a signed custom-webhook adapter. Customers still supply approved accounts, credentials, objects/fields, mapping values, and provider-side reconciliation authority.
- Evaluation signing is an entirely local simulation that neither embeds nor contacts DocuSeal. Production uses a customer-owned DocuSeal Cloud or self-hosted endpoint, exact ordered template roles, unique signer emails, provider email delivery with no signer-link exposure in Notice, verified callbacks, scanned final evidence, and a separate exact human activation review.

## Current product acceptance criteria

The product proves the use case if a legal-operations lead can:

- understand what is blocking contracting within ten seconds;
- generate a sell-side, buy-side, or corporate agreement from approved paper and business data;
- submit and atomically convert a version-pinned governed intake without duplicate agreement creation;
- import a source file, review extracted terms and risk flags, and create a managed record;
- review versioned working text, consult or insert approved language, and retain attributable negotiation decisions without leaving the agreement room;
- exchange one exact version through a governed counterparty round, review a clean returned Word file, promote only complete reviewed text bound to that source, and prove the resulting version requires fresh approval;
- create and reuse approved language;
- decide approvals and track signature work from dedicated queues;
- create and complete an owned obligation with an auditable event;
- filter and search the agreement portfolio, page through bounded live work queues, and read portfolio totals without combining currencies;
- trace repository search or an extraction proposal to version/hash-pinned registered citations, require human verification against the working paper, and prove that review alone does not mutate the agreement;
- use the workflow on desktop and mobile with clear focus and readable text;
- reload the deployed product and retain saved agreement operations data.

## Pilot measures

- median request-to-first-draft time under five minutes;
- median uploaded-document-to-confirmed-record time under two minutes;
- 90%+ accuracy on the targeted extraction set after human confirmation;
- 50% reduction in email and version handoffs per agreement;
- 80% of standard agreements reach signature without legal rewriting;
- 95% of signed commercial agreements link back to their CRM record;
- zero active agreements without an owner, signed record, and confirmed core terms;
- 95% of tracked obligations completed or escalated by their due date.

## Known extensions

The repository now includes signed Cloudflare Access application-JWT validation, an explicit trusted-header compatibility mode, workspace roles and manual groups, governed service principals and agent plans, versioned templates/workflows/intake and playbooks, direct/group lane authority, repository fragments and cited extraction proposals, structured parties/relationships, saved views, paged work queues, portfolio reporting, signed audit export, verified signature webhooks, secure counterparty rounds, recurring obligation schedules, gateway-backed notification delivery, and deployment-selected OCR through a signed customer-hosted scanner gateway. Remaining extensions include immutable content/version snapshots and deterministic rendering before governed templates may compose approved-language blocks, broader extraction and content-disarm/reconstruction adapters beyond the shipped OCR gateway, a governed proposal-application executor, automated clause-level playbook or legal verdicts, an IdP-specific OIDC/SAML login flow beyond Cloudflare Access and actual SCIM/group synchronization, higher-fidelity Word round trips, interactive provider OAuth installation and token vaulting, a business-friendly no-code designer beyond the governed JSON contracts, bulk migration execution beyond bounded ingestion inventory, additional large-estate analytics and cursor coverage, an operator replay console, and independently retained/WORM evidence.

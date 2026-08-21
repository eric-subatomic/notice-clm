# Operations

This runbook describes the application signals and recovery actions the repository supports. The operator must connect them to its own observability, paging, backup, incident, and change-management systems before real-data use.

## Service inventory

| Component | State | Primary operational risk |
| --- | --- | --- |
| Cloudflare/vinext Worker | Application and API execution | identity boundary, availability, release regression |
| D1 `DB` | Identity, domain records, audit, outbox, webhook, retention | corruption, migration failure, inconsistency, capacity |
| R2 `DOCUMENTS` | Original, quarantine, signed, and version bytes | missing/orphaned object, unauthorized access, deletion |
| Cloudflare Access or reviewed compatibility edge | Signed application JWT (recommended) or sanitized verified identity headers | spoofing, wrong audience, direct-origin/alternate-host bypass, session/revocation failure |
| Counterparty portal and optional inbound-email gateway | Scoped bearer download/return with durable per-round transfer budgets and signed per-round mail capture | URL leakage, overbroad public route, stale delivery, transfer-budget pressure, spoof/replay/collision, returned-file exposure |
| Scan gateway | Malware verdict before extraction/use | unavailable scanner, false verdict, data leakage |
| DocuSeal | Signature submission and authoritative status | forged/delayed callback, provider drift, missing evidence |
| Delivery gateway | Mail-provider boundary | retry/dead letter, duplicate action, recipient-policy failure |
| CRM gateway + D1 `CRM_DB` | Durable CRM receipts and HubSpot, Salesforce, or custom provider boundary | retry/dead letter, mapping drift, stale write, replay, payload retention |
| Native Cron Triggers; optional external scheduler | Obligation materialization/reminders and outbox delivery on the delivery trigger, plus retention and CRM recovery invocation | missed/incorrect trigger, leaked external bearer, overlapping backlog |
| Backup/evidence systems | Recovery and independent audit copies | unrecoverable or inconsistent recovery point |

Record owner, escalation, service/account identifier, status page, contract/SLA, data region, secret rotation, and support path for every production instance.

## Probes and readiness

| Check | Meaning | Does not prove |
| --- | --- | --- |
| `GET|HEAD /api/health` | Worker can answer a dependency-free liveness request | D1/R2, identity, providers, or business correctness |
| `GET|HEAD /api/health?mode=ready` | Exact schema marker 21 is present and D1 query/R2 `head` complete within 1.5 seconds | migration provenance/content, backups, identity, providers, workflow acceptance, or record integrity |
| `GET /api/readiness` | Protected production code/configuration gates and current configuration-bound live diagnostics pass | full provider mutation/reconciliation, end-to-end workflow, certification |
| `GET /api/admin/integrations` | Redacted configuration prerequisites and retained live-test evidence for the exact current profile | future availability or full business mapping |
| `POST /api/admin/integrations` | Safe live read/scan/dry-run succeeds now | future availability or full business mapping |

Probe responses intentionally omit resource names, endpoints, secrets, object keys, and detailed provider errors. Alert using status, latency, request ID, and separately protected platform telemetry.

Recommended alert classes:

- Worker error/latency and deployment rollback threshold;
- repeated D1/R2 readiness failure;
- authentication/authorization anomalies and direct-origin attempts;
- exchange-route traffic outside expected rounds, abnormal invalid/expired-token volume, sustained busy or exhausted portal `429` responses, abnormal new-round creation, or any exchange-related edge policy broader than exact `/api/exchange/*` and optional exact `POST /api/webhooks/email`;
- oldest pending `negotiation.round_requested` age, a terminal negotiation event whose portal URL was not scrubbed, repeated `negotiation_delivery_superseded`, and provider acceptance/delivery ambiguity;
- inbound-email signature/freshness failures, event/body/provider-message collisions, stale processing receipts, wrong-domain/alias requests, and new messages to inactive rounds;
- quarantined document age, scanner outage, and malicious verdict;
- returned-file `sender_review` backlog, unexpected promotion volume, and a promoted version that does not promptly enter the required reapproval process;
- failed or repeated governed publication, stale intake pins, competing conversion attempts, unexpected lane-authority denials, revoked-authority use attempts, or group-membership drift;
- repository fragment/citation integrity failure, proposal-review backlog, any accepted proposal whose application state is not still blocked, ingestion replay/collision, or source-hash/link mismatch;
- work-item cursor errors, paged queue age, portfolio-report failure, or any attempted cross-currency aggregation/FX assumption;
- invalid/failed DocuSeal webhook, incomplete/stale signer reconciliation, `completed_superseded` outcome, suspected signing-capability exposure, or signed-evidence lag;
- outbox oldest-pending age, retry growth, dead state, and gateway rejection;
- retention job failure, blocked/ineligible backlog, or R2 deletion failure;
- audit integrity/export failure;
- backup failure, restore-test failure, capacity, and secret expiry.

The in-process rate limiter is only defense in depth. The portal separately enforces durable limits on each exchange round across token rotations, but neither control aggregates abuse across rounds, verified users, or IPs. Monitor and enforce those distributed limits at the edge as appropriate.

## Logging and data handling

Every API response includes `X-Request-Id`. Propagate it into edge, Worker, gateway, scheduler, and provider correlation where possible.

Log metadata needed to operate the service, not agreement content. Do not log:

- identity headers beyond approved pseudonymous identifiers;
- document text/bytes, extracted clauses, comments, signer payloads, or export bodies;
- tokens, HMAC keys/signatures, job bearer, webhook body, or full provider responses;
- counterparty portal URLs/tokens, generated reply aliases except in a separately protected need-to-know delivery record, raw inbound-email bodies, or returned-file names where they contain personal data;
- R2 object keys, signed URLs, database statements containing customer data, or raw exception stacks in customer-visible systems.

Define protected fields, redaction tests, retention, access review, legal hold, export, and deletion for logs/traces/metrics. Request IDs are support correlators, not authentication or evidence by themselves.

The optional self-hosted DocuSeal MCP diagnostic is intentionally non-mutating. A valid check performs `initialize`, requires the tagged server's exact HTTP 202 acknowledgement of `notifications/initialized`, validates `tools/list` and its five pinned annotations, then invokes only read-only `load_template` and requires the ID and ordered roles to match the REST-selected template. Any other response, version, tool shape, template mismatch, or mutation/open-world tool call is a failed diagnostic and should be investigated; do not supply agent credentials to make it pass.

## Counterparty portal transfer budgets

Portal transfer controls are durable D1 state on the exchange round, not best-effort token or Worker-isolate counters. Replacing a portal token does not reset them. Each round admits:

- at most 10 upload attempts total, with no more than 4 accepted and no more than 6 rejected/failed;
- at most 96 MiB of cumulative multipart upload bytes;
- exactly one upload-work reservation at a time, charged as 21 MiB and leased for five minutes before body reading or scanning; and
- at most 20 download attempts and 256 MiB of cumulative outbound bytes.

A completed bounded upload read reconciles its byte charge to the actual multipart body. An aborted, oversized, or incomplete read keeps the full 21 MiB charge. An abandoned lease becomes recoverable after five minutes, but its attempt remains counted and is charged rejected/failed before replacement; the old owner cannot commit. A concurrent live lease returns `429 exchange_upload_busy` with `Retry-After: 5`. Upload or download exhaustion returns `429` with the applicable `*_limit_reached` code. Download attempt and exact outbound-size charges commit before the R2 read, so an object-read failure remains charged. Portal metadata exposes the fixed policy, not current counters or reservation state.

On repeated busy responses, inspect request timing and the age of the round's reservation without logging the token, then allow the current lease to finish or its five-minute recovery boundary to pass. On exhaustion, close or otherwise finish the affected round under ordinary policy, prepare a new round from the current immutable working paper, and send its new secure link. Do not rotate the token expecting more capacity, edit counters/reservations directly, or create an informal counter-reset procedure. Alert on sustained busy/exhausted responses and abnormal new-round volume; apply distributed edge controls for cross-round, verified-user, IP, and aggregate abuse.

## Scheduled job operations

All three main job routes require a bearer matching `NOTICE_JOB_RUNNER_SECRET`, which must contain at least 32 characters. Native scheduling invokes obligations and outbox independently from the delivery trigger, then retention from its separate trigger; an approved external scheduler may call the same routes. Put the bearer in an authorization header from the scheduler's secret store, never a URL, query, or logged command. Scanner, DocuSeal-webhook, delivery/CRM, and audit-signing HMAC secrets have the same 32-character minimum; the DocuSeal API token remains provider-defined.

### Obligations

`POST /api/jobs/obligations` processes bounded work for non-deleted executed agreements with active, fulfill-eligible owners. Each run:

- materializes up to 25 due schedule occurrences from the original local-calendar anchor with a unique schedule/occurrence number and compare-and-swap schedule cursor;
- advances up to 50 due reminder cursors, collapses missed windows into one catch-up, and queues at most one deterministic reminder for the applicable local date;
- rechecks the parent agreement, schedule, owner, membership, time zone, and prior cursor inside the guarded mutation; and
- returns `materialized`, `remindersQueued`, `reminderDuplicates`, and `conflicts` counters with HTTP `202`.

Repeated or concurrent runs converge: a duplicate occurrence/reminder or stale cursor cannot create a second durable result. Isolated conflicts may therefore be benign, but a growing conflict or overdue backlog is actionable. An ineligible or inactive owner leaves the schedule/reminder cursor in place for explicit repair rather than silently skipping the work. Verify the delivery trigger, owner eligibility, schedule state, local-calendar boundary, next cursors, and downstream outbox status. Reassign stranded work through the governed schedule action; never edit recurrence terms, occurrence identity, evidence, or cursors directly. Pausing or ending a schedule stops future materialization but does not cancel existing open occurrences.

### Outbox

`POST /api/jobs/outbox`:

- resets processing locks older than ten minutes;
- selects up to 25 available pending events;
- claims each record before delivery;
- initializes an immutable per-event sink set (`delivery`, plus `crm` for eligible topics when enabled);
- signs mail and CRM independently with different secrets and the CRM provider/mapping profile;
- preserves accepted sinks while retrying only the destination that failed;
- retries only network/timeouts, 408, 425, 429, and 5xx with bounded exponential delay; and
- dead-letters permanent redirects/other 4xx immediately or transient failures after eight attempts, processing the parent only after every persisted sink accepts.

Response counters are `processed`, `delivered`, `retried`, and `dead`. A successful HTTP response with `retried` or `dead` greater than zero is operationally actionable.

Outbox incident procedure:

1. identify affected workspace, topic, aggregate, event IDs, first failure, oldest pending age, and gateway response class without copying payload content;
2. confirm the current gateway endpoint/secret and its provider health;
3. determine whether the gateway durably accepted an event before a timeout—deduplicate before replay;
4. restore the gateway or rotate/redeploy credentials through change control;
5. reconcile downstream mail/CRM state against D1 events;
6. for a CRM repair, fully configure and test the exact destination profile, then use the administrator **CRM resync & backfill** control (or `POST /api/admin/integrations/resync`) with an explicit `projection` or `tombstone` action; projection is limited to active matching records, while tombstone requires a matching soft deletion or immutable proof of a fully profile-bound projection attempt not yet fenced by an accepted same-profile tombstone—pending/dead attempts remain material because delivery response loss is ambiguous; for a historical-profile cleanup, pause CRM mutations/scheduling, drain the outbox, reconcile the intended live gateway/provider state, restore the old profile, complete the explicit maintenance acknowledgement and typed confirmation, deliver its tombstone, then immediately restore/retest/reproject the intended live profile and reconcile `deleted=false` plus current fields before resuming; unresolved newer CRM mutation work must be reconciled first; a fenced profile cannot be reactivated here while another profile remains live, so an approved rollback uses a new immutable mapping-version profile and reviewed migration; for older evidence with missing destination metadata, reconcile every possible downstream copy externally before using the separately confirmed `legacy_cleanup_attestation`, preserve supporting exports/tickets, and repeat its 20-event batches while `hasMore=true`; other dead-letter replay still requires a reviewed procedure because the repository does not include a general replay console; and
7. retain evidence and correct alert/runbook gaps.

Do not directly mark an event processed merely to clear a queue.

For `negotiation.round_requested`, the pending event necessarily contains the scoped plaintext portal URL until delivery is accepted or terminally dead. Restrict D1, backup, queue, and gateway access accordingly. Before each gateway call, Notice verifies that the URL still uses the canonical origin and exact exchange path and that its token hash, expiry, active round, agreement, and immutable outbound SHA-256 are current. A stale event is made terminal and scrubbed instead of being delivered.

Rotation, close, and promotion are intentionally fenced while that event is `pending` or `processing`, with the same no-pending condition repeated at commit. If a delivery stalls, do not edit D1, clear a lock, rotate around the fence, or copy the URL into a new queue item. Reconcile whether the gateway or mail provider accepted the event. Restore normal delivery for an ordinary transient failure; for a security incident, use the containment procedure below so the gateway returns a truthful accepted or permanent-rejection outcome. After terminal state scrubs the URL, close the affected round, prepare a new round from the current immutable paper, and send it as a new event.

### Retention

Use `POST /api/jobs/retention?dryRun=true` during policy validation/change review. Dry run reports eligible IDs and safeguards without modifying storage. Production runs omit the parameter or set false.

Each run evaluates bounded batches and returns:

- `softDeleted` agreement/document IDs;
- `d1Purged` IDs whose guarded structured-record deletion committed;
- `hardPurged` IDs whose immediate object-storage cleanup also completed;
- `lifecyclePurged` rejected intake submissions and abandoned/terminal ingestion batches removed after the configured grace period;
- `purgeStorage` retry/completed/pending job IDs;
- `blocked` records with safe reasons;
- `failures` with resource type/ID and phase;
- grace/cutoff and policy safeguards; and
- HTTP `207` if any item failed.

Before enabling automatic purge:

1. approve the retention schedule, legal-hold authority, grace days, and downstream deletion scope;
2. verify time synchronization;
3. run and review dry-run output with synthetic/approved staging data;
4. test agreement hold, document hold, linked-document blocking, indefinite retention, and non-Active agreements;
5. prove D1/R2 backup and restore; and
6. prove an accepted same-profile deletion tombstone at an equal or later aggregate version for every fully profile-bound CRM projection attempt in any status, and retain an explicit payload-bound legacy-cleanup attestation only after externally reconciling each older unprofiled event, including CRM-disable and provider-change cases; and
7. configure alerts and escalation for every failure/blocked backlog.

Rejected, unconverted intake answers are removed after the configured purge grace period. Submitted requests remain visible work until Legal/Admin converts or rejects them. Abandoned upload-only and terminal ingestion batches use the same grace boundary; a legal hold on any linked document or agreement blocks that ledger cleanup. Agreement or standalone-document hard purge removes only the ingestion items tied to the purged resource so unrelated items in a mixed batch retain their provenance.

Hard purge refuses to erase a soft-deleted agreement until the exact current deletion epoch is `processed`, its delivery sink exists, and every persisted current sink is `accepted`. Separately, every fully profile-bound historical CRM projection attempt in any status must have an accepted same-profile tombstone at an equal or later aggregate version. An older non-`None` CRM event with no delivery row or incomplete destination profile remains blocking until an administrator completes external reconciliation and records the exact payload-bound legacy-cleanup attestation; the attestation does not call a provider or manufacture a receipt. A missing current CRM sink after enablement/provider change requires a fresh administrator tombstone resync; a pending/dead sink requires gateway reconciliation. Do not mark or delete receipt or attestation rows to bypass the gate. Once all current receipts and historical cleanup evidence are durable, the guarded D1 purge removes the tombstone, its delivery payload, and the agreement's legacy attestations together.

Every non-dry run retries existing workspace-scoped `storage_pending` jobs before evaluating new candidates. Alert on pending count, oldest `created_at`, attempts, and safe `last_error`; object keys remain server-side. An R2 failure after hard D1 purge must not be repaired by recreating the parent or manually marking the job complete. Restore storage access and rerun the authenticated retention job; R2 deletion is idempotent and the durable manifest remains the source of retry scope. Staged-write cleanup is cancelled if the exact object later becomes authoritative. Rejected-malware cleanup is deferred whenever the document or parent agreement is held; an OCR-rejected source retains a policy-only target agreement association so a target hold applied after `422` still finds and fences it. The worker claims the exact job in D1 before deletion, and hold activation is transactionally fenced until that attempt records success or failure. The rejected row remains deleted, unreadable, and ineligible as agreement paper. The claim does not expire. If execution is interrupted while its safe `last_error` says deletion is in progress, pause the scheduler, verify no worker can still be running, reconcile the exact R2 key and D1 policy, and escalate through the customer's reviewed recovery procedure; do not clear or replay the claim merely because it is old.

The `retention.d1_purged` outbox event is emitted in the guarded D1 batch with `storageStatus=storage_pending` and its `purgeJobId`. It proves structured deletion and durable retry scope, not R2 deletion. Use the retention-job result and corresponding `purge_jobs.status=completed` row as final primary-storage completion evidence; the repository emits no separate R2-completed outbox topic.

On unexpected eligibility or D1 purge failure, stop the scheduler, preserve evidence, set legal hold where authorized, and reconcile D1/R2 before resuming. Never delete object prefixes manually.

## Document and scanner incidents

- Structural format rejection: before scanning, Notice checks the complete supported byte/container boundary—controlled valid UTF-8 for text, bounded header/trailer/xref and referenced-object structure for PDF, balanced bounded RTF without embedded binary/object controls, or canonical bounded non-overlapping DOCX ZIP layout with verified expansion/checksums and bounded required-OOXML-part structure. A rejected file must be safely regenerated from a trusted source; do not rename it or bypass the check. PDF/DOCX structural acceptance is not proof of semantic validity or safe rendering, so rendering, extraction, and review remain isolated.
- Scanner unavailable: new files remain under the quarantine prefix with no extraction/link/download. Restore the gateway, confirm credentials, then use the rescan route. A rescan atomically owns the exact source/version through a five-minute claim before scanner I/O; another live attempt returns `409`. Wait for the owner to finish or the bounded stale-recovery window, reload, and retry normally—never clear the claim in D1. Alert on quarantine and claim age.
- Malicious verdict: a new upload is rejected before storage. A quarantined rescan atomically marks the record rejected and queues durable exact-object cleanup unless the document or parent is held. An exact correlated malicious verdict dominates a late/concurrent clean result; conflict reconciliation must preserve rejection, and a failure to record it leaves the source quarantined and unreadable for operator reconciliation. Held bytes remain inaccessible; unheld cleanup is retried with a fresh hold check and a D1 deletion claim. Follow the customer's malware/incident policy; do not download or reintroduce the content casually.
- Metadata exists but bytes are missing: download returns `410`. Preserve D1 state, inspect authorized R2 audit/version history, restore if valid, verify SHA-256, and record impact.
- Orphaned object: application cleanup is best effort after D1 failure. Reconcile tenant prefixes against D1 under a read-first, reviewed tool; never bulk-delete based only on age.
- Customer-hosted OCR problem: classify the outcome before acting. Gateway unavailability restores the prior clean state for immediate retry. A wrong/unknown response ID or malformed clean result leaves the source quarantined and unreadable; do not clear it manually—reconcile or rescan after the claim window. `customer_hosted_ocr_commit_failed` means Notice removed uncommitted staging and restored the prior clean state; reload the current agreement and retry. An unresolved final D1 outcome remains quarantined until exact source/version reconciliation. Treat an exact-correlated malicious verdict as malicious even when ancillary fields are malformed. Confirm the protected readiness view's exact deployment-selected model/profile, gateway HMAC/freshness, private inference health/capacity, pinned model/runtime digest, and output bounds. Do not switch to another model/provider or public endpoint as an incident workaround, and treat all extracted terms as untrusted until source review.

## Counterparty exchange incidents

The portal token is a scoped bearer credential: possession authorizes that round's download and upload until expiry or revocation. A portal upload records the typed sender but does not prove mailbox control. The inbound-email HMAC authenticates the configured gateway and exact raw request bytes; it does not make the attachment safe or replace human legal review.

### Suspected portal-link leakage or wrong recipient

1. Identify the workspace, agreement, round, outbox event, intended recipient, expiry, and current delivery state without copying the token or full URL into the incident record.
2. If no corresponding delivery is `pending` or `processing`, close the round immediately when the exchange should stop. If work may safely continue, rotation revokes the old token, but the replacement must be delivered through an approved path; do not assume a terminal/redacted event can be resent.
3. If delivery is still `pending` or `processing`, immediately deny the exchange path at the edge if risk warrants it, pause the outbox trigger, and ask the gateway/mail provider to suppress that exact event. Do not bypass Notice's revocation fence or alter queue state. Have the gateway return its truthful durable-acceptance or permanent-rejection result, run one controlled reconciliation attempt, and confirm the event becomes terminal and the stored URL is scrubbed.
4. Close the affected round, prepare a fresh round from the current immutable working paper, and send a new event only after the intended recipient and route are reverified. A terminally failed event is never the resend source.
5. Search protected mail/gateway/edge/observability systems for the leaked URL using an approved secret-safe process, remove or restrict copies under records policy, review access, and assess counterparty notification. Do not paste the URL into ordinary search, chat, ticket, or SIEM fields.
6. Verify the old route returns the expected revoked/expired behavior through an approved test, restore the edge and scheduler progressively, and retain the token hash, event/round IDs, timeline, disposition, and new-round evidence—not the plaintext token.

### Unexpected portal traffic or public-route exposure

- A structurally invalid/unknown token returns `404`; a known expired or revoked link returns `410`. Alert on unusual volume, but do not build telemetry that stores the path token or reveals which workspace/round exists.
- A live concurrent upload returns `429` with `Retry-After: 5`; a round that exhausts its upload or download budget returns `429` and must be replaced with a newly prepared round. Rotation does not restore capacity. Use the transfer-budget runbook above; do not reset durable counters during an incident.
- Temporarily deny exact `/api/exchange/*` if exploitation is suspected. Verify the canonical `NOTICE_PUBLIC_BASE_URL`, exact method/path bypass, direct-origin block, and `workers.dev`/preview/alternate-host denial before restoring access.
- Confirm that no blanket `/api/*` or `/api/webhooks/*` bypass exists and that human pages, agreement APIs, and document downloads still require verified corporate identity. The exchange exceptions are only exact `GET|POST /api/exchange/<token>` and, when enabled, exact `POST /api/webhooks/email`; keep the separately documented DocuSeal webhook, health-monitor, and optional external-job policies narrow and independent.
- Check for email security products that rewrite, visit, or detonate links. The portal GET is deliberately non-consuming, but an unrelated redirector or telemetry product can still leak the bearer; exempt the path or reject the deployment until the mail path is safe.

### Inbound-email authentication, replay, or collision

1. On repeated `401`, pause the inbound gateway and compare clocks, exact raw-body byte preservation, body SHA-256, secret version, and the documented `<timestamp>.<body-sha256>` input. Never log or parse/reserialize the body to debug the signature.
2. On `404`, verify the dedicated configured domain and exact generated `reply-<24-lowercase-hex>@<domain>` recipient. Do not enable a catch-all, plus-address alias, or broader route to make the message pass.
3. On `409`, quarantine the provider event and alert security. Reusing an event ID with different bytes, a digest under a different event identity, or a provider-message ID across rounds is a collision; do not generate a replacement ID to conceal it.
4. On `410`, stop unchanged retries. The round is inactive; retain the terminal receipt and, only when authorized, capture genuinely late evidence through the authenticated manual path.
5. For a stale processing receipt, wait for the documented 15-minute lease before an identical retry with unchanged body/event/message IDs and a fresh timestamp/signature. Never create a semantically new callback for retry.
6. If the secret may be exposed, disable capture, rotate `NOTICE_INBOUND_EMAIL_SECRET` in the gateway and Worker through controlled change, verify the golden vector plus wrong-secret/freshness tests, and only then attest the integration and resume.

### Returned attachment, PII, or promotion incident

- Treat every returned file, sender field, reviewed-text copy, and comparison as agreement data that may contain client, employee, counterparty, or other personal information. Restrict support/download access and apply the customer's residency, DLP, legal-hold, and incident-notification rules.
- Scanner outage stays quarantined; a malicious verdict remains inaccessible and enters durable policy-aware cleanup. Do not download a suspect DOCX/PDF into an ordinary workstation. Investigate in the customer's approved isolated environment and reconcile any held bytes before cleanup.
- After scanner recovery, an authorized reviewer uses the exact submission's review/rescan action. A clean verdict advances the same private object under its existing hash/round lineage; a malicious verdict rejects it and queues policy-aware cleanup. Never replace the object, edit its status, or promote around quarantine manually.
- Sender/authentication mismatch remains `sender_review`. An authorized reviewer must independently validate the sender and record the reason before marking a clean source ready; do not reinterpret a failed mail-authentication result as a pass.
- If the wrong source, inaccurate reviewed text, or unauthorized actor was promoted, disable the affected membership/session as appropriate, preserve the immutable returned source, promoted version, comparison, and audit trail, and inspect any approval or signature work started from it. Cancel/reconcile an external signature submission where authorized. Correct through a new immutable version or fresh negotiation round and complete approval again; never overwrite or delete the evidence to make the record appear clean.

### Recovery evidence

Close an exchange incident only after recording the source revision, workspace/agreement/round/event IDs, intended and actual recipient scope, token expiry/hash (not plaintext), delivery and provider disposition, edge-policy result, receipt/collision state, returned-file hashes and scan status, human decision actor/note, any replacement round/version, reapproval/signature state, notification decision, and control owner/due date.

## DocuSeal incidents

- Invalid/stale callback: return remains rejected; inspect provider clock/configuration and do not bypass HMAC/freshness.
- Duplicate callback: a processed body digest returns accepted replay. Confirm no duplicate provider/business action.
- Receipt failed: retain receipt and request ID; reconcile submission directly from DocuSeal, scanner state, signature packet, R2 artifact, and agreement version.
- Provider says completed but artifact is missing/unscannable: keep agreement from authoritative activation, restore provider/scanner access, and retry through an approved reconciliation path.
- Creation returned an error or provider mapping is absent: reload the packet. Every provider submission non-success, malformed response, or transport failure after the durable packet is created leaves it `creating`, because DocuSeal may have accepted it. Reconcile the same packet; never issue another create. After one hour, an administrator may use `abandon_unmapped`, which releases only after an exact empty provider lookup. A found, ambiguous, mismatched, or failed lookup must keep the reservation and be escalated.
- Agreement version conflict occurred after provider success: the mapped packet remains retained. Reconcile its current/stale basis before considering a replacement; do not create another while the reservation is active.
- Reconciliation returns `202`/`processing: true`: another fresh lease owns terminal work. Retry later. If a `reconciling` lease is older than 15 minutes, the normal reconcile action restores the safe prior state and version; do not edit D1 manually.
- Packet is `archived`: DocuSeal `archived_at` is reversible, so Notice keeps the active reservation. Refresh to observe an unarchive. If replacement is authorized, a workspace administrator may use `supersede_archived`; Notice first confirms the provider still reports an archived pending submission. Any later completion remains nonactivating evidence.
- Packet is `superseded`: it no longer reserves the current workflow and cannot activate the agreement. Preserve its history and reconcile any later callback as evidence.
- Packet is `completed_superseded`: preserve the signed artifact and non-activating event, identify which document, material field, stage, or approval changed, and do not relabel it completed/Active. Route current paper for fresh approval and create a new packet only after the prior provider submission is terminal and policy authorizes it.
- Signer progress appears stale: the list shows persisted evidence rather than silent provider polling. Use **Refresh provider state** or the `reconcile` PATCH action, inspect webhook receipts, and repair callback delivery/configuration; never hand-edit signer JSON or mark the agreement complete. Contradictory IDs/emails, a missing signer, a duplicate signer, or any non-completed terminal status must fail reconciliation before artifact download.
- A signer invitation or provider-side signer URL may have reached the wrong person: production Notice does not expose or embed these bearer capabilities, so inspect the DocuSeal account and mail path. Revoke or cancel the provider submission where supported, reconcile it safely, preserve incident evidence, rotate affected credentials if warranted, and create a replacement only after the active-packet guard permits it.

Rotate the DocuSeal token/webhook secret after exposure and update both sides atomically enough to avoid an unmonitored callback gap.

## Audit and export operations

Agreement and workspace exports stop on audit-chain, storage-prefix, or agent-evidence closure failure. Treat `audit_integrity_failure`, `storage_integrity_failure`, or `export_referential_integrity_failure` as a security incident until explained.

For every retained export:

1. store the exact JSON envelope in protected independent storage;
2. recompute the evidence payload SHA-256;
3. verify the HMAC using an approved verifier with controlled key access;
4. record chain head(s), source revision, workspace, exporter, time, and custody;
5. for workspace exports, retrieve each binary artifact separately and verify size/hash; and
6. retain/export/delete the evidence under policy.

Hash chains do not independently reveal deletion of the latest event without a previously retained head/export. Use periodic external/WORM retention when required.

## Backup and restore

Back up D1 and R2 as a mutually consistent recovery set, together with:

- application revision and applied migrations;
- required runtime configuration references;
- independent audit exports/heads;
- webhook/outbox reconciliation state; and
- provider account/template/mapping versions needed to interpret records.

Protect backups separately from the application identity and test restoration. A successful backup job is not restore evidence.

Restore procedure:

1. open an incident/change record with owner, scope, legal-hold constraints, target recovery point, and RTO/RPO;
2. preserve current state and avoid overwriting the only recoverable copy;
3. restore into isolated resources with the matching application/schema revision;
4. validate table counts, workspace ownership, versions, object links, file hashes, audit chains, outbox/receipt state, and signature evidence;
5. run synthetic identity, lifecycle, document, provider, audit, retention, and export checks;
6. reconcile external providers and queued work;
7. obtain technical, security, data-owner, and legal approval; and
8. cut over, monitor, document loss/inconsistency, and dispose of temporary resources after approval.

Perform a scoped restore after material storage/migration changes and a full exercise at least on the customer-approved cadence.

## Enterprise governance and repository operations

- Treat published or retired template versions, workflow definitions, intake template pins, and playbook versions as immutable. Correct an error with a new reviewed version and explicit lifecycle action; never edit rows or hashes in storage.
- Review direct-user and group lane authorities together with workspace membership. Authority is exact to lane and currency and may have a minor-unit ceiling. Revoke through the guarded API so history remains. A lane with any authority history no longer uses the compatibility fallback, even when every record is revoked.
- A submitted intake is immutable. If conversion times out, repeat the same exact form/template/workflow pins and agreement payload; the one committed agreement is returned. Do not create a second contract manually until the conversion record has been reconciled.
- Notice stores monetary values in minor units by currency and performs no FX conversion. Reconcile portfolio values within each currency bucket; do not manufacture an estate total or reuse a ceiling from another currency.
- Repository fragment records must remain pinned to an existing immutable working-version ID, version, and document hash. The source-text digest, offsets, fragment text/hash, and extractor identity are caller-supplied; verify their internal digest/slice consistency and require the human reviewer to compare every cited passage with the protected working paper. Quarantine an extractor whose output fails either check.
- Require an extractor to retain each proposal's UUID idempotency key and exact normalized request until it receives a definitive response. Retry the same material/key after ambiguity; treat `Idempotency-Replayed: true` as recovery and a `409 idempotency_conflict` as a reconciliation incident rather than generating another proposal silently.
- Accepting or rejecting an extraction proposal appends human-review evidence only. An accepted proposal must remain `applicationStatus=blocked` with `governed_executor_required`. Any automatic field mutation or legal-verdict claim is an incident, because no proposal-application executor is included.
- Ingestion batches inventory at most 50 metadata items per idempotent request, deduplicate by exact SHA-256, and may link only an existing matching live document. They do not upload, OCR, extract, or migrate content; reconcile those external steps separately.
- Paged work-item cursors are bound to workspace, user, resource, filters, sort, and page size and carry the insertion fence established on page one. Later inserts stay outside that traversal, but status or sort-field updates can move existing rows between pages. Refresh from page one after mutations; on a cursor conflict or expiry, restart rather than editing or guessing the token.

## Release and migration operations

Run `npm test`, `npm run test:e2e`, and `npm run test:e2e:production` for every release after installing the Playwright Chromium runtime. The current application requires exact `notice_schema_state` marker 21. Migrations through `0017` provide the hardened lifecycle, provider, negotiation, agent-governance, and obligation foundation. Migration `0018` adds enterprise configuration and agreement references: legal entities, counterparties, groups/members, typed custom fields, saved views, governed templates/workflows/intake, direct/group lane authorities, structured parties/relationships, and canonical minor-unit currency. Migration `0019` adds exact workflow/template snapshot pins, immutable clause playbooks, version/hash-pinned registered repository fragments and cited extraction proposals, bounded idempotent ingestion batches/items, and strengthened tenant/referential integrity. Migration `0020` adds immutable tenant- and administrator-bound receipts for atomic, retry-safe initial governed template and clause-playbook creation. Migration `0021` adds durable, CHECK-constrained per-round upload/download budgets and one expiring portal upload-work reservation. Review generated SQL and each final marker update, test the ordered path on a realistic copy, retain a recovery point, apply in staging, and validate before production. The ordinary production runtime only reads and verifies the exact marker; a missing, older, or unexpectedly newer marker fails closed with HTTP 503. Runtime additive initialization is restricted to isolated local validation and is not migration approval.

During rollout monitor Worker error/latency, D1/R2 readiness, authorization failures, provider diagnostics, queue age, webhook reconciliation, and data integrity. For a customer-hosted OCR profile change, deploy and health-check the new pinned model/runtime under a new identifier, update the deployment manifest, rerun the synthetic signed diagnostic, sample approved documents against the source and prior baseline, and only then attest it. Roll back by restoring the prior manifest identifiers and exact prior pinned artifacts, rerunning the diagnostic, and retaining both evidence sets; never make the gateway silently alias the new identifier to old or fallback infrastructure. Roll back code only when schema compatible; prefer a reviewed forward repair for additive migrations.

## Access and secret operations

- Use individual accounts, least privilege, phishing-resistant MFA where available, and time-bounded support elevation.
- Review application admin, cloud platform, identity edge, source, CI, backup, observability, scheduler, and provider access at least quarterly and on every mover/leaver event.
- Keep at least two active workspace administrators; the application prevents removal of the last active admin.
- Rotate credentials on policy and after suspected exposure; test revocation and recovery.
- Membership and identity-recovery changes use their own hash-linked workspace audit chain; retain and review that evidence alongside platform/administrator access logs.
- Never expose secret values through readiness/diagnostics, browser state, logs, or exports.

## Incident response

Define primary/backup incident commander, operations, security, privacy/legal, customer communication, and provider escalation contacts. Treat suspected cross-workspace disclosure, identity spoofing, unauthorized approval/signature, audit failure, destructive purge, backup loss, or credential compromise as highest provisional severity until scoped down.

Response lifecycle:

1. declare severity, commander, secure channel, and timeline;
2. correlate request IDs and identify workspaces/records/identities/providers without spreading content;
3. contain by revoking identity/secret, pausing job/webhook/export, quarantining data, or isolating the deployment;
4. preserve logs, database/object versions, audit/export evidence, and provider state;
5. eradicate, restore/reconcile, validate boundaries, and progressively resume;
6. notify under contractual/legal assessment; and
7. complete root cause, control gaps, owners, deadlines, and residual-risk review.

Exercise account takeover, cross-workspace access, malicious upload/parser, webhook forgery/replay, mass export, leaked secret, D1/R2 outage, destructive migration, backup loss, gateway duplication, and retention failure scenarios.

## Offboarding

1. Approve scope, cutoff, legal holds, recipient, format, and transfer channel.
2. Generate `/api/admin/export`; verify audit chains and HMAC.
3. Retrieve every required R2 artifact and verify manifest size/SHA-256.
4. Reconcile records/artifacts/counts with the customer and record acceptance.
5. Disable members/sessions, schedulers, webhooks, gateways, and provider credentials.
6. Apply approved holds/retention/deletion to primary data and propagate to backups, logs, exports, and downstream providers.
7. Record backup-expiry timing and deletion limitations.
8. Retain a deletion/offboarding certificate and final access review under policy.

## Routine evidence cadence

| Evidence | Suggested trigger/cadence |
| --- | --- |
| Health, provider, queue, webhook, retention dashboards | Continuous |
| Dead-letter/quarantine/retention reconciliation | Daily or tighter SLA |
| Backup verification | Every backup cycle |
| Restore exercise | After material storage change and approved periodic cadence |
| Access review and secret inventory | Quarterly and on role/personnel changes |
| Dependency/security scan | Every change plus scheduled review |
| Threat model and penetration test | Material boundary change and approved annual cadence |
| Retention/offboarding sample | Before automation and periodically thereafter |
| Incident/tabletop exercise | At least annually or customer-required cadence |

Replace suggested frequencies with contractually approved SLOs and retain actual results, not just configured schedules.

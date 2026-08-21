# Application and governed agent APIs

The unversioned `/api/*` route handlers are the authoritative boundary used by the bundled UI. They are versioned with the application and are not a stable third-party public API. The bounded `/api/v1/*` surface is the governed machine contract: it exposes action discovery, exact resource affordances, and durable plans while keeping human-only decisions behind the normal user session.

The shared action registry is broader than the v1 machine contract. `/api/v1/actions` returns every human/domain action with an explicit `agentApiV1` capability: only `agreement.read` and `approval.request` are delegable, plannable, and executable, and `approval.request` accepts only `ensure_required`. Every other registry action carries `AGENT_API_V1_ACTION_UNSUPPORTED`; grant creation and plan collection/proposal reject it. The OpenAPI `info.version` is the document release (`1.1.0`), not the response-envelope `schemaVersion`; `x-notice-agent-api-schema-version` publishes the latter (`1.0`) separately.

## Common behavior

### Authentication classes

| Class | Routes | Authentication |
| --- | --- | --- |
| User | `/api/session`, all agreement/document/workflow/admin routes | Verified Cloudflare Access application JWT (recommended) or verified compatibility-edge headers, active user, active configured-workspace membership, and route permission |
| Human agent reviewer | `/api/v1` discovery, the internal agent-plan inbox, `GET /api/v1/plans/:id`, and plan decisions | Normal verified human session with the route permission; inbox, plan detail, and decisions require `agent:admin`. Human review never inherits the plan's service execution authority. |
| Service principal | `/api/v1` discovery, plan collection/proposal/detail, and execution | Independently verified Cloudflare Access service-token JWT; the signed `common_name` client ID maps to one registered active principal with one independently sufficient, unexpired human-sponsored grant. Plan routes bind one exact grant rather than selecting among overlapping grants. Raw service-token headers are never identity evidence. Local evaluation accepts only a registered principal UUID from a loopback origin. |
| Scheduled job | `/api/jobs/obligations`, `/api/jobs/outbox`, `/api/jobs/retention` | Native Worker Cron dispatches internally with `NOTICE_JOB_RUNNER_SECRET`; the frequent trigger attempts obligation materialization/reminders and outbox delivery independently, while retention remains isolated. An approved external scheduler may call the same routes with `Authorization: Bearer <NOTICE_JOB_RUNNER_SECRET>`; comparison is constant-time. |
| Provider callback | `/api/webhooks/docuseal` | Fresh timestamped HMAC in `x-docuseal-signature`; no browser session |
| Inbound email callback | Exact `/api/webhooks/email` | Optional independent HMAC over `<unix-seconds>.<sha256-of-exact-raw-multipart-body>`, exact content digest/event/alias, replay receipt, and scanner controls; no browser session |
| Counterparty exchange | `/api/exchange/*` | Possession of one random expiring round-scoped bearer token; corporate user session is not required and the path must not be widened |
| Probe | `/api/health` | No identity; returns only generic status and request ID |

In recommended `cloudflare-access` mode, the production application ignores convenience identity headers and verifies the Access application JWT's signature, issuer, audience, time, type, subject, and email. In the optional `trusted-headers` compatibility mode, it accepts canonical `x-notice-identity-*` values only after the deployer has blocked direct origin access and configured the identity-aware edge to strip caller-supplied values before injecting verified subject, email, and encoded display name. The API never accepts workspace, actor, user, or role from a request body.

### Mutation protection

User mutations require an `Origin` exactly matching the request origin. Safe methods are not rejected by the origin guard. Job and provider routes use their separate bearer/HMAC authentication paths.

JSON bodies have route-specific byte limits and Zod schemas. Unknown fields are stripped unless the route declares a strict schema. File imports have independent byte/type limits. Identifiers, actor, timestamps, workspace ownership, calculated lifecycle state, and audit sequence are server-owned.

Concurrent records carry `version`. A stale mutation normally returns `409 version_conflict`; clients must reload and ask the user to reapply the change.

### Responses

JSON responses are `no-store`, include `X-Request-Id`, and do not expose stack traces, SQL, object keys, or secrets.

Typical success:

```json
{
  "agreement": { "id": 123, "version": 4 },
  "event": { "id": "uuid", "sequence": 8 },
  "requestId": "uuid"
}
```

Typical error:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "Reload the record before saving."
  },
  "requestId": "uuid"
}
```

Validation errors also contain bounded `issues` with field paths and messages.

Common statuses are `200`, `201`, `202`, `400`, `401`, `403`, `404`, `409`, `413`, `415`, `422`, `429`, `500`, `503`, and `410` for metadata whose bytes are no longer available.

## Route inventory

| Method and path | Permission/auth | Purpose |
| --- | --- | --- |
| `GET /api/session` | Signed-in member | Non-secret, server-authoritative workspace/user/role/permissions |
| `GET /api/v1/openapi` | Public | OpenAPI 3.1 description of the bounded governed agent surface |
| `GET /api/v1/actions` | Human `agent:read` or registered service principal | Full stable action registry with separate `agentApiV1` planning/execution capability, unsupported-action blocker, and caller-specific authority coverage |
| `GET /api/v1/agreements/:id/available-actions` | Human `agent:read` or exact service resource grant | Current version, paper hashes, preconditions, v1 capability, and blockers without execution |
| `GET /api/v1/plans` | Exact service principal and required `grantId`/action/resource query | Cursor-bounded plans for one allowlisted v1 action, resource, principal, and grant; never an admin-wide collection |
| `POST /api/v1/plans` | Exact service principal and body `grantId`; `Idempotency-Key` required | Persist a canonical exact-basis plan only for `agreement.read` or `approval.request`/`ensure_required`; unsupported registry actions return `409 agent_api_v1_action_unsupported`; exact replay returns `200` plus `Idempotency-Replayed: true`, while key reuse for a different scoped proposal returns `409` |
| `GET /api/v1/plans/:id` | Exact creating service principal/grant or human `agent:admin` | Read one plan, decision, and execution receipt for service use or governed human review |
| `POST /api/v1/plans/:id/decisions` | Human `agent:admin` | Record one attributable decision bound to the exact plan digest; the grant sponsor cannot approve or reject it, and the deciding user must still be an active Admin at commit |
| `POST /api/v1/plans/:id/execute` | Exact service principal/grant; `Idempotency-Key` required | Execute an approved `agreement.read` plan or the policy-derived `approval.request`/`ensure_required` mutation with exact review, current-authority/basis fences, atomic receipt, and durable replay semantics; read claim and completion both recheck exact principal/grant/sponsor/time/resource/agreement/latest-paper authority |
| `GET /api/agreements` | `agreement:read` | Cursor-bounded active-agreement register with literal `q` search across party/type/owner/tags, side/stage/risk filters, Updated/Value/Risk sorting, exact page-one `totalMatched`, and an insertion fence; default/maximum page size 200. Value sort groups by ISO currency code and orders exact minor units within each currency—there is no implicit FX comparison. Existing rows remain live, so filter/sort mutations can move them between pages and callers should refresh after changes. |
| `POST /api/agreements` | `agreement:create` | Idempotent creation with server ID/stage/approval state, snapshot, audit event, and outbox event; requires a UUID `Idempotency-Key` |
| `PATCH /api/agreements` | `agreement:update` | Detail-only update with optimistic version |
| `DELETE /api/agreements` | `agreement:update` | Legal-hold-aware soft deletion with optimistic version |
| `POST /api/agreements/transition` | `agreement:update` | One-step lifecycle move; approval gate before Signature |
| `GET /api/agreements/:id/relationships` | `agreement:read` | Workspace-scoped structured party roles and inbound/outbound agreement relationships with safe related-record summaries; each collection is deterministically capped at 200 and its `page.*.hasMore` flag discloses truncation |
| `POST|DELETE /api/agreements/:id/relationships` | `agreement:update` | Add/remove one validated legal-entity/counterparty role or directional agreement link; cannot rewrite working paper |
| `GET /api/agreements/:id/versions` | `document:read` | List working versions and safe linked-source summaries |
| `GET /api/agreements/:id/versions?version=N` | `document:read` | Protected content-version download |
| `POST /api/agreements/:id/versions` | `document:manage` | Create immutable R2-backed text/Markdown version |
| `GET /api/agreements/:id/audit` | `audit:read` | Verify chain and download signed agreement evidence, including any exact source-attributed agent plan/decision/execution closure |
| `GET /api/agreements/:id/negotiation` | `document:read` | Round, submission, comparison, derived delivery state, and separate portal/outbound/negotiation-mail/inbound readiness flags with raw alias/token/object keys omitted |
| `GET /api/agreements/:id/negotiation?view=review-text&submissionId=<uuid>` | `document:read` | No-store download of exact retained human-reviewed text and its SHA-256 |
| `POST /api/agreements/:id/negotiation` | `document:manage` | Prepare/rotate/send/record manual send, mark a verified clean return ready, reject/close/promote, or authenticated multipart return upload with action-specific bounds |
| `GET /api/exchange/:token` | Expiring 64-hex bearer token | Self-contained secure exchange form; `?format=json` returns scoped metadata and static per-round transfer policy, while `?download=1` returns exact outbound bytes/hash under the durable download budget |
| `POST /api/exchange/:token` | Same bearer token plus exact same-origin mutation guard | One returned file plus sender email/name; 20 MiB file/21 MiB body limits, durable round budget and upload-work lease, structural inspection/scanning, immutable capture, no automatic promotion |
| `GET /api/language-blocks` | `language:read` | Up to 200 approved-language records |
| `POST /api/language-blocks` | `language:write` | Create approved language with server ID/version |
| `PATCH /api/language-blocks` | `language:write` | Replace approved-language fields with optimistic version |
| `GET /api/templates` | `agreement:read` | Published governed templates with their exact current published immutable version |
| `GET /api/intake/forms` | `agreement:read` | Published structured intake forms and their exact template-version/workflow pins |
| `GET /api/intake/submissions` | `agreement:read` | Bounded workspace intake submissions with safe form metadata |
| `POST|PATCH|DELETE /api/intake/submissions` | `agreement:create` | Create/update/submit a draft or delete an unsubmitted intake; submitted answers are immutable |
| `POST /api/intake/submissions/:id/convert` | `agreement:create` | Atomically convert one exact submitted form/template/workflow basis into one agreement, initial snapshot/event/outbox, and a converted submission; exact replays return the winner |
| `GET|POST|PATCH|DELETE /api/saved-views` | `agreement:read` | Read and manage bounded resource views; shared views are readable workspace-wide, while only the owner or a workspace administrator may change/remove them |
| `GET /api/operations` | `agreement:read` | Up to 200 approvals, materialized obligation occurrences, schedules, immutable completion-evidence records, eligible obligation owners, and 300 recent events; every obligation projection joins a non-deleted agreement |
| `POST /api/operations` | Per action | Ensure required approval lanes; create/claim/decide approval; idempotently create, complete, reassign, pause/resume/end obligation schedules; or append comment/change evidence |
| `GET /api/work-items` | Resource permission (`approval:read`, `agreement:read`, `obligation:read`, or `audit:read`) | Bounded live-queue cursor pages for approvals, signatures, obligations, schedules, or events, with page-one insertion fencing, totals/status counts, and owner/agreement/text/status filters |
| `GET /api/reports/portfolio` | `agreement:read` | Workspace portfolio counts by stage/risk, renewals, approval/signature/obligation work, and values grouped by currency; no FX or cross-currency total |
| `GET /api/documents/import` | `document:upload` | Recover the safe result of a committed upload by its tenant/user-bound `Idempotency-Key` |
| `POST /api/documents/import` | `document:upload` | Idempotent multipart inspection, scan/quarantine, extraction, R2/D1 persistence |
| `PATCH /api/documents/import` | `document:upload` | Link an accepted, unlinked document only through the exact same-user, same-key committed import reservation; staging, expired, or receiptless sources are rejected |
| `PUT /api/documents/import` | `document:manage` | Rescan a quarantined document and promote or reject it |
| `GET /api/documents/:id` | `document:read` | Tenant-scoped accepted-document download |
| `GET|POST /api/intelligence/fragments` | `document:read` / `document:manage` | Read or register up to 50 non-overlapping extractor-supplied fragments per request and 500 per source-text digest, pinned to an immutable working-document ID/version/hash; source-text digest, offsets, and content are caller-supplied, exact batch retries replay, disjoint batches append, and ordinal/overlap/extractor conflicts fail closed |
| `GET /api/intelligence/search` | `document:read` | Literal provider-neutral, snapshot/cursor-paged search over registered fragments, returning their document-version/hash pin, caller-supplied offsets/text, and digests for human verification against protected paper |
| `GET|POST|PATCH /api/intelligence/proposals` | `document:read` / `document:manage` | Read/create/review confidence-bearing proposals cited to registered fragments; `POST` requires a UUID `Idempotency-Key`, exact replay returns `200` plus `Idempotency-Replayed: true`, conflicting material returns `409`, and acceptance applies no agreement/custom-field mutation |
| `GET|POST|PATCH /api/intelligence/ingestion` | `document:read` / `document:upload` | Bounded, idempotent inventory of at most 50 source items with SHA-256 dedupe/link/review state and explicit external-extraction blockers |
| `GET /api/signatures` | `agreement:read` | Up to 200 sanitized DocuSeal packet records; `?include=provider_roles` also reads the configured ordered template roles |
| `POST /api/signatures` | `agreement:update` | Create a DocuSeal packet for a Signature-stage, approval-ready agreement |
| `PATCH /api/signatures` | `agreement:update`; Legal/Admin exact-review confirmation; admin for release actions | Reconcile `creating`/`pending`/`partially_signed`/`reconciling`/`archived`, record exact human review of `completed_review_required` evidence, abandon a verified-absent unmapped packet, or supersede a provider-confirmed archive |
| `POST /api/webhooks/docuseal` | DocuSeal HMAC | Replay-safe provider reconciliation and exactly-one final signed-artifact ingestion; completion never activates an agreement without subsequent exact human review |
| `POST /api/webhooks/email` | Inbound-email raw-body-digest HMAC | Strict multipart manifest, exact alias, replay/collision receipt, up to five hash-bound attachments, scanner/quarantine, no automatic promotion |
| `POST /api/reminders` | `notification:send` | Queue approval or obligation reminders for active assigned members |
| `GET /api/admin/memberships` | `workspace:admin` | List workspace members |
| `POST /api/admin/memberships` | `workspace:admin` | Invite/reactivate a member by verified email and role |
| `PATCH /api/admin/memberships` | `workspace:admin` | Change role/status; prevents removal of the last active admin and refuses to strand active/paused schedules or open occurrences with an ineligible owner |
| `GET|POST|PATCH /api/admin/agent-principals` | `agent:admin` | List/register/version-enable-or-disable service principals; stores no bearer secret |
| `GET|POST|PATCH /api/admin/agent-grants` | `agent:admin` | List/create/revoke bounded action-and-resource grants; new grants accept only the two v1-supported actions and sponsor authority is re-evaluated on every machine request |
| `GET /api/admin/agent-plans` | `agent:admin` | Cursor-bounded human oversight inbox, optionally filtered by plan status, principal, or action; use exact v1 detail before deciding |
| `GET /api/admin/integrations` | `integration:manage` | Redacted provider configuration status |
| `POST /api/admin/integrations` | `integration:manage` | Harmless authenticated live diagnostic for one provider boundary |
| `GET|POST|PATCH /api/admin/configuration/legal-entities` | `workspace:admin` | Manage versioned workspace legal-entity reference records and default currencies |
| `GET|POST|PATCH /api/admin/configuration/counterparties` | `workspace:admin` | Manage deduplicated versioned counterparty reference records |
| `GET|POST|PATCH /api/admin/configuration/groups` | `workspace:admin` | Manage groups and manual active-member links; external IDs do not constitute bundled SCIM synchronization |
| `GET|POST|PATCH /api/admin/configuration/custom-fields` | `workspace:admin` | Manage typed definitions for agreements, counterparties, and legal entities |
| `GET|PUT|DELETE /api/admin/configuration/custom-field-values` | `workspace:admin` | Validate and manage one typed value on an active exact-scope resource |
| `GET|POST|PATCH /api/admin/configuration/templates` | `workspace:admin` | Atomically create a template plus immutable first draft, add later versions, and publish or retire exact versions |
| `GET|POST|PATCH /api/admin/configuration/workflows` | `workspace:admin` | Create, publish, and retire immutable schema-version `1.0` approval-lane definitions |
| `GET|POST|PATCH /api/admin/configuration/intake-forms` | `workspace:admin` | Create/version/publish/retire structured forms with exact published template-version and workflow pins |
| `GET|POST|PATCH /api/admin/configuration/approval-authorities` | `workspace:admin` | Manage active/revoked direct-user or group lane authority for one currency and optional minor-unit ceiling |
| `GET|POST|PATCH|DELETE /api/admin/configuration/saved-views` | `workspace:admin` | Manage owner-scoped or shared saved-view definitions for administration |
| `GET|POST|PATCH /api/admin/configuration/playbooks` | `workspace:admin` | Atomically create a scoped playbook plus immutable first rule version, add later versions, and publish or retire them |
| `GET /api/admin/retention` | `workspace:admin` | Retention summary or policy detail by agreement/document |
| `PATCH /api/admin/retention` | `workspace:admin` | Versioned retention/legal-hold change with reason and optional cascade |
| `GET /api/admin/export` | `workspace:admin` | Signed workspace/offboarding record, sanitized retention/integration/agent-governance ledgers, and artifact manifest |
| `GET /api/readiness` | `workspace:admin` | Redacted code/customer production preflight; `503` while incomplete |
| `GET|HEAD /api/health` | Public probe | Dependency-free liveness |
| `GET|HEAD /api/health?mode=ready` | Public probe | Exact D1 schema marker plus D1/R2 reachability; `503` when unavailable or mismatched |
| `POST /api/jobs/outbox` | Job bearer | Claim and deliver up to 25 pending canonical events |
| `POST /api/jobs/obligations` | Job bearer | Materialize up to 25 due schedule occurrences and advance/queue up to 50 due reminder cursors with replay/concurrency guards |
| `POST /api/jobs/retention` | Job bearer | Soft-delete and hard-purge bounded eligible retention batches |

The exchange bearer remains usable for the active round until its recorded expiry or until staff rotate it, close the round, or promote a return; one upload does not consume it. Transfer accounting belongs to the exchange round and link rotation does not reset it. A round admits at most 10 upload attempts, independently capped at 4 accepted returns and 6 rejected/failed attempts, with 96 MiB of cumulative multipart request bytes. Each admitted upload reserves the 21 MiB body ceiling before reading/scanning and holds the round's sole five-minute upload-work lease; an overlapping request returns `429 exchange_upload_busy` with `Retry-After: 5`. Downloads are atomically capped at 20 attempts and 256 MiB cumulatively. Upload or download exhaustion returns `429 exchange_*_limit_reached` and requires a new round rather than a rotated link. Failed attempts remain charged according to the documented bounded-read rules, while the HTML/JSON metadata exposes only this static policy—not counters, reservation IDs, or remaining capacity.

The HTML response gives the counterparty a filename, opaque receipt/support reference, and safe retry or close guidance. JSON success is intentionally narrow: `{ accepted, recorded, receipts: [{ receiptId }], requestId }`. It never returns internal workspace, agreement, round, document, reviewer, storage, submission, or transfer-counter records.

Each serialized round includes `deliveryState` as one of `not_queued`, `queued`, `processing`, `accepted`, `dead`, or `manual_recorded`. `accepted` means the configured gateway durably accepted responsibility for the event; it is not evidence that the counterparty received or opened the message. `sentAt` is the queue or manual-attestation time, not a recipient-delivery timestamp. The active agreement queue is reconciled from this state and every current-round submission, with actionable returned-file review taking precedence over a later delivery outcome.

Rotation, close, and promotion refuse to race a `pending` or `processing` `negotiation.round_requested` delivery. The same absence-of-pending-delivery predicate is repeated in the committing round mutation, so the outbox cannot validate a bearer and then send it after a concurrent revocation or resolution.

## Core mutation examples

### Create an agreement

`POST /api/agreements` accepts business inputs such as `creationMode`, `party`, `side`, `type`, canonical `valueMinor` plus `currencyCode`, owner/member reference, primary counterparty and legal-entity references, exact governed-template version and variables for generated work, exact published workflow definition, due fields, CRM labels, tags, department, dates, and optional governing law for compatibility starter paper. `value` remains a non-negative whole-unit compatibility projection for older clients; new clients should send `valueMinor` in the named currency. Notice validates zero-, two-, and three-decimal minor-unit conventions, but has no exchange-rate source and never converts currencies. Caller-supplied ID, stage, queue action, risk outcome, approval/signature status, actor, workspace, and timestamps do not control the stored values; an explicit `nextAction` is rejected. Every new agreement is stored as `Unassessed` until the dedicated exact-paper risk operation succeeds.

Every valid creation request must include `Idempotency-Key: <uuid>`. Generate one UUID for one intake, retain that key and the exact JSON body until a definitive response is received, and reuse both after timeouts, connection loss, or other ambiguous failures. The first committed request returns `201`, `replay: false`, and `Idempotency-Replayed: false`. An exact retry by the same authenticated user in the same workspace returns `200`, the current active agreement plus its original Created event and original creation artifact semantics, `replay: true`, and `Idempotency-Replayed: true`; it does not add audit, outbox, document, or storage side effects. Reusing the key with different intake JSON returns `409 idempotency_key_conflict`. Keys are scoped by workspace and user, but callers should still never reuse one for a different intake.

For `creationMode: "imported"`, this must be the same UUID used by the committed document upload. The creation transaction revalidates the unexpired tenant/user-scoped receipt and durably reserves its exact source before returning success; a missing, mismatched, linked, expired, deleted, or records-policy-modified source fails closed.

```http
POST /api/agreements HTTP/1.1
Content-Type: application/json
Idempotency-Key: 00000000-0000-4000-8000-000000000001

{"creationMode":"manual","party":"Example Counterparty","side":"Buy-side","type":"NDA","value":0,"valueMinor":1250000,"currencyCode":"EUR","owner":"Contract Owner","due":"2026-08-28","crm":"None","crmRecord":"","tags":[],"department":"Legal","effectiveDate":"","expirationDate":""}
```

Creation mode determines the initial stage:

- `generated` -> `Draft`, with immutable R2-backed working document version 1 created in the same authoritative application operation; when `governedTemplateVersionId` is supplied, the exact published immutable version is digest-checked and rendered from its bounded required variables
- `imported` -> `Review`
- `manual` -> `Intake`

New, imported, generated, converted, and materially changed agreements begin `Unassessed` with approval `Required`. If a published workflow is selected, Notice stores its exact definition digest and the lanes deterministically selected for the agreement's side, type, department, risk/disposition, currency, and minor-unit amount. Without a governed workflow, an exact-paper Low/Medium assessment can become `Not required` only when the compatibility starter policy does not require Finance; High risk, a waiver, USD value above 100,000, or any material non-USD value requires routing because no FX source exists. `Required` means policy requires routing but no reviewer has yet been asked and is deliberately different from `Pending`.

The generated response includes a safe `documentVersion` summary (never the R2 object key). If document storage or the D1 batch fails, creation fails and best-effort object cleanup runs; a requester may invoke this governed creation operation without receiving the broader `document:manage` permission used for arbitrary later versions.

### Update agreement details

```json
{
  "id": 123,
  "version": 4,
  "owner": "Maya Chen",
  "expirationDate": "2028-06-30"
}
```

`nextAction` is a server-derived, read-only queue projection and is rejected on creation and detail updates. Lifecycle, queue, and signature/approval state must use their dedicated server operations.

The server normalizes and compares every submitted detail with the authoritative row. If nothing effectively changed, it returns the existing agreement with `unchanged: true` and `event: null`; it does not increment the version, supersede approvals, emit audit/outbox evidence, or reject an executed agreement. Changes to material approval fields—including party/side/type, canonical amount or currency, department, dates, and the governed template/workflow/reference selections used by the basis—recompute the exact workflow snapshot when present and invalidate current risk/approval evidence. Risk cannot be patched through this route. An actual material change remains forbidden after activation or verified signature completion.

### Move lifecycle

```json
{
  "id": 123,
  "version": 5,
  "toStage": "Negotiation"
}
```

Only the next legal step is accepted. `Active` is reached only after provider completion, retention and scanning of the exact final artifact, and a separate authorized human review of that artifact against the approved basis—not through this browser transition route.

### Workflow operations

`POST /api/operations` is a discriminated request with `entity`, `action`, and `record`:

- `risk/assess` — requires `risk:assess`, a positive agreement version, rationale, confirmation, and the exact current risk basis, document version, and document SHA-256. The server supersedes stale approvals and stores the attributable evidence.
- `risk/waive` — requires Admin-only `risk:waive` and the same exact-paper evidence. A waiver leaves the level `Unassessed`, records a governed disposition, and re-evaluates the selected published workflow; without one, the compatibility policy requires Legal and Finance.
- `approval/ensure_required` — requires `approval:request` and atomically creates any missing server-policy lanes for the exact current working paper and material agreement basis. This is the canonical way to route the repository policy.
- `approval/create` — requires `approval:request`, creates an additional explicitly named approval lane, binds it to the exact current working-document version/hash and material agreement/workflow basis, and records the requesting user. Optional `approverUserId` must be a different active admin/legal/approver member whose direct/group/legacy authority covers the exact lane, currency, and amount; otherwise the request enters an explicit unassigned queue.
- `approval/claim` — requires `approval:decide` and atomically assigns an eligible unassigned request to the current user only when current direct/group/legacy authority covers the lane, currency, and amount. It rejects a requester's attempt to claim their own request and repeats authority in the commit predicate.
- `approval/decide` — requires `approval:decide`, an explicit confirmation, the exact current basis/document evidence, and current lane/currency/amount authority; it rejects a changed document/basis, rejects the user who requested that approval, and prevents one user from satisfying two simultaneously required lanes on the same basis. A change request requires a reason. An `approver` role may decide only its assigned request. Admin/legal technical permission does not bypass configured lane authority, requester/decider separation, or required-lane separation.
- `obligation/create` — requires `obligation:write`, explicit human confirmation, and a canonical UUID `Idempotency-Key`. It accepts only an `Active` agreement or one with verified `Completed` signature status, an active eligible owner, a canonical first due date, and an optional bounded recurrence rule. The first commit atomically creates the immutable rule, occurrence 1, receipt, audit event, and outbox event. An exact retry returns the same live result; key reuse with different normalized input returns `409 idempotency_key_reused`.
- `obligation/complete` — requires explicit human confirmation, an exact occurrence version, and evidence. The assigned owner may fulfill with `obligation:fulfill`; Legal/Admin may use `obligation:write` with an override reason. Completion atomically writes one immutable SHA-256 evidence record and cannot be reopened or rewritten.
- `obligation/reassign` — Legal/Admin only. It requires the exact schedule version, an active eligible owner, a reason, confirmation, and `includeOpenOccurrences=true`; schedule ownership and every currently open occurrence move together.
- `obligation/schedule_status` — Legal/Admin only. It pauses or resumes future materialization, or irreversibly ends the schedule, with exact version, reason, and confirmation. Existing open occurrences remain actionable and continue following their own reminder/evidence lifecycle.
- `event/comment` and supported change evidence — require audit append permission; actor/time are always server-derived.

Approval records store policy **lane labels** such as `Legal`, `Finance`, or a governed customer-defined name in the `role` field. They are not lowercase workspace identity roles. An active `approval_lane_authorities` record grants one direct user or active group authority in one exact currency, optionally up to a minor-unit ceiling; a revoked record remains authority history and prevents silent fallback. A lane with no authority record at all uses the compatibility mapping: `admin`/`legal` for `Legal`, `admin`/`approver` for `Finance`, and `admin` for another lane. The customer supplies and reviews the real matrix; Notice enforces the configured records and fails closed when none matches.

### Obligation schedules, occurrences, and evidence

Notice stores a recurrence rule separately from each actionable occurrence. Supported v1 rules are `once`, `week`, `month`, and `year`, with interval 1–12, one validated IANA time zone, one inclusive optional end date, and 1–8 unique reminder lead days from 0–365. Quarterly is represented as `month` with interval `3`. Calendar math is anchored to the original first due date: month-end and leap-day clamping never drifts the next calculation. Existing legacy obligations migrate as ended one-time schedules; free-text legacy cadence is never interpreted as a recurrence rule.

The scheduler materializes from the schedule cursor with a schedule-version compare-and-swap and unique `(workspace, schedule, occurrence number)` identity. Missed reminder windows collapse to at most one catch-up notification, then the occurrence cursor advances past every elapsed window. Reminder delivery rechecks the non-deleted executed parent, exact open occurrence/version/owner/due date, active user and membership, an obligation-eligible role, and the exact recipient immediately before delivery. Manual due/overdue reminders use the occurrence's local calendar day as their deterministic retry key, including after every automated cursor has been consumed.

`GET /api/operations` returns `obligationSchedules`, occurrence-compatible `obligations`, `obligationEvidence`, and `eligibleObligationOwners`. Schedule rule terms and occurrence identity/terms are immutable. Pausing or ending a schedule does not cancel existing open occurrences. Hard purge deletes creation receipts, evidence, occurrences, and schedules only inside the agreement's legal-hold/retention-guarded transaction; workspace export exposes recurrence records and only a receipt count, never idempotency keys or request digests.

### Ensure required approval lanes

Request:

```json
{
  "entity": "approval",
  "action": "ensure_required",
  "record": {
    "agreementId": 123,
    "due": "2026-09-15"
  }
}
```

The route reads the active agreement and latest immutable working version, requires a current exact-paper risk decision, computes their material/workflow-basis hash, and ensures current attributable coverage. When a governed workflow snapshot exists, its evaluated lanes are authoritative. Otherwise the compatibility lanes are `Legal` for every routed approval, plus `Finance` for High risk, a waiver, USD value above 100,000, or any material non-USD value because Notice performs no FX conversion. Missing lanes are created as unassigned `Pending` requests; existing current extra lanes remain part of the aggregate and must also be approved. Each required lane needs a distinct attributable decider. A current `Changes requested` decision blocks rerouting on the same basis until the change is addressed and a new working version is saved.

Created response (`201` when at least one lane was created):

```json
{
  "approvals": [
    {
      "id": "uuid",
      "agreementId": 123,
      "role": "Legal",
      "status": "Pending",
      "approverUserId": null,
      "version": 1
    }
  ],
  "agreement": {
    "id": 123,
    "approvalStatus": "Pending",
    "version": 8
  },
  "event": {
    "id": "uuid",
    "sequence": 12
  },
  "createdRoles": ["Legal"],
  "requestId": "uuid"
}
```

The response returns all current valid approval coverage after the operation, the authoritative agreement, and `createdRoles` containing the lane labels created by this call. It returns `200` when no request was created. A `200` response may be a true no-op—in which case `createdRoles` is empty and `event` is absent—or an aggregate-state reconciliation write, in which case `event` is present.

There is no caller-supplied idempotency key. Idempotence is derived from workspace, agreement, exact document/material basis, policy lane, and attributable request state. Repeating the same request does not duplicate already valid `Pending` or separated `Approved` coverage, and it does not rewrite an existing request's due value. Concurrent routing is protected by the agreement version guard; a losing request receives `409 version_conflict` and should reload before retrying.

Route-specific errors:

| Status/code | Meaning and next action |
| --- | --- |
| `400 validation_failed` | Body, agreement ID, or due label is invalid; correct the request. |
| `403 permission_denied` | The member lacks `approval:request`; do not retry without an authorized identity. |
| `404 agreement_not_found` | No active agreement exists in the verified workspace. |
| `409 executed_agreement_immutable` | The agreement is executed; use an amendment or replacement agreement. |
| `409 document_version_required` | Save and review an immutable working version first. |
| `409 approval_changes_required` | Address the requested changes and save a new working version before rerouting. |
| `409 version_conflict` | The agreement changed concurrently; reload authoritative state, then retry if still required. |
| `429 rate_limit_exceeded` | Back off until the response's rate-limit window resets. |
| `503 schema_incomplete` or `configuration_incomplete` | Complete the deployment/migration prerequisite before retrying. |

### Create a working document version

```json
{
  "content": "# Draft agreement\n...",
  "contentType": "text/markdown",
  "label": "Legal draft",
  "expectedAgreementVersion": 6
}
```

Content is limited to 2,000,000 characters. The route assigns the next version, stores immutable bytes in R2, hashes them, advances the agreement version, and appends evidence. A new version invalidates prior approvals and returns the agreement to approval `Required`; material metadata changes do the same. Executed agreements require an amendment workflow rather than silent mutation.

The list response also includes safe `sourceDocuments` summaries for active documents linked to the agreement. Their IDs can be used only with the workspace-scoped protected download route; R2 object keys are never returned.

## Enterprise configuration, intake, and repository intelligence

Enterprise configuration routes are workspace-admin APIs, not a public configuration language. Initial template and playbook creation uses `action: "create_with_version"` and requires a canonical UUID `Idempotency-Key`: the parent, immutable version 1, one-way receipt, and audit event commit in one D1 batch. An exact retry returns the same parent/version with `Idempotency-Replayed: true`; key reuse for different material returns `409 idempotency_key_conflict`. Parent-only creation actions are rejected. `action: "create_version"` remains available both to repair an existing draft parent created by an earlier deployment and to add a later governed revision. Mutable parent records use optimistic `version` checks; publication and retirement require confirmation plus a reason. Published/retired template versions, workflow definitions, playbook versions, and published intake template pins are immutable. A governed template body can use only its declared bounded variables; generation verifies the exact content digest and renders the selected published self-contained body rather than a mutable parent. New template versions must send an empty `languageBlockIds` array: nonempty approved-language composition is rejected until immutable block content/version snapshots and deterministic composition are implemented. Approved-language insertion remains a separate, human-reviewed editor action. A workflow definition supports only schema version `1.0`: one to twenty unique approval lanes, at least one unconditional lane, and ANDed conditions over side, agreement type, department, risk/disposition, exact currency, and minimum/maximum minor-unit amount.

Published intake forms contain one to one hundred typed fields (`text`, `number`, `date`, `boolean`, `single_select`, or `multi_select`). Publishing a form that references a template pins the template's exact published version; the workflow reference must also be published. A submission stores the form version and template-version pin presented to the requester. Submission freezes the answers. Conversion requires the caller to repeat those exact pins and versions, choose an active owner and optional active legal entity/counterparty, and confirm a reason. The guarded D1 batch creates the agreement, initial metadata snapshot, audit event, optional CRM outbox projection, and conversion marker together. A concurrent or later retry returns the one committed agreement and cannot create a second one.

Workspace groups are managed manually by these routes. Optional external-provider/external-ID fields are identifiers only; Notice does not contact an IdP or perform SCIM synchronization. Custom-field values are validated against the active definition's resource type and data type. Structured agreement parties and relationships supplement primary agreement fields and never change document content.

Repository intelligence is evidence-first and provider-neutral:

- fragment registration requires an existing immutable agreement working-document ID, version, and document SHA-256 plus a caller-supplied source-text SHA-256, non-overlapping code-point offsets, fragment content/hashes, and extractor/version identity; Notice does not derive or compare the registered text with canonical working-paper bytes;
- literal search is workspace-scoped and snapshot/cursor-paged, and returns version/hash-pinned registered fragment text/offsets/digests rather than a free-standing generated answer; callers and reviewers must verify it against the protected working paper;
- extraction proposals target a bounded core agreement field or active agreement custom field, include a `0`–`1` confidence value, and require one to twenty citations whose quoted text matches slices inside registered fragments carrying the same document-version/hash pin and caller-supplied source-text digest; this proves internal consistency, not source correspondence; and
- accepting or rejecting a proposal requires attributable human review against the protected working paper. Acceptance returns `mutationApplied: false` and `governed_executor_required`; no agreement or custom-field value is changed and no legal/playbook verdict is made.

Proposal creation requires a canonical UUID `Idempotency-Key`. Retain that UUID and the exact normalized proposal material across an ambiguous response. The first commit returns `201`; an exact retry by the same authenticated creator in the workspace returns the existing proposal and citations with `200`, `idempotentReplay: true`, and `Idempotency-Replayed: true`. Reusing the UUID for different document, target, value, confidence, extractor, ingestion item, source-text digest, or normalized citations returns `409 idempotency_conflict` and creates nothing.

Ingestion batches accept at most 50 metadata items plus a UUID `Idempotency-Key`. They inventory/deduplicate by SHA-256 and can link only to an already accepted matching live document. The endpoint does not upload bytes, extract text, run OCR, or migrate agreements; unresolved items explicitly report the missing external step.

`GET /api/work-items` requires one `resource` value: `approvals`, `signatures`, `obligations`, `obligation_schedules`, or `events`. Pages default to 100 and cap at 200. The opaque cursor is bound to the workspace, user, resource, filters, sort, and page size and carries a page-one insertion fence, so rows inserted after page one are excluded from that traversal. This is a bounded live queue, not an immutable snapshot: status or sort-field updates can move existing rows between pages, so refresh from page one after mutations. `GET /api/reports/portfolio` aggregates the current filtered estate without a record cap, but returns every monetary bucket separately by currency. Neither endpoint performs FX conversion.

## Document import states

`POST /api/documents/import` uses multipart field `file`, supports PDF, DOCX, RTF, and text up to 20 MiB, and requires a canonical lowercase UUID in `Idempotency-Key`. The server inspects the complete bounded file rather than trusting its name or caller MIME label: text must be well-formed UTF-8 under the control-character policy, RTF must have a balanced bounded structure without binary/object payloads, PDF must carry bounded header/trailer/xref and referenced-object structure, and DOCX must be a canonical bounded ZIP with the required entries, consistent safe central/local layout, verified expansion/checksums, and bounded required-OOXML-part structure. These are structural admission checks, not semantic OOXML/PDF validation, malware proof, CDR, or legal review. The server stores only a workspace/user-scoped digest of the UUID. Its request digest is the canonical tuple of normalized filename, exact size, and file SHA-256; multipart boundaries and caller MIME labels do not affect retry identity. The first clean/quarantined commit returns `201`/`202`. The same normalized file and key replays as `200` with `Idempotency-Replayed: true`; a different file under that key returns `409`. `GET` with the same header recovers a commit after a lost response without uploading the bytes again.

The browser retains one workspace/user-bound intake UUID and phase through upload, editable analysis, imported-agreement creation, and final source linking. It revalidates the receipt immediately before the first agreement-creation attempt, freezes the exact agreement JSON after that attempt, and clears recovery only after link convergence. Imported agreement creation requires that same upload UUID and atomically reserves the source, so a response lost at the seven-day staging boundary can still finish linking without creating an orphan agreement. A user may explicitly discard a wrong staged source and start with a new UUID; the abandoned unlinked object remains subject to automatic cleanup.

- `201` — clean; linking is available. Production extracts bounded text/RTF in process. For PDF/DOCX, linking either invokes the one deployment-selected customer-hosted OCR profile through the signed scanner gateway or uses the explicitly disabled/manual reviewed-text path.
- `202` — scanner unavailable; bytes are quarantined and extraction is skipped.
- `422` — malicious; the upload is rejected.

A `PUT` rescan body is `{ "documentId": "uuid" }`. Before scanner I/O, the route atomically claims the exact quarantined source under a five-minute D1 lease, so a second live rescan cannot race it; an expired claim may be recovered. A clean result can advance only the exact claimed version/object/hash state. A later exact-correlated malicious result is reconciled against the current row and dominates a concurrent clean result, preserving rejection/cleanup/hold and negotiation lineage. A `PATCH` link body is `{ "documentId": "uuid", "agreementId": 123 }`. Linking a readable source creates immutable working-document version 1 from extracted text, records `sourceDocumentId`, advances the agreement version, and returns `workingVersionCreated: true`. When customer-hosted OCR is enabled for a production PDF/DOCX, this link step sends the exact source only to the same HMAC scanner gateway under protocol 2.0, requires the selected model/profile and source SHA-256 to echo exactly, accepts no more than 400,000 characters/2,000,000 UTF-8 bytes, and records OCR provenance with the R2 working object and agreement event. There is no fallback.

Customer-hosted OCR claims and makes the exact source unreadable before inference. `422 ocr_source_rejected` means an exact-correlated malicious verdict was recorded—even if ancillary response fields were malformed. The source is rejected/deleted and policy-associated with the target agreement solely for retention and legal-hold enforcement; it is not usable agreement paper. `503 customer_hosted_ocr_response_untrusted` means an accepted body, response ID, or clean-result shape could not be trusted, so the source remains quarantined, unreadable, and unlinked pending administrator reconciliation or rescan. `503 customer_hosted_ocr_unavailable` restores the prior clean state after a request/header timeout, transport failure, or non-2xx result before Notice accepts a response body. `409` or `503 customer_hosted_ocr_commit_failed` means uncommitted staging was removed and the prior clean state restored for retry. If the final D1 acknowledgement is ambiguous, Notice reads back the exact linked source/version pair: a committed result returns success with `alreadyLinked: true`; an exact pending rollback is cleaned and released; and an unresolved state remains unreadable for reconciliation. `503 ocr_rejection_recording_unavailable` likewise preserves quarantine when a malicious verdict was observed but rejection could not be durably recorded.

When OCR is explicitly disabled, the source may link with `workingVersionCreated: false` until an authorized human supplies reviewed text. The final D1 link/version/snapshot/audit writes are atomic, while the preceding R2 version write uses guarded compensating cleanup only after the object is proven uncommitted.

An upload begins with a seven-day unlinked retention deadline. A successful imported-agreement reservation removes that staging deadline atomically; final linking inherits the agreement's retention and legal-hold values. Unreserved uploads that reach the deadline enter the ordinary guarded retention workflow. The durable receipt contains only digests, the document foreign key, bounded safe response JSON/status, and lifecycle timestamps—never the raw retry key, object key, file bytes, or extracted source text outside the already bounded safe response projection.

Downloads are attachments with `private, no-store`, `nosniff`, and sandbox policy. Quarantined, rejected, soft-deleted, missing, or other-workspace documents are not returned.

## Signature API and webhook

`GET /api/signatures` returns at most 200 workspace packets with sanitized signer evidence. Provider signer URLs and other capabilities are never returned. `GET /api/signatures?include=provider_roles` also validates the pinned DocuSeal 3.2.1 deployment, API-client contract, `/submissions/html` entitlement attestation, and complete configured template before returning its exact ordered `signerRoles` array. The template must be accessible, non-archived, non-public, expose one to ten unique roles, and give every role a required signature or initials field.

`POST /api/signatures` body:

```json
{
  "agreementId": 123,
  "version": 7,
  "parties": [
    { "role": "Counterparty", "email": "signer@customer.invalid", "name": "Authorized Signer" }
  ]
}
```

The route requires a customer-configured DocuSeal adapter, one to ten parties, and a unique normalized email for every signer. It re-reads the complete configured template and requires the submitted role array to match exactly in count, value, and order. It verifies the latest immutable working bytes and SHA-256, checks that every active approval covers the same document/material/workflow basis, and prevents a duplicate active packet. It sends the escaped working paper through DocuSeal's one-off HTML submission API with the configured customer signature-page/template ID, preserves order, requests one merged evidence artifact, applies the configured 1–720 hour expiry and per-signer email 2FA policy, and enables provider email delivery globally and per signer.

Production never exposes or embeds provider signer bearer URLs. A successful `201` response contains `embedSrc: null`; signer URLs are not copied into packet evidence, lists, audit, or export. Provider email delivery is the production signer path. Evaluation mode uses an entirely local signing simulation that neither embeds nor contacts a provider and cannot create verified production evidence.

Typical `201` response:

```json
{
  "signaturePacket": {
    "id": "uuid",
    "status": "pending",
    "submissionId": "456",
    "version": 2,
    "signers": [
      {
        "role": "Counterparty",
        "email": "signer@customer.invalid",
        "name": "Authorized Signer",
        "submitterId": 789,
        "status": "pending"
      }
    ]
  },
  "embedSrc": null,
  "agreement": { "id": 123, "signatureStatus": "Sent", "version": 8 },
  "event": { "id": "uuid", "sequence": 13 },
  "requestId": "uuid"
}
```

After template/basis validation and before the submission-create call, Notice persists a unique packet with status `creating`, version `1`, an active agreement reservation, and stable per-signer recovery keys. Every provider non-success, malformed create response, mapping failure, or transport failure after that point deliberately leaves the packet `creating`; even a provider 4xx does not prove that no submission exists. A provider success followed by an agreement concurrency conflict leaves the mapped `pending` packet in place. In either retained state, do **not** retry `POST` or create a replacement: reload `GET /api/signatures` and reconcile the same packet with `PATCH /api/signatures`. Only the guarded `abandon_unmapped` action described below can release an unmapped `creating` reservation, and only after a fresh exact-empty provider lookup.

Create-specific outcomes:

| Status/code | Meaning and next action |
| --- | --- |
| `400 validation_failed` | IDs/versions/parties are malformed, there are more than ten signers, or signer emails are missing/invalid/duplicated. Correct before retrying. |
| `403 permission_denied` | The member lacks `agreement:update`. |
| `404 agreement_not_found` | No active agreement exists in the verified workspace. |
| `409 version_conflict` | Reload. If provider creation already occurred, the retained packet must be reconciled rather than recreated. |
| `409 signature_stage_required`, `approval_required`, or `approval_basis_changed` | Move through the governed workflow or re-route approval on the exact current basis. |
| `409 document_version_required`, `document_version_unsupported`, `document_version_missing`, or `document_integrity_failure` | Supply/recover a supported exact immutable text/Markdown working version; do not bypass the integrity gate. |
| `409 signature_packet_exists` | Reconcile or resolve the existing active packet. |
| `409 signature_roles_mismatch` | Reload provider roles and submit the exact configured count/order; do not relabel or reorder them. |
| `429 rate_limit_exceeded` | Back off until the rate-limit window resets. |
| `500 internal_error` | A provider/template/create/mapping operation failed safely. Reload packets: if a `creating` packet was persisted, recover that packet; otherwise correct/escalate the pre-create provider failure before retrying. |
| `503 schema_incomplete` or `configuration_incomplete` | Complete the migration/deployment prerequisite before retrying. |

### Recover or refresh a signature packet

`PATCH /api/signatures` request:

```json
{
  "packetId": "uuid",
  "version": 1,
  "action": "reconcile"
}
```

`action` defaults to `reconcile` and accepts exactly these values:

| Action | Eligible packet and effect |
| --- | --- |
| `reconcile` | An `agreement:update` member may recover or refresh `creating`, `pending`, `partially_signed`, `reconciling`, or `archived`. The route never creates a second provider submission. |
| `abandon_unmapped` | A workspace administrator may release only an unmapped `creating` packet at least one hour old. Notice performs a fresh recovery-key lookup and changes the packet to `error` with no active key only when the returned provider list is exactly empty. |
| `supersede_archived` | A workspace administrator may release only a mapped `archived` packet after a fresh provider read still reports `status: pending` plus `archived_at`. The packet becomes `superseded`; any later completion is nonactivating evidence. |

For an unmapped packet, `reconcile` looks up DocuSeal by the stable signer recovery key generated during the original `POST`. A unique exact match is durably mapped. No match returns `provider_mapping_pending` and preserves the reservation; malformed, mismatched, multiple, or failed lookups fail closed. If the paper, material basis, approvals, or lifecycle is stale at mapping time, the packet becomes `superseded`, its active key is cleared, and the agreement does not advance.

For mapped `pending`, `partially_signed`, `reconciling`, or `archived` packets, `reconcile` reads authoritative provider state. Nonterminal reads refresh attributable signer evidence. DocuSeal `archived_at` is reversible: an archived packet retains its active key and can return to `pending` or `partially_signed` after provider unarchive. If another fresh terminal reconciliation lease already owns the work, the route returns `202` with `processing: true`; a `reconciling` lease older than 15 minutes is restored to `pending`, `partially_signed`, or `superseded` according to its durable evidence and active key.

Typical `200` response:

```json
{
  "signaturePacket": {
    "id": "uuid",
    "status": "pending",
    "submissionId": "456",
    "version": 2
  },
  "agreement": {
    "id": 123,
    "signatureStatus": "Sent",
    "version": 8
  },
  "event": {
    "id": "uuid",
    "sequence": 13
  },
  "reconciled": true,
  "basisCurrent": true,
  "providerStatus": "pending",
  "requestId": "uuid"
}
```

Interpret the outcome from the returned fields and authoritative records:

| Outcome | Meaning |
| --- | --- |
| `200`, `reconciled: false` with nonterminal `providerStatus` | The provider had no durable state change. |
| `reconciled: true`, `basisCurrent: true` | The retained submission was mapped on the current basis and the agreement was eligible to advance to `Sent`; terminal reconciliation may then complete or close it. |
| `reconciled: true`, `basisCurrent: false` | The packet was mapped but stale and becomes `superseded`, or terminal stale paper becomes `completed_superseded`; neither can activate the agreement. |
| `reconciled: true` with terminal `providerStatus` | Completion, decline, or expiry was processed. Read the returned packet and agreement for the authoritative result. |
| `200`, `abandoned: true` | An administrator waited one hour, Notice proved no provider submission existed, and the unmapped reservation was released as `error`. |
| `200`, `superseded: true` | An administrator freshly confirmed an archived pending submission and released it as `superseded`. |
| `202`, `processing: true` | A fresh terminal reconciliation lease is already working; retry the same current packet later rather than creating another. |

`event`, `basisCurrent`, `providerStatus`, and action-specific flags are outcome-dependent. The returned `signaturePacket` and `agreement` are authoritative; reload before retrying any optimistic version.

Route-specific recovery errors:

| Status/code | Meaning and next action |
| --- | --- |
| `400 validation_failed` | Packet ID or positive version is invalid. |
| `403 permission_denied` | The member lacks `agreement:update`. |
| `404 signature_packet_not_found` | No packet exists in the verified workspace. |
| `404 agreement_not_found` | The retained packet's active agreement is unavailable. |
| `409 version_conflict` | Reload the packet and retry with its current version. |
| `409 signature_packet_not_recoverable` | `reconcile` accepts only `creating`, `pending`, `partially_signed`, `reconciling`, or `archived`; inspect other terminal/error records instead. |
| `409 signature_packet_not_abandonable` or `signature_packet_abandonment_wait` | `abandon_unmapped` requires an unmapped `creating` packet at least one hour old. Preserve it and wait/reconcile. |
| `409 provider_submission_exists` | The abandonment lookup found a provider submission; use `reconcile`, never abandon or recreate. |
| `409 signature_packet_not_supersedable` or `provider_archive_changed` | `supersede_archived` requires a mapped `archived` packet that a fresh read still reports archived and pending. Refresh/review current provider state. |
| `409 signature_packet_provider_id_invalid` | The mapped provider identifier is unsafe; preserve the packet and escalate for operator review. |
| `409 provider_mapping_pending` | DocuSeal has not exposed a unique submission for the recovery key. Verify the provider account, wait if appropriate, then retry the same `PATCH`—never a new `POST`. |
| `429 rate_limit_exceeded` | Back off until the rate-limit window resets. |
| `500 internal_error` | Provider lookup, ambiguous/multiple mapping, or reconciliation failed safely; keep the packet and escalate with `requestId`. |
| `503 schema_incomplete` or `configuration_incomplete` | Complete the deployment/migration prerequisite before retrying. |

DocuSeal sends the raw webhook body with:

```text
x-docuseal-signature: <unix-seconds>.<hex-hmac-sha256>
```

The HMAC payload is `<timestamp>.<raw-body>`. Timestamps outside ±300 seconds are rejected. The webhook secret must be the `whsec_...` value from DocuSeal's webhook HMAC tab. Partial form events must match a registered signer by non-contradictory provider ID/email evidence. Terminal completion re-reads DocuSeal and requires the exact expected signer count, a one-to-one match for every stored signer, verified signer email identity, `completed` status for all signers, and exactly one supported completion artifact before any artifact is downloaded or written. The clean artifact is retained as review evidence and the agreement stops at `completed_review_required`; provider completion alone never activates it. A Legal or Admin human must then review the exact retained artifact SHA-256 against the exact working-paper version, SHA-256, and basis hash, provide a reason, and explicitly confirm the evidence before activation. A stale packet is `superseded`; a later completed packet is retained as `completed_superseded` evidence and cannot activate the agreement. A successful provider completion atomically emits `signature.completed` into the durable outbox, while the later human review records the distinct activation decision.

## Integration diagnostics

`GET /api/admin/integrations` never returns endpoints, tokens, secrets, template IDs, or account data. Each item reports provider, required/configured/testable state, and a safe diagnostic message. The scanner item also returns `selectedOcrProfile` with execution mode plus the exact deployment-selected model/profile identifiers, or `null`; those identifiers are deliberately non-secret readiness evidence.

`POST /api/admin/integrations` body:

```json
{ "provider": "scanner" }
```

Provider values are `docuseal`, `scanner`, `delivery`, and `crm`. Diagnostics are deliberately non-mutating:

- DocuSeal validates the pinned 3.2.1 deployment/API-contract/entitlement profile and performs an authenticated REST read of the complete configured template. Optional self-hosted MCP performs `initialize` → `notifications/initialized` (exact HTTP 202) → `tools/list`, validates the pinned inventory/annotations, then sends exactly one read-only `load_template` call whose ID and ordered roles must match the REST template. No mutation/open-world MCP tool is called.
- Scanner submits a harmless synthetic text document. When customer-hosted OCR is selected, it also embeds a fresh random challenge in a generated one-page synthetic PDF, sends it through the signed protocol 2.0 extraction path, and requires both the exact challenge and selected model/profile/hash bounded result. It sends no customer document and performs no fallback.
- Delivery/CRM send a signed dry-run event with `x-notice-test: connection` and `payload.dryRun=true`; a conforming gateway must not send mail or change CRM state.

The route can test complete settings before `NOTICE_*_CONFIGURED=true`; the attestation flag should be set only after the result passes and evidence is retained.

### CRM resync and backfill

`GET /api/admin/integrations/resync` requires `integration:manage` and returns agreements in bounded pages. Follow the opaque `nextCursor` with `GET /api/admin/integrations/resync?cursor=...` until it is `null`; there is no fixed overall record cap. Each row includes `eligibleActions`, `historicalCleanup`, and a nullable `resyncBlockedReason`. Profile-bound projection/tombstone actions are calculated for the currently configured and successfully tested immutable CRM profile; a legacy-cleanup action is listed independently when an older projection lacks complete destination metadata. `POST /api/admin/integrations/resync` accepts one explicit operation:

```json
{
  "action": "projection",
  "agreementId": 123,
  "version": 8,
  "reason": "Backfill after approved mapping v3 cutover"
}
```

For `projection` and `tombstone`, the server requires both a complete `NOTICE_CRM_CONFIGURED=true` attestation and a successful, unexpired live diagnostic whose fingerprint matches the current endpoint, credential, provider, and mapping. It atomically increments the authoritative agreement version, records an administrator-attributed audit event and immutable snapshot, and queues a fresh event. A stale version returns `409`. The call returns `202` because downstream acceptance remains asynchronous.

A projection is eligible only when the agreement is active and its own CRM selection matches the configured provider. A tombstone is eligible only for a soft-deleted agreement that matches that provider, or when immutable main-outbox evidence shows a fully profile-bound projection attempt to the exact endpoint/provider/mapping without a same-profile accepted tombstone at that version or later. Projection deliveries in `pending`, `dead`, or `accepted` state on the exact cleanup profile all count because a lost response cannot prove the downstream write did not occur. During a same-provider cutover, however, a restored profile is classified as historical only if it has a prior exact-profile projection and another exact profile has a strictly newer accepted projection that remains unfenced. Any still-unbound, incomplete, pending, or dead newer CRM mutation withholds both repair choices and `POST` returns `409 crm_projection_reconciliation_required` until the outbox evidence is reconciled. A previously used profile already fenced by its accepted tombstone cannot be projected while another accepted profile remains live; `POST` returns `409 crm_profile_reactivation_not_supported`. This prevents provider-name equality or a racing event from deciding profile authority.

Use resync after first CRM enablement, provider/mapping changes, or an approved backfill/reconciliation. To clean a former profile, enter a CRM maintenance window, drain/pause the outbox, reconcile the gateway receipt and provider state for the intended live profile, temporarily restore the exact historical endpoint/provider/mapping, complete a fresh diagnostic, page to the record, and choose `tombstone`. Historical cleanup additionally requires `historicalCleanupConfirmed=true` and the exact typed sentence shown below; otherwise `POST` returns `409 crm_historical_cleanup_confirmation_required`:

```json
{
  "action": "tombstone",
  "agreementId": 123,
  "version": 9,
  "reason": "Approved mapping v2 cleanup in maintenance window CHG-1042",
  "historicalCleanupConfirmed": true,
  "historicalCleanupConfirmation": "I confirm this configured CRM profile is historical, the intended live profile is reconciled, and I will restore, retest, reproject, and verify it before resuming service."
}
```

Notice enables the action only when immutable evidence proves that exact profile has an unresolved projection and, for a same-provider cutover, a newer accepted profile exists. Main-outbox acceptance proves durable handoff to the gateway, not the final provider value, which is why the operator reconciliation and confirmation are required. The `202` response sets `liveProfileReprojectionRequired=true` for historical cleanup. After its tombstone accepts, immediately restore and retest the intended live profile, project the active record at the new higher version, deliver it, and reconcile current provider fields plus `deleted=false` before resuming service. This is required because two mapping profiles may address the same provider object/external ID. Reactivating a previously used and fenced profile is intentionally unsupported by this repair endpoint while another profile remains live. For an approved rollback, create a new immutable mapping-version profile and execute a reviewed maintenance migration rather than reusing the fenced profile identity. The endpoint remains record-at-a-time so every repair has an explicit reason and optimistic version guard.

Pre-profile projection events require a different, deliberately manual path. They are eligible for `legacy_cleanup_attestation` only when their payload selected Salesforce, HubSpot, or Custom CRM and the CRM delivery row is absent or has at least one missing provider, mapping-version, or destination-fingerprint field. Every delivery status is material. The operator must first reconcile or delete every possible downstream copy outside Notice, then submit the exact confirmation:

```json
{
  "action": "legacy_cleanup_attestation",
  "agreementId": 123,
  "version": 9,
  "reason": "Reconciled historical copies against the approved provider export",
  "legacyCleanupConfirmed": true,
  "legacyCleanupConfirmation": "I confirm every legacy CRM copy for this agreement was reconciled or deleted outside Notice."
}
```

This action intentionally does not require or infer the current CRM profile, does not contact a provider, and never creates or alters a delivery receipt. In one guarded transaction it advances the agreement version, records attributed audit evidence, and inserts immutable attestations for at most 20 deterministic oldest event IDs. Each row contains a SHA-256 digest of the persisted payload encoded as recursively sorted-key JSON. Every conditional insert rechecks the workspace, agreement, payload, non-None provider selection, missing profile metadata, and absence of an earlier attestation; a concurrent change aborts the entire batch. The outbox runner uses the same attestation as a race fence: it neither initializes nor binds nor sends that incomplete CRM destination, while a destination that became fully bound first makes the attestation fail. Other delivery sinks retain their ordinary receipt requirements. The final 20-row mutation-guard cleanup uses 22 bound parameters, safely below D1's 100-bind statement limit. The `201` response reports `attestedEvents` and `hasMore`; reload and repeat after a fresh human review while `hasMore=true`. If the agreement is already soft-deleted, the same transaction also queues a fresh exact-current canonical deletion tombstone so retention evidence remains aligned with the new version.

## Retention and legal hold

Policy update example:

```json
{
  "targetType": "agreement",
  "targetId": 123,
  "expectedVersion": 8,
  "legalHold": true,
  "retentionUntil": "2032-12-31",
  "cascadeRetentionToDocuments": true,
  "reason": "Matter preservation notice 2026-17"
}
```

Document targets use a UUID and omit `cascadeRetentionToDocuments`. `retentionUntil` accepts `YYYY-MM-DD`, a timezone-aware ISO timestamp, or `null` for indefinite retention. Date-only values normalize to the end of that UTC day. Agreement hold is an effective hold on linked documents.

The retention job processes bounded batches. Automatic agreement soft deletion applies only to expired, unheld `Active` agreements. Hard purge also requires a prior soft deletion older than `NOTICE_RETENTION_PURGE_GRACE_DAYS`, no linked ineligible/held content, no active or recoverable signature packet, and an exact current-version deletion tombstone whose persisted sinks are all accepted and whose outbox event is finalized. The delivery sink must exist. The same configured grace boundary removes rejected, unconverted intake answers and abandoned or terminal ingestion ledgers; submitted intake remains active until Legal/Admin converts or rejects it, and a linked document/agreement legal hold blocks ledger cleanup. A resource hard purge removes only the ingestion items tied to that resource, preserving unrelated siblings in a mixed batch. Independently, every fully profile-bound historical CRM projection attempt—whether `pending`, `dead`, or `accepted`—must be fenced by an accepted tombstone for that same provider, mapping, and destination fingerprint at an equal or later aggregate version. An older non-`None` CRM event with no delivery row or incomplete profile fields blocks until its payload-bound `legacy_cleanup_attestation` records completed external reconciliation. Disabling or changing CRM therefore cannot silently orphan an ambiguous downstream copy. Missing, pending, or dead current-tombstone receipts appear in `blocked`; restore/reconcile the sink or queue an administrator tombstone resync. The purge transaction re-checks the exact tombstone epoch, historical cleanup, attestations, linked inbound-email and signature-callback receipt counts, negotiation evidence, and active-signature absence. It then deletes those aggregate-linked receipts, tombstone, and attestation rows with the agreement so provider identifiers, body digests, and delivery payloads do not outlive the retained record.

For hard purge, one D1 batch deletes the parent/standalone record under the complete current policy predicate, immediately inserts a `changes() = 1` guarded `purge_jobs` manifest, then deletes dependent rows and records workspace audit/outbox evidence. Only after that batch commits does Notice delete the validated workspace-owned R2 keys. Failed R2 cleanup remains `storage_pending` and is retried before new candidates on the next non-dry run. Rejected-malware cleanup is also durable but differs from hard purge: the record remains as inaccessible security evidence, so every retry rechecks the document and parent legal holds. An OCR-rejected initial source stores its target agreement ID only as a records-policy association; the row remains deleted, unreadable, and ineligible as agreement paper. The worker claims the exact cleanup row before R2 deletion, and a racing hold mutation must lose its guarded D1 update and be retried after the cleanup outcome is known. A target hold applied after the `422` response therefore blocks a later cleanup claim. That claim has no automatic expiry; completion or a handled R2 failure clears it, while an interrupted claim remains fail-closed for a paused-scheduler operator reconciliation rather than risking a late delete under a newly applied hold.

The response distinguishes `d1Purged` IDs from `hardPurged` IDs whose immediate storage attempt also completed. `purgeStorage` reports retry/completion/pending job IDs without exposing object keys; storage failures appear with phase `storage-delete` and produce HTTP `207`.

## Outbox gateway contract

Notice sends `POST` to `NOTICE_DELIVERY_GATEWAY_URL` with JSON `{ "schemaVersion": "1.0", "event": ... }` and:

```text
x-notice-event-id: <event UUID>
x-notice-timestamp: <unix seconds>
x-notice-signature: sha256=<hex HMAC-SHA256(timestamp.body)>
```

The mail gateway must verify signature/freshness using its shared secret of at least 32 characters, deduplicate by event ID, and durably accept responsibility before returning 2xx. The three `notification.*` topics and `negotiation.round_requested` are required mail actions; other supported lifecycle topics may be approved no-op receipts but must never infer recipients from free text. Notice will not emit `negotiation.round_requested` until the general gateway is configured and `NOTICE_NEGOTIATION_MAIL_ACCEPTED=true` records the separate counterparty-message acceptance. For that topic, the gateway sends the bounded subject/message to the explicit external recipient and renders the scoped `portalUrl` as the secure download/upload link; `outboundDocument` supplies the immutable ID, filename, and SHA-256 for display/reconciliation, not attachment bytes or a public document route. The gateway must not claim the file is attached. `replyTo` is present only when the optional inbound gateway is attested: the delivery gateway must use that exact alias when present and must not invent a Notice alias or invite an unmonitored reply when absent. The portal URL is a temporary bearer credential. Notice retains it only while mail delivery is pending, then replaces plaintext with a redaction marker and SHA-256 after acceptance or terminal dead state. Gateway queues/logs must apply equivalent minimization. A terminal event cannot be resent from the redacted payload, and rotating its outbound round does not make it sendable again. Close the failed outbound round to revoke its token, prepare a new round from the current immutable working draft, and send that new round. The product does not include an operator replay tool for this recovery path.

CRM-eligible topics are delivered independently to `NOTICE_CRM_GATEWAY_URL`, signed with a different secret plus the selected provider and mapping version; negotiation topics never mutate CRM. Each persisted sink retries independently; 408, 425, 429, network/timeouts, and 5xx are transient, while redirects and other 4xx responses dead-letter immediately. Transient failures dead-letter after eight attempts. The parent event is processed only after every immutable persisted sink accepts it.

## Workspace export

`GET /api/admin/export` reads every D1 row that contributes to the signed package in one transactional batch snapshot, then verifies every agreement audit chain, every R2 reference prefix, and the tenant-local principal -> grant -> run -> plan -> decision/execution graph before producing an export. The JSON contains soft-deleted and active structured records; sanitized purge-job and integration-diagnostic ledgers; durable service-principal, grant, run, plan, decision, and execution evidence with counts; and an artifact manifest. It omits purge object keys/errors, diagnostic configuration fingerprints/detail, and live idempotency correlation material. Agreement audit exports use the same single-snapshot rule, include only the plan/decision/execution rows named by that agreement's `sourceAgentPlanId` approval or event evidence, and fail closed on a dangling or mismatched reference. R2 artifact bytes are retrieved separately and must be verified against the signed snapshot's size and SHA-256.

The workspace export intentionally does not embed document bytes. Retrieve each allowed application path or exact operator-only storage reference and verify its declared SHA-256 before completing offboarding.

Production agreement/workspace exports return `503` unless `NOTICE_AUDIT_SIGNING_KEY` is available.

## Compatibility and limits

- The agreement register, work-item queues, repository search, governed agent-plan collections/inbox, and CRM-resync maintenance inventory use bounded opaque cursors. Portfolio reporting uses bounded filters and aggregate queries rather than a row page. Several configuration/detail lists retain fixed caps and still require target-environment load evidence for large estates.
- The API is single-workspace-per-deployment and does not accept a tenant selector.
- Provider credentials remain outside the main API. Mail uses the customer's signed delivery gateway; CRM uses the included separately deployed gateway with HubSpot, Salesforce, or signed custom-webhook adapters.
- API consumers should use returned records rather than assuming optimistic local changes succeeded.
- Routes may add fields with application revisions; coordinate external gateway schema changes through `schemaVersion` and topic contracts.

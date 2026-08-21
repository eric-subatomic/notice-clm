# Scanner, mail, inbound-email, and CRM gateway conformance

This is the implementation and acceptance contract for four gateway boundaries:

- the **scanner gateway**, which classifies document bytes before Notice extracts, links, downloads, or accepts them as signed evidence and can optionally run one exact customer-hosted OCR model/profile;
- the **mail delivery gateway**, which durably classifies the complete Notice event catalogue and maps the three approved notification topics plus required counterparty-round requests to the customer's selected mail service;
- the optional **inbound-email gateway**, which receives mail at a generated negotiation-round alias and forwards one exact, bounded, raw-body-signed request to Notice; and
- the **included CRM gateway**, which is deployed from this repository and durably maps a bounded agreement projection to HubSpot, Salesforce, or an approved signed custom webhook.

The scanner, outbound-mail, and inbound-mail provider services are customer-selected boundaries; the repository supplies exact signed contracts for their Notice-facing requests. The CRM receipt/retry service and all three CRM adapters are already implemented under `integrations/crm-gateway/`. The customer configures provider objects, fields, credentials, mapping, and acceptance evidence rather than writing another CRM bridge for the supported projection.

An implementation partner can build the scanner or mail gateway without reading application source, and can deploy the included CRM gateway without modifying it. The executable reference verifiers and tests use no vendor account or production credential:

```bash
node --import tsx --test tests/gateway-conformance.test.ts
node --import tsx --test tests/negotiation-exchange.test.ts tests/negotiation-origin.test.ts tests/negotiation-review-policy.test.ts tests/negotiation-portal-budget.test.ts tests/negotiation-route-security.test.ts
node --import tsx --test tests/crm-gateway-service.test.ts tests/crm-gateway-migrations.test.ts tests/crm-provider-adapters.test.ts
```

The tests send requests through Notice's real scanner and delivery request builders, verify them from the gateway side, exercise tampering and freshness failures, and demonstrate delivery deduplication. `tests/helpers/gateway-conformance.ts` is readable reference code, not production middleware: a deployed gateway must also apply its platform's streaming limits, authentication controls, logging policy, persistence, and monitoring.

## Shared security rules

1. Use different high-entropy secrets for scanning, mail delivery, inbound email, and CRM ingress. Each secret must contain at least 32 characters and live only in the deployment secret manager and its gateway counterpart.
2. Encode the canonical signature input as UTF-8 and calculate HMAC-SHA-256 with the raw secret bytes.
3. The protocol sender transmits the result as 64 lowercase hexadecimal characters after the literal prefix `sha256=`.
4. Compare HMAC values in constant time. Do not log the secret, signature input, raw document, full delivery payload, or recipient data.
5. Require a request timestamp no more than 300 seconds in the past or future. Synchronize both systems to a reliable time source. The inclusive boundary is valid; 301 seconds is not.
6. Expose a direct HTTPS endpoint with no embedded URL credentials. Notice permits plain HTTP only for `localhost` and `127.0.0.1` conformance work and rejects redirects.
7. Verify freshness and HMAC before any provider call or business side effect. Bound the request while reading it; never rely on the signed metadata as a substitute for inspecting the received bytes.

The scanner, signed-event, and inbound-email protocols deliberately use different canonical inputs. The mail gateway and included CRM gateway both receive the signed-event envelope, but use separate URLs and independent secrets. The inbound-email request signs a raw-body digest, not the signed-event body and not scanner metadata. Do not reuse one verifier for another protocol.

## Scanner gateway protocol

### Request

Notice sends `POST` with `Accept: application/json` and a generated `multipart/form-data` content type. Do not require a fixed multipart boundary or part order.

| Header | Required value |
| --- | --- |
| `x-notice-timestamp` | Canonical UTC ISO-8601 with milliseconds, for example `2026-08-01T12:00:00.000Z` |
| `x-notice-signature` | `sha256=<64-lowercase-hex-HMAC>` |

The multipart body contains exactly one value for each security-relevant field:

| Field | Type | Meaning |
| --- | --- | --- |
| `file` | binary file part | The exact bytes to classify. Notice currently accepts PDF, DOCX, RTF, and UTF-8 text up to 20 MiB. |
| `documentId` | text | An opaque Notice identifier. It is currently a UUID; do not derive tenant or authorization from its shape. |
| `sha256` | text | SHA-256 of the exact `file` bytes as 64 lowercase hexadecimal characters. |

The canonical signature input is:

```text
<x-notice-timestamp>.<documentId>.<sha256>
```

The multipart serialization is not signed because its random boundary is transport-specific. The file is bound to the signature through `sha256`, so the gateway must recompute SHA-256 over the received file and compare it with the declared value before trusting the request. The filename and MIME type are useful hints but are not in the HMAC input; treat them as untrusted metadata and inspect the content independently.

Before calling the gateway, Notice applies its own full-byte structural intake boundary: controlled valid UTF-8 and control-character checks for text, bounded header/trailer/xref and referenced-object checks for PDF, balanced bounded RTF with no embedded binary/object controls, or canonical DOCX ZIP entries, verified expansion/checksums, bounded non-overlapping layout, and bounded structure checks over required OOXML parts. The PDF/DOCX checks constrain the accepted structure; they do not prove semantic document validity, safe rendering, or absence of hidden content. The gateway must still inspect the exact bytes independently.

Gateway verification order:

1. require HTTPS, `POST`, a bounded multipart request, and exactly one `file`, `documentId`, and `sha256`;
2. parse and freshness-check the canonical timestamp;
3. require a 64-character lowercase SHA-256 value;
4. recompute the file hash and reject a mismatch;
5. recompute the HMAC over the canonical input and compare it in constant time; and
6. classify the bytes with the approved malware engine under customer byte, decompression, parser, region, retention, and timeout policy.

### Response

A conclusive classification is a 2xx JSON response. Use `malicious` rather than an error status when malware is detected:

```json
{
  "verdict": "clean",
  "provider": "approved-scanner-name",
  "detail": "No malware detected"
}
```

```json
{
  "verdict": "malicious",
  "provider": "approved-scanner-name",
  "detail": "Malware detected"
}
```

| Field | Requirement |
| --- | --- |
| `verdict` | Required; exactly `clean` or `malicious` |
| `provider` | Optional string; Notice defaults to `scan-gateway` and retains at most 120 characters |
| `detail` | Optional non-sensitive string; Notice supplies a default and retains at most 500 characters |

Notice treats a timeout, network failure, non-2xx response, invalid JSON, or unsupported verdict as `unavailable`. The source remains quarantined and is not extracted, linked, or downloadable. Use suitable non-2xx responses for malformed/authentication/rate/availability failures; never return `clean` merely to keep ingestion moving. Notice gives response headers and body one shared end-to-end deadline of at most 15 seconds.

Ordinary v1 scanner calls are read-only. A rescan can repeat the same `(documentId, sha256)` with a new timestamp and signature. Before scanner I/O, Notice atomically claims that exact document version/object key/size/hash and prior state for five minutes; a live claim serializes the call, while an abandoned claim can be recovered only after that window. Only the matching claim may commit clean. An exact correlated malicious verdict remains authoritative over a late or concurrent clean result, including through conflict reconciliation; failure to durably record that rejection leaves the source quarantined and unreadable. It is valid for the gateway to scan again under current definitions; it is not valid to create unrelated external effects. If the gateway caches results, its expiry and engine-definition behavior must follow the customer's malware policy. Protocol v2 inference adds the one-use request identity below.

### Optional customer-hosted OCR request (scanner protocol 2.0)

Ordinary malware scans above remain protocol v1. When deployment administrators select customer-hosted OCR and an authorized user links a clean PDF or DOCX, Notice sends a second request to the **same gateway URL**. It never sends bytes directly to an OCR/model endpoint. The request adds `x-notice-scanner-protocol: 2.0` and exactly five multipart text fields:

| Field | Exact contract |
| --- | --- |
| `requestId` | Fresh canonical lowercase UUIDv4 generated for this one inference attempt |
| `operation` | `extract-text` |
| `modelId` | Exact deployment-selected non-secret identifier |
| `profileId` | Exact deployment-selected non-secret identifier |
| `maximumCharacters` | `400000` |

The existing `file`, `documentId`, and `sha256` fields remain required. Model/profile identifiers contain at most 128 characters, use one or two alphanumeric segments separated by at most one `/`, allow only `.`, `_`, and `-` within a segment, contain no `..`, and are never URLs or credentials.

The v2 canonical HMAC input is the following exact UTF-8 text with newline separators and no trailing newline:

```text
notice-scanner/2.0
<x-notice-timestamp>
<requestId>
<documentId>
<sha256>
extract-text
<modelId>
<profileId>
400000
```

Before inference, apply the ordinary method/content/freshness/file-hash/HMAC checks, reject duplicate or extra fields, then atomically claim the signed `requestId`. Retain that claim for at least ten minutes and reject an already claimed ID without another model call; the five-minute timestamp window independently rejects older captures. Only after the claim succeeds may the gateway run a fresh malware scan and resolve the exact model/profile through a closed customer-controlled allowlist. Unknown, unhealthy, or mismatched selections fail. Never use a default model, another version, an arbitrary URL, or an external fallback. The parser/model service belongs behind the gateway in customer infrastructure with bounded pages/pixels/decompression/CPU/memory/concurrency/time and private or explicitly allowlisted network egress.

A successful response is strict 2xx JSON:

```json
{
  "verdict": "clean",
  "requestId": "<exact-request-uuid>",
  "provider": "customer-isolated-ocr",
  "detail": "Bounded extraction completed",
  "extraction": {
    "status": "complete",
    "modelId": "customer-vision-v1",
    "profileId": "contracts-en-v1",
    "sourceSha256": "<64-lowercase-hex-source-sha256>",
    "text": "<extracted text>"
  }
}
```

The top level accepts only `verdict`, required exact `requestId`, optional `provider` (at most 120 characters), optional `detail` (at most 500 characters), and `extraction`; clean extraction accepts only the five shown fields. Notice requires a nonblank exact-profile/exact-hash result, valid UTF-8 JSON and well-formed UTF-16 text, no lone surrogate or NUL, no more than 400,000 UTF-16 code units or 2,000,000 UTF-8 text bytes, and no more than 2,016,384 response bytes. Valid surrogate pairs remain byte-stable. It gives headers and body one shared end-to-end deadline of at most 30 seconds. A conforming malicious response echoes the exact `requestId` and includes no extraction. As defense in depth, a parseable exact-correlated malicious verdict remains malicious even if ancillary evidence, an extra top-level field, or prohibited extraction content is malformed; gateways must not rely on that tolerance. A missing/wrong request ID, invalid/oversized/incomplete accepted body, body-read timeout/failure, or malformed clean response is untrusted and leaves Notice's source claim quarantined and unreadable. A request/header timeout, transport failure, capacity rejection, or non-2xx result before an accepted body is an unavailable outcome and releases the prior clean state. Notice does not try another model.

After valid clean OCR, known uncommitted persistence failures remove staging and release the claim for retry. An ambiguous final D1 acknowledgement is resolved by exact source/version readback: Notice returns success if committed, releases only after proving the exact pending rollback, and otherwise remains fail-closed. A malicious verdict rejects/deletes the source, records protocol/request/model/profile evidence, and creates no working version. The rejected row keeps its target agreement only as a records-policy association, allowing later legal holds to fence guarded retention cleanup; it never becomes usable agreement paper.

The protected scanner live test runs the v1 harmless scan and, when OCR is selected, embeds a new random challenge in a generated one-page PDF and passes only when the exact per-run challenge returns through this v2 path. A cached/static nonempty response cannot pass. A model/profile or gateway-secret change invalidates prior diagnostic evidence. See [Customer-hosted OCR](./CUSTOMER_HOSTED_OCR.md) for deployment and operating instructions.

### Scanner golden vector

These values are synthetic and must never be used outside tests:

```text
secret:     scanner-conformance-secret-32-characters
timestamp:  2026-08-01T12:00:00.000Z
documentId: bc707ff1-dd31-4e56-9466-bfd1a858c40d
file bytes: expected bytes
sha256:     89a51c27f6905ba4c9a1e284cc4b9c3678fa6660a953c65475d036e7dddd639b
HMAC:       94555c458c9d3cdad6bab4b866f88fedde74dd357182522301305658f83cb53c
header:     sha256=94555c458c9d3cdad6bab4b866f88fedde74dd357182522301305658f83cb53c
```

Scanner protocol v2 uses the same synthetic secret and file hash with this independent golden vector:

```text
timestamp:   2026-08-01T12:00:00.000Z
requestId:   123e4567-e89b-42d3-a456-426614174000
documentId:  bc707ff1-dd31-4e56-9466-bfd1a858c40d
sha256:      89a51c27f6905ba4c9a1e284cc4b9c3678fa6660a953c65475d036e7dddd639b
modelId:     customer-vision-v1
profileId:   contracts-en-v1
canonical:   notice-scanner/2.0\n2026-08-01T12:00:00.000Z\n123e4567-e89b-42d3-a456-426614174000\nbc707ff1-dd31-4e56-9466-bfd1a858c40d\n89a51c27f6905ba4c9a1e284cc4b9c3678fa6660a953c65475d036e7dddd639b\nextract-text\ncustomer-vision-v1\ncontracts-en-v1\n400000
HMAC:        c18870557542d9c3c6d7d111ee89ab1d92d4ee5043295764bf5916787019288b
header:      sha256=c18870557542d9c3c6d7d111ee89ab1d92d4ee5043295764bf5916787019288b
```

## Counterparty exchange and inbound-email protocol

### Portal-token and reply-alias semantics

A prepared negotiation round is bound to the exact immutable outbound document ID and SHA-256. At most one round is active for an agreement. When the portal is enabled, Notice generates a random 32-byte token encoded as 64 lowercase hexadecimal characters and places it in `/api/exchange/<token>`. The negotiation-round row stores only the token's SHA-256; an automated-mail outbox event temporarily carries the scoped plaintext URL while delivery is pending and scrubs it after accepted or terminal-dead state as described below. The raw token is a scoped bearer credential: keep it out of logs, analytics, referrers, support tickets, and monitoring query strings. Rotation replaces the stored hash but does not reset the round's durable transfer budget; resolving or closing the round clears the capability. Production requires an explicit portal TTL of 1–336 hours.

Each round also has one random 12-byte alias code, rendered only as `reply-<24-lowercase-hex>@<NOTICE_INBOUND_EMAIL_DOMAIN>`. The inbound receiver must route only the configured domain and exact generated alias form. It must not accept plus-address variants, arbitrary local parts, catch-all forwarding to other Notice routes, or a domain chosen from untrusted message content. Notice normalizes the recipient, requires the configured domain, extracts the exact code, and looks up that round only in the configured workspace.

The corporate identity edge should bypass its interactive user policy only for `/api/exchange/*` and, when email capture is enabled, exact `POST /api/webhooks/email`. Do not bypass `/api/*`, `/api/webhooks/*`, document downloads, agreement APIs, or the human application. These route exceptions do not make the rest of the origin public; block preview, `workers.dev`, and alternate-host access.

### Portal HTTP boundary

The scoped counterparty endpoint is `GET|POST /api/exchange/<64-hex-token>`; the token appears only in the path, never a query string, form field, cookie, or header. `GET` serves a self-contained HTML download/upload form with no third-party assets. `GET ?format=json` returns scoped round metadata plus the fixed transfer policy, but never current counters or reservation state. `GET ?download=1` first durably charges one attempt and the exact outbound size, then returns the exact hash-verified bytes with `X-Document-SHA256`; an R2 read failure remains charged. Every successful portal representation uses no-store/CDN-no-store, no-referrer, nosniff, deny-frame, noindex, restrictive permissions and cross-origin-resource headers, and a same-origin/no-external-resource CSP.

`POST` requires an `Origin` exactly matching the request origin and rejects cross-site mutation. It accepts `multipart/form-data` with exactly one `file` (1 byte through 20 MiB), required text `senderEmail`, and optional text `senderName`; implementations should send no other fields. The entire multipart body is capped at 21 MiB. Before reading the body or invoking the scanner, Notice atomically reserves 21 MiB and the round's single upload-work slot for five minutes. A completed bounded read reconciles the reservation to actual multipart bytes; an aborted, oversized, or otherwise incomplete read retains the full 21 MiB charge. A stale reservation is charged as one rejected/failed attempt before replacement, and an old lease owner cannot commit.

The durable budget belongs to the exchange round across token rotations: no more than 10 upload attempts total, with at most 4 accepted and at most 6 rejected/failed, and no more than 96 MiB cumulative multipart bytes; no more than 20 outbound downloads and 256 MiB cumulative outbound bytes are admitted. A concurrent upload returns `429 exchange_upload_busy` with `Retry-After: 5`. Exhausted upload or download limits return `429` and require the contract sender to create a new round; replacing the current round's token does not reset them. Invalid tokens return `404`, expired/revoked links return `410`, and a changed transfer basis returns `409`. Notice rechecks the token hash/expiry immediately before any ready return advances the round, structurally inspects and scans the bytes, and creates an immutable portal submission. A successful browser response is HTML `201`; clients requesting `application/json` receive a bounded `201` receipt.

Portal upload is possession-token authorization, not proof that the typed sender controls the prepared counterparty mailbox. Notice records the supplied sender and still requires an authenticated human review/promotion. Do not place reviewed text in the portal form: only an authenticated Notice member may supply trusted review text after examining the returned source.

### Inbound request and raw-body signature

The inbound gateway sends exactly one `POST /api/webhooks/email` request with `multipart/form-data`. The complete HTTP body, including every boundary, header line, CRLF, manifest byte, attachment byte, and closing delimiter, is capped at **21 MiB** (`22,020,096` bytes). The edge and every intermediary must forward exactly the bytes the gateway hashed; do not parse/reserialize, normalize line endings, or decompress/recompress the body.

| Header | Required value |
| --- | --- |
| `Content-Type` | `multipart/form-data; boundary=<generated-boundary>` |
| `x-notice-email-event-id` | Stable provider event identifier; 1–200 ASCII letters, digits, `.`, `_`, `:`, or `-` |
| `x-notice-content-sha256` | SHA-256 of the exact raw multipart body; exactly 64 lowercase hexadecimal characters |
| `x-notice-timestamp` | Unix time in whole positive decimal seconds; 1–13 digits |
| `x-notice-signature` | `sha256=<64-lowercase-hex-HMAC>` |

Calculate the canonical signature in this order:

1. serialize the final multipart body once;
2. calculate lowercase hexadecimal `bodySha256 = SHA256(exactRawBodyBytes)`;
3. calculate `HMAC-SHA256(NOTICE_INBOUND_EMAIL_SECRET, UTF8("<timestamp>.<bodySha256>"))`; and
4. send that HMAC after the exact lowercase `sha256=` prefix.

Notice re-reads the bounded raw body, recomputes `bodySha256`, requires it to equal `x-notice-content-sha256`, enforces a timestamp no more than 300 seconds in the past or future, recomputes the HMAC, and compares the fixed-width value in constant time before parsing multipart. The inclusive 300-second boundary is valid; 301 seconds is not. The secret must be independent and managed, contain at least 32 characters, and encode to no more than 4096 UTF-8 bytes. This contract signs the raw-body **digest**; it is intentionally different from the signed-event protocol, which signs the raw JSON body directly.

### Exact multipart manifest

The body contains exactly one text field named `manifest`. Its value is strict JSON with no unrecognized properties. Every other multipart field must be one unique file part named by the manifest; no detached, duplicate, or unlisted file is accepted.

```json
{
  "schemaVersion": "1.0",
  "providerEventId": "evt-01J...",
  "providerMessageId": "provider-message-01J...",
  "internetMessageId": "<optional-rfc-message-id@example.invalid>",
  "inReplyTo": "<optional-parent-message-id@example.invalid>",
  "from": {
    "email": "counterparty-counsel@example.invalid",
    "name": "Counterparty counsel"
  },
  "to": "reply-0123456789abcdef01234567@redlines.customer.invalid",
  "authentication": {
    "aligned": true,
    "spf": "pass",
    "dkim": "pass",
    "dmarc": "pass"
  },
  "attachments": [
    {
      "fieldName": "attachment_0",
      "fileName": "counterparty-redline.docx",
      "contentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "size": 12345,
      "sha256": "<64-lowercase-hex-sha256-of-the-exact-file-bytes>"
    }
  ]
}
```

| Manifest field | Contract |
| --- | --- |
| `schemaVersion` | Exactly `1.0` |
| `providerEventId` | Required, 1–200 characters matching `[A-Za-z0-9._:-]+`; must exactly equal `x-notice-email-event-id` and remain stable across retries |
| `providerMessageId` | Required nonblank provider message identifier, at most 500 characters; remains stable across retries and deduplicates submissions within the round |
| `internetMessageId`, `inReplyTo` | Optional strings, each at most 500 characters; correlation metadata only, never authorization |
| `from.email`, `from.name` | Email is required and 3–320 characters; name is optional and at most 200. Notice later applies strict single-address normalization and compares the normalized sender with the round's expected counterparty. |
| `to` | Required 3–320 character recipient; must be the exact generated alias on the configured inbound domain |
| `authentication.aligned` | Required boolean derived from provider-verified authentication/alignment, not a caller-controlled mail header. A clean attachment becomes ready only when this is `true` **and** the normalized sender exactly matches the prepared counterparty. |
| `authentication.spf`, `dkim`, `dmarc` | Optional; when supplied, each is exactly `pass`, `fail`, `neutral`, or `unknown`. They are signed descriptive inputs; `aligned` is the explicit gate used by Notice. |
| `attachments` | Required array with 0–5 entries. Zero attachments is accepted as a durable `no_attachment` response, not as a new working paper. |

Each attachment entry is strict. `fieldName` is one of `attachment_0` through `attachment_4` and must be unique; `fileName` is 1–255 characters; `contentType` is 1–200; `size` is 1 byte through 20 MiB; and `sha256` is exactly 64 lowercase hexadecimal characters. The actual multipart file name, byte length, and media type must exactly match the entry. Notice recomputes the file SHA-256 during ingestion, applies the full-byte format/container boundary described above rather than trusting MIME, and runs the production scanner. The 21 MiB aggregate body cap still applies when multiple attachments are listed.

The gateway should derive `from`, `to`, authentication, stable event/message identifiers, and attachment bytes from its authenticated provider event—not from arbitrary forwarded headers or message text. Remove active mail-provider wrappers before serializing only if the customer's documented process intentionally does so; the signed manifest and attachment hashes must describe exactly what Notice receives.

### Replay, processing, and response semantics

Notice stores the `providerEventId` with the already verified SHA-256 of the exact raw multipart body before ingestion. An exact retry therefore keeps the event ID and body bytes unchanged; only the timestamp/signature headers are refreshed. Reusing an event ID with different raw bytes—or reusing a body digest under another event identity—is a security collision. A workspace-wide provider-message ID fence prevents a different signed event from duplicating the same provider message across rounds.

| Response | Meaning and gateway action |
| --- | --- |
| `200` with `accepted:true` | Ingestion durably completed, or the identical event was already processed. Stop retrying; inspect `replay` only for telemetry. |
| `400` / `415` | Event ID, multipart, manifest, attachment inventory, or media type is invalid. Do not retry unchanged. |
| `401` | Raw-body hash, freshness, or signature failed. Do not retry unchanged; investigate clock/secret/body transformation. |
| `404` | Recipient is not a configured generated round alias. Do not retry unchanged or disclose whether another workspace/round exists. |
| `409` | Provider event identity/raw-body digest or provider-message identity collided. Quarantine and alert; do not generate a new ID to conceal the collision. |
| `410` | This is a new event for a resolved, closed, expired, or otherwise inactive round. Notice retains the terminal receipt but no returned document; stop retrying unchanged. An event already processed before closure still replays as `200`. |
| `413` | Aggregate request exceeded 21 MiB or a declared/file attachment exceeded its bound. Do not retry unchanged. |
| `429` | Best-effort per-workspace ingress limit was exceeded. Back off and retry the identical signed event with a fresh timestamp/signature and unchanged body/event IDs. |
| `503` with `Retry-After: 5` | Processing is busy or failed after a durable claim. Retry the identical body/event identifiers with a fresh timestamp/signature. A processing lease becomes reclaimable after 15 minutes. |

Email returns never promote a working document automatically. A missing attachment records `no_attachment`; scanner failure quarantines; malicious or invalid content rejects; and a sender or authentication mismatch records `sender_review`. A new callback to a resolved, closed, or otherwise inactive alias returns a durable `410` rejection and is not stored as a document; an exact replay of an event that completed before closure still returns its existing `200` receipt. An authenticated Notice user may separately record a genuinely late file through the manual evidence path. A clean, aligned, expected-sender attachment becomes `ready`, but an authenticated Notice user must still review the exact file and explicitly promote reviewed text. Production does not parse DOCX tracked changes or make legal/playbook verdicts.

### Inbound-email golden vector

These synthetic values use a zero-attachment manifest and must never be used as deployment credentials. The body is **530 bytes**. `rawBodyEscaped` is a JSON string representation: decode each `\r\n` as the two CRLF bytes and do not add a trailing byte beyond the final represented CRLF.

```text
secret:       inbound-email-conformance-secret-32-characters
timestamp:    1785585600
content-type: multipart/form-data; boundary=notice-email-boundary
event id:     evt-conformance-001
rawBodyEscaped: "--notice-email-boundary\r\nContent-Disposition: form-data; name=\"manifest\"\r\nContent-Type: application/json\r\n\r\n{\"schemaVersion\":\"1.0\",\"providerEventId\":\"evt-conformance-001\",\"providerMessageId\":\"provider-message-001\",\"internetMessageId\":\"<message-001@example.invalid>\",\"from\":{\"email\":\"counsel@counterparty.invalid\",\"name\":\"Counterparty counsel\"},\"to\":\"reply-0123456789abcdef01234567@redlines.customer.invalid\",\"authentication\":{\"aligned\":true,\"spf\":\"pass\",\"dkim\":\"pass\",\"dmarc\":\"pass\"},\"attachments\":[]}\r\n--notice-email-boundary--\r\n"
body SHA-256: 4eb3b778b574041d4fd4e9e7a9e9e6e67a1e2bbff4ebeb7ed74d3b4f128f332e
canonical HMAC input: 1785585600.4eb3b778b574041d4fd4e9e7a9e9e6e67a1e2bbff4ebeb7ed74d3b4f128f332e
HMAC:        bc2653e9a657c76a9cd4ea84ddde55aca3058656d792830b0470b6c8f78ef88a
signature:   sha256=bc2653e9a657c76a9cd4ea84ddde55aca3058656d792830b0470b6c8f78ef88a
```

The executable assertion for this exact fixture is in `tests/negotiation-exchange.test.ts`.

## Signed event protocol

### Request and signature

Notice sends `POST` with `Content-Type: application/json`.

| Header | Required value |
| --- | --- |
| `x-notice-event-id` | Exact match for JSON `event.id`; the stable idempotency key across retries |
| `x-notice-timestamp` | Unix time in whole decimal seconds |
| `x-notice-signature` | `sha256=<64-lowercase-hex-HMAC>` |
| `x-notice-test` | Absent for normal delivery; exactly `connection` for a connection diagnostic |

The canonical signature input is:

```text
<x-notice-timestamp>.<exact raw HTTP request body>
```

Verify the HMAC against the exact received body bytes before parsing JSON. Whitespace and property order are significant to the signature; parsing and reserializing before verification will reject valid messages or create an ambiguity.

The version 1.0 envelope is:

```json
{
  "schemaVersion": "1.0",
  "event": {
    "id": "45f6d30d-6dad-420a-832c-613f54b34b67",
    "workspaceId": "orchid-firm",
    "topic": "notification.approval_reminder",
    "aggregateType": "approval",
    "aggregateId": "18d22f9f-f50a-4df5-824a-13684de80ad2",
    "payload": {
      "approvalId": "18d22f9f-f50a-4df5-824a-13684de80ad2",
      "agreementId": 4102,
      "role": "Legal",
      "due": "2026-08-15",
      "recipient": {
        "userId": "user-9",
        "email": "approver@example.invalid",
        "displayName": "Approval Owner"
      }
    },
    "createdAt": "2026-08-01T12:00:00.000Z"
  }
}
```

| Envelope field | Contract |
| --- | --- |
| `schemaVersion` | Required string; exactly `1.0` for this document |
| `event.id` | Required opaque string; stable across Notice retries |
| `event.workspaceId` | Required workspace identifier; use it in every downstream ownership/mapping lookup |
| `event.topic` | Required allowlisted routing key |
| `event.aggregateType` / `aggregateId` | Required source-record reference; not an authorization decision by itself |
| `event.payload` | Required JSON object whose fields depend on `topic` |
| `event.createdAt` | Required ISO-8601 time when Notice created the durable event; it does not change on retry |

Gateways should reject an unsupported `schemaVersion`, validate required topic fields, ignore additive unknown payload fields, and never route an unknown topic to a default provider action. A future breaking envelope change will use another schema version. Every newly emitted payload also carries `topicVersion: "1.0"`; lifecycle payloads may carry `aggregateVersion` and `causationId`. Treat these as protocol metadata, not user input.

### Version 1.0 topic catalogue

| Topic | Payload fields |
| --- | --- |
| `notification.workspace_access` | `workspaceId`, `role`, `recipient { userId, email, displayName }` |
| `notification.approval_reminder` | `approvalId`, `agreementId`, `role`, `due`, `recipient { userId, email, displayName }` |
| `notification.obligation_reminder` | `obligationId`, `agreementId`, `title`, `dueDate`, `recipient { userId, email, displayName }` |
| `negotiation.round_requested` | `roundId`, `agreementId`, `roundNumber`, `party`, `agreementType`, `subject`, optional `message`, external `recipient { email, displayName }`, optional `replyTo`, sensitive `portalUrl`, `outboundDocument { id, fileName, sha256 }`, `sentBy { userId, email, displayName }` |
| `agreement.created` | `agreementId`, `version`, optional `documentVersion` (present for generated starter paper), `crmAgreement` |
| `agreement.updated` | `agreementId`, `version`, `changedFields[]`, `crmAgreement` |
| `agreement.stage_changed` | `agreementId`, `from`, `to`, `version`, `crmAgreement` |
| `agreement.deleted` | `agreementId`, `version`, `externalKey`, `tombstone` (`true`), `deletedAt`, `crm`, `crmRecord` |
| `approval.requested` | `approvalId`, `agreementId`, `requestedByUserId`, `approverUserId` (nullable), `documentVersion`, `documentSha256`, `basisHash` |
| `approval.assigned` | `approvalId`, `agreementId`, `approverUserId` |
| `approval.decided` | `approvalId`, `agreementId`, `status`, `decidedByUserId` |
| `obligation.created` | `obligationId`, `agreementId`, `ownerUserId` (nullable), `dueDate` |
| `obligation.completed` | `obligationId`, `agreementId` |
| `language.created` | `languageBlockId`, `version` |
| `language.updated` | `languageBlockId`, `version` |
| `signature.packet_created` | `packetId`, `agreementId`, `provider`, `submissionId`, `documentVersion`, `documentSha256`, `basisHash` |
| `signature.packet_abandoned` | `packetId`, `agreementId`, `provider`, `reason` (`provider_mapping_absent`), `verifiedAt` |
| `signature.packet_archived` | `packetId`, `agreementId`, `provider`, `submissionId`, `documentVersion`, `documentSha256`, `basisHash`, `status` (`archived`), `actionable` (`false`), `recovered` (`true`) |
| `signature.packet_superseded` | `packetId`, `agreementId`, `provider`, `submissionId`, `documentVersion`, `documentSha256`, `basisHash`, `status` (`superseded`), `actionable` (`false`), `recovered`; optional `reason` (`administrator_released_archived_packet`) is present for administrator archive release |
| `signature.completed` | `packetId`, `agreementId`, `provider`, `submissionId`, `status`, `activated`, `documentVersion`, `documentSha256`, `evidenceDocumentId`, `crmAgreement` |
| `retention.d1_purged` | `resourceType`, `resourceId`, `d1PurgedAt`, `storageStatus` (`storage_pending`), `purgeJobId` |

Exactly four version 1.0 topics carry a direct recipient: the three `notification.*` topics and `negotiation.round_requested`. The mail gateway must accept and classify every supported catalogue topic because Notice uses its delivery sink for the full event stream, but it must not infer a recipient from free text or send other lifecycle events as email. A supported non-recipient lifecycle topic may become an approved no-op receipt or another explicitly approved non-CRM integration action. `negotiation.round_requested` is **not** an allowed no-op: a 2xx response means the gateway durably accepted responsibility to send the approved subject/message to `recipient.email` and render the scoped `portalUrl` as the secure link for downloading and returning the exact outbound paper. When optional inbound capture is attested, the payload includes `replyTo` and the gateway must set that exact round alias. When it is absent, the gateway must not invent a Notice alias or invite an unmonitored reply; it uses only the operator-approved sender behavior and the counterparty returns through the portal. The `outboundDocument` ID, filename, and SHA-256 identify that immutable paper for display/reconciliation; they are not attachment bytes or a public download URL. The gateway must not say the file is attached and must not fetch it through an unauthorized human route.

Treat `portalUrl` as a short-lived bearer credential. Allowlist the exact configured Notice HTTPS origin and `/api/exchange/` path, prevent redirects or link rewriting that exposes it to an unrelated domain, do not place it in logs/analytics/provider metadata beyond what is required to deliver the email, and retain it in gateway queues only as long as required by the accepted retry/evidence policy. Notice must keep plaintext temporarily while its durable mail delivery is pending. After the required delivery is accepted—or reaches terminal dead state—Notice replaces the persisted plaintext URL with a redaction marker plus its SHA-256 so D1 history/backups do not extend bearer exposure. Operators cannot resend a terminal event from that redacted record, and rotating its outbound round does not make it sendable again. The supported recovery is to close the failed outbound round, which revokes its token, prepare a new round from the current immutable working draft, and send that new round. The product does not include an operator replay tool for this path.

CRM synchronization is a separate outbox sink and separate gateway secret; do not duplicate it behind the mail gateway. The included CRM gateway allowlists only `agreement.created`, `agreement.updated`, `agreement.stage_changed`, `signature.completed`, and `agreement.deleted`, derives a smaller bounded provider projection, and never routes notification/approval/obligation/language/negotiation topics to a CRM mutation.

`crmAgreement` is authoritative server-produced state, not a patch. It contains stable `externalKey`, workspace/agreement identity and version, party, type, value, stage, owner, department, risk, approval/signature status, effective/expiration dates, existing CRM link fields, and `updatedAt`. The included gateway forwards only its explicit mapped fields. `agreement.deleted` carries a tombstone instead of live projection data.

`approval.decided` records one attributed request decision; it does not include a lane/role field and does not assert that the agreement aggregate has satisfied every required approval lane. A gateway that needs aggregate or lane state must reconcile the agreement through an authorized integration process rather than infer it from one event.

`signature.packet_abandoned` proves an administrator waited for the guarded window and Notice received an exact empty provider recovery lookup before releasing an unmapped packet. `signature.packet_archived` preserves a reversible provider reservation; it is not terminal and is not actionable. `signature.packet_superseded` is also nonactionable: `recovered=true` means stale-basis recovery released it, while `recovered=false` plus the documented `reason` means an administrator freshly confirmed and released an archived pending packet. None of these topics is a signing invitation or contains a signer URL.

For `signature.completed`, `status` is `completed_review_required` with `activated=false` when provider completion produced current retained evidence that still requires exact Legal/Admin review, `completed` with `activated=true` only after that review activates the agreement, or `completed_superseded` with `activated=false` when Notice retained completion evidence but the document, material agreement basis, lifecycle, or approval authority no longer matched. Use the explicit `activated` boolean; never interpret provider completion alone as activation.

`retention.d1_purged` is deliberately not a final storage-deletion event. It proves the guarded D1 purge and durable manifest committed, while `storageStatus` remains `storage_pending`. Use `purgeJobId` for operator reconciliation; final R2 completion is recorded in `purge_jobs` and the authenticated retention-job result, and version 1.0 emits no R2-completed topic.

### Idempotency and response semantics

Any HTTP 2xx response means that gateway durably accepted responsibility for its sink. Notice ignores the response body and marks only that sink accepted. Mail and CRM have independent delivery rows; the logical outbox event is processed only after every required sink accepts it. A timeout or non-2xx response retries only the failing sink and can eventually place that sink in dead state. Notice waits up to 15 seconds, so asynchronous gateway processing is recommended.

Before returning 2xx, atomically persist `event.id` as the idempotency key together with the accepted raw body digest, workspace, topic, status, and receipt time. Then:

- on the first valid event, enqueue or perform the single approved downstream action;
- on the same `event.id` and same body, return 2xx without repeating the effect;
- on the same `event.id` with different content, quarantine it as a collision/security incident and do not perform an effect; and
- pass `event.id` to the downstream provider as its idempotency key when supported.

Delivery is at least once per required sink; exactly-once effects require durable gateway deduplication and provider reconciliation. Do not rely on timestamps or signatures for deduplication because both change on retry. Do not assume global event ordering.

Recommended responses are `202` for a newly durably queued event, `200` or `204` for an already accepted identical event, `400` for malformed input, `401` for failed HMAC/freshness, `422` for unsupported schema/topic, `429` for deliberate back-pressure, and `503` when durable acceptance is unavailable. Error bodies are optional and must not expose secrets or payload content.

### Connection diagnostic and dry-run semantics

The protected Notice integration diagnostic sends a signed event through the same request builder. A valid diagnostic has all of these markers:

```text
x-notice-test: connection
event.workspaceId: __connection_test__
event.topic: integration.delivery.connection_test
             or integration.crm.connection_test
event.aggregateType: system
event.aggregateId: <same value as event.id>
event.payload: { "dryRun": true, "channel": "delivery" | "crm" }
```

Verify HMAC, freshness, schema, event-ID equality, and both dry-run markers first. A valid connection diagnostic must not send mail, call a CRM mutation, reserve a provider identifier, or write customer business data. It may write a bounded gateway diagnostic receipt and should return 2xx. Reject a request that has only the header or only `payload.dryRun=true`; never let a partially marked diagnostic fall through to a real action.

`NOTICE_DELIVERY_GATEWAY_URL` and `NOTICE_CRM_GATEWAY_URL` are separate runtime destinations with independent HMAC secrets and acceptance state. A valid mail diagnostic proves nothing about CRM, and vice versa.

## Included CRM gateway

Deploy the CRM gateway as a second Cloudflare Worker only when CRM is enabled. Use the strict non-secret example manifest and plan/render tool:

```bash
cp deploy/crm-gateway.deployment.example.json .wrangler/crm-gateway.deployment.staging.json
node --import tsx scripts/crm-gateway-kit.mjs dry-run .wrangler/crm-gateway.deployment.staging.json
node --import tsx scripts/crm-gateway-kit.mjs render .wrangler/crm-gateway.deployment.staging.json
```

The rendered Worker exposes `GET /healthz`, accepts signed events only at `POST /v1/events`, binds an independent `CRM_DB`, and installs a retry/recovery Cron Trigger. The main Worker's `NOTICE_CRM_GATEWAY_SECRET` and the gateway's `NOTICE_INGRESS_SECRET` are the same ingress key stored independently in each Worker's secret set. `NOTICE_INGRESS_PREVIOUS_SECRET` supports a bounded rotation overlap. Provider credentials stay only in the gateway secret set.

Before returning 202 for a new business event, the included gateway verifies raw-body HMAC/freshness and strict envelope/topic bounds, normalizes the provider-neutral CRM projection, and persists the event ID plus body digest. An identical replay is accepted without another effect; an event-ID/body collision is quarantined. Per-agreement aggregate leases serialize effects. The first durably accepted event at the highest aggregate version owns a monotonic watermark; lower versions and later nonwinning events at the same version become `superseded` before provider mutation, even when the winning attempt is retrying, dead, or its terminal receipt has later been pruned. Transient provider failures retry with bounded backoff/`Retry-After`; permanent or exhausted failures become `dead`; the scheduled handler recovers stale leases and prunes old completed receipts without removing that aggregate watermark.

The supported provider paths are:

| Adapter | Included behavior | Customer-specific inputs |
| --- | --- | --- |
| HubSpot | Private-app bearer authentication, configurable object and unique ID property, batch upsert by stable Notice external key | Approved object/properties, unique ID property, private-app token/scopes, optional field mapping |
| Salesforce | Client-credentials token flow, allowlisted Salesforce instance host, configurable object/external-ID field, external-ID upsert | Connected app, integration user/scopes, approved object/fields and external-ID field, optional field mapping |
| Custom | HTTPS JSON projection, HMAC/timestamp, dry-run and idempotency headers, redirect rejection | Approved receiving endpoint, independent shared secret, optional external-ID field/mapping, durable downstream idempotency |

Use [the CRM gateway deployment guide](../integrations/crm-gateway/README.md) for exact manifest fields, provider secret names, default mappings, migration order, and synthetic checks. Do not set the main Worker's `NOTICE_CRM_CONFIGURED=true` until the no-side-effect diagnostic and an approved synthetic provider create/update/tombstone flow pass. `agreement.deleted` deliberately maps a tombstone (`deleted=true`); it does not instruct an adapter to hard-delete provider data.

## Signed-event golden vector

These values are synthetic and must never be used outside tests. The body is one exact line with no trailing newline.

```text
secret:    delivery-conformance-secret-32-characters
timestamp: 1785585600
body:      {"schemaVersion":"1.0","event":{"id":"5eb479d4-f747-4b6e-9a8d-5ef31f155f0e","workspaceId":"__connection_test__","topic":"integration.delivery.connection_test","aggregateType":"system","aggregateId":"5eb479d4-f747-4b6e-9a8d-5ef31f155f0e","payload":{"dryRun":true,"channel":"delivery"},"createdAt":"2026-08-01T12:00:00.000Z"}}
HMAC:      2a588e799aa6c5bad69dfe28baddfb059710fbc8bb31bcf9c5f1df86f6af58f1
header:    sha256=2a588e799aa6c5bad69dfe28baddfb059710fbc8bb31bcf9c5f1df86f6af58f1
```

## Implementation and acceptance checklist

1. Run the repository conformance test unchanged and retain the result with the reviewed revision.
2. Port the verifier behavior into customer-selected scanner/mail/inbound-email gateways. Add their own tests using the applicable golden vectors. Do not rewrite the included CRM gateway for a supported provider.
3. Add negative tests for wrong secret, changed body/file, stale and future timestamps, duplicate fields, duplicate event, event-ID collision, wrong alias/domain, partial dry-run markers, oversized input, timeout, and provider failure.
4. Prove scanner `clean`, `malicious`, malformed, and unavailable behavior without customer documents; prove full-file/container structural rejection, five-minute rescan claim serialization/stale recovery, and malicious-over-clean race dominance.
5. Keep `NOTICE_NEGOTIATION_MAIL_ACCEPTED=false` on the production target while the gateway directly receives signed synthetic `negotiation.round_requested` fixtures and proves first acceptance, identical replay, collision, dry run, unsupported topic, exact rendered portal link, explicit recipient, no invented attachment, optional exact Reply-To, and bearer-safe logging/retention. After that gateway-only acceptance passes, set the flag true only in an isolated staging deployment containing no customer data; run a synthetic Notice round to prove delivery, retry/dead behavior, terminal URL scrubbing, and reconciliation. Retain both phases of evidence, then use same-source configuration promotion to enable the flag on production and repeat one harmless synthetic delivery before admitting real counterparty data.
6. For every portal deployment, prove upload/download attempt-and-byte exhaustion, one-upload busy `429`/`Retry-After: 5`, stale-lease charging and old-owner fencing, token-rotation non-reset, hidden current counters, pre-R2 download charging, and new-round recovery. When inbound email is enabled, also prove exact raw-body golden verification, changed-body/digest rejection, freshness, event/manifest collision, identical retry, busy/failed retry, alias/domain enforcement, authentication/sender review, zero/one/multiple attachment handling, hash/metadata mismatch, body/file/count limits, scanner quarantine/rejection, and explicit human promotion.
7. When CRM is enabled, deploy/migrate the included gateway and prove invalid ingress, first acceptance, identical replay, event-ID collision, partial dry-run rejection, provider authentication, retry/dead behavior, stale-version supersession, mapping-version control, and synthetic create/update/tombstone reconciliation.
8. Configure staging endpoints and managed secrets while `NOTICE_*_CONFIGURED=false`, then run the protected Notice diagnostics and retain both Notice and gateway receipt evidence.
9. Run an approved synthetic end-to-end workflow, verify provider-side state and no dry-run side effect, then set the corresponding attestation flag true and retest.
10. Complete customer review of provider accounts, data region/retention, mappings, recipients, scopes, logs, alerts, SLA, incident contacts, secret rotation, and reconciliation procedures.

The local kits do not prove production TLS/egress, clock synchronization, streaming/resource limits, malware efficacy, live vendor credentials, customer mapping correctness, downstream idempotency, deliverability, observability, load behavior, or regulatory/vendor approval. Those are deployment acceptance responsibilities; they do not imply missing Notice CLM, SSO, or supported CRM-adapter code.

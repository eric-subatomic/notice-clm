# Customer-hosted OCR and bring-your-own model

Notice can create the first immutable text working version of a clean PDF or DOCX with a deployment-admin-selected OCR/model profile hosted by the customer. The model does not run in the application Worker, and Notice never calls a model vendor or model host directly. Document bytes cross only the existing HMAC-authenticated scanner gateway; that customer-operated gateway performs a fresh malware check, resolves one exact allowlisted model/profile in customer infrastructure, runs bounded extraction, and returns bounded text tied to the source SHA-256.

No OCR engine, model image, weights, provider account, or general model proxy is bundled. A customer may instead leave OCR disabled and use the existing authorized human-reviewed text process.

## Why selection is deployment-level

The deployment manifest selects one model ID and one profile ID. Notice production deployments select one workspace, so this is effectively a workspace-specific infrastructure choice without putting model routing, credentials, or arbitrary endpoints in application data or an end-user picker. It also prevents a document uploader from choosing a different model, URL, region, or fallback at request time.

The identifiers are non-secret operational labels and appear in protected integration/readiness output and immutable working-version evidence. Credentials and the mapping from an identifier to an executable model remain only in the gateway's secret/configuration store.

Do not use one shared deployment for workspaces that require different models, regions, or retention policies. Give those workspaces separate Notice deployments/gateways. Per-workspace model persistence and a runtime picker would require a separate threat model, schema, authorization, diagnostic-fingerprint, and UI change; it is intentionally not implied by this contract.

## Notice configuration

Use the deployment manifest rather than editing generated Worker configuration:

```json
{
  "scanner": {
    "enabled": true,
    "configured": false,
    "gatewayUrl": "https://scanner.customer.example/v1/scan",
    "ocr": {
      "enabled": true,
      "modelId": "customer-vision-v1",
      "profileId": "contracts-en-v1"
    }
  }
}
```

The renderer produces:

```text
NOTICE_SCAN_OCR_ENABLED=true
NOTICE_SCAN_OCR_MODEL_ID=customer-vision-v1
NOTICE_SCAN_OCR_PROFILE_ID=contracts-en-v1
```

Identifiers are 1–128 ASCII characters, use only bounded alphanumeric, `.`, `_`, or `-` segments with at most one `/`, cannot contain `..`, and cannot be placeholder text or a URL. When OCR is disabled, both identifiers must be absent. These are selections, not secrets.

## Host the model in customer infrastructure

1. Deploy the OCR inference service in the approved customer account, region, and network. Pin its image digest, model-weight digest, runtime version, and parser/rendering dependencies. Verify that the model/data license permits the intended commercial use, geography, document classes, modifications, and support arrangement. Fetch and malware/signature-check artifacts through the customer's reviewed supply-chain process before serving production traffic.
2. Keep inference private. The public or Notice-reachable component is the existing scanner gateway only. The gateway may call the inference service over a private service identity; it must not accept a model URL, token, provider, model, or profile from an uploader.
3. Configure a closed mapping such as `customer-vision-v1 + contracts-en-v1 -> <private service, pinned model digest, exact prompt/parser/language/page policy>`. Reject every unknown, disabled, unhealthy, or mismatched pair. Never substitute a default, another version, a public API, or a best-effort provider.
4. Scan the exact received bytes with the approved malware engine before rendering or model inference. Recompute the SHA-256, verify the Notice HMAC and freshness, and reject a mismatch before any model call.
5. Isolate parsing/rendering and inference. Enforce at most the Notice 20 MiB input, plus customer-approved page, pixel, decompression, recursion, archive, CPU, GPU/accelerator memory, host memory, concurrency, queue, and wall-clock limits. Size warm capacity and backpressure for the approved peak; do not spill to a public service when GPU/CPU capacity is exhausted. Notice gives headers and body one shared 30-second end-to-end deadline, accepts at most 400,000 UTF-16 code units and 2,000,000 UTF-8 text bytes, and caps the complete response at 2,016,384 bytes; the gateway should use tighter limits where appropriate.
6. Disable general outbound network access from the parser/inference workload, or enforce an explicit private allowlist. Never send source bytes, rendered pages, prompts, or extracted text to an undeclared external service. Do not use external fallback when the selected service is slow or unavailable.
7. Do not log document bytes, page images, extracted text, signatures, or canonical HMAC input. Apply the customer's encryption, support-access, data residency, temporary-file deletion, retention, DLP, observability, incident, and model-quality policies.
8. Return the exact response contract below. Persist provider-side evidence keyed by source SHA-256, model ID, profile ID, pinned model/runtime digests, outcome, and safe timestamps without retaining content unless the approved records policy requires it.

The gateway can be implemented in any language or platform. It remains a customer service because only that environment can supply the approved model image/weights, private network, malware engine, credentials, region, scaling policy, and operational ownership.

Patch the parser, inference runtime, base image, and model only through a reviewed profile revision. A material runtime or weight change gets a new model/profile identifier; do not mutate the meaning of an attested identifier in place.

## Signed extraction request

Ordinary malware scans retain the scanner v1 contract. When an authorized user links a clean PDF or DOCX and OCR is selected, Notice sends a second request to the same configured scanner gateway URL with `x-notice-scanner-protocol: 2.0`. The multipart body contains exactly:

- `file`, a generated canonical UUID `requestId`, and `documentId`/`sha256` from the immutable source;
- `operation=extract-text`;
- the deployment-selected `modelId` and `profileId`; and
- `maximumCharacters=400000`.

The signature is HMAC-SHA-256 over these exact UTF-8 lines, including the final limit and no trailing newline:

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

The restricted identifier alphabet and validated request/document identities prevent newline ambiguity. The gateway must recompute the file hash, compare the HMAC in constant time, and atomically claim each signed v2 `requestId` before inference. Reject a repeated ID without another model call and retain the replay claim for at least ten minutes; timestamp freshness still rejects captures outside the five-minute window. See [Gateway conformance](./GATEWAY_CONFORMANCE.md) for the complete verification order, golden vector, and executable reference verifier.

After a fresh clean malware result and exact model execution, return 2xx JSON:

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
    "sourceSha256": "<exact-lowercase-source-sha256>",
    "text": "<bounded extracted text>"
  }
}
```

The clean-response contract is strict: `requestId` must echo the signed request; `provider` is at most 120 characters and `detail` at most 500; and unknown fields, an empty result, invalid UTF-8/JSON, a lone UTF-16 surrogate, NUL, excess bytes/characters, a different model/profile/hash, or any unsupported status fails closed. Valid surrogate pairs such as emoji are allowed. A missing or wrong `requestId`, malformed JSON/object, or malformed clean result is untrusted: the claimed source remains quarantined, unreadable, and unlinked, no working version is created, and an administrator must reconcile or rescan it after the five-minute claim window. As defense in depth, once a parseable plain-object response contains the exact `requestId` and `verdict=malicious`, Notice preserves that malicious classification even when optional provider/detail evidence, extra top-level fields, or prohibited extraction content is malformed; unsafe ancillary evidence is discarded or replaced with bounded evidence. A wrong or unknown request ID never qualifies for that correlation. Gateways should still return a minimal malicious response with no extraction, and use non-2xx for authentication, parser, capacity, model, or availability failures. Notice never calls another endpoint or model.

## Working-version and review behavior

OCR does not make a legal decision. Before sending v2 bytes, Notice atomically claims the exact clean source and makes it unreadable so concurrent link/rescan attempts cannot promote a competing result. On exact success, Notice writes the accepted text byte-for-byte—including leading/trailing whitespace—as immutable working-document version 1; stores protocol, request ID, provider, model, profile, and source-hash metadata with the R2 object; and records the correlation evidence in the agreement event. A request/header timeout, transport failure, or non-2xx result before Notice accepts a response body releases the claim to its prior clean scanner state. An accepted 2xx response with an invalid length, oversized/incomplete body, body-read timeout/failure, wrong correlation, or malformed clean result stays quarantined because Notice cannot prove a trustworthy result. After a valid clean result, a known uncommitted R2, event, or D1/CAS failure removes any staged working object and restores that prior clean state for immediate retry. If the final D1 batch outcome is ambiguous, Notice reads back the exact source and working-version identity: it returns success when the commit is present, cleans and releases only when the exact pending rollback is proven, and otherwise preserves the unreadable claim for reconciliation.

A correlated malicious verdict changes the source to rejected/deleted, records bounded workspace/agreement security evidence, and creates no working version. The rejected row retains the target agreement ID solely as a records-policy association; it remains unreadable and ineligible as agreement paper. Every rejected-object retention policy check and deletion claim rechecks both source and target holds. A racing hold and cleanup claim are serialized in D1, so a hold applied after the `422` response still fences cleanup and retains the exact object. An unavailable current hold check conservatively retains inaccessible bytes for reconciliation. A stale pending claim is never readable and becomes eligible for administrator rescan only after five minutes. The ordinary exact-paper risk, approval, and signature gates still apply. Reviewers must compare important text and citations with the protected source because a correctly attributed OCR result can still omit or misread content.

Repository ingestion remains only a bounded metadata inventory, and repository fragment/proposal APIs keep their existing evidence rules. OCR selection does not enable semantic retrieval, automatic playbook/legal verdicts, or automatic proposal application.

## Readiness and acceptance

The protected integration status and readiness output expose the selected non-secret model/profile. The scanner live diagnostic first scans harmless text and, when OCR is enabled, embeds a new random challenge in a generated one-page synthetic PDF, sends it through the signed v2 extraction path, and passes only when returned text contains that exact per-run challenge. A static/cached nonempty response cannot pass. A model/profile or secret/configuration change invalidates earlier diagnostic evidence.

Keep `scanner.configured=false` until the live diagnostic and provider-side evidence pass. Acceptance should also prove:

- wrong secret, stale timestamp, changed bytes/hash, changed model/profile/limit, extra/duplicate fields, and unknown protocol fail before inference;
- unknown or unhealthy profiles return failure with no fallback and no public egress;
- malicious input never reaches inference and never returns text;
- a captured v2 request ID cannot invoke inference twice, and an echoed response ID must match the signed request;
- oversized, over-page, decompression-heavy, slow, empty, invalid, mismatched, and oversized-output cases fail closed;
- an exact-correlated malicious verdict remains malicious despite malformed ancillary fields, while a wrong/unknown response ID or malformed clean result remains quarantined and unreadable;
- injected working-object, event, and D1/CAS failures remove uncommitted staging and permit immediate retry, while a lost final D1 acknowledgement is resolved by exact source/version readback;
- a target agreement hold applied after OCR rejection prevents the retention worker from deleting the rejected object;
- exact source/model/profile/hash evidence is retained without content leakage;
- an OCR outage restores the prior clean source without linking, while disabling OCR explicitly uses the documented human-reviewed text process; and
- reviewers can trace the immutable working version to the exact source SHA-256 and selected profile.

## Promotion and rollback

For a first installation, select the profile with `scanner.configured=false`, deploy the pinned artifacts privately, prove health/capacity and negative cases, run the signed synthetic diagnostic, compare an approved representative corpus with the protected sources, and only then promote `scanner.configured=true` through the guarded same-source configuration workflow.

For an existing deployment, the same-source promotion command intentionally cannot change model/profile identifiers. Treat a profile change as a reviewed post-install configuration change under [Deployment](./DEPLOYMENT.md): prepare the new private artifacts and rollback set, activate an exact reviewed Worker configuration with the new identifiers and scanner attestation false during the approved change window, run the diagnostic/baseline checks, and then use same-source promotion only for the final false-to-true attestation.

Rollback restores the prior manifest identifiers and their exact prior image/model/runtime digests, reruns the diagnostic and representative checks, and retains both change records. Never implement rollback by silently repointing the failed identifier, enabling a default route, or falling through to a public API. Working versions already created remain immutable evidence with their original profile/source hash; decide explicitly whether they require renewed human review rather than rewriting them.

Run the focused local contract checks with:

```bash
node --import tsx --test tests/customer-hosted-ocr-link.test.ts tests/gateway-conformance.test.ts tests/integration-status.test.ts tests/deployment-manifest.test.ts
```

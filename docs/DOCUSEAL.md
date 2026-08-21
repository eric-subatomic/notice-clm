# DocuSeal integration profile

Notice validates its DocuSeal adapter against **DocuSeal 3.2.1** (released
2026-08-17) and the
official JavaScript API client contract **`@docuseal/api` 1.0.24**. These are
compatibility attestations: Notice uses bounded raw REST requests and does not
install or execute the upstream client package. Review the
[3.2.1 release](https://github.com/docusealco/docuseal/releases/tag/3.2.1),
[tagged API specification](https://github.com/docusealco/docuseal/blob/3.2.1/docs/openapi.json),
and [official client package](https://github.com/docusealco/docuseal-js/blob/20e0188c8330f18b2d4cd6952895b260dcc9ca5d/package.json)
before changing either pin.

## Supported deployments

Choose one exact `NOTICE_DOCUSEAL_DEPLOYMENT` value:

| Value | Required API base URL | MCP |
| --- | --- | --- |
| `cloud-global` | `https://api.docuseal.com` | Disabled |
| `cloud-eu` | `https://api.docuseal.eu` | Disabled |
| `self-hosted` | Customer HTTPS URL ending in `/api`, such as `https://sign.company.com/api` | Optional, at the same origin's exact `/mcp` path |

The adapter resolves REST paths relative to the complete configured API base.
It never removes a self-hosted `/api` prefix, follows an HTTP redirect, or
sends the API token to a different origin. Self-hosted installations expose
REST below `/api` in the [tagged routes](https://github.com/docusealco/docuseal/blob/3.2.1/config/routes.rb).

An enabled deployment records these non-secret values:

```text
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

Expiration is mandatory and bounded to 1–720 hours. Email 2FA defaults to
enabled in the tracked deployment templates; setting it to `false` is an
explicit customer policy exception, not an implicit provider default.

Keep these values only in the managed secret store:

- `NOTICE_DOCUSEAL_API_TOKEN` is the REST API token sent as `X-Auth-Token`.
- `NOTICE_DOCUSEAL_WEBHOOK_SECRET` must be the `whsec_...` value from the
  webhook's **HMAC** tab. Do not use DocuSeal's separate arbitrary `Secret`
  header setting.
- `NOTICE_DOCUSEAL_MCP_TOKEN` is required only for optional self-hosted MCP. It
  is a separate Bearer token and must not equal the REST API token.

## Account and template gate

Notice creates submissions through `POST /submissions/html`. DocuSeal documents
that endpoint as available with Pro or the free Cloud Developer Sandbox, and
completed API documents can be billable. Confirm that entitlement with the
account owner, then set `NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED=true`; a
read-only template lookup cannot prove commercial entitlement. See
[DocuSeal's endpoint entitlement FAQ](https://www.docuseal.com/faq/which-endpoints-are-available-only-with-the-pro-plan).

The live diagnostic reads the complete configured template and fails unless:

- it is accessible, not archived, and has no public shared link;
- it contains one to ten ordered roles with unique names and identifiers;
- every field belongs to a known role; and
- every role has at least one required `signature` or `initials` field with a
  document area.

The signing route reuses the same profile check, then requires submitted roles
to match that exact order. Retain a screenshot/export of the approved template
and the passing diagnostic with the release evidence.

## Submission protections

Notice sends the SHA-256-verified immutable working text as escaped HTML beside
the approved template and explicitly requests:

- provider email delivery globally and for every signer;
- preserved signer order and no SMS delivery;
- `merge_documents=true` for one final evidence PDF;
- the configured expiration timestamp; and
- the configured email 2FA policy for every signer.

Notice assigns stable per-signer recovery IDs but never returns, persists,
audits, or exports DocuSeal `embed_src` signer URLs. Those URLs are bearer
capabilities. Signed-document URLs are temporary; Notice retrieves a fresh
merged URL during reconciliation, applies a 25 MiB local artifact ceiling,
scans the bytes, hashes them, and retains them before human activation review.
See DocuSeal's [download guidance](https://www.docuseal.com/guides/download-signed-documents).

## Webhook setup

Register the exact callback:

```text
https://<notice-host>/api/webhooks/docuseal
```

In DocuSeal, enable HMAC signing and copy its `whsec_...` value into the managed
secret. Notice verifies the raw request body with HMAC-SHA256, the exact
`[timestamp].[signature]` header format, a five-minute tolerance, and a
constant-time comparison. It returns success only after durable receipt or
replay handling; transient failures remain retryable. Follow the official
[webhook guide](https://www.docuseal.com/resources/use-webhooks) and test valid,
invalid, stale, duplicate, partial, completed, declined, expired, archived, and
unarchived events before attesting production.

## Optional self-hosted MCP diagnostic

MCP is available only for self-hosted DocuSeal. In the DocuSeal account, first
open **Settings → MCP Server** and enable **Enable MCP server**. Then create a
distinct MCP token and add:

```text
NOTICE_DOCUSEAL_MCP_ENABLED=true
NOTICE_DOCUSEAL_MCP_PROTOCOL_VERSION=2025-11-25
NOTICE_DOCUSEAL_MCP_SERVER_VERSION=3.2.1
```

The diagnostic derives `https://<same-origin>/mcp`; no arbitrary MCP endpoint
is configurable. It performs the protocol-correct bounded handshake:
`initialize`, `notifications/initialized`, then `tools/list`. The middle
notification must receive DocuSeal's tagged **HTTP 202** response; any other
status fails the diagnostic before tool discovery. It requires
protocol `2025-11-25`, server name `DocuSeal`, server version `3.2.1`, the exact
five-tool inventory, and the release's exact
read-only/destructive/idempotent/open-world annotations. It then sends exactly
one `tools/call` for read-only, idempotent, closed-world `load_template` and
requires its template ID and ordered signer roles to match the template already
validated through REST. It never invokes `create_template`, `send_documents`,
`search_documents`, or another tool. See the official
[MCP guide](https://www.docuseal.com/guides/integrate-with-ai-agents-using-mcp)
and [tagged protocol implementation](https://github.com/docusealco/docuseal/blob/3.2.1/app/controllers/mcp/protocol_controller.rb).

Do not give a production Notice agent a DocuSeal REST, CLI, or MCP credential.
Upstream marks `send_documents` destructive, non-idempotent, and open-world;
calling it directly would bypass Notice's exact-paper, approval, role,
reservation, reconciliation, and human-activation controls. DocuSeal's
documented AI capabilities provide operational tools and automatic field
detection, not contract drafting, clause negotiation, legal analysis, or risk
scoring.

## Upgrade procedure

For every DocuSeal upgrade, keep `NOTICE_ESIGN_CONFIGURED=false` until the
tagged API and MCP contracts have been reviewed, focused provider tests pass,
and staging proves template discovery, a synthetic expiring/email-2FA
submission, email delivery, webhook verification/retry, recovery,
reconciliation, artifact retrieval/scanning, and signer-URL non-exposure.
Update the release and API-client-contract pins together with their fixtures
and evidence; never use an unreviewed floating provider version in production.

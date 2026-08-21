# 15-minute first staging installation

This quickstart creates validated, non-secret deployment plans and portable
Wrangler configurations for one Notice staging environment. The main
application kit is always used; the included CRM gateway kit is used when CRM
is enabled. These kits do **not**
contact Cloudflare, create resources, apply migrations, upload secrets, or
attest that providers have passed their live tests. You review and run every
Cloudflare command yourself.

Use [Production setup](./PRODUCTION_SETUP.md) for go-live acceptance, provider
evidence, backup/restore, and ownership decisions. A staging deployment is not
authorization to use real customer agreements.

## Before the timer starts

Have these available:

- Node.js `>=22.13.0 <23`, npm `>=11.3.0 <12`, and a clean Notice checkout;
- a Cloudflare account ID, a zone that may host the staging custom domain, and
  an active Workers Paid plan;
- a unique main Worker name, permanent staging workspace ID, display name, and
  two verified organizational bootstrap administrators;
- when CRM is enabled, a distinct CRM gateway Worker name and approved provider
  object/fields, field mapping, and least-privilege credential;
- preferably, a Cloudflare Access self-hosted application connected to the
  customer's existing Entra ID, Okta, Google Workspace, generic OIDC, or generic
  SAML identity provider;
- the Access team domain and application Audience (AUD), or an already reviewed
  identity edge for the advanced `trusted-headers` mode;
- approved DocuSeal, scanner, mail, optional inbound-email, and optional CRM gateway endpoints/domains; for DocuSeal, complete [the pinned integration profile](./DOCUSEAL.md); if OCR is selected, approve the [customer-hosted OCR profile](./CUSTOMER_HOSTED_OCR.md); and
- the corresponding credentials in a secret manager, never in the deployment
  manifest.

The custom domain must be a real lowercase hostname in a Cloudflare-managed
zone. Worker preview, `workers.dev`, `pages.dev`, IP, local, reserved, and
placeholder hostnames are rejected.

Workers Free is supported for local evaluation only. It is not a supported
staging or production target: its 50 D1-query-per-invocation ceiling is below
the bounded obligation materialization/reminder, outbox, and retention job paths. Both guarded release
wrappers require an explicit `--confirm-workers-paid-plan` acknowledgement.

## 1. Install and create an ignored manifest

```bash
node --version
npm --version
# If npm is older than 11.3.0:
npm install --global npm@11.3.0
npm --version
npm ci
mkdir -p .wrangler
cp deploy/notice.deployment.example.json .wrangler/notice.deployment.staging.json
```

Some Node 22 installers still bundle npm 10. Upgrade npm before installation rather than using an older client against the reviewed lockfile. If the global npm location is not writable, use a Node version manager or another user-owned installation; do not use `sudo` in the project checkout.

When CRM is enabled, also create its ignored, non-secret manifest:

```bash
cp deploy/crm-gateway.deployment.example.json .wrangler/crm-gateway.deployment.staging.json
```

`.wrangler/` is ignored by Git. The tracked example is deliberately invalid:
replace every `replace-*`/`.invalid` value and the zero DocuSeal template ID.
Set `accountId` to the exact lowercase 32-character Cloudflare account ID and
`sourceRevision` to the clean checkout's full lowercase `git rev-parse HEAD`
value. The manifest must contain only non-secret configuration.

Keep `workspace.bootstrap.enabled=true` with at least two verified administrator
emails for every empty main first installation and its bounded resume. The main
release wrapper refuses an empty auto-provisioned target with bootstrap disabled,
because that new D1 database cannot already contain a durable administrator.

Choose one identity object:

```json
{
  "mode": "cloudflare-access",
  "teamDomain": "https://replace-with-team.cloudflareaccess.invalid",
  "audience": "the-64-character-hexadecimal-access-application-aud"
}
```

Cloudflare Access is the recommended corporate option because it brokers common
SAML and OIDC providers while Notice validates one application-token format.
The team domain must be the exact `https://<team>.cloudflareaccess.com` origin,
and the AUD must be its 64-character hexadecimal application tag.

Use the following only when a separately reviewed edge blocks direct origin
access, removes caller-supplied Notice identity headers, and injects canonical
identity after authentication:

```json
{ "mode": "trusted-headers" }
```

CRM choices are exact:

- `{ "provider": "none" }` disables CRM synchronization;
- `hubspot`, `salesforce`, and `custom` require `configured` plus a safe HTTPS
  `gatewayUrl`;
- the repository includes a separately deployed durable CRM gateway and all
  three adapters; provider credentials and mappings remain in that gateway's
  deployment secrets/non-secret manifest, not the main application manifest;
- HubSpot requires the approved object type and unique ID property; Salesforce
  requires the approved object and external-ID field; custom requires an
  approved receiving HTTPS endpoint.

Set each integration's `configured` value to `false` until its harmless live
diagnostic passes and the evidence is retained. A copied manifest must not
manufacture that attestation.

For DocuSeal, keep the pinned `validatedRelease` `3.2.1` and
`apiClientContract` `1.0.24`. Select `cloud-global`, `cloud-eu`, or
`self-hosted`; self-hosted `apiBaseUrl` must retain its trailing `/api`. Confirm
the account's Pro/Developer Sandbox `/submissions/html` entitlement before
setting `htmlSubmissionsEntitled=true`. Keep the 168-hour expiration and email
2FA defaults unless the customer explicitly approves a bounded exception. MCP
is self-hosted-only and remains disabled unless its separate read-only
diagnostic profile is required.

Make the scanner OCR decision explicit. Keep `{ "ocr": { "enabled": false } }` for the human-reviewed text path. To use customer-hosted OCR, select one non-secret model/profile in the scanner object:

```json
{
  "ocr": {
    "enabled": true,
    "modelId": "customer-vision-v1",
    "profileId": "contracts-en-v1"
  }
}
```

This is a deployment-administrator infrastructure selection, not an end-user picker. The scanner gateway must resolve that exact pair to a pinned private model with no public fallback. Keep scanner `configured=false` until the ordinary scan and synthetic signed v2 OCR diagnostic both pass; follow [Customer-hosted OCR](./CUSTOMER_HOSTED_OCR.md) for hosting, capacity, licensing, patching, rollback, and acceptance.

The counterparty portal is an application capability, not a provider account. Make its policy explicit in the manifest; `ttlHours` is required even when the portal is disabled and must be a whole number from 1 through 336:

```json
{
  "automatedDeliveryAccepted": false,
  "portal": { "enabled": true, "ttlHours": 72 },
  "emailCapture": { "enabled": false, "configured": false, "provider": "none" }
}
```

That default supports expiring portal links and reviewed manual delivery without operating an inbound mail service. Transfer budgets are fixed per exchange round and survive link rotation: at most 10 admitted uploads (4 accepted, 6 rejected/failed, 96 MiB multipart bytes), one five-minute upload/scan lease, and 20 downloads/256 MiB. Busy upload work returns `429` with a five-second retry interval; exhausted capacity requires a new round. Retain distributed edge/WAF controls for cross-round/IP/tenant abuse. `automatedDeliveryAccepted` is a separate default-false gate: leave it false until the gateway-only counterparty-message acceptance and an isolated staging Notice round both pass. To enable optional email capture, replace `emailCapture` with `{"enabled":true,"configured":false,"provider":"inbound-gateway","inboundDomain":"redlines.company.example"}`, add the managed secret named below, implement the exact gateway contract, and retain its negative plus harmless round-trip evidence before attesting `configured=true`.

## 2. Validate and review the redacted plan

```bash
node --import tsx scripts/deployment-kit.mjs plan .wrangler/notice.deployment.staging.json
```

When CRM is enabled, validate its plan separately, then manually confirm that
its provider type exactly matches the main manifest's CRM provider. Neither
plan exposes credential values:

```bash
node --import tsx scripts/crm-gateway-kit.mjs plan .wrangler/crm-gateway.deployment.staging.json
```

Validation fails on unknown keys, placeholder values, unsafe URLs/hostnames,
embedded credentials, secret-bearing fields, invalid provider combinations,
duplicate administrators, invalid retention, and invalid or duplicate cron
schedules. The supported cron subset has five fields and uses `*`, lists,
ranges, and positive steps; month and weekday names are accepted.

The plan is deterministic and does not print administrator emails, the Access
AUD, provider URLs, or template ID. It shows only redacted status, required
secret **names**, preconditions, the ignored output path, and the exact commands
that remain. Planning performs no writes and no network calls.

## 3. Create the ignored secret file

Create `.dev.vars.staging` outside source control. Populate only the names the
main plan reports. With DocuSeal, scanning, and mail enabled, the baseline is:

```text
NOTICE_AUDIT_SIGNING_KEY=<high-entropy-value>
NOTICE_DELIVERY_GATEWAY_SECRET=<independent-high-entropy-value>
NOTICE_DOCUSEAL_API_TOKEN=<provider-token>
NOTICE_DOCUSEAL_WEBHOOK_SECRET=<whsec_-value-from-the-DocuSeal-HMAC-tab>
NOTICE_JOB_RUNNER_SECRET=<independent-high-entropy-value>
NOTICE_SCAN_GATEWAY_SECRET=<independent-high-entropy-value>
```

Add the distinct `NOTICE_DOCUSEAL_MCP_TOKEN` only when self-hosted MCP is
enabled. Add `NOTICE_CRM_GATEWAY_SECRET` when CRM is enabled. Do not reuse secrets across
purposes. Do not pass values as command-line arguments, paste them into the
manifest, or retain them in deployment output.

Add `NOTICE_INBOUND_EMAIL_SECRET=<independent-high-entropy-value>` only when `counterpartyExchange.emailCapture.enabled=true`. The deployment plan includes this name conditionally and rejects it when email capture is disabled.

The same CRM ingress secret value is installed as
`NOTICE_CRM_GATEWAY_SECRET` on the main Worker and `NOTICE_INGRESS_SECRET` on
the CRM gateway. Put the gateway's provider credential in its separate ignored
secret file exactly as reported by the CRM plan: HubSpot access token,
Salesforce client ID/client secret, or custom webhook secret. Do not copy a
provider credential into the main Worker.

## 4. Render, validate, migrate, and install

This section is only for a new staging target with no live Worker or customer
data. The plan's `nextCommands` delegates the remote work to the guarded wrapper
so the rendered profile and secret-file keys are checked before any remote
change.

Render the main configuration and lock down its ignored secret file:

```bash
npm test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:production
node --import tsx scripts/deployment-kit.mjs render .wrangler/notice.deployment.staging.json
chmod 600 .dev.vars.staging
```

The generated file is mode `0600`, contains non-secret deployment values, and stays
under ignored `.wrangler/`. It points Wrangler at the reviewed build output,
declares the custom domain, keeps `workers.dev` and preview URLs disabled,
declares required secret names, and leaves D1/R2 resource identifiers unresolved
so Wrangler can use Cloudflare automatic provisioning.

`npm test` builds the application, renders valid fixture configurations, and
runs both Wrangler upload and deploy dry-runs against generated main and CRM
profiles. The separate Playwright suites add evaluation and isolated
production-mode browser evidence. None of these tests substitutes the tracked
binding-only profiles for a customer-specific generated deployment profile.

If CRM is enabled, render its reviewed configuration, apply its independent D1
receipt-store migration, and deploy it before attesting CRM in the main Worker:

```bash
node --import tsx scripts/crm-gateway-kit.mjs render .wrangler/crm-gateway.deployment.staging.json
chmod 600 .dev.vars.crm-staging
npm run crm:gateway:deploy -- --config .wrangler/notice-crm-gateway-staging.json --secrets-file .dev.vars.crm-staging --confirm-empty-environment --confirm-workers-paid-plan
curl --fail --silent --show-error "https://notice-crm-staging.company.example/healthz"
```

Use the exact generated path and secret names printed by the CRM plan if they
differ from the illustrative staging names above. The gateway exposes public
`/healthz`, signed `/v1/events`, and operations-secret-authenticated
`/v1/operations/receipts` plus `/v1/operations/requeue`; it stores a receipt
before accepting a normal event and runs scheduled retry/recovery work. Follow its
[deployment guide](../integrations/crm-gateway/README.md) for the provider-side
object/field preparation and synthetic acceptance procedure.

`GET /healthz` is a safe runtime/configuration and storage-readiness probe: it
fails until `CRM_DB` is reachable at exact gateway schema version 2. It does not
authenticate to or mutate the selected provider. CRM acceptance additionally
requires the signed Notice CRM dry run against
the configured provider, verification that the response identifies the expected
provider/mapping, and a normal synthetic event whose durable gateway receipt and
provider-side upsert/tombstone are reconciled.

Now install the main Worker:

```bash
npm run deploy -- --config .wrangler/notice-deployment-staging.json --secrets-file .dev.vars.staging --confirm-empty-environment --confirm-workers-paid-plan
curl --fail --silent --show-error "https://notice-staging.company.example/api/health?mode=ready"
```

Replace each illustrative hostname with the exact manifest domain. Each wrapper
reconstructs and re-renders the manifest, requires an exact generated-config
match, and validates the explicit secret allowlist without printing values.
Arbitrary variables, bindings, secret keys, and all `NOTICE_INTERNAL_*` settings
are rejected. The main first-install and resume modes also require workspace
bootstrap to remain enabled with the manifest's two verified administrators.
Before any remote mutation, each wrapper proves that the clean checkout
matches `sourceRevision`, that the active credential can access the pinned
account, and that the Worker and exact Wrangler auto-provision target names are
absent. A name collision or inconclusive lookup fails closed instead of
attaching an existing D1/R2 resource. The wrapper dry-runs the package, then
uses `wrangler deploy` (Wrangler cannot upload a version for an absent Worker)
to create one 100%-stable **isolated bootstrap** with no route, Cron Trigger,
`workers.dev`, or preview URL. It proves the bootstrap tag, source revision,
complete variable/secret/resource binding set, and the exact newly provisioned
D1/R2 identities, then writes those identities only into owner-readable ignored
temporary configs. Migrations and the final deployment use those pinned IDs;
only the bootstrap creation uses automatic provisioning. The wrapper applies
the committed migrations, asserts exact main schema marker `21` or CRM marker
`2`, proves the same isolated bootstrap is still the sole 100%-traffic version,
and only then deploys the route and Cron Triggers.

Cloudflare automatic provisioning can create D1/R2 before an interrupted
bootstrap upload finishes. If the exact auto-named resources exist but there is
no Worker/bootstrap version, neither `first-install` nor `resume` is allowed.
An approved Cloudflare administrator must first prove those exact resources are
new and empty (no application tables/rows and no R2 objects), record the
evidence, delete only those targets under the change/incident procedure, and
rerun `first-install`. Never clean up by name alone, and never delete a resource
whose ownership or emptiness is uncertain.

If the process stops after the isolated bootstrap is active but before final
activation, do not delete resources and do not rerun `first-install`. Rerender
the same manifest from the same clean `sourceRevision`, find the sole
100%-traffic UUID carrying the `<worker>-isolated-<revision-prefix>` tag, then
use the bounded resume command:

```bash
npm run crm:gateway:resume -- --config .wrangler/notice-crm-gateway-staging.json --secrets-file .dev.vars.crm-staging --expected-bootstrap-version <bootstrap-uuid> --confirm-stranded-first-install --confirm-workers-paid-plan
npm run deploy:resume -- --config .wrangler/notice-deployment-staging.json --secrets-file .dev.vars.staging --expected-bootstrap-version <bootstrap-uuid> --confirm-stranded-first-install --confirm-workers-paid-plan
```

Run only the line for the interrupted component. Resume proves the exact
100%-stable bootstrap UUID, isolated tag, source revision, complete
variable/secret/resource binding set, and auto-named resource identities. It
re-pins those identities, clears Cron Triggers, reapplies tracked D1 migrations
idempotently, verifies the exact marker, and repeats the same-version stability
check immediately before activation. Any different or split deployment, source,
binding, resource identity, or secret-name set is refused.

Do not use this sequence for an upgrade. Notice currently enforces an exact
schema marker, so migration-before-activation makes the old revision reject the
new marker and activation-before-migration makes the new revision reject the old
marker. Existing environments require the maintenance, roll-forward, and
coherent restore procedure in [Deployment](./DEPLOYMENT.md). There is no generic
zero-downtime upgrade command in this repository.

## 5. Protect routes and complete staging acceptance

Before admitting even synthetic business records, verify the external policy:

| Path | Required boundary |
| --- | --- |
| Human UI and normal APIs | Cloudflare Access application policy, or the reviewed trusted-header edge |
| `/api/webhooks/docuseal` | Exact provider callback path plus Notice HMAC/replay verification using the HMAC-tab `whsec_...` secret; do not require an interactive user session |
| `/api/webhooks/email` | Exact path-specific Access bypass only when inbound email capture is enabled; Notice independently requires the documented fresh raw-body HMAC, exact alias, replay key, and bounded attachments |
| `/api/exchange/*` | Exact path-scoped Access bypass for expiring counterparty bearer links; never widen this to `/api/*` |
| Cron-triggered obligation/outbox delivery and retention work | Native Worker scheduled handler; keep HTTP job routes protected for explicitly approved external schedulers only |
| `/api/health` | Deliberate monitor policy that exposes no identity or configuration data |
| `/api/readiness` and administrator APIs | Authenticated Notice administrator through the human identity boundary |

The rendered configuration includes distinct delivery and retention Cron Triggers; the delivery trigger runs obligation materialization/reminders and outbox delivery independently.
Staging acceptance must prove that the deployed release handles both schedules;
configuration alone is not execution evidence.

Then:

1. sign in through the identity boundary and prove direct/forged identity fails;
2. let both bootstrap administrators establish durable memberships;
3. create and independently publish synthetic legal-entity/counterparty/group,
   custom-field, template/workflow/intake/playbook, and exact
   lane/currency/amount-authority records; prove atomic intake conversion,
   minor-unit/no-FX behavior, registered-fragment citation consistency plus
   human working-paper verification and proposal non-mutation, and paged
   work/per-currency portfolio reporting;
4. run and retain required provider diagnostics while `configured=false`; if
   DocuSeal was installed with `htmlSubmissionsEntitled=false`, first confirm
   the account entitlement and promote only that flag so the diagnostic becomes
   testable;
5. for CRM, prove gateway replay/collision behavior, version fencing, and a
   synthetic provider create/update/tombstone round trip;
6. update only passing integrations to `configured=true`, rerender, record the
   current 100%-traffic Worker version UUID, and use `npm run deploy:promote --
   --config <generated-main> --expected-current-version <uuid>
   --confirm-configuration-only --confirm-workers-paid-plan`;
7. verify schema/R2 readiness, synthetic lifecycle, scheduled jobs, webhook,
   counterparty portal expiry/rotation/return, non-resetting per-round upload/download exhaustion, one-work-lease concurrency, and explicit human promotion; after gateway-only counterparty-message acceptance, use an isolated synthetic staging deployment with `automatedDeliveryAccepted=true` to prove one Notice end-to-end delivery before promoting that flag on the production target,
   optional inbound-email signature/replay/quarantine behavior, outbox,
   retention dry-run, role isolation, and restore evidence;
8. set bootstrap `enabled=false`, clear `adminEmails`, rerender, repeat the
   configuration-promotion command with the new current UUID, and confirm both
   durable administrators still have access; and
9. retain the exact source revision, generated redacted plans, deployment versions,
   migration record, readiness output, and acceptance approvals.

The promotion command accepts no secrets file and therefore cannot rotate
secret values. It requires the same source tag, exact existing secret/resource
binding names, exact schema marker, and one expected Worker version at 100%
traffic. It allows only `configured=false` to `true` attestations, the explicit
DocuSeal `/submissions/html` entitlement attestation, the separate
`NOTICE_NEGOTIATION_MAIL_ACCEPTED=false` to `true` acceptance after the mail
gateway and portal prerequisites pass, and bootstrap retirement (`enabled=true`
to `false` with the email list cleared); before a
retirement it queries the exact pinned D1 database and requires at least two
distinct active administrator memberships backed by active users, then repeats
that check immediately before activation. A malformed response, wrong workspace,
different target, or insufficient administrator count fails closed. Every other
non-secret change fails closed. Do not rerun either first-install wrapper.
When the initial DocuSeal entitlement value was false, use one promotion for
that manually verified entitlement, run the live diagnostic against the new
configuration, and use a later promotion for `configured=true`; do not combine
those two transitions without current diagnostic evidence.

The deployment kit deliberately stops at the boundary between repeatable
installation and customer authority. It automates neither identity-policy
approval, provider account/field creation, CRM mapping approval, legal approval
lanes, nor permission to process real agreements. Those are implementation
inputs—not evidence that the SSO verifier or supported CRM adapters are missing.

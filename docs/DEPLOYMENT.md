# Deployment

This guide describes the release path for the repository. Customer values and approvals are covered in [Production setup](./PRODUCTION_SETUP.md); source-publication gates are in [Public release and adopter handoff](./PUBLIC_RELEASE.md); ongoing controls are in [Operations](./OPERATIONS.md).

For a first staging installation, start with the [15-minute deployment plan](./DEPLOYMENT_QUICKSTART.md). Its strict manifests render the main Notice Worker and optional included CRM gateway without putting credentials or customer resource IDs in source control. Return here for promotion, rollback, and handoff controls.

Treat source publication as a separate release gate. A public project must start from a disclosure-reviewed snapshot or clean root history, not an unreviewed private collaboration history, and it needs a tested private vulnerability-reporting path. Record the exact pushed revision and remote CI result whether the approved source release is public or private. The npm `"private": true` flag prevents package publication; it is not source-host privacy evidence.

## Supported repository target

Notice builds a pinned vinext application for a Cloudflare Worker using Node.js `>=22.13.0 <23` and npm `>=11.3.0 <12` for build and validation. Use the current security-patched Node 22 LTS release for staging and production builds. Release CI runs the full suite on Node `22.23.2`, separately verifies the declared `22.13.0` engine floor, and pins npm `11.3.0` so dependency and SBOM evidence stays reproducible. The tracked [wrangler.jsonc](../wrangler.jsonc) declares the customer-independent runtime contract:

```text
Worker entry: worker.ts (vinext application plus native scheduled handler)
D1 binding: DB
R2 binding: DOCUMENTS
```

No account ID, database ID, bucket name, project ID, or secret is committed. The binding-only entries support local development and Cloudflare's provisioning workflow. `workers_dev` and `preview_urls` are disabled deliberately; production must use an explicit customer-controlled route protected by Cloudflare Access or the reviewed trusted-header compatibility edge. A controlled installation may instead pin pre-provisioned resources through its deployment control plane while preserving the logical binding names.

Build with `npm run build`, but do not use the binding-only tracked profile as a production deployment configuration. The canonical path is to validate and render an ignored customer manifest with `scripts/deployment-kit.mjs`, then deploy with Wrangler's `--config` pointing to that generated file. It carries the reviewed variables, route, required-secret names, and Cron Triggers that the base profile deliberately omits. Keep the Cloudflare account, credentials, environment-specific resource selection, migrations, variables, secrets, routes, identity edge, and schedules outside the shared repository. `NOTICE_DEPLOYMENT_MODEL` records who owns those operating responsibilities; it does not change the packaged runtime.

## Environment model

Use a separate Worker deployment, D1 database, R2 bucket, identity policy, secret set, Cron Trigger set, and observability context for each environment and customer unless an approved architecture says otherwise. A production deployment selects one stable `NOTICE_WORKSPACE_ID`; never reuse it for a different customer.

At minimum maintain:

- local evaluation, started with `npm run dev:evaluation` and containing synthetic data only;
- staging, with production-equivalent controls and non-production providers/data; and
- production, isolated from both.

Do not connect local development tooling to production D1, R2, provider accounts, or secrets.

`dev:evaluation` sets a Vite local-only flag that injects only evaluation mode into the local Worker. Setting the mode only as a shell prefix on the normal development command is not supported because it does not populate the Worker binding; local evaluation does not belong in staging or production.

## Release prerequisites

Before publishing a deployment candidate:

1. confirm the target uses Workers Paid and record the account owner’s approval; Workers Free is evaluation-only and its 50-D1-query-per-invocation ceiling is unsupported for the bounded production jobs;
2. confirm the exact disclosure-reviewed public snapshot or approved private source revision and its access/branch/environment policy;
3. review the change, dependency diff, generated artifacts, and threat-model impact;
4. run `npm ci` in a clean environment;
5. install the Playwright Chromium runtime, run `npm test`, `npm run test:e2e`, and `npm run test:e2e:production`, and retain the results;
6. run `npm run readiness -- --json` in a controlled context with intended configuration and managed secrets available, and retain the redacted report;
7. review any schema change and its generated migration;
8. back up/establish a recoverable point for affected D1/R2 state;
9. verify staging identity, published governed artifacts, the customer-approved direct/group lane-to-person authority matrix with exact currency/amount scope, provider diagnostics, scheduled jobs, monitoring, and rollback ownership; and
10. obtain the required technical, security, data-owner, and change approval.

`npm test` runs unit tests, TypeScript, ESLint, the production build, rendered-output checks, and both the evaluation and isolated production-mode API evidence suites. Its release gate renders valid fixture configurations for both the main Worker and CRM gateway, then runs both `wrangler versions upload --dry-run` and `wrangler deploy --dry-run` against those generated files. It never substitutes the tracked binding-only profiles for this check. The two Playwright commands add real-browser lifecycle, responsive, keyboard, automated accessibility, and signed production-identity/mutation evidence. The production suites include attributed approval routing, exact escaped DocuSeal submission, ordered template-role and unique-email validation, production signer-URL non-exposure, partial and exact terminal signer reconciliation, recoverable packet creation, verified webhook/provider/scanner/PDF evidence, replay handling, and exact human signed-evidence review before activation of the unchanged approved basis. A successful local suite still does not prove the protected edge, live providers, restore, manual assistive-technology acceptance, or customer acceptance.

## Schema and migration sequence

Production schema changes use the generated files under `drizzle/`.

The current application requires exact `notice_schema_state` marker **21**. Migrations `0006`–`0010` add approval/signature basis and active-packet uniqueness, durable `purge_jobs`, approval requester attribution, CHECK-constrained `mutation_guards`, and the independent per-sink outbox delivery ledger; `0011`–`0017` add configuration-bound provider evidence, immutable CRM destination and legacy-cleanup records, negotiation lineage, governed risk and agent-plan evidence, and recurring obligation schedules/occurrences/receipts. Migration `0018` adds the enterprise foundation: legal entities, counterparties, groups and members, typed custom fields, saved views, governed template versions, governed workflow definitions, intake forms/submissions, direct/group approval-lane authorities, agreement parties/relationships, stable owner/reference fields, and canonical minor-unit currency amounts. Migration `0019` binds agreements and published intake forms to exact workflow/template snapshots, adds immutable clause-playbook versions, version/hash-pinned registered repository fragments and cited extraction proposals, bounded idempotent ingestion batches, and additional tenant/referential/primary-party integrity checks. Migration `0020` adds tenant- and administrator-bound immutable receipts for atomic, retry-safe creation of each governed template or clause playbook together with its first immutable version. Migration `0021` adds additive, CHECK-constrained per-round portal upload/download counters and one expiring upload-work reservation so cumulative transfer cost and scanner concurrency are durably bounded. Apply every committed migration in order; do not skip directly to a marker value.

```bash
npm run db:generate
```

For each generated migration:

1. inspect every SQL statement and Drizzle metadata change;
2. increment `NOTICE_SCHEMA_VERSION` in `db/schema-guard.ts` and make the same reviewed migration update the `notice_schema_state` marker only after its schema statements succeed;
3. confirm existing rows, indexes, defaults, and workspace ownership are preserved;
4. test forward migration against a representative isolated database copy;
5. measure lock/time/storage behavior and define rollback or restore;
6. apply through the deployment platform's D1 migration workflow in staging;
7. run authenticated lifecycle, tenant-isolation, audit, retention, and export checks;
8. apply to production through the approved change procedure; and
9. publish the application revision only when its required schema marker is present.

Do not edit or delete a migration already applied to any environment. In ordinary production, `ensureStorageSchema()` performs one read-only marker/version verification and returns `503 schema_incomplete` on a missing or mismatched marker; it never creates or alters schema. Additive runtime bootstrap exists only for local evaluation and the isolated production-evidence harness. Its internal Vite-only switch is not a deployment setting.

The exact marker is intentionally strict, but it also means the current package does **not** offer a generic zero-downtime upgrade: migrating first makes the old revision reject the new marker, while activating the new revision first makes it reject the old marker. `npm run deploy` and `npm run crm:gateway:deploy` are therefore first-install commands for confirmed empty environments only. They are not upgrade or rollback tools. Until a particular release supplies an explicitly tested compatibility/expand-contract migration, every upgrade that changes the marker requires the maintenance procedure below.

## Configuration and secrets

Use [.env.example](../.env.example) as a name/template reference only. Put non-secret settings in deployment configuration and secrets in the managed secret store.

Production identity and workspace settings:

- `NOTICE_APP_MODE=production`
- `NOTICE_DEPLOYMENT_MODEL=hosted` or the approved responsibility model
- `NOTICE_PUBLIC_BASE_URL` — exact canonical safe HTTPS origin; required for metadata and provider completion redirects
- `NOTICE_WORKSPACE_ID` — 3–63 lowercase letters, digits, or hyphens, starting alphanumeric
- `NOTICE_WORKSPACE_NAME`
- `NOTICE_BOOTSTRAP_ENABLED=true` only during controlled initial onboarding; set false afterward
- `NOTICE_BOOTSTRAP_ADMIN_EMAILS` — verified bootstrap identities while enabled; clear when bootstrap is disabled
- `NOTICE_AUTH_MODE=cloudflare-access` (recommended) with the exact `NOTICE_ACCESS_TEAM_DOMAIN` and application `NOTICE_ACCESS_AUDIENCE`; Notice validates the signed application JWT
- `NOTICE_TRUST_IDENTITY_HEADERS=false` in Cloudflare Access mode
- `NOTICE_AUTH_MODE=trusted-headers` plus `NOTICE_TRUST_IDENTITY_HEADERS=true` only for the separately reviewed compatibility edge

The tracked profile does not publish a `workers.dev` or preview URL. Configure the canonical route explicitly, then prove that no alternate direct origin bypasses the identity edge. After at least two durable administrators and recovery/access review are verified, set `NOTICE_BOOTSTRAP_ENABLED=false`, clear `NOTICE_BOOTSTRAP_ADMIN_EMAILS`, use the same-source configuration-promotion command described below, and retain the successful access/readiness evidence.

External capability settings:

- DocuSeal: the exact deployment type and API base, validated release `3.2.1`, official API-client contract `1.0.24`, explicit `/submissions/html` entitlement, expiration/email-2FA policy, optional self-hosted MCP selection, and the customer-approved template profile described in [DocuSeal integration](./DOCUSEAL.md)
- scanner: `NOTICE_SCAN_ENABLED`, `NOTICE_SCAN_PROVIDER`, `NOTICE_SCAN_CONFIGURED`, gateway URL, and explicit `NOTICE_SCAN_OCR_ENABLED`; when enabled, the non-secret bounded `NOTICE_SCAN_OCR_MODEL_ID` and `NOTICE_SCAN_OCR_PROFILE_ID`
- delivery: `NOTICE_MAIL_ENABLED`, `NOTICE_MAIL_PROVIDER`, `NOTICE_MAIL_CONFIGURED`, separate `NOTICE_NEGOTIATION_MAIL_ACCEPTED`, and delivery gateway URL
- counterparty portal: explicit `NOTICE_COUNTERPARTY_PORTAL_ENABLED=true|false` and `NOTICE_COUNTERPARTY_PORTAL_TTL_HOURS` from 1 to 336; production has no implicit TTL. Transfer budgets are fixed per exchange round across token rotations: 10 admitted uploads, at most 4 accepted and 6 rejected/failed, 96 MiB multipart bytes, one five-minute work lease, and 20 downloads/256 MiB; aggregate edge/WAF controls remain deployment inputs
- optional inbound counterparty email: `NOTICE_EMAIL_CAPTURE_ENABLED`, `NOTICE_EMAIL_CAPTURE_PROVIDER`, `NOTICE_EMAIL_CAPTURE_CONFIGURED`, and a real dedicated `NOTICE_INBOUND_EMAIL_DOMAIN`; leave the tracked default disabled with provider `none`
- optional CRM: `NOTICE_CRM_ENABLED`, included adapter slug `NOTICE_CRM_PROVIDER`, `NOTICE_CRM_CONFIGURED`, and the separate runtime `NOTICE_CRM_GATEWAY_URL`
- retention: `NOTICE_RETENTION_PURGE_GRACE_DAYS` from 7 to 365
- native schedules: distinct five-field `NOTICE_OUTBOX_CRON` and `NOTICE_RETENTION_CRON` values that match the deployed Cron Triggers

Managed secrets:

- `NOTICE_DOCUSEAL_API_TOKEN` — provider-defined strength/format
- `NOTICE_DOCUSEAL_WEBHOOK_SECRET` — the `whsec_...` value from DocuSeal's webhook HMAC tab, not its arbitrary Secret-header setting
- optional self-hosted `NOTICE_DOCUSEAL_MCP_TOKEN` — a Bearer token distinct from the REST API token
- `NOTICE_SCAN_GATEWAY_SECRET` — at least 32 characters
- `NOTICE_DELIVERY_GATEWAY_SECRET` — at least 32 characters
- optional `NOTICE_INBOUND_EMAIL_SECRET` — at least 32 characters and at most 4096 UTF-8 bytes; required only when inbound email capture is enabled
- optional `NOTICE_CRM_GATEWAY_SECRET` — at least 32 characters
- `NOTICE_JOB_RUNNER_SECRET` — at least 32 characters
- `NOTICE_AUDIT_SIGNING_KEY` — at least 32 characters

Never expose these through client code, build arguments recorded in logs, `.env.example`, readiness output, tickets, or screenshots.

## Identity gate

The recommended path is `NOTICE_AUTH_MODE=cloudflare-access`. Connect the customer's Entra ID, Okta, Google Workspace, generic OIDC, or generic SAML provider to one Cloudflare Access self-hosted application, set its exact team domain and 64-character application AUD, and keep trusted headers disabled. Notice verifies the Access assertion signature, issuer, audience, time bounds, token type, subject, and email before it applies D1 membership and roles. Follow [Corporate SSO](./SSO.md) and prove token tampering, revocation, logout, alternate-hostname, and direct-origin failure in staging.

If Access cannot be used, `NOTICE_AUTH_MODE=trusted-headers` is an explicit compatibility mode. Before setting `NOTICE_TRUST_IDENTITY_HEADERS=true`, prove that:

- the Worker origin cannot be called directly outside the protected identity-aware edge;
- the edge removes client-supplied `x-notice-identity-subject`, `x-notice-identity-email`, `x-notice-identity-name`, and `x-notice-identity-name-encoding` headers;
- the edge injects those canonical values only after authentication;
- TLS, session expiry, logout/revocation, MFA/conditional access, and account recovery match customer policy; and
- logs distinguish edge identity failures from application membership failures without recording sensitive claims unnecessarily.

There is no fallback between modes. Missing Access configuration, a bad token, an unproven header trust flag, or absent workspace/admin settings closes production instead of opening the application.

## Provider onboarding order

For each required provider:

1. provision the production account, least-privilege credential, data region, retention, and support/escalation;
2. configure endpoint/ID and managed secret;
3. set `ENABLED=true` and the repository-supported provider slug, but keep `CONFIGURED=false`; for DocuSeal, separately confirm Pro/Developer Sandbox `/submissions/html` entitlement before recording that attestation;
4. deploy to staging and call `POST /api/admin/integrations` as an administrator for the harmless live test;
5. retain the passing evidence and verify expected provider logs;
6. set `CONFIGURED=true`, redeploy, and rerun diagnostics; and
7. repeat in production under change approval.

Supported slugs are:

- `NOTICE_ESIGN_PROVIDER=docuseal`
- `NOTICE_SCAN_PROVIDER=scan-gateway`
- `NOTICE_MAIL_PROVIDER=delivery-gateway`
- `NOTICE_EMAIL_CAPTURE_PROVIDER=inbound-gateway` when optional inbound email capture is enabled; otherwise `NOTICE_EMAIL_CAPTURE_PROVIDER=none`
- `NOTICE_CRM_PROVIDER=hubspot`, `salesforce`, or `custom` when CRM is enabled

Customer-hosted OCR is not another provider slug or an end-user URL/model choice. It is one deployment-level exact model/profile resolved only inside `scan-gateway`. Configure it in the manifest's `scanner.ocr` object and follow [Customer-hosted OCR](./CUSTOMER_HOSTED_OCR.md); leave it explicitly disabled with no stale identifiers when using reviewed human text.

CRM uses the separately deployed [included CRM gateway](../integrations/crm-gateway/README.md), not the mail gateway. It durably accepts signed Notice events before returning 2xx, prevents duplicate/colliding effects, fences stale aggregate versions, retries provider failures, and includes HubSpot private-app, Salesforce client-credentials/external-ID, and signed custom-webhook adapters. The customer still creates the approved provider object/fields and least-privilege credential, approves the mapping, and supplies provider-side monitoring and reconciliation ownership.

The administrator UI and API display redacted integration state and expose the no-side-effect test as soon as all prerequisites are present, even while `CONFIGURED=false`. Run it in that pre-attestation state, retain the evidence, then rerender with the attestation enabled.

Inbound email capture is a separate optional acceptance path rather than a generic provider card. Keep it disabled unless the deployment operates a conforming mail receiver. When enabled, retain the negative and harmless round-trip evidence required by [Gateway conformance](./GATEWAY_CONFORMANCE.md), then and only then set `NOTICE_EMAIL_CAPTURE_CONFIGURED=true`. The scoped portal and automated outbound negotiation delivery work without inbound capture when the required `delivery-gateway` is attested; that portal-only message omits a Notice reply alias. When inbound capture is attested, the same message adds the exact per-round alias. An operator can instead record a reviewed manual delivery reference after using a separately approved external mail process. A terminally failed negotiation delivery is recovered by closing that outbound round, preparing a new round from the current immutable working draft, and sending the new round; the product does not queue another send from the old round or include a replay console.

## Webhook and scheduled jobs

Register the production DocuSeal callback URL under the exact `NOTICE_PUBLIC_BASE_URL` origin:

```text
https://<customer-host>/api/webhooks/docuseal
```

Use only the `whsec_...` value from DocuSeal's webhook **HMAC** tab. Test valid, invalid, stale, duplicate, delayed, partial, declined, expired, archived/unarchived, and completed callbacks with one-to-ten signer packets as applicable. Completion must show provider re-read, an exact one-to-one match for every expected signer email/identity and `completed` status, exactly one supported artifact before retrieval, scanning, signed-artifact retention, and a recomputed current approval/document basis. A current completion must stop at `completed_review_required`; only a later Legal/Admin review of the exact retained artifact, working-paper hashes, version, and basis may make the agreement Active. If the paper, material metadata, stage, or approval authority changed, retain the packet/artifact as `completed_superseded`, emit `signature.completed` with `activated=false`, and leave the agreement non-Active. Verify that production returns `embedSrc: null`, never renders or exposes provider signer bearer URLs, and relies on provider email delivery. Local evaluation uses a local simulation and neither embeds nor contacts a provider. Exercise retained `creating` recovery, the one-hour administrator-only verified-empty `abandon_unmapped` action, nonterminal refresh, `202` busy retry, stale-lock recovery, reversible `archived_at`, administrator `supersede_archived`, and the exact human review gate before approving go-live. If optional self-hosted MCP is enabled, prove `initialize` → `notifications/initialized` (exact HTTP 202) → `tools/list`, then one read-only `load_template` result matching the REST-selected template and ordered roles; verify that no mutation/open-world tool is called. The complete provider profile and Cloud/self-hosted URL rules are in [DocuSeal integration](./DOCUSEAL.md).

When counterparty exchange is enabled, configure the identity edge with two deliberately narrow public machine/capability paths:

- exact `POST /api/webhooks/email` only, protected in Notice by the independent inbound HMAC, five-minute freshness window, exact raw-body digest, alias scope, body/attachment bounds, replay handling, and scanner/quarantine controls; and
- `/api/exchange/*` only, protected by a random expiring bearer token whose negotiation-round row stores SHA-256 rather than the raw token. A protected outbox event temporarily retains the scoped plaintext URL while automated mail delivery is pending, then scrubs it to SHA-256 on accepted or terminal-dead state. Rotation revokes the previous link; resolving or closing the round clears it.

Do not bypass Cloudflare Access for `/api/*`, `/api/agreements/*`, the human UI, document download routes, or administrator routes. Block `workers.dev`, preview, and alternate-origin access. The inbound gateway must forward the exact body bytes it hashed without proxy reserialization or decompression changes. Follow [Corporate SSO](./SSO.md) for edge policy and [Gateway conformance](./GATEWAY_CONFORMANCE.md) for the wire contract.

The rendered main Worker configuration installs two distinct Cron Triggers. `worker.ts` dispatches the matching scheduled event internally to:

- `/api/jobs/obligations` followed by `/api/jobs/outbox` on the delivery trigger, frequently enough to meet occurrence/reminder and notification/integration latency while attempting both even when one fails; and
- `/api/jobs/retention` on the customer-approved disposition schedule.

Keep `NOTICE_OUTBOX_CRON` and `NOTICE_RETENTION_CRON` identical to the deployed trigger expressions and retain execution evidence for both. The first expression is the delivery trigger: it attempts `/api/jobs/obligations` and `/api/jobs/outbox` independently so one failure cannot starve the other. Use separate logs/alerts for obligation, outbox, and retention outcomes. The HTTP job routes remain bearer-protected for an explicitly approved external scheduler; never put the bearer in a URL or query string. The obligation and retention jobs are bounded and may require repeated runs; nonzero conflicts/failures or remaining eligible records must trigger follow-up.

## Publish and verification sequence

### First installation into an empty environment

1. Install the Playwright Chromium runtime; run `npm test`, `npm run test:e2e`, and `npm run test:e2e:production`; render and review the ignored main and optional CRM configurations; keep main workspace bootstrap enabled with at least two verified administrator emails for this empty target; and restrict each ignored secrets file to its owner (`chmod 600 <file>` on Unix-like systems).
2. If CRM is enabled, install its independent gateway first with `npm run crm:gateway:deploy -- --config <generated-crm-config> --secrets-file <ignored-crm-secret-file> --confirm-empty-environment --confirm-workers-paid-plan`.
3. Install the main Worker with `npm run deploy -- --config <generated-main-config> --secrets-file <ignored-main-secret-file> --confirm-empty-environment --confirm-workers-paid-plan`.
4. Verify `GET /api/health`, `GET /api/health?mode=ready`, and CRM `/healthz` when enabled. The CRM liveness endpoint is not sufficient by itself; confirm its migration list and signed provider diagnostic.
5. Sign in through Cloudflare Access or the approved compatibility edge; confirm invalid identity, alternate-host, and direct-origin access fails.
6. Verify both configured bootstrap administrators, then disable bootstrap and clear the bootstrap email list.
7. Run the protected readiness report and provider live diagnostics.
8. Exercise synthetic governed-template generation, version-pinned intake and atomic conversion replay, entity/counterparty/custom-field/relationship references, workflow snapshot evaluation, direct/group lane-authority and minor-unit currency ceilings, registered-fragment search/citation consistency plus human working-paper verification and proposal non-mutation, paged work/portfolio reporting, create/update/conflict, attributed approval request/claim/decision including sponsor/reviewer separation and concurrent reviewer revocation, document structural admission/scan/version plus rescan malicious-over-clean dominance, counterparty portal rotation/expiry/return/human promotion plus non-resetting upload/download budgets and one-work-lease behavior, optional inbound-email replay/quarantine paths, one-to-ten-signer signature, obligation schedule/materialization/reminder/outbox, independent CRM delivery, transactional-snapshot audit export, hold/retention, and workspace export workflows.
9. Verify another role cannot perform prohibited actions, an unauthorized person cannot claim/decide a lane under the exact direct/group/legacy predicate, revoked authority disables fallback for that lane, and another workspace identifier cannot access records/objects.
10. Verify request IDs, provider logs, native job metrics, per-sink dead-letter alerting, and backup/restore evidence.
11. Approve the separately rendered production first install, rerun the safe smoke set, and monitor the change window.

The wrappers reconstruct and re-render the manifest, require the config to match that exact ignored deployment-kit output, and reject arbitrary variables, bindings, secret keys, every `NOTICE_INTERNAL_*` setting, and any first-install secret not in the exact required set. Values are validated without being printed. Each external input rejects a final symbolic link, uses a no-follow open where the operating system supports it, verifies the opened handle's identity, checks and reads through that exact handle, and then closes it. The configuration object and a canonical JSON representation of the validated secret values remain only in wrapper memory. Replacing the input file, its parent directory, or a later virtual path cannot change those snapshots. The wrapper overwrites its Buffer-backed input and transport snapshots and clears the runner registry in `finally`; JavaScript parsing and serialization still create transient immutable strings that the runtime may retain until garbage collection, so this is bounded best-effort cleanup rather than a memory-erasure guarantee.

Every main and CRM Wrangler preflight, dry run, first install, resume, and promotion directly launches the repository-local Wrangler CLI whose manifest, lock, installation, path, and version are pinned to `4.123.0`; it does not invoke `npx` or a shell. Before starting any release subprocess, the wrapper validates the operator environment once and derives separate least-privilege child environments. Git and the production build receive no Cloudflare credential or Wrangler control setting. Node loader settings, every `NPM_CONFIG_*` setting, and every `GIT_*` setting are removed; the Git removal prevents environment-based repository or configuration redirection. The build also removes all `NOTICE_*`, `NEXT_*`, `__NEXT_*`, `VINEXT_*`, `__VINEXT_*`, `VITE_*`, `VERCEL_*`, `MINIFLARE_*`, `CLOUDFLARED_*`, and `DOTENV_*` settings. Empty loader, native-library, TLS-override, esbuild-path, Vite runner-client, and Vinext revalidation-secret sentinels prevent ignored dotenv values from restoring executable or transport options or selecting a predictable runtime revalidation credential in later build workers; the wrapper forces `NODE_ENV=production`, and Vinext generates a fresh revalidation secret. Inherited `LD_*` and `DYLD_*` settings fail closed so they cannot inject native code into a child; `ESBUILD_BINARY_PATH`, `NAPI_RS_NATIVE_LIBRARY_PATH`, `VP_RUN_NODE_CLIENT_PATH`, and disabled Node TLS verification fail closed as executable and transport overrides. Only Wrangler receives the optional `CLOUDFLARE_API_TOKEN`, plus code-forced production/public API selection, sanitized logging, disabled telemetry/error reporting, and disabled dotenv/process-environment secret loading. Every other inherited `CLOUDFLARE_*`, `CF_*`, `WRANGLER_*`, `WORKERS_*`, or `OPEN_NEXT_*` setting aborts the workflow before a child starts; this includes alternate API bases, account/name/environment selectors, and bundle overrides. If `CLOUDFLARE_API_TOKEN` is present, the wrapper selects token mode and disables stored-keyring lookup; if it is absent, Wrangler uses the reviewed stored-login state under the trusted `HOME`/XDG location. Do not mix the modes or export other Wrangler controls. General operating-system and approved proxy settings remain available. Child-process CA/OpenSSL environment overrides are cleared; install an approved private CA in the trusted host/runtime store before the clean wrapper launch instead.

The production build bypasses npm lifecycle configuration and directly launches the repository-local Vinext CLI whose manifest, lock, installation metadata, path, and version are pinned to `1.0.0-beta.7`, under the exact Node executable and without a shell. Project-root `.env`, `.env.local`, `.env.production`, `.env.production.local`, and unsuffixed `.dev.vars` files are forbidden for this release build: a preload rejects them at child startup and keeps those exact paths unavailable to Vinext, Vite, and the Cloudflare build plugin if one appears later. The documented suffixed staging secret inputs remain separate operator files and are never build inputs. Put reviewed deployment values in the signed manifest; any future public build-time variable requires a reviewed explicit allowlist. The clean checkout and its tracked build preload remain trusted after launch, so this control does not claim to make arbitrary source-tree mutation safe. The wrapper sends only the selected in-memory configuration and secrets to Wrangler through bounded anonymous Node stdio pipes, the same child boundary used on POSIX and Windows. A separate tracked preload exposes those bytes at exact, randomized virtual paths immediately beneath the logical `.wrangler` directory, preserving config-relative `main`, asset, and migration paths without creating a replaceable config or secret file. The child reports the hashes and read counts through a separate pipe, and a missing read or mismatched attestation fails closed. Derived bootstrap, resource-pinned activation, and promotion variants also remain in memory and use the same per-child boundary through the final command, so there are no temporary snapshots to clean up.

Run this workflow only from a clean, isolated release host controlled exclusively by the release operator's OS identity. Environment validation begins after the reviewed Node wrapper starts, so a Node or native loader injected into the process that launches the wrapper could already have executed; clear loader settings before invoking the documented command. The path-swap defense assumes the reviewed checkout, tracked preload, pinned dependency installation, running Node executable, executable-resolution `PATH`, `HOME`/XDG stored-auth locations, approved proxy, host/runtime CA and TLS configuration, and operating system are trusted. Those host inputs must be reviewed before launch; the child sanitizer retains the snapshotted path, home, and proxy values but cannot repair an already compromised parent process. An actor who can replace the trusted code or control the release process/runtime already controls Wrangler itself. The main first-install and resume modes additionally reject `NOTICE_BOOTSTRAP_ENABLED=false`: their newly auto-provisioned empty D1 database cannot contain an existing administrator. Before mutation, each wrapper proves the clean checkout equals the manifest’s exact `sourceRevision`, verifies the active credential against its pinned `accountId`, and proves the Worker and exact auto-named D1/R2 targets are absent. It then uses `wrangler deploy` to create a 100%-stable isolated bootstrap with no public route, Cron Trigger, `workers.dev`, or preview URL, validates its exact source tag and binding set, verifies the provisioned storage identities, and pins those identities in its in-memory configuration variants. Only that bootstrap creation uses automatic provisioning. The wrapper applies migrations with the pinned D1 ID, requires main marker `21` or CRM marker `2`, proves the same isolated bootstrap remains the sole 100%-traffic version, and deploys the final route and schedules with pinned resources. `--confirm-empty-environment` and `--confirm-workers-paid-plan` remain explicit operator attestations in addition to those remote checks.

If automatic provisioning creates the exact auto-named D1/R2 resources but the isolated bootstrap upload fails, stop: there is no version that the resume command can safely authenticate. A named Cloudflare administrator must prove those exact resources are new and empty, retain the inventory evidence, and delete only those approved targets before retrying first install. Never infer ownership from a name or delete an uncertain/non-empty resource.

If a first install stops after the isolated bootstrap is active, rerender the same manifest from the same clean source and run only the applicable bounded resume command:

```bash
npm run crm:gateway:resume -- --config <generated-crm-config> --secrets-file <original-crm-secret-file> --expected-bootstrap-version <sole-100-percent-bootstrap-uuid> --confirm-stranded-first-install --confirm-workers-paid-plan
npm run deploy:resume -- --config <generated-main-config> --secrets-file <original-main-secret-file> --expected-bootstrap-version <sole-100-percent-bootstrap-uuid> --confirm-stranded-first-install --confirm-workers-paid-plan
```

Resume refuses disabled workspace bootstrap, split traffic, or any version, source tag, variable, exact secret-name set, resource binding, or auto-named resource identity that differs from the isolated bootstrap. It re-pins the proven IDs, reapplies migrations idempotently, rechecks the exact marker and bootstrap immediately before activation, and never serves the migration phase through a public route.

### Same-source configuration promotion

Provider attestation, the DocuSeal `/submissions/html` entitlement attestation, separate automated counterparty-delivery acceptance, and administrator-bootstrap retirement do not require a generic upgrade. Rerender the same `sourceRevision`, record the sole 100%-traffic Worker UUID, and run `npm run deploy:promote -- --config <generated-main-config> --expected-current-version <uuid> --confirm-configuration-only --confirm-workers-paid-plan` (or `npm run crm:gateway:promote` for an unchanged CRM profile). Promotion accepts no secret file, retains the exact existing secret-name/resource binding set, verifies the exact schema marker and source tag, and permits only `false` to `true` changes for provider `configured` attestations, `NOTICE_DOCUSEAL_HTML_SUBMISSIONS_ENTITLED`, and `NOTICE_NEGOTIATION_MAIL_ACCEPTED` when its mail-gateway/scoped-portal prerequisites are true, or bootstrap `true` to `false` with the email list cleared. If DocuSeal was installed with its entitlement false, confirm the account contract and promote that flag by itself, run and retain the now-testable live diagnostic, then use a second promotion to set `NOTICE_ESIGN_CONFIGURED=true`; never promote both flags from an untested profile. For bootstrap retirement, the wrapper queries the exact resource-pinned D1 target, requires one result for the configured workspace with at least two distinct active administrator memberships whose users are also active, and repeats that proof immediately before activation; a malformed response, workspace/target drift, or insufficient count stops the release. It cannot rotate secrets or change endpoints, OCR model/profile identifiers, schedules, identity, workspace, provider, mapping, retention, routes, or resources. An existing deployment's OCR profile change therefore uses a reviewed post-install configuration change with scanner attestation false, followed by the new diagnostic and a separate false-to-true promotion; see [Customer-hosted OCR](./CUSTOMER_HOSTED_OCR.md).

### Reviewed post-install secret rotation

Secret rotation is a manual maintenance operation, not configuration promotion. Pin the account, Worker name, clean source revision, current sole 100%-traffic version UUID, schema marker, and complete binding inventory in the change record. Put only the approved replacement keys in an owner-readable ignored file, run `npx wrangler versions secret bulk <file> --name <worker> --config <generated-config> --message <change-id> --tag <reviewed-tag>`, record the returned version UUID, and inspect it with `npx wrangler versions view <new-uuid> --name <worker> --config <generated-config> --json`. An independent reviewer must verify that the source and every non-secret/resource/secret **name** are unchanged before `npx wrangler versions deploy <new-uuid>@100% --name <worker> --config <generated-config> --yes`. Run readiness and a harmless live test before revoking the old credential. For the CRM ingress overlap, add `NOTICE_INGRESS_PREVIOUS_SECRET` only in this reviewed gateway rotation, deploy the new gateway secret, rotate the paired main `NOTICE_CRM_GATEWAY_SECRET`, prove delivery, then create and deploy a reviewed version that deletes the previous secret. First-install/resume and configuration-promotion wrappers intentionally reject this overlap key and never perform rotation.

### Upgrade of an existing environment

There is no unattended upgrade command in this repository. For a marker-changing release, use a reviewed maintenance window:

1. rehearse the exact forward migrations and new artifacts against a representative isolated restore; record duration, expected marker, and pass/fail evidence;
2. capture D1 Time Travel bookmarks/recovery points for `DB` and, when used, `CRM_DB`; inventory the corresponding R2 state and record the last known-good Worker versions;
3. render the new configurations and run `npm test`, `npm run test:e2e`, and `npm run test:e2e:production`, but do not pass the first-install confirmation or use either deployment wrapper against the live target;
4. put the public route into an approved maintenance response that blocks mutations, pause Cron Triggers and external job callers, pause or queue provider callbacks, and drain or inventory in-flight signature, webhook, obligation, outbox, retention, and CRM work/receipts;
5. upload the reviewed Worker versions without activating them, apply and verify the CRM migration first when present, then apply and verify the main migration; keep maintenance in place because the old exact-marker application may now return `503`;
6. activate the corresponding new CRM and main versions, verify migration lists, schema markers, health/readiness, identity, jobs, callbacks, storage, and a bounded synthetic lifecycle; and
7. resume callbacks, schedules, and customer traffic only after the named release owner accepts the evidence. Reconcile everything that accumulated during maintenance.

The maintenance boundary, provider pause, and exact Cloudflare commands are customer-controlled change inputs. They must be reviewed for the target account and release; copying first-install commands is not an upgrade procedure.

`GET /api/readiness` returns `503` while any code/customer gate fails and never returns secret values. It verifies exact implemented provider slugs, required endpoint/credential prerequisites, and configuration attestations; it is still a policy/preflight report. `GET`/`POST /api/admin/integrations` provides the current redacted presence and live-access checks; neither replaces end-to-end business verification.

## Rollback

Before release, identify the last known-good artifact, compatible schema range, data recovery point, decision owner, and maximum acceptable rollback window.

If rollback is needed:

1. stop or isolate affected mutations, webhooks, and jobs if continuing them could worsen inconsistency;
2. preserve logs, request IDs, outbox/webhook state, and current D1/R2 evidence;
3. if no migration was applied, restore the last known-good Worker version and verify it before reopening traffic;
4. if the schema marker changed, keep maintenance active and prefer a reviewed roll-forward application/schema fix—the old exact-marker revision is not a valid automatic rollback;
5. restore D1 only to the approved pre-change bookmark when the data owner accepts the recovery-point loss, and restore/reconcile R2 and provider state to the same logical point rather than restoring one store in isolation;
6. apply the same decision independently to `CRM_DB`, then reconcile its durable receipts and provider-side records before CRM delivery resumes;
7. reconcile DocuSeal, scanning, gateway, outbox, webhook receipts, R2 objects, and D1 records; and
8. document customer impact, any lost or replayed work, recovery evidence, and follow-up work before reopening traffic.

Never rerun the first-install wrappers, improvise destructive SQL, or delete R2 prefixes during an incident. If the approved restore cannot make D1, R2, CRM receipts, and provider state coherent, remain in maintenance and escalate to the named data/release owners.

## Handoff record

The release owner should provide the customer/operator with:

- exact source revision, publication/history-review record, repository visibility, and built artifact identity;
- applied migration list and database recovery point;
- non-secret configuration inventory and managed-secret ownership/rotation dates;
- identity-edge test evidence;
- approved approval-lane policy, lane-to-person/group authority matrix, and generic-role versus lane-scoped-adapter decision;
- provider diagnostic evidence and webhook/job configuration;
- readiness, full test, security scan, and penetration-test results;
- backup/restore, monitoring, alerting, incident, and escalation runbooks;
- retention/legal-hold/offboarding policy and verification evidence; and
- accepted limitations, residual risks, approvers, and review dates.

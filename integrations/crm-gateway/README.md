# Notice CRM gateway

The included CRM gateway is a separately deployed Cloudflare Worker that turns
Notice agreement events into durable, idempotent CRM upserts. It ships with
first-party adapters for HubSpot, Salesforce, and a signed custom webhook. The
gateway acknowledges a new event only after its bounded canonical payload is
stored in D1; retries, lease recovery, aggregate-version fencing, and completed
payload redaction and receipt pruning are handled by its scheduled Worker.

This component is intended to be deployed next to Notice, not embedded in the
main Worker. That separation keeps CRM credentials out of the CLM application,
lets customers apply a narrow network and ownership boundary, and allows the
gateway to be upgraded or rolled back independently.

## Fast path

Prerequisites are Node 22, npm 11, a Cloudflare account with an approved custom
domain and Workers Paid plan, and a CRM integration identity with the least
privileges needed for the target object. Workers Free is evaluation-only; its
50-D1-query-per-invocation ceiling is unsupported for the bounded recovery job.

1. Install and validate the repository:

   ```sh
   npm ci
   npm test
   ```

2. Copy `deploy/crm-gateway.deployment.example.json` to an ignored customer
   manifest such as `.wrangler/crm-gateway.deployment.staging.json`. Replace
   every placeholder and select the provider. Never add credentials to this
   JSON file.

3. Validate without writing or contacting Cloudflare:

   ```sh
   node --import tsx scripts/crm-gateway-kit.mjs dry-run .wrangler/crm-gateway.deployment.staging.json
   ```

   The output is a redacted deployment plan and the exact list of required
   secret names. Resolve every precondition before continuing.

4. Render the ignored Wrangler configuration:

   ```sh
   node --import tsx scripts/crm-gateway-kit.mjs render .wrangler/crm-gateway.deployment.staging.json
   ```

   The generated file is mode `0600`, contains non-secret settings only, and
   leaves the `CRM_DB` D1 resource unresolved so Wrangler can provision it
   automatically during the isolated first-install bootstrap.

5. Put the required secrets in the deployment secret manager or an ignored
   `.dev.vars.crm-staging` file. `NOTICE_INGRESS_SECRET` must be a strong random
   value of at least 32 characters and must equal `NOTICE_CRM_GATEWAY_SECRET` in
   the paired Notice deployment. `NOTICE_OPERATIONS_SECRET` must be a different
   random value of at least 32 characters, distributed only to authorized
   operators. Never reuse either value for the provider credential.

6. For a genuinely empty environment, run the guarded first-install wrapper
   with the exact rendered config and ignored secret file:

   ```bash
   npm run crm:gateway:deploy -- --config .wrangler/notice-crm-gateway-staging.json --secrets-file .dev.vars.crm-staging --confirm-empty-environment --confirm-workers-paid-plan
   ```

   The wrapper reconstructs and strictly re-renders the manifest, rejects
   undeclared/internal settings and secret names, pins the manifest’s Cloudflare
   account and clean source revision, proves the Worker and exact auto-named D1
   target are absent, and performs the package dry run. It creates one tagged,
   route-less and schedule-less 100%-stable bootstrap, proves its exact source,
   secret-name/binding set, and newly provisioned D1 identity, then pins that ID
   in owner-only ignored temporary configs. It lists/applies the exact committed
   gateway migrations, requires schema marker 2, rechecks the same isolated
   bootstrap, and activates the reviewed route/schedule only after success. Do
   not use the first-install wrapper for an
   existing environment; follow the maintenance/roll-forward upgrade sequence
   in `docs/DEPLOYMENT.md`. Do not enable CRM delivery in Notice until migration
   and deployment both succeed. A successful `GET /healthz` proves that runtime
   configuration is valid, D1 is reachable, and exact gateway schema version 2
   is applied. It deliberately does not call the provider; the signed CRM
   connection test is the separate provider-readiness check.

   If execution stops after the isolated bootstrap is the sole 100%-traffic
   version, rerender from the same clean `sourceRevision` and resume only with
   its exact UUID:

   ```bash
   npm run crm:gateway:resume -- --config .wrangler/notice-crm-gateway-staging.json --secrets-file .dev.vars.crm-staging --expected-bootstrap-version <bootstrap-uuid> --confirm-stranded-first-install --confirm-workers-paid-plan
   ```

   Resume revalidates the isolated source/tag/bindings, exact secret-name set,
   and auto-named D1 ID before any mutation. If D1 was provisioned but no
   bootstrap version exists, stop for administrator evidence and approved
   empty-resource cleanup; resume cannot authenticate that partial state.

7. Configure Notice with:

   ```text
   NOTICE_CRM_ENABLED=true
   NOTICE_CRM_PROVIDER=<hubspot|salesforce|custom>
   NOTICE_CRM_GATEWAY_URL=https://<gateway-domain>/v1/events
   NOTICE_CRM_GATEWAY_SECRET=<same value as gateway NOTICE_INGRESS_SECRET>
   NOTICE_CRM_CONFIGURED=false
   ```

   Run Notice's CRM connection test. Set `NOTICE_CRM_CONFIGURED=true` only after
   that signed dry-run reaches the real provider successfully and the evidence
   has been retained.

## Manifest reference

Every manifest has these top-level fields:

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Must be `1.0`. |
| `accountId` | Exact lowercase 32-character Cloudflare account ID used for credential/target verification. |
| `sourceRevision` | Exact lowercase full Git revision of the clean checkout deployed and tagged. |
| `environment` | Stable lowercase environment identifier. |
| `workerName` | Unique Cloudflare Worker name. |
| `customDomain` | Production custom hostname for the gateway; preview hostnames are rejected. |
| `provider` | Exactly one provider configuration described below. |
| `schedules.recovery` | Five-field Cloudflare cron used to retry and recover durable receipts. |
| `retention.terminalPayloadDays` | Days to retain terminal canonical payloads before irreversible redaction; the supplied default is 90. |
| `retention.terminalMetadataDays` | Days to retain redacted receipt metadata before deletion; must be at least the payload period and defaults to 365. |

All provider variants require a stable `mappingVersion` and a `fieldMapping`
object. Start with `{}` to use the supplied defaults. Treat `mappingVersion` as
an immutable destination-profile revision, not a reusable label. Bump it and
retain the exact old-profile deployment whenever the provider account or
tenant, API origin or custom URL, object type, external-ID field, field mapping,
or destination semantics changes. A credential rotation may retain the version
only when it preserves the exact account and destination semantics. The D1
ordering key is provider plus mapping version; reusing that key for a different
destination can suppress or misorder writes.

The old deployment, including its recovery schedule and operations endpoint,
must remain available until its retry/dead-letter reconciliation and any
required cleanup tombstones are complete. Scheduled recovery, operational
listing, payload redaction, and metadata pruning intentionally see only the
deployment's exact provider and mapping version. Do not overwrite the sole
Worker's profile in place and assume it will drain old-profile receipts. When
deployments share one D1 database, their ordering watermarks and leases remain
isolated by exact provider and mapping version. Give simultaneously draining
profiles distinct reviewed Worker names and hostnames/schedules, route new
Notice events only to the current profile, and keep the old operations endpoint
available to authorized operators until its reconciliation evidence is closed.

The manifest parser rejects unknown keys, private key material, secret-bearing
field names, unsafe endpoints, placeholder values, invalid provider field
names, duplicate mapping targets, and an `externalId` mapping that disagrees
with the configured unique ID field.

## HubSpot

Manifest shape:

```json
{
  "type": "hubspot",
  "mappingVersion": "2026-08-02.1",
  "fieldMapping": {},
  "apiBaseUrl": "https://api.hubapi.com",
  "objectType": "2-1234567",
  "idProperty": "notice_external_id"
}
```

Required secrets:

- `NOTICE_INGRESS_SECRET`
- `NOTICE_OPERATIONS_SECRET`
- `NOTICE_CRM_HUBSPOT_ACCESS_TOKEN`

Create a dedicated [HubSpot private app](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview)
or another approved token source with read/write access only to the selected
object. The configured object must support the
[CRM batch upsert endpoint](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/objects/batch/upsert-objects).
Create `idProperty` as a unique-value text property before deployment. The
gateway uses the stable value `notice:<workspace>:agreement:<id>` for every
upsert. A batch is acknowledged only when HubSpot reports terminal `COMPLETE`,
exactly one result ID, and no per-input errors. Pending, processing, or canceled
batches are retried; partial or ambiguous responses never become successful
receipts.

With an empty mapping, create these HubSpot properties:

```text
notice_external_id       notice_workspace_id       notice_agreement_id
notice_aggregate_version notice_mapping_version     notice_deleted
notice_event_topic       notice_event_occurred_at   notice_party
notice_agreement_type    notice_contract_value      notice_stage
notice_owner             notice_department          notice_risk
notice_approval_status   notice_signature_status    notice_effective_date
notice_expiration_date   notice_crm_provider        notice_crm_record
notice_updated_at        notice_deleted_at
```

Use HubSpot property types compatible with the canonical values: numeric for
agreement ID, aggregate version, and contract value; boolean for deleted; date
or text compatible with ISO dates for date fields; and text for the remainder.
If an existing object uses different names, override only those canonical keys
in `fieldMapping`.

## Salesforce

Manifest shape:

```json
{
  "type": "salesforce",
  "mappingVersion": "2026-08-02.1",
  "fieldMapping": {},
  "loginUrl": "https://login.salesforce.com",
  "object": "Agreement__c",
  "externalIdField": "Notice_External_Id__c",
  "apiVersion": "v65.0"
}
```

Required secrets:

- `NOTICE_INGRESS_SECRET`
- `NOTICE_OPERATIONS_SECRET`
- `NOTICE_CRM_SALESFORCE_CLIENT_ID`
- `NOTICE_CRM_SALESFORCE_CLIENT_SECRET`

Use a dedicated integration user and a connected app configured for Salesforce's
[OAuth client credentials flow](https://help.salesforce.com/s/articleView?id=xcloud.connected_app_client_credentials_setup.htm&language=en_US&type=5).
In this deployment model both the client ID and client secret remain in the
secret store. Give the integration user object and field access only to the
selected object.

Create `Notice_External_Id__c` as a unique External ID field. The adapter uses
Salesforce's [external-ID upsert resource](https://developer.salesforce.com/docs/platform/mobile-sdk/guide/ref-rest-apis-upsert.html),
so retries converge on the same record.

With an empty mapping, create these fields on the selected object:

```text
Notice_External_Id__c       Notice_Workspace_Id__c       Notice_Agreement_Id__c
Notice_Aggregate_Version__c Notice_Mapping_Version__c     Notice_Deleted__c
Notice_Event_Topic__c       Notice_Event_Occurred_At__c   Notice_Party__c
Notice_Agreement_Type__c    Notice_Contract_Value__c      Notice_Stage__c
Notice_Owner__c             Notice_Department__c          Notice_Risk__c
Notice_Approval_Status__c   Notice_Signature_Status__c    Notice_Effective_Date__c
Notice_Expiration_Date__c   Notice_CRM_Provider__c        Notice_CRM_Record__c
Notice_Updated_At__c        Notice_Deleted_At__c
```

Use Number/Currency for numeric values, Checkbox for deleted, Date or Date/Time
compatible with the canonical ISO value, and appropriately bounded Text for the
remaining fields. Field-level permissions are required for every mapped field.

## Custom webhook

Manifest shape:

```json
{
  "type": "custom",
  "mappingVersion": "2026-08-02.1",
  "fieldMapping": {},
  "url": "https://integrations.customer.invalid/v1/notice/crm",
  "externalIdField": "externalId"
}
```

Required secrets:

- `NOTICE_INGRESS_SECRET`
- `NOTICE_OPERATIONS_SECRET`
- `NOTICE_CRM_CUSTOM_SECRET`

The destination receives `POST` requests with JSON, a stable
`Idempotency-Key`, `X-Notice-Event-Id`, `X-Notice-Timestamp`,
`X-Notice-Dry-Run`, and `X-Notice-Signature`. Verify the signature over the
exact raw body before parsing:

```text
v1=hex(HMAC-SHA256(secret, "<unix-seconds>.<exact-body-bytes>"))
```

Reject stale timestamps and duplicate IDs with conflicting bodies. For each
actual destination record, atomically ignore an aggregate version lower than
the version already applied; an equal version is valid only for the same
idempotency key. This destination-side check closes the ambiguity left by a
request timeout after the receiver may already have committed. A connection
test has event ID `notice.crm.connection-test` and
`X-Notice-Dry-Run: true`; validate the credential and mapping but do not mutate
CRM data. Return any 2xx response for success. A real upsert may return
`X-Notice-Provider-Record-Id` with the destination record ID.

The body has schema version `1.0`, the Notice event and aggregate versions,
`externalId`, deletion state, and a `fields` object. With an empty mapping,
destination field names are the canonical names: `externalId`, `workspaceId`,
`agreementId`, `aggregateVersion`, `mappingVersion`, `deleted`, `topic`,
`occurredAt`, `party`, `type`, `value`, `stage`, `owner`, `department`, `risk`,
`approvalStatus`, `signatureStatus`, `effectiveDate`, `expirationDate`, `crm`,
`crmRecord`, `updatedAt`, and `deletedAt`.

## Operations and rotation

- The public event route is `/v1/events`. It authenticates Notice's exact raw
  request with timestamped HMAC and rejects oversized, stale, malformed, or
  conflicting requests. Do not place a generic identity login in this
  server-to-server path.
- The scheduled trigger is required. Immediate delivery is best-effort after
  durable acceptance; the trigger recovers stale leases and retries due events.
  A malformed/partial run rejects the scheduled Worker invocation so platform
  Cron monitoring can alert while the durable receipt remains safe for retry.
- Aggregate fencing and leases are scoped to the exact workspace, agreement,
  provider, and mapping version. A lower or losing equal-version receipt is
  rejected before a provider call. If a lower version already owns the live
  lease when a higher version is accepted, the higher call waits for that lease
  to complete or fail. This is not a transaction with the external CRM: a
  timeout or lost response is ambiguous because the provider may have committed
  after the gateway stopped waiting. Keep `aggregateVersion` mapped, alert on
  retries/dead letters, reconcile the destination, and issue an explicit newer
  resync when that ambiguity cannot be proved safe. Custom receivers must also
  enforce the destination-side monotonic check described above.
- `GET /v1/operations/receipts` is an authenticated, read-only receipt and
  dead-letter view. Send `Authorization: Bearer <NOTICE_OPERATIONS_SECRET>` and
  optionally select one status and a bounded page size, for example
  `?status=dead&limit=50`. Results contain operational identifiers, state,
  attempts, safe error codes, timestamps, and whether the payload is retained
  or redacted. Event bodies, digests, provider record IDs, and secrets are
  never returned.
- `POST /v1/operations/requeue` accepts only
  `{"workspaceId":"...","eventId":"..."}` with the same bearer
  authentication. It resets a retained `dead` receipt for scheduled delivery.
  It refuses non-dead or quarantined receipts, redacted payloads, and receipts
  created under a different provider or mapping version. For a changed profile,
  resynchronize with a new event ID and higher aggregate version instead.
- The recovery cron redacts terminal event payloads after
  `retention.terminalPayloadDays` and deletes already-redacted terminal receipt
  metadata after `retention.terminalMetadataDays`. Choose values that satisfy
  customer policy, incident investigation, and applicable recordkeeping rules.
- Monitor Worker errors, D1 availability, provider 401/403/429/5xx rates, and
  the Notice-side outbox backlog. Alert on dead/quarantined receipts and an
  unhealthy readiness endpoint. Never log request bodies, HMACs, operations
  authorization, or provider credentials.
- Secret rotation is a reviewed manual maintenance operation, never
  `crm:gateway:deploy`, `crm:gateway:resume`, or `crm:gateway:promote`. Those
  wrappers accept the exact first-install secret set or no secret file and will
  reject `NOTICE_INGRESS_PREVIOUS_SECRET`. Follow the pinned-version procedure
  in `docs/DEPLOYMENT.md`: create a secret-only version, inspect its complete
  bindings, deploy its recorded UUID at 100%, and test before revocation.
- To rotate ingress without an outage, add the old value as
  `NOTICE_INGRESS_PREVIOUS_SECRET` only in that reviewed secret-only gateway
  version, install the new `NOTICE_INGRESS_SECRET`, rotate Notice's paired
  `NOTICE_CRM_GATEWAY_SECRET`, confirm a live test and real event, then create,
  inspect, and deploy a version that deletes the previous secret.
- Provider credential rotation uses the same reviewed secret-only procedure.
  Confirm a dry-run connection test before revoking the old credential.
- Preserve the D1 database across Worker rollbacks. Apply migrations before
  routing Notice traffic to a schema-dependent gateway version.
- Rotate `NOTICE_OPERATIONS_SECRET` with the same pinned, reviewed secret-only
  procedure and update the operator vault entry in the same maintenance window.

## Handoff checklist

- Non-secret manifest reviewed and stored outside version control.
- Required secret names populated in the approved secret manager.
- Ingress and operations secrets are distinct, random, at least 32 characters,
  and assigned to separate application/operator access paths.
- Dedicated CRM identity, least-privilege scopes, object, external ID, and all
  mapped fields reviewed by the customer's CRM administrator.
- Rendered deployment dry-run passes and unresolved D1 is provisioned.
- D1 migration list shows no pending migrations.
- `GET /healthz` passes with the final D1 schema, then Notice's signed CRM
  connection test passes.
- One harmless create/update and delete fixture converges on the expected CRM
  record without duplicates.
- Authenticated receipt listing and one retained dead-letter requeue are tested
  without exposing the event payload.
- Recovery cron, dead-letter alerting, secret rotation owner, rollback owner,
  retention policy, and incident runbook are assigned before go-live.

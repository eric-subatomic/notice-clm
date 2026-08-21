# Corporate SSO

Notice uses Cloudflare Access as its recommended production identity broker. A
customer connects its existing identity provider to Access; Notice then verifies
the signed Access application token and applies its own workspace membership and
role permissions. No provider-specific authentication code or SAML parser runs in
the Notice Worker.

Cloudflare Access supports Microsoft Entra ID, Okta, Google Workspace, multiple
simultaneous identity providers, generic OpenID Connect, and generic SAML 2.0.
Use OIDC when a provider offers both protocols. See Cloudflare's current
[identity-provider catalogue](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/)
for provider-side prerequisites.

This means adopters do not implement a new SAML/OIDC parser or a different
Notice authentication adapter for each corporate directory. The repository
already contains Access token verification and workspace authorization. The
customer-specific work is to create the Access self-hosted application, connect
and approve the existing IdP/MFA/session policy, copy two non-secret identifiers,
and run the acceptance tests below. Directory-to-Notice role or approval-lane
mapping remains an explicit customer authority decision, not an SSO feature.

## Responsibility boundary

| Layer | Authority |
| --- | --- |
| Authentication, MFA, conditional access, session duration, account revocation | Customer IdP and Cloudflare Access |
| Token signature, issuer, audience, time, type, subject, and email validation | Notice Worker |
| Workspace admission and `admin`, `legal`, `approver`, `requester`, `viewer` roles | Notice D1 membership records |
| Manual Notice groups and approval-lane delegated authority | Workspace-scoped D1 group/membership and direct/group lane-authority records with exact currency and optional minor-unit ceiling; never inferred from an IdP group |

Access groups are useful for deciding who can reach the application. They do not
automatically grant a Notice role, create a Notice group, synchronize its members,
or grant lane authority. Notice has no SCIM client or IdP-group mapper; its manual
groups and lane-authority records must be administered and reviewed separately.
This separation prevents a broad or renamed directory group from silently
becoming application administration or approval authority. Cloudflare also
documents that custom JWT claims may be trimmed to fit cookie limits, so Notice
does not depend on a group claim for authorization.

## Notice configuration

Create one Access self-hosted application for the canonical Notice hostname, then
copy its team domain and application AUD tag into the Worker configuration:

```text
NOTICE_AUTH_MODE=cloudflare-access
NOTICE_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
NOTICE_ACCESS_AUDIENCE=<64-character-application-aud>
NOTICE_TRUST_IDENTITY_HEADERS=false
```

The team domain must be the exact HTTPS origin shown above. Notice derives the
rotating JWKS endpoint from it and does not accept an independent key URL. The AUD
must be the exact tag of the Notice Access application, not the ID of another
application in the same account.

On every protected request, Notice reads only `Cf-Access-Jwt-Assertion` and:

1. retrieves and caches the current rotating Access keys;
2. allows only RS256;
3. verifies the signature, exact issuer and exact application audience;
4. enforces expiration and not-before time;
5. accepts only an identity application token with a bounded subject and email;
6. rejects organization and service tokens on user routes; and
7. derives the user solely from the verified claims.

Caller-provided `x-notice-identity-*` headers have no effect in this mode. Notice
does not fall back to the `CF_Authorization` cookie because Cloudflare recommends
validating the assertion header passed to the origin. See [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

The standard Access application token always provides verified email and subject.
If a small `name` custom claim is configured, Notice uses it as the display name;
otherwise it uses the verified email. Name is presentation data, never authority.

## Access application and route policy

Protect the canonical hostname and every user-facing route. Use deny-by-default
policies, explicitly select the customer's IdP/group or approved addresses, require
the customer-approved MFA method, and choose a bounded application session.

Notice also has machine endpoints. Give each a separate, more-specific Access
application or policy rather than weakening the hostname-wide user policy:

| Path | Recommended Access treatment | Application control retained |
| --- | --- | --- |
| `/api/webhooks/docuseal` | Narrow path-specific Bypass when DocuSeal cannot send an Access service token | Timestamped HMAC, replay receipt, body limit, provider reconciliation |
| Exact `POST /api/webhooks/email` | Narrow path-specific Bypass only when optional inbound email capture is enabled | Exact raw-body SHA-256, fresh timestamp-and-digest HMAC, generated round alias, provider-message replay key, attachment bounds, scanner/quarantine, sender review |
| `/api/exchange/*` | Narrow path-specific Bypass for counterparty possession links | Random expiring bearer token; its round row stores only SHA-256, while a pending automated-mail event temporarily holds the scoped URL and scrubs it on accepted/terminal-dead state; rotation/round close/reconciliation revokes it; agreement/round scope and attachment controls remain server-enforced |
| Native obligation/outbox delivery and retention Cron Triggers | No external Access request; `worker.ts` dispatches the scheduled event internally | Exact configured cron match, job bearer generated inside the Worker, constant-time route verification, bounded runner rate |
| `/api/jobs/obligations`, `/api/jobs/outbox`, and `/api/jobs/retention` when an external scheduler is explicitly used | Service Auth, in addition to the Notice job bearer secret | Constant-time bearer verification and bounded runner rate |
| `/api/health` | Explicit health-monitor policy; expose no other path | Non-secret liveness/readiness response |

Cloudflare evaluates the more specific application path independently. Verify the
exact path inventory after every route change. A Bypass disables Access controls
and Access logging, so use it only for these explicitly documented machine or
possession-token paths and rely on their independent Notice controls. Never use a
blanket `/api/*`, `/api/webhooks/*`, `/api/agreements/*`, or hostname-wide Bypass.
The inbound-email rule is the exact route, not a prefix; the counterparty rule is
only `/api/exchange/*`. Preserve the exact email request body through the edge—do
not reserialize multipart/JSON, decompress and recompress, or otherwise change the
bytes after the gateway hashes them. Prefer native Cron Triggers for the included
jobs; use Service Auth for automated HTTP callers that must hold service credentials.
See [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
and [public endpoint policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).

Keep `workers_dev` and preview URLs disabled, attach only the reviewed canonical
route, and enable account-level Access protection where compatible with the
customer's hostname inventory. An alternate hostname without an Access application
is an identity bypass even though Notice validates tokens on the primary path.

## Provider setup

The Notice configuration is identical for every provider. Only the Access-to-IdP
connection changes:

- **Microsoft Entra ID:** use the native integration, configure the verified email
  claim, enable group support if Access policy uses directory groups, and use SCIM
  session revocation when licensed and approved.
- **Okta:** prefer the native OIDC integration; SAML is also supported. Enable
  group support or Access-side SCIM only when the customer owns that lifecycle.
- **Google Workspace:** use the Workspace integration when Access policy needs
  Google groups. Record the current provisioning limitations in the customer's
  joiner/mover/leaver procedure.
- **Generic OIDC:** configure the authorization, token, and JWKS endpoints from the
  provider's discovery metadata and select the claim that Access should treat as
  verified email.
- **Generic SAML 2.0:** exchange Access service-provider metadata with the IdP,
  require signed assertions/Authn requests as supported, and enable assertion
  encryption when customer policy requires it.

Access may enable more than one provider for employees, acquired companies, or
approved partners. Notice still sees one consistent, signed Access identity.

## Onboarding and lifecycle

1. Limit the Access application initially to the named implementation users.
2. Enable Notice bootstrap for verified organizational administrator emails.
3. Sign in through Access and create at least two durable Notice administrators.
4. Invite other members by their IdP-verified email and assign least-privilege
   Notice roles.
5. Create any manual Notice groups and direct/group lane-authority records, then
   prove exact lane, currency, amount-ceiling, revocation, and fallback behavior.
6. Test disabled membership, group removal, and IdP revocation.
7. Set `NOTICE_BOOTSTRAP_ENABLED=false`, clear the bootstrap list, rerender the
   deployment configuration, and redeploy.
8. Retain the Access policy test, Notice membership/group/authority audit, and
   recovery evidence.

An invitation binds once to the verified Access subject. Access subjects can change
when a person is removed and re-added to a Zero Trust organization. Do not
automatically relink an existing bound Notice account merely because an email was
reused. Use Notice's administrator-authorized recovery flow:

1. A workspace administrator disables the member.
2. A different administrator verifies the replacement immutable subject in the
   corporate identity system and opens **Workspace access → Replace SSO**.
3. The administrator confirms the exact existing email and enters the replacement
   subject. Notice binds it to the same configured identity boundary, rejects a
   subject already assigned to another account, and writes a workspace audit event.
4. The membership remains disabled. Review the audit event, have the member prove a
   login with the new subject, and only then enable the membership.
5. Prove that the superseded subject is denied and retain the evidence.

The API equivalent is `PATCH /api/admin/memberships` with
`action: "replace_identity"`, the member `userId`, `confirmationEmail`, and
`newIdentitySubject`. Self-replacement, replacement of an active membership, a
mismatched email, an already assigned subject, and an account referenced by any
other workspace all fail closed. Use a separately verified replacement account
for a multi-workspace user; one workspace administrator can never change another
workspace's identity authority. A same-email reinvitation never silently rebinds
authority, and direct D1 edits are unsupported.

Access logout is available at the same application origin under
`/cdn-cgi/access/logout`. Include that action in customer navigation or the support
runbook, and test both application and team-session logout behavior.

## Compatibility adapter

`NOTICE_AUTH_MODE=trusted-headers` preserves the earlier reverse-proxy boundary for
deployments that cannot use Access. It additionally requires:

```text
NOTICE_TRUST_IDENTITY_HEADERS=true
```

This is an explicit compatibility choice, not an automatic fallback. The external
edge must block direct origin access, remove all caller-provided
`x-notice-identity-*` values, inject only verified subject/email/name values, and
own session revocation. Clear the Access team-domain and AUD settings in this mode.
New Cloudflare deployments should use signed Access JWT validation.

The compatibility contract is intentionally strict. The injected subject must be
an immutable, non-reassigned identifier in one stable edge/IdP namespace, contain
no whitespace or control characters, and be at most 512 characters. The verified
email is normalized to lowercase and bounded to 254 characters. Omit both display
name headers to use email as the label, or supply one percent-encoded UTF-8 name of
at most 200 decoded characters together with
`x-notice-identity-name-encoding: percent-encoded-utf-8`. Partial, malformed,
double-purpose, control-bearing, or oversized identity headers fail closed. A
change of edge, issuer, tenant, subject-generation rule, or subject-reassignment
policy is an identity migration: keep affected members disabled and use the
audited replacement procedure instead of reusing the `trusted-edge` namespace.

## Acceptance evidence

Before real agreements are admitted, retain evidence that:

- missing, tampered, expired, future, wrong-issuer, wrong-audience, wrong-algorithm,
  wrong-token-type, and malformed-claim JWTs fail;
- an authenticated user cannot override identity with `x-notice-identity-*`;
- compatibility-edge headers reject partial, overlong, whitespace/control-bearing,
  or incorrectly encoded identities, and the edge proves subjects are immutable
  and never reassigned;
- JWKS key rotation succeeds and key retrieval failure closes access;
- anonymous/direct-origin and alternate-hostname requests fail;
- invited, disabled, viewer, requester, approver, legal, and administrator behavior
  matches the Notice role matrix;
- IdP revocation and Access logout end access within the accepted session policy;
- subject-change recovery follows the disable → independently verify → audited
  replacement → review → enable procedure, while the old subject stays denied;
- the DocuSeal webhook, exact inbound-email webhook when enabled, scoped
  counterparty exchange path, and scheduled jobs work only through their intended
  narrow machine/capability policies; broader API and document paths remain denied; and
- two-administrator recovery works after bootstrap is retired.

Run the repository's complete release gate after configuration changes. Local JWT
tests prove the verifier contract; they do not replace a staging login and
revocation test against the customer's real Access and identity-provider policies.

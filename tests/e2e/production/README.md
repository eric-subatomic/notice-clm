# Production browser evidence

Run this suite with:

```bash
npm run test:e2e:production
```

The Playwright global setup starts the repository's existing explicit local
production-evidence mode. It generates an ephemeral RSA key, serves its public
JWK from a loopback Cloudflare Access fixture, and signs short-lived Access JWTs
for each browser identity. `NOTICE_TRUST_IDENTITY_HEADERS` remains false; the
application validates those JWTs through the ordinary production Access path.

Each run receives a temporary Miniflare persistence directory for isolated D1
and R2 state plus loopback DocuSeal, scanner/mail, CRM, and JWKS boundaries. The
golden test creates and reloads a durable agreement through the UI, exercises a
provider diagnostic, binds a separately signed viewer membership, and proves a
real server-side `403` for an unauthorized mutation without route interception.

This is application-level production-mode evidence, not live-deployment
acceptance. It cannot prove the customer's Cloudflare edge policy, real IdP,
provider accounts, email delivery, WAF, network isolation, backups, monitoring,
or staging/production configuration. Those still require the documented live
synthetic acceptance run in the protected target environment.

## What problem does this solve?

<!-- Describe the user, operator, security, or contributor problem. Link the issue when one exists. -->

## What changed?

<!-- Explain the smallest coherent implementation and any deliberate non-goals. -->

## Security and data review

- [ ] The change uses only synthetic, non-sensitive fixtures and contains no credentials, customer data, private portal URLs, or confidential contract text.
- [ ] Identity, tenant scope, least privilege, exact-paper/basis, retention/hold, provider, and safe-retry implications were reviewed where relevant.
- [ ] New inputs and outputs are bounded, validated, documented, and fail closed in production.
- [ ] Schema changes include the reviewed migration, metadata snapshot, bootstrap parity, and upgrade/rollback notes.

## User experience and compatibility

- [ ] The complete upstream and downstream workflow was exercised.
- [ ] Loading, empty, error, retry, success, keyboard, mobile, and accessibility states were considered where relevant.
- [ ] API, migration, configuration, provider, and persisted-data compatibility is described.
- [ ] User, operator, API, architecture, security, and release documentation is updated where the contract changed.

## Verification

<!-- List focused tests and paste concise results. Do not paste secrets or sensitive logs. -->

- [ ] `npm test`
- [ ] `npm run test:e2e`
- [ ] `npm run test:e2e:production`
- [ ] `npm run audit:production && npm run audit:all`
- [ ] `git diff --check`

## Residual risk or follow-up

<!-- State accepted limitations, deployment/customer work, or follow-up issues. Write "None" when there are none. -->

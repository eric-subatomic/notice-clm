# Contributing to Notice

Thank you for helping make contract operations easier to understand and operate.

Notice is a production-oriented product foundation with an explicit local evaluation mode. Contributions must preserve the fail-closed production boundary and label evaluation-only behavior accurately.

> [!CAUTION]
> Use synthetic data only. Do not upload or commit real agreements, personal information, credentials, customer data, or confidential material.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

- Search existing issues and pull requests before opening duplicate work.
- Use the structured bug or feature issue form so reports include the revision, mode, reproduction, and boundary considerations reviewers need.
- For a material workflow, data-model, integration, or architectural change, open an issue first so the direction can be discussed.
- Report vulnerabilities privately according to [SECURITY.md](./SECURITY.md). Do not open a public security issue.
- Read [GOVERNANCE.md](./GOVERNANCE.md) for decision and release ownership and [SUPPORT.md](./SUPPORT.md) for the public support boundary.

## Development setup

Prerequisites:

- Node.js `>=22.13.0 <23`
- npm `>=11.3.0 <12`

Install and run locally:

```bash
node --version
npm --version
# If npm is older than 11.3.0:
npm install --global npm@11.3.0
npm --version
npm ci
npm run dev:evaluation
```

Some Node 22 installers still bundle npm 10. Upgrade npm before installation rather than using an older client against the reviewed lockfile. If the global npm location is not writable, use a Node version manager or another user-owned installation; do not use `sudo` in the project checkout.

`dev:evaluation` injects only the local Worker evaluation flag. Local D1 and R2 state is created under the ignored `.wrangler/` directory, and synthetic seed records let contributors exercise workflows without sensitive data. Plain `npm run dev` retains the production-default, fail-closed configuration behavior.

## How to contribute

1. Create a focused branch from the latest `main`.
2. Make the smallest coherent change that completes the intended behavior.
3. Add or update verification for the behavior you changed.
4. Update user, API, architecture, or deployment documentation when the contract changes.
5. Run the required checks.
6. Open a pull request explaining the user problem, approach, limitations, and validation.

The pull-request template is part of the review contract. Complete it accurately; when a checklist item does not apply, explain why instead of checking it without evidence.

## Product and UX expectations

Notice is designed to be immediately understandable to people who do not live in a CLM every day.

When changing the interface:

- make the underlying agreement directly reachable wherever an agreement is shown;
- use clear nouns and verbs instead of internal legal-operations jargon;
- preserve a consistent route back to the agreement register;
- keep primary actions visually and semantically obvious;
- support keyboard, pointer, and touch interaction;
- preserve visible focus, meaningful labels, reduced motion, and responsive behavior;
- add empty, loading, error, and success states where relevant; and
- never make a simulated action appear production-backed without an explicit label.

Walk through the complete upstream and downstream flow, not only the screen being edited.

## Data and API changes

Protected APIs resolve verified server identity, workspace membership, and action permission. Machine endpoints use their dedicated webhook or job authentication boundary. A contribution must not weaken those controls, accept caller-selected tenant/actor data, or turn evaluation behavior into a production fallback.

For schema changes:

```bash
npm run db:generate
```

Then:

- inspect the generated SQL;
- commit `db/schema.ts`, the migration, and Drizzle metadata together;
- preserve existing data with an explicit migration strategy;
- add indexes only for demonstrated query patterns; and
- run `PRAGMA optimize` after creating indexes.

For route changes:

- require the least-privilege permission (or the documented machine credential), validate bounded inputs, and return consistent safe errors;
- avoid trusting user identity, ownership, actors, or permissions from the browser;
- scope every D1 query and R2 key from the verified workspace context;
- batch record, audit, version, and outbox writes atomically where D1 supports it, and document unavoidable R2/provider saga behavior;
- keep document bytes in R2 and relational/search metadata in D1;
- document the request, response, status, and compatibility impact in `docs/API.md`; and
- call out any behavior that remains evaluation-only.

Authentication and tenant isolation changes require a security review.

## Document import changes

Only use synthetic fixtures that are safe to publish. Do not commit third-party contract text without a compatible license.

Cover:

- accepted and rejected extensions;
- MIME validation;
- empty and oversized inputs;
- extraction success and metadata-only fallback;
- R2 storage failure;
- D1 metadata failure; and
- document-to-agreement linking.

Extraction and risk flags must be described as heuristics unless a separately validated system replaces them. Do not add in-process production PDF/DOCX parsing: keep complex-document extraction/OCR behind an isolated, resource-bounded service or an authorized reviewed-text workflow. The local evaluation parser is limited to synthetic PDF/DOCX files no larger than 5 MiB and is not production evidence.

## Required checks

Run:

```bash
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:production
git diff --check
```

`npm test` includes unit and security tests, type checking, lint, migration validation, the production build, a Wrangler deployment-package dry run, rendered-output checks, a local evaluation D1/R2/API flow, and an isolated production-mode API evidence flow covering fail-closed configuration, signed Cloudflare Access JWT identity plus the explicit compatibility-header mode, membership/roles, workspace isolation, content versions, retention, native scheduled jobs, webhook rejection, and independent mail/CRM outbox transitions. The Playwright suites exercise evaluation-mode lifecycle, responsive, keyboard, and automated accessibility behavior plus an isolated production-mode browser journey with separately signed admin/viewer identities and real server authorization. Use synthetic data only.

The automated gate does not replace focused negative-path, concurrency, provider-contract, accessibility, or restore testing. Add the strongest proportionate evidence for new behavior rather than expanding source-string checks alone.

## Pull request checklist

- [ ] The change solves a stated user or contributor problem.
- [ ] No real contract data, credentials, or confidential information is included.
- [ ] Working and simulated behavior are labeled accurately.
- [ ] Relevant user flows remain direct and understandable.
- [ ] Accessibility and responsive behavior were considered.
- [ ] API, schema, and migration changes are documented.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run test:e2e` and `npm run test:e2e:production` pass.
- [ ] Documentation reflects the current behavior.

## Commit and review style

- Use concise, imperative commit subjects.
- Keep generated migrations in the same change as their schema update.
- Avoid unrelated cleanup in a feature or fix.
- Explain tradeoffs and known gaps in the pull request.
- Expect reviewers to test the whole affected workflow, including entry and exit points.

## Licensing

By contributing, you agree that your contribution is licensed under the [MIT License](./LICENSE).

Only contribute work you have the right to license. Preserve required notices for third-party material and identify external provenance in the pull request.

No contributor license agreement or copyright assignment is currently required. If that changes, the governance and contribution documents must be updated before the requirement applies.

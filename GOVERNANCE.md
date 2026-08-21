# Governance

Notice uses a maintainer-led governance model while the contributor community develops. The current accountable maintainer is [@ericwithac](https://github.com/ericwithac).

## Decision making

Routine fixes and documentation improvements are decided through issue and pull-request review. Material changes to security boundaries, persisted data, workflows, provider contracts, public APIs, licensing, or project direction should begin with an issue so requirements and compatibility can be discussed before implementation.

Maintainers decide whether a change is accepted based on product fit, safety, evidence, compatibility, maintainability, and the project's documented boundaries. When reasonable alternatives remain, the decision and tradeoffs should be recorded in the issue or pull request. There is no guarantee that a proposed contribution will be merged.

## Maintainer responsibilities

Maintainers are responsible for:

- reviewing and merging changes;
- protecting release and security boundaries;
- triaging private vulnerability reports;
- keeping supported documentation and release evidence current;
- managing repository settings, releases, and contributor conduct; and
- identifying conflicts of interest or delegating review when appropriate.

CODEOWNERS requests review from the current maintainer. Public branch rules and release approvals are the enforceable controls; CODEOWNERS alone does not create them.

## Contributor path

Contributors participate under the [Code of Conduct](./CODE_OF_CONDUCT.md) and [Contributing guide](./CONTRIBUTING.md). Sustained contributors may be invited to take responsibility for a documented area after demonstrating sound review judgment, reliable follow-through, and respect for security and community standards.

Adding or removing a maintainer requires a public governance change that identifies the person, scope, effective date, and any release or security responsibilities being transferred. Security-sensitive transitions may be prepared privately and recorded publicly once accounts and access have been changed safely.

## Releases and security

Only an accountable maintainer may publish a release or change repository visibility. A release must satisfy [Public release and adopter handoff](./docs/PUBLIC_RELEASE.md). Vulnerabilities follow [SECURITY.md](./SECURITY.md); embargoed details stay in the private advisory until coordinated disclosure.

## Changing this model

This file is expected to evolve as the project gains maintainers and adopters. Governance changes use the same reviewed pull-request process and must preserve a clear accountable owner for security intake and releases.

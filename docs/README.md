# Notice documentation

This directory contains the complete product, administration, implementation, and technical documentation for Notice. GitHub renders the Markdown files directly; no documentation server is required.

## Start with the right guide

| You are… | Start here |
| --- | --- |
| A requester, reviewer, approver, Legal user, records user, or workspace administrator | [Complete user guide](./USER_GUIDE.md) |
| A visual learner or someone rehearsing the first workflow | [Self-contained HTML how-to](./how-to/index.html) |
| A private-wealth pilot owner | [Wealth-management starter profile](./WEALTH_MANAGEMENT_PROFILE.md) |
| An implementation partner | [15-minute staging quickstart](./DEPLOYMENT_QUICKSTART.md), then [Production setup](./PRODUCTION_SETUP.md) |
| A production operator | [Operations runbook](./OPERATIONS.md) and [Deployment guide](./DEPLOYMENT.md) |
| A security, identity, or risk reviewer | [Security policy](../SECURITY.md), [Threat model](./THREAT_MODEL.md), and [SSO boundary](./SSO.md) |
| An application or integration developer | [Architecture](./ARCHITECTURE.md), [API](./API.md), and [Governed agent API](./AGENT_API.md) |
| A DocuSeal implementer | [DocuSeal 3.2.1 integration profile](./DOCUSEAL.md) |
| An OCR/scanner implementer | [Customer-hosted OCR and bring-your-own model](./CUSTOMER_HOSTED_OCR.md) and [Gateway conformance](./GATEWAY_CONFORMANCE.md) |
| A release owner | [Public release and adopter handoff](./PUBLIC_RELEASE.md) |
| A contributor or community member | [Contributing](../CONTRIBUTING.md), [governance](../GOVERNANCE.md), [support](../SUPPORT.md), and [security](../SECURITY.md) |

## User documentation

The [complete user guide](./USER_GUIDE.md) is the GitHub-native operating manual. It covers:

- evaluation versus production behavior;
- roles, navigation, keyboard use, accessibility, and mobile operation;
- Today, Contracts, saved views, templates, imports, published intake, and the agreement workspace;
- immutable working paper, secure counterparty exchange, risk, approvals, DocuSeal signature, obligations, comments, audit evidence, and records controls;
- Portfolio & work, Repository, approved language, governed templates and playbooks;
- every **Setup & access** area, including workspace access and governed agent oversight;
- safe retries, troubleshooting, first-contract checklists, persistence, and customer responsibilities.

The [HTML how-to](./how-to/index.html) is a parallel visual and printable walkthrough. Download or clone the repository and open it locally; it is self-contained and loads no external scripts or styles.

## Implementation documentation

- [Implementation handoff](./IMPLEMENTATION_HANDOFF.md) — responsibility split, customer inputs, and acceptance package.
- [Deployment quickstart](./DEPLOYMENT_QUICKSTART.md) — shortest reviewed route to an isolated staging deployment.
- [Production setup](./PRODUCTION_SETUP.md) — identity, storage, providers, records, monitoring, and go-live controls.
- [Deployment guide](./DEPLOYMENT.md) — guarded release mechanics and environment requirements.
- [Operations](./OPERATIONS.md) — jobs, alerts, backup/restore, retention, and incident-safe recovery.

## Product and integration references

- [Architecture](./ARCHITECTURE.md) — trust boundaries, persistence, workflows, and evidence model.
- [Application API](./API.md) — protected browser and administration routes plus the governed machine boundary.
- [Governed agent API](./AGENT_API.md) — service principals, grants, plans, human review, and deliberately bounded execution.
- [DocuSeal](./DOCUSEAL.md) — exact supported release/API/MCP compatibility and operational acceptance.
- [Customer-hosted OCR](./CUSTOMER_HOSTED_OCR.md) — deployment-selected model/profile hosting, scanner protocol, failure behavior, and acceptance.
- [Gateway conformance](./GATEWAY_CONFORMANCE.md) — scanner, outbound delivery, and optional inbound-email contracts.

## Documentation rules

- The root [README](../README.md) is the product and repository entry point; detailed operating instructions belong here.
- Evaluation examples are never production evidence or customer-approved policy.
- Provider pins describe tested compatibility, not proof that a customer's live deployment passed acceptance.
- When code, migrations, or workflows change, update the user guide, the relevant technical guide, and executable documentation tests in the same change.

## Project and community references

- [Contributing](../CONTRIBUTING.md) — development setup, review expectations, and release checks.
- [Governance](../GOVERNANCE.md) — accountable maintainership and decision making.
- [Support](../SUPPORT.md) — public help boundary and safe report contents.
- [Security](../SECURITY.md) — supported versions and private vulnerability reporting.
- [Code of Conduct](../CODE_OF_CONDUCT.md) — participation standards.
- [Changelog](../CHANGELOG.md) — notable public changes and release history.

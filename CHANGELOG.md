# Changelog

All notable project changes will be documented here. Notice uses a human-curated changelog; Git history remains the detailed engineering record.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and tagged public releases will use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Anchored the synthetic recurring-obligation browser test to its fixture date and disambiguated agent-governance success notices from loading announcements.
- Updated local validation launchers for Vinext's supported Vite host and strict-port options.
- Kept CodeQL initialization and analysis on the same pinned release and grouped future Dependabot updates for those actions.

### Changed

- Refreshed compatible dependencies and GitHub Actions while retaining Node 22, TypeScript 6, and ESLint 9 support. Aligned Next and its ESLint configuration, the React runtime packages, and the Cloudflare toolchain.
- Updated the guarded deployment pins to Wrangler 4.152.0 and Vinext 1.3.1 without relaxing input validation, credential isolation, or exact-version checks.

## [0.1.0] - 2026-08-21

### Added

- Open-source issue forms, pull-request guidance, ownership, governance, and support documentation.
- Schema migration `0021` and durable round-scoped counterparty portal transfer budgets, including serialized upload/scanner work and bounded download accounting.
- Adversarial document-format and concurrent rescan regressions, governed-agent decision/read concurrency regressions, and transactional signed-export snapshot coverage.

### Security

- Prevented a grant sponsor from approving or rejecting their own agent plan, revalidated the deciding Admin at commit, and added exact authority/time/resource/paper fences to both agreement-read claim and completion.
- Bounded public exchange cost per round across token rotation: upload/download count and byte ceilings, one expiring upload-work lease, non-disclosing exhaustion, and explicit new-round recovery.
- Strengthened complete-file admission for supported text, RTF, PDF, and DOCX/OOXML containers, and made a fresh correlated malicious rescan authoritative over racing clean work without restoring unsafe bytes.
- Built agreement and workspace signed exports from one transactional D1 snapshot so concurrent writes cannot produce a signed mixed-version evidence view.
- Added a scheduled CodeQL workflow for public-repository operation and pinned every GitHub Action to a reviewed commit SHA.

[Unreleased]: https://github.com/ericwithac/notice-clm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ericwithac/notice-clm/releases/tag/v0.1.0

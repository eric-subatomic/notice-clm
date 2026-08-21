# Changelog

All notable project changes will be documented here. Notice uses a human-curated changelog; Git history remains the detailed engineering record.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and tagged public releases will use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

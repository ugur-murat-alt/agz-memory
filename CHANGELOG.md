# Changelog

All notable changes to AGZ Memory are recorded here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.5.2] - 2026-09-04

### Changed

- Updated linked Git worktree guidance so a main checkout and its linked
  worktrees safely reuse the same `memoryProjectID` after Git metadata confirms
  the shared common directory.
- Preserved persisted binding path and key compatibility while allowing distinct
  OpenCode project/workspace identities to map to that shared memory project.
- Aligned release metadata, package examples, and bilingual operational guidance
  with the 0.5.2 release surface.

### Compatibility

- Retained SQLite schema 11, the exact nine-tool MCP contract, and inert plugin
  defaults across the worktree identity guidance change.

## [0.5.1] - 2026-09-04

### Changed

- Hardened Phase 1 stabilization with the migration-root fix, shared limits and
  typed errors, bounded pagination, strict default-off plugin configuration,
  bounded late attachment/shutdown, and resumable administrative reindexing.
- Added the 10-sample p95 migration timing artifact, safe clean/evidence
  tooling, and keyed quarantine HMAC rotation with Windows fail-closed behavior.

### Security

- Preserved exactly nine MCP tools, SQLite schema 11, semantic backend `none`,
  and inert plugin defaults.

## [0.5.0] - 2026-09-02

### Added

- Added SQLite schema 11 database identity, exact schema fingerprinting,
  domain-separated length-prefixed hash tuples, composite tenant foreign keys,
  and a deterministic lossless schema-10 migration.
- Added a cross-process maintenance gate with lifetime database leases,
  no-symlink path checks, streaming verified restore, rollback verification,
  and deep doctor invariants.
- Added generated reindex operations with purge-first snapshots, fenced and
  heartbeat-protected outbox leases, hard backend timeouts, and explicit retry.
- Added Linux minimum/current Bun, macOS, Windows, property, stress, restore,
  benchmark, package-install, CodeQL, and dependency-review CI gates.

### Changed

- Advanced capture to `agz-memory.capture/2` with strict kind-specific source
  identities, UTF-8 byte limits, fail-closed redaction, and idempotency conflict
  detection.
- Made canonical note, revision, provenance, supersession, and required outbox
  mutations share immediate transactions with optimistic revision checks.
- Bounded plugin reconciliation and history/context probes, preserved turn
  opt-out across hook order and restart, kept prompt capture from advancing the
  reconciliation watermark, validated every event against the full binding,
  and made shutdown independent of hung OpenCode calls.
- Hardened retrieval with one end-to-end deadline, strict backend parsing,
  batched canonical validation, deterministic fusion, directed graph handling,
  and Unicode-safe context limits.

### Security

- Preserved exactly nine MCP tools, fail-closed project isolation, untrusted
  context envelopes, inert plugin defaults, and semantic backend `none`.
- Added the complete [AGZ-001 through AGZ-068 resolution record](docs/review-resolution.md).
- Rejects unsupported databases before permission or journal mutation and
  serializes administrative backup/prune with active database handles.

## [0.4.2] - 2026-09-02

### Added

- Added a versioned `agz-memory` OpenCode skill catalog to the core npm package
  and documented the explicit immutable skill source used for discovery.

### Changed

- Expanded MCP `initialize` guidance so an unfamiliar agent reuses the correct
  durable project, recalls before relying on history, records only verified
  outcomes, and handles non-atomic or destructive mutations safely.
- Added field-level descriptions to the nine tool schemas, including directed
  link semantics, note content behavior, batch ordering, and selector roles.
- Corrected MCP tool annotations for closed-world operation, destructive
  rename/unpin behavior, and safe idempotent retries.
- Documented that npm installation does not itself activate a skill and that
  installers must not modify the user's ambient global `AGENTS.md` policy.

## [0.4.1] - 2026-09-01

### Fixed

- Re-read the SQLite schema after acquiring the migration lock so concurrent
  MCP processes do not act on a stale pre-lock version.
- Skip backup and migration work when another process already completed the
  target schema, preventing redundant backups whose manifest version could
  differ from the copied database.
- Retry migration-lock handoff when the previous owner releases the lock
  between a competing process's create attempt and ownership check.
- Reopen the canonical SQLite file after taking the migration lock so a waiter
  cannot continue on a database file replaced during automatic recovery.
- Verify versioned backup manifests against the schema stored in their SQLite
  database instead of trusting the caller-provided source label.
- Added a six-process regression test that requires exactly one v9 backup, a
  v9 backup database, and one healthy v10 canonical database.

## [0.4.0] - 2026-09-01

### Added

- Published the final `@vaur94/agz-memory` MCP/core/admin package and the
  lockstep `@vaur94/agz-memory-plugin` package.
- Added schema v10 migration for final AGZ Memory persisted contract identity.
- Added a release-surface verifier for package versions, bilingual section
  parity, final version pins, and retired-name reintroduction.
- Added final English/Turkish installation, rollout, recovery, architecture,
  contribution, security, and community documentation.

### Changed

- Standardized capture events on `agz-memory.capture/1`, backup manifests on
  `agz-memory-backup/1`, and injected records on the escaped
  `<agz-memory-context trust="untrusted">` envelope.
- Centralized runtime package identity on product version `0.4.0`.
- Upgraded the canonical SQLite schema from v9 to v10 while preserving all v9
  capture rows and rewriting their contract during migration.
- Updated every public command, package dependency, configuration sample, and
  release document to exact final version `0.4.0`.

### Security

- Kept the OpenCode plugin inert by default: `mode: "off"`, capture disabled,
  no bindings, automatic project creation forbidden, and semantic backend
  `none`.
- Preserved strict project ownership, destructive confirmation, double
  redaction, payload-free outbox, verified backup, and fail-closed migration
  behavior.

### Compatibility

- MCP remains independent of the OpenCode application version.
- The optional plugin supports exactly OpenCode V2 and `@opencode-ai/plugin`
  `0.0.0-beta-18743`.
- Final backup manifests are intentionally accepted only under the final AGZ
  Memory format. A prerelease manifest must be handled by the prerelease that
  created it before upgrading.

## [0.4.0-beta.1] - 2026-08-31

- Introduced verified backup/restore, migration locking, schema v9, revisions,
  provenance, trigger-maintained FTS5, supersession, and the derived-index
  outbox.
- Introduced strict capture events, deterministic idempotency, double
  redaction, quarantine, retention, and policy-gated automatic writes.
- Introduced bounded lexical/graph retrieval and the exact-beta OpenCode V2
  plugin with staged rollout modes.
- Preserved the nine-tool MCP interface and project-isolation guarantees while
  establishing the AGZ Memory public packages and repository.

[0.5.0]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.5.0
[0.4.2]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.4.2
[0.4.1]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.4.1
[0.4.0]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.4.0
[0.4.0-beta.1]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.4.0-beta.1

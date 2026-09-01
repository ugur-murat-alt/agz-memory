# Changelog

All notable changes to AGZ Memory are recorded here. The project follows
[Semantic Versioning](https://semver.org/).

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

[0.4.1]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.4.1
[0.4.0]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.4.0
[0.4.0-beta.1]: https://github.com/ugur-murat-alt/agz-memory/releases/tag/v0.4.0-beta.1

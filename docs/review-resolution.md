# AGZ 0.5.0 Review Resolution

This record maps every AGZ-001 through AGZ-068 review finding to its 0.5.0
resolution and durable source or regression evidence. `Fixed` means the source
change and cited local test or release gate exist in this branch. Repository
settings are external state; AGZ-064 remains explicitly deferred and blocks a
release-ready claim until the controls in `repository-hardening.md` are verified.

| Finding | Priority | Resolution | Evidence |
|---|---|---|---|
| AGZ-001 | P1 | Fixed | Note update and pin compare-and-swap under multiprocess contention: `src/store.ts`, `test/concurrency/note-update-multiprocess.test.ts`. |
| AGZ-002 | P1 | Fixed | Project deletion binds the immutable ID and confirmed current name in one transaction: `src/store.ts`, `test/concurrency/project-delete-rename.test.ts`. |
| AGZ-003 | P1 | Fixed | Revision snapshots and provenance use the row returned by the successful mutation: `src/store.ts`, `test/store/lifecycle.test.ts`. |
| AGZ-004 | P1 | Fixed | Required outbox insertion shares the canonical transaction and cannot be ignored: `src/store.ts`, `test/store/lifecycle.test.ts`. |
| AGZ-005 | P1 | Fixed | Concurrent project and binding creation distinguishes duplicates from conflicts: `src/store.ts`, `src/store/capture.ts`, `test/concurrency/binding-race.test.ts`. |
| AGZ-006 | P1 | Fixed | Domain-separated, length-prefixed UTF-8 tuple hashing removes delimiter and Unicode collisions: `src/hash.ts`, `test/capture/capture-contract-v2.test.ts`. |
| AGZ-007 | P1 | Fixed | Reused capture identities with different source or payload fail as `idempotency_conflict`: `src/store/capture.ts`, `test/capture/capture-contract-v2.test.ts`. |
| AGZ-008 | P1 | Fixed | Shared MCP/core identities retain the exact nine-tool and fail-closed contract: `src/tools.ts`, `test/contract/mcp-surface.test.ts`. |
| AGZ-009 | P1 | Fixed | Normal handles publish lifetime database leases before opening SQLite: `src/db/maintenance.ts`, `test/db/maintenance.test.ts`. |
| AGZ-010 | P1 | Fixed | Maintenance uses one exclusive gate and rejects active or unverifiable handles: `src/db/maintenance.ts`, `test/db/maintenance.test.ts`. |
| AGZ-011 | P1 | Fixed | Restore refuses to replace a database held by a live writer: `src/db/backup.ts`, `test/db/restore-live-writer.test.ts`. |
| AGZ-012 | P1 | Fixed | Restore copies and hashes one opened source inode instead of reopening a verified path: `src/db/backup.ts`, `test/db/restore-toctou.test.ts`. |
| AGZ-013 | P1 | Fixed | Database, backup, sidecar, gate, lease, and manifest paths reject symbolic links: `src/db/maintenance.ts`, `src/db/backup.ts`, `test/db/path-symlink-matrix.test.ts`. |
| AGZ-014 | P1 | Fixed | `application_id` and `agz_meta` bind product, database UUID, schema, and hash policy: `src/db/schema.ts`, `docs/schema-v11.md`. |
| AGZ-015 | P1 | Fixed | Exact application-object fingerprint detects same-version schema drift: `src/db/schema.ts`, `test/db/schema-drift-failclosed.test.ts`. |
| AGZ-016 | P1 | Fixed | Nonempty unsigned databases fail closed while a zero-object database may initialize: `src/db.ts`, `test/db/unrecognized-database.test.ts`. |
| AGZ-017 | P1 | Fixed | Projection reports truncation into the redaction boundary instead of hiding removed suffixes: `src/capture/projection.ts`, `test/security/redaction-property.test.ts`. |
| AGZ-018 | P1 | Fixed | Credential/private-key/high-entropy redaction fails closed across boundaries and punctuation: `src/capture/redact.ts`, `test/security/redaction-corpus.test.ts`. |
| AGZ-019 | P1 | Fixed | Capture event kinds enforce required and forbidden native source identity fields: `src/capture/contract.ts`, `test/capture/capture-contract-v2.test.ts`. |
| AGZ-020 | P1 | Fixed | Composite foreign keys reject cross-project binding, capture, checkpoint, note, and outbox references: `src/db/schema.ts`, `test/capture/capture-contract-v2.test.ts`. |
| AGZ-021 | P1 | Fixed | Quarantined events retain no payload and cannot materialize notes: `src/store/capture.ts`, `test/capture/capture.test.ts`. |
| AGZ-022 | P1 | Fixed | Extraction admits terminal text/status only and excludes tool payloads and reasoning: `packages/opencode-plugin/src/extract.ts`, `test/capture/capture.test.ts`. |
| AGZ-023 | P1 | Fixed | Checkpoints use `(binding_key, session_id)` so native session IDs can repeat safely: `src/db/schema.ts`, `test/capture/capture-contract-v2.test.ts`. |
| AGZ-024 | P1 | Fixed | Startup/hourly retention drains bounded terminal, quarantined, and checkpoint backlogs: `src/store/capture.ts`, `test/capture/capture.test.ts`. |
| AGZ-025 | P2 | Fixed | Reconciliation resumes only after the persisted binding/session checkpoint: `packages/opencode-plugin/src/runtime.ts`, `test/plugin/reconcile-incremental.test.ts`. |
| AGZ-026 | P2 | Fixed | Reconciliation has bounded global concurrency and coalesces same-session reruns: `packages/opencode-plugin/src/runtime.ts`, `test/plugin/reconcile-backpressure.test.ts`. |
| AGZ-027 | P1 | Fixed | Shutdown aborts without awaiting hung event, session, or context calls: `packages/opencode-plugin/src/runtime.ts`, `test/plugin/hung-context-stop.test.ts`. |
| AGZ-028 | P1 | Fixed | Turn opt-out remains effective across every supported hook order: `packages/opencode-plugin/src/runtime.ts`, `test/plugin/optout-hook-permutations.test.ts`. |
| AGZ-029 | P2 | Fixed | Concurrent opt-out history probes share one bounded request: `packages/opencode-plugin/src/runtime.ts`, `test/plugin/optout-hook-permutations.test.ts`. |
| AGZ-030 | P2 | Fixed | Reconciliation, terminal-event, and opt-out preflight calls have bounded abortable timeouts: `packages/opencode-plugin/src/runtime.ts`, `packages/opencode-plugin/test/plugin.test.ts`. |
| AGZ-031 | P2 | Fixed | Runtime errors are reduced to safe codes and do not log payload text: `packages/opencode-plugin/src/runtime.ts`, `packages/opencode-plugin/test/plugin.test.ts`. |
| AGZ-032 | P1 | Fixed | Location and binding checks fail closed on missing, mismatched, or conflicting identity: `packages/opencode-plugin/src/binding.ts`, `packages/opencode-plugin/test/plugin.test.ts`. |
| AGZ-033 | P2 | Fixed | First run creates the private default database hierarchy below `HOME`: `src/config.ts`, `test/plugin/first-run-home.test.ts`. |
| AGZ-034 | P1 | Fixed | Injection remains bounded, escaped, and explicitly marked untrusted: `src/retrieval/formatter.ts`, `test/retrieval/retrieval.test.ts`. |
| AGZ-035 | P1 | Fixed | Plugin defaults remain off/empty and exact OpenCode version mismatch disables startup: `packages/opencode-plugin/src/config.ts`, `packages/opencode-plugin/test/plugin.test.ts`. |
| AGZ-036 | P1 | Fixed | Backend hits use the redacted derived-document hash, not canonical note hash: `src/retrieval/derived.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-037 | P1 | Fixed | Backend responses have strict keys/types/count bounds and malformed data falls back lexically: `src/retrieval/contract.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-038 | P2 | Fixed | One deadline covers backend, canonical validation, graph expansion, and formatting: `src/store/retrieval.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-039 | P2 | Fixed | Backend hit validation uses bounded batch SQL rather than per-hit queries: `src/store/retrieval.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-040 | P2 | Fixed | Reciprocal-rank fusion is deterministic under channel permutation: `src/retrieval/fusion.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-041 | P1 | Fixed | Directed graph retrieval preserves source and target endpoints: `src/store/retrieval.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-042 | P2 | Fixed | Context truncation never splits a Unicode code point: `src/retrieval/formatter.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-043 | P1 | Fixed | Stale and cross-project backend hits are rejected against canonical rows: `src/store/retrieval.ts`, `test/retrieval/retrieval.test.ts`. |
| AGZ-044 | P1 | Fixed | Outbox backend calls hard-time out even when `AbortSignal` is ignored: `src/store/outbox.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-045 | P1 | Fixed | Heartbeat, lease generation, and fence condition every final outbox transition: `src/store/outbox.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-046 | P1 | Fixed | Operation-specific checks and tuple-hashed operation keys reject malformed queue rows: `src/db/schema.ts`, `src/store/outbox.ts`, `test/store/outbox.test.ts`. |
| AGZ-047 | P1 | Fixed | Each reindex generation queues purge plus a transactional active-note snapshot: `src/admin/index.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-048 | P2 | Fixed | Dead work retries explicitly and bounded exponential backoff preserves FIFO: `src/admin/index.ts`, `src/store/outbox.ts`, `test/store/outbox.test.ts`. |
| AGZ-049 | P1 | Fixed | Project deletion and rebuild enqueue purge so derived stores cannot retain omitted content: `src/store.ts`, `src/admin/index.ts`, `test/store/outbox.test.ts`. |
| AGZ-050 | P1 | Fixed | Backup publication and migration occur only under the maintenance gate with verified rollback: `src/db.ts`, `src/db/backup.ts`, `test/db/maintenance.test.ts`, `test/db/backup-restore.test.ts`. |
| AGZ-051 | P2 | Fixed | Batch mutations remain ordered, independently committed, and return every result: `src/tools.ts`, `test/contract/mcp-surface.test.ts`. |
| AGZ-052 | P1 | Fixed | Schema-10 migration preserves valid legacy bindings, events, tombstones, and orphaned outbox history: `src/db/migrations/v011.ts`, `test/db/migration-v11.test.ts`. |
| AGZ-053 | P1 | Fixed | Migration verifies counts, revisions, hashes, FTS, foreign keys, identity, and fingerprint before publish: `src/db/migrations/v011.ts`, `src/admin/doctor.ts`, `test/db/migration-v11.test.ts`. |
| AGZ-054 | P2 | Fixed | Public query and batch inputs retain explicit hard cardinality bounds: `src/tools.ts`, `test/contract/mcp-surface.test.ts`. |
| AGZ-055 | P1 | Fixed | Semantic query bytes and retrieval card requests clamp to hard limits: `src/store/retrieval.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-056 | P2 | Fixed | Store conflicts and lease loss return stable typed error codes rather than raw SQLite errors: `src/store.ts`, `src/store/outbox.ts`, concurrency regressions. |
| AGZ-057 | P1 | Fixed | Doctor checks database identity, exact fingerprint, tenant references, hashes, revisions, FTS, and operation keys: `src/admin/doctor.ts`, `test/db/migration-v11.test.ts`. |
| AGZ-058 | P2 | Fixed | Admin reindex/status/retry responses are bounded and payload-free: `src/admin/index.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-059 | P2 | Fixed | Retrieval metrics deduplicate rankings and clamp recall, MRR, and NDCG to the unit interval: `benchmark/evaluate.ts`, `test/retrieval/hardening.test.ts`. |
| AGZ-060 | P2 | Fixed | `benchmark:gate` enforces the documented p99 latency ceiling: `benchmark/run.ts`, `package.json`. |
| AGZ-061 | P3 | Fixed | Baseline manifest, timings, logs, platform, commit, and benchmark artifacts are committed in `artifacts/baseline/manifest.json` and its listed files. |
| AGZ-062 | P2 | Fixed | CI covers minimum/current Bun on Linux plus current Bun on macOS and Windows: `.github/workflows/ci.yml`. |
| AGZ-063 | P2 | Fixed | CI has separate property, stress, restore, benchmark, CodeQL, and dependency-review gates with immutable action pins: `.github/workflows/ci.yml`. |
| AGZ-064 | P2 | Deferred | `main` protection/ruleset and `npm-release` environment are absent external repository settings; required controls and verification are in `docs/repository-hardening.md`. |
| AGZ-065 | P2 | Fixed | Package smoke derives both tarball names from the manifest version instead of a stale literal: `.github/workflows/ci.yml`. |
| AGZ-066 | P3 | Fixed | Runtime ranges, exact plugin compatibility, frozen lock installs, audits, and Dependabot policy are explicit: `package.json`, `packages/opencode-plugin/package.json`, `.github/dependabot.yml`. |
| AGZ-067 | P3 | Fixed | English/Turkish README and recovery sections are release-verified as mapped contracts: `scripts/verify-release.ts`, `test/release/release-surface.test.ts`. |
| AGZ-068 | P2 | Fixed | Release verification requires exactly this ordered 68-row record and forbids deferred P0/P1 findings: `scripts/verify-release.ts`, `test/release/release-surface.test.ts`. |

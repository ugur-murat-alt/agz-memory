# SQLite Schema 11

Schema 11 is the canonical storage contract for AGZ Memory 0.5.1. SQLite remains the source of truth. Search backends are derived, redacted, disposable indexes rebuilt through the durable outbox.

## Database Identity

- `PRAGMA application_id` is the AGZ Memory application identifier.
- `agz_meta` contains exactly one row with the database UUID, product identifier, schema version, schema fingerprint, hash policy, and creation time.
- `schema_state` contains exactly one row with version `11`.
- A zero-object SQLite database can be initialized. A nonempty unsigned database is rejected by normal open.
- Existing schema 11 databases are verified, not repaired. Missing, changed, or unexpected application objects fail with `schema_fingerprint_mismatch`.

## Hash Policy

All new persisted hashes use the version 2 tuple encoder described in [`adr/hash-identity-v2.md`](adr/hash-identity-v2.md). Canonical note hashes and derived-document hashes use separate domains. A derived backend hit is valid only when its revision and derived hash match a fresh `deriveDocument()` result from the same active project note.

## Tenant Constraints

- Notes and edges retain composite project foreign keys.
- `notes(project_id, supersedes_id)` references `notes(project_id, id)` with `ON DELETE RESTRICT`. A referenced superseded note must not be deleted until the relationship is explicitly resolved.
- `project_bindings(binding_key, project_id)` is a composite parent key.
- Capture events and checkpoints use the binding/project composite foreign key.
- Checkpoints are identified by `(binding_key, session_id)`, so native session IDs may repeat under independent bindings.

## Capture Contract

The schema 11 writer stores `agz-memory.capture/2` events. Event identities are strict:

| Kind | Required identity | Forbidden identity |
|---|---|---|
| user candidate | message ID | ordinal, tool call, terminal status |
| assistant candidate | message ID and ordinal | tool call, terminal status |
| tool signal | message ID, tool call ID, terminal status | ordinal |
| session summary | checkpoint message ID | ordinal, tool call, terminal status |

Ingestion recomputes the idempotency key. An identical retry is `duplicate`; a reused key with different source or payload is `idempotency_conflict`.

## Revision and Mutation Invariants

- A note's `current_revision` is monotonically increasing.
- Updates and pin changes use optimistic compare-and-swap: `UPDATE ... WHERE current_revision = ? RETURNING *`.
- A retry reloads the current row and reapplies the original patch.
- The returned row is the only source for revision snapshots, provenance, derived hashes, and outbox generation.
- Revision/provenance/outbox insertion happens in the same immediate transaction as the canonical mutation.
- A canonical commit never depends on backend availability. A required outbox insertion cannot be silently ignored.
- Manual title or kind changes clear `subject_key`; manual edits must not retain an automatic capture identity for a changed subject.

## Outbox

Schema 11 adds operation identity, reindex generation, lease generation/fence, and heartbeat fields. Operation-specific checks require:

- `upsert-note`: note ID, positive revision, and derived SHA-256.
- `delete-note`: note ID and positive revision; no document payload.
- `purge-project`: no note ID, revision, or content hash.

Partial unique indexes prevent duplicate active upsert, delete, purge, and reindex-generation operations without allowing historical terminal rows to block a new rebuild. Backends receive an idempotency operation key and monotonically increasing fence. Lease heartbeat and final state transitions are owner/fence conditional; zero changed rows is `lost_lease`.

## Reindex

Each reindex command transactionally creates a new generation of durable outbox operations. Every selected project queues one purge before its bounded active-note upserts. Progress is represented by the persisted outbox states. A repeated reindex uses a new generation and is not blocked by old succeeded rows. Quarantined derived documents are omitted after purge and counted by reason code.

## Migration From Schema 10

Before migration, AGZ Memory creates and verifies one source-schema-10 backup while holding the maintenance gate. Migration then:

1. Validates source health, tenant relationships, supersession references, capture source identities, and outbox rows.
2. Builds schema 11 replacement tables.
3. Recomputes version 2 canonical, revision, derived, binding, payload, event, checkpoint, and outbox identities.
4. Records aggregate old/new mapping counts without private content.
5. Verifies row counts, foreign keys, current-revision agreement, hashes, FTS, application identity, and the exact schema fingerprint.
6. Publishes version 11 only after all checks pass.

Cross-project, malformed, or ambiguous legacy rows stop migration. Documented compatibility normalization resets checkpoint watermarks, canonicalizes retained payloadless capture identities, and repairs valid historical outbox tombstone fields without dropping rows. The error identifies only the safe table/row identity and an error code; the verified backup path is included in the operator-facing migration report.

Reopening a valid schema 11 database is idempotent and does not execute `CREATE IF NOT EXISTS`. A 0.4.1 binary observes version 11 and rejects it as newer before writing application DDL.

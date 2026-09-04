# AGZ Memory Architecture

This document describes the `0.5.1` runtime and SQLite schema v11.

## System Boundaries

```text
OpenCode MCP client
  -> agz-memory stdio server
     -> nine-tool MCP adapter
        -> memory core
            -> SQLite schema v11 (canonical)

OpenCode V2 beta-18743
  -> @vaur94/agz-memory-plugin
     -> explicit project binding
     -> redacted capture and policy
     -> bounded retrieval and untrusted context
        -> the same memory core and SQLite database

SQLite outbox
  -> optional derived retrieval backend
      -> disabled in 0.5.1; backend = none
```

The MCP adapter owns tool schemas, annotations, and result envelopes. The core
owns transactions, project isolation, note lifecycle, capture, retrieval,
backup, migration, and outbox behavior. The plugin owns only OpenCode hook and
event adaptation. It issues no SQL directly.

## Trust And Ownership

`projects.id` is the ownership boundary. Every note, edge, revision,
provenance record, binding, checkpoint, and capture event carries or resolves
to that immutable UUID. Names are unique labels and may change.

Public selectors accept exactly one of `projectID` or `projectName`. The store
resolves the selector before any read or mutation. Edge creation verifies that
both endpoints belong to the selected project. Project deletion relies on
foreign-key cascades only after the caller supplies the immutable ID, exact
current name, and fixed confirmation phrase.

## Canonical Schema

SQLite schema v11 contains:

| Table | Responsibility |
|---|---|
| `projects` | Immutable project identity and unique normalized name. |
| `notes` | Current note state, status, subject key, revision, and content hash. |
| `note_edges` | Typed same-project graph relations. |
| `notes_fts` | Trigger-maintained FTS5 projection of current note text. |
| `project_bindings` | Explicit OpenCode-to-memory mapping with a v2 tuple-hashed canonical path. |
| `capture_checkpoints` | Binding-scoped reconciliation progress without transcript text. |
| `capture_events` | Redacted, idempotent capture audit under `agz-memory.capture/2`. |
| `note_provenance` | Source identity, extractor/redaction versions, and confidence. |
| `note_revisions` | Immutable snapshot for each committed note revision. |
| `index_outbox` | Payload-free, generation- and fence-aware queue for replaceable indexes. |
| `agz_meta` | Database UUID, product, schema, fingerprint, and hash policy identity. |
| `schema_state` | The single current schema version. |

The v11 migration replaces delimiter-joined hashes with domain-separated,
length-prefixed v2 tuple hashes. It validates and deterministically maps every
schema 10 note, binding, capture, checkpoint, and outbox row. Composite foreign
keys enforce project ownership. Migration publishes schema 11 only after row
counts, revisions, hashes, FTS, foreign keys, database identity, and the exact
schema fingerprint pass.

## Note Lifecycle

Manual MCP writes and automatic writes use the same invariants:

1. Normalize and validate the project selector and input.
2. Calculate the canonical content SHA-256.
3. Commit the note mutation and its provenance/revision in one transaction.
4. Maintain supersession status and the `SUPERSEDES` edge when applicable.
5. Enqueue required identity-only derived-index operations in the same commit.
6. Let SQLite triggers update FTS5 for insert, update, and delete.

Only active notes are returned by normal recall. Superseded and archived state
remains auditable through revisions and explicit reads where supported.

## MCP Contract

The external contract has exactly nine tools. Single and batch mutations share
the same validation rules. A batch is ordered but deliberately non-atomic:
each completed item commits before the next begins, and every item returns its
own result.

Tool descriptions mark read-only, idempotent, and destructive behavior for MCP
clients. `memory_read` is the only operation that expands indexed cards to full
content and graph neighbors. `memory_recall` returns bounded cards suitable for
model context.

## Capture Pipeline

Capture requires all of these gates:

1. The plugin version and running OpenCode beta match exactly.
2. Mode is not `off`, capture is enabled, and exactly one explicit binding
   matches project ID, workspace ID, and canonical directory.
3. Only terminal user/assistant text or terminal tool status is projected.
4. Credential and private-key patterns are removed or quarantined.
5. The strict `CaptureEventV2` parser enforces UTF-8 size, kind-specific source identity, event
   kind, and redaction metadata.
6. A v2 tuple-hashed idempotency key prevents replay duplicates and rejects
   mismatched reuse as an idempotency conflict.
7. Shadow modes stop at the audit event. `auto-write` continues only for an
   allowed kind, explicit durable evidence, supported intent, and confidence at
   or above policy.
8. Content is redacted again before note materialization.

Quarantined events never retain a payload. Startup and hourly retention workers
drain bounded batches: terminal event payloads become eligible for clearing
after 30 days, quarantined events for deletion after 7 days, and expired idle,
closed, or unavailable checkpoints for deletion. If every AGZ Memory process is
stopped at the deadline, overdue work is drained on the next MCP or plugin start.

## Retrieval Pipeline

Retrieval starts with project-filtered lexical FTS5 results. Same-project graph
neighbors can be added with bounded fan-out. Optional backend responses are
strictly parsed, validated against current canonical rows in bounded batch SQL,
and discarded when project, revision, or derived hash differs. A deterministic
reciprocal-rank fusion step deduplicates candidates and returns at most eight
cards within one deadline for the complete pipeline.

The plugin formats cards inside an escaped
`<agz-memory-context trust="untrusted">` envelope capped at 4,800 characters.
The envelope states that records are reference data, not instructions or system
policy. A timeout or retrieval failure produces no injection and leaves the
original OpenCode context unchanged.

Semantic providers implement an optional backend contract: project-filtered
query, idempotent upsert, deterministic delete, full project purge, and health.
No provider is enabled in `0.5.1`. The SQLite lexical/graph path remains fully
functional without one.

## Derived Index Outbox

`index_outbox` stores backend, operation, project ID, note ID, revision, and
content hash. It never stores note text. Workers lease rows, derive content
from the canonical database at execution time, and acknowledge success only
after the backend call completes.

Leases heartbeat while work runs and every completion is conditional on the
lease owner, generation, and monotonic fence. Backend calls have a hard timeout
even when they ignore `AbortSignal`. Retries use bounded exponential backoff;
terminal failures become `dead` and are visible through the admin CLI. Project
purge is a first-class operation, and each reindex generation queues a purge
before a transactional snapshot of active-note upserts.

Outbox adapters must declare `agz-memory-outbox/1` and atomically reject an
operation context older than the greatest `(sequence, fence)` already applied
for that backend and project. `sequence` orders distinct queue rows while
`fence` orders competing leases for one row; `operationKey` makes an accepted
attempt idempotent. An adapter that cannot enforce this protocol is not eligible
for outbox registration.

## Backup, Migration, And Restore

Every normal database handle publishes a lifetime lease. Migration, restore,
backup publication, and prune acquire an exclusive filesystem maintenance gate
and refuse to proceed while an active or unverifiable lease exists. Before the
first schema mutation, AGZ Memory checkpoints WAL,
creates a SQLite-consistent copy with `VACUUM INTO`, verifies integrity and row
counts, hashes the bytes, and atomically publishes both database and
`agz-memory-backup/1` manifest.

A failed migration closes the active connection and attempts restore from that
verified backup. Manual restore is two-step: dry-run inspection, then exact
SHA-256 and `RESTORE_DATABASE_FROM_VERIFIED_BACKUP` confirmation. The replaced
database is preserved under a unique failed-source name.

## Failure Policy

- Unsupported future schema: fail closed without mutation.
- Missing or conflicting plugin binding: disable the plugin.
- OpenCode version mismatch: disable the plugin; MCP remains available.
- Capture parsing, redaction, or policy failure: reject or quarantine, never
  broaden acceptance.
- Retrieval timeout/backend error: omit injection and preserve original context.
- Migration failure: restore verified source or raise an aggregate failure.
- Dead outbox work: retain canonical SQLite data and report operational state.

These rules favor durable canonical data and explicit operator action over
automatic recovery that could cross a project or trust boundary.

# AGZ Memory v9 Architecture

## System Boundaries

```text
OpenCode V2 beta-18743
  -> @vaur94/agz-memory-plugin
     -> projection -> redaction -> policy -> CaptureEventV1
     -> bounded retrieval -> untrusted context
         -> @vaur94/agz-memory/core
           -> SQLite schema v9 (canonical)
              -> FTS5 + graph + revisions + provenance + outbox
                 -> optional replaceable derived backend (currently none)

OpenCode MCP client
  -> agz-memory stdio server
     -> unchanged nine-tool MCP adapter
        -> same core and canonical SQLite database
```

The MCP adapter owns tool schemas and text result envelopes. The core owns
transactions, project isolation, capture, lifecycle, retrieval, and outbox.
The plugin owns only exact OpenCode V2 hook/event adaptation. It writes no SQL.

## Canonical Storage

`projects`, `notes`, and `note_edges` preserve the public v8 identities and
fields. Schema v9 adds internal note fields:

| Field | Invariant |
|---|---|
| `current_revision` | Integer `>= 1` |
| `subject_key` | Optional normalized supersession key |
| `content_hash` | SHA-256 of canonical kind/title/summary/content |

Additional tables:

| Table | Purpose |
|---|---|
| `project_bindings` | Explicit OpenCode project/workspace to memory project mapping; stores only path hashes |
| `capture_checkpoints` | Crash-safe session reconciliation progress without transcript text |
| `capture_events` | Bounded redacted idempotent event audit |
| `note_provenance` | Source IDs, extractor/redaction versions, and confidence; no prompt/tool payload |
| `note_revisions` | Full snapshot for every committed note state |
| `index_outbox` | Payload-free at-least-once derived-index queue |

`schema_state` is the only schema version source and contains exactly `9` after
migration. Foreign keys are enabled during normal operation.

## Transaction Invariants

- Create commits note, provenance, revision, FTS trigger, and outbox together.
- Patch and pin increment revision only when values actually change.
- Hard note delete cascades revision, provenance, edge, and FTS state.
- Project delete queues payload-free backend purge operations before project
  cascades, in the same transaction.
- Supersession marks the old note `superseded`, snapshots it, creates the active
  replacement, adds a `SUPERSEDES` edge, and writes outbox operations atomically.
- Capture materialization commits the event disposition and note lifecycle in
  one transaction.

The partial unique index on `(project_id, kind, subject_key)` applies only to
active notes with a subject key. Manual MCP notes keep `subject_key = NULL`, so
the existing free-form contract remains unchanged.

## FTS And Retrieval

`notes_fts` is an external-content FTS5 table keyed by `notes.rowid`. Insert,
update, and delete triggers maintain it inside note transactions. Migration
uses FTS `rebuild` and compares note/FTS counts.

Retrieval channels are bounded:

| Channel | Candidate limit |
|---|---:|
| Lexical BM25 | 40 |
| Optional semantic | 40 |
| One-hop graph | 30 |

Weighted reciprocal rank fusion uses `1.00`, `0.80`, and `0.35` channel weights
with constant `60`. Every semantic hit is re-read by `(project_id, note_id)` and
rejected when missing, inactive, cross-project, stale-revision, or hash-mismatched.
Semantic failure falls back to lexical retrieval.

The injection formatter emits only kind, opaque ID, title, and summary. It
escapes delimiter characters, includes a fixed untrusted-data warning, limits
output to eight cards and 4,800 characters, and never injects full note content.

## Capture Pipeline

The plugin uses the exact `@opencode-ai/plugin@0.0.0-beta-18743` Promise API:

- `ctx.session.hook("prompt")`
- `ctx.session.hook("context")`
- `ctx.tool.hook("execute.after")`
- `ctx.event.subscribe({ signal })`
- `ctx.session.get({ sessionID })`
- `ctx.session.context({ sessionID })`

The live event stream is a latency hint, not the canonical ingestion boundary.
Prompt checkpoints and bounded context reconciliation recover missed terminal
events. Event reconnect uses bounded backoff. Plugin cleanup aborts the stream,
disposes hooks, and waits only a bounded period.

The projection boundary accepts user prompt text and assistant terminal text.
It excludes reasoning, tool arguments/results, attachments, files, shell output,
system/synthetic/skill/compaction parts, paths, diffs, environment values, and
provider state. Tool capture stores only name, terminal status, opaque native
IDs, and a normalized error type.

Redaction runs before extraction and again inside core. High-risk payloads are
quarantined with `payload_json = NULL`. Raw secret values and hashes are not
stored in capture audit tables.

## Binding And Isolation

Plugin bindings require memory project UUID, OpenCode project ID, optional
workspace ID, and a verified canonical directory. Raw paths are not persisted.
The binding key is:

```text
sha256("opencode-v2\0" + projectID + "\0" + workspaceID + "\0" + sha256(realpath))
```

Basenames are never project identities. Event location or session location must
match the active plugin instance. Missing, conflicting, moved, or cross-project
bindings disable capture/injection for that callback.

## Backup And Migration

Migration uses `<database>.migration.lock/owner.json`, mode `0700/0600`, with
PID, process-start marker, host, timestamp, target schema, and random owner ID.
A live owner cannot be broken by runtime or admin.

Before v8-to-v9 DDL:

1. Checkpoint WAL and validate source integrity/foreign keys.
2. Create a unique `VACUUM INTO` snapshot.
3. Validate the snapshot on a separate connection.
4. Write SHA-256, byte size, schema, SQLite version, and row counts to a manifest.
5. Fsync temporary files and the backup directory, then atomically rename.
6. Rebuild notes/edges, create revision/provenance rows, create v9 tables and
   trigger-based FTS, and set schema `9` as the final SQL step.
7. Re-enable and verify foreign keys, integrity, counts, revisions, and FTS.

Failure closes the candidate DB and restores the verified snapshot. Restore
never overwrites the previous canonical DB; it preserves the old file and
quarantines WAL/SHM sidecars.

## Outbox

Outbox work is FIFO per `(backend, project_id)`. Atomic claims use random worker
lease IDs and expiry. Stale revision upserts complete without export. Vendor
exports apply redaction again and derive a hash from the redacted document.
High-risk manual notes remain canonical but are not exported.

Delivery is at least once and adapters must be idempotent by opaque project/note
key. Ten failed attempts move work to `dead`; canonical note commits are never
rolled back by a derived backend outage.

## Fail-Open And Fail-Closed

| Operation | Behavior |
|---|---|
| Plugin capture/injection | Fail-open; OpenCode request continues |
| Semantic query | Lexical fallback |
| Binding conflict | Fail-closed for memory feature |
| Secret quarantine | Fail-closed for note write |
| MCP mutation | Transaction rollback and explicit tool error |
| Migration/restore | Fail-closed; service does not start on partial state |

Logs contain allowlisted operation/outcome/error codes only. Prompt, query,
note text, paths, tool payloads, headers, and credentials are never logged.

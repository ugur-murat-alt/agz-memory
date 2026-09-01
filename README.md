# AGZ Memory

English | [Türkçe](README.tr.md)

Project-scoped persistent memory for OpenCode V2. The repository publishes two
lockstep packages:

- `@vaur94/agz-memory`: the nine-tool stdio MCP server, reusable core, and
  recovery-oriented admin CLI.
- `@vaur94/agz-memory-plugin`: optional safe capture and bounded context
  injection for an exact OpenCode V2 beta.

SQLite schema v9 is the canonical source of truth. Optional semantic services
are disposable derived indexes and are disabled unless their isolation,
deletion, purge, and quality contracts pass the benchmark gates.

## Compatibility

| Component | Version |
|---|---|
| Core/MCP | `0.4.0-beta.1` |
| Plugin | `0.4.0-beta.1` |
| OpenCode V2 | `0.0.0-beta-18743` |
| `@opencode-ai/plugin` | `0.0.0-beta-18743` |
| Bun | `>=1.3.14` |
| SQLite schema | `9` |

The plugin disables itself when the running OpenCode version does not exactly
match its supported beta. The MCP server remains independently usable.

## MCP Server

```sh
bunx @vaur94/agz-memory@0.4.0-beta.1
```

OpenCode V2 configuration uses `mcp.servers`:

```jsonc
{
  "mcp": {
    "servers": {
      "agz-memory": {
        "type": "local",
        "command": ["bunx", "@vaur94/agz-memory@0.4.0-beta.1"],
        "environment": {
          "OPENCODE_MEMORY_DATABASE_PATH": "{env:OPENCODE_MEMORY_DATABASE_PATH}"
        },
        "codemode": false
      }
    }
  }
}
```

The default database path is
`~/.local/share/opencode-memory/memory.sqlite`. Override it with
`OPENCODE_MEMORY_DATABASE_PATH` before starting OpenCode.

### Tools

The external MCP contract remains exactly nine tools:

| Tool | Purpose |
|---|---|
| `project_list` | List immutable project IDs and current names |
| `project_create` | Create an empty project |
| `project_update` | Rename a project without changing its ID |
| `project_delete` | Permanently delete one confirmed project |
| `memory_recall` | Project-filtered FTS5 and one-hop graph recall |
| `memory_update` | Create, patch, or permanently delete notes |
| `memory_pin` | Set note priority inside one project |
| `memory_link` | Add same-project graph edges |
| `memory_read` | Read full note bodies and graph edges |

Every `memory_*` request selects exactly one `projectID` or `projectName`.
Cross-project reads, updates, deletes, links, and recall are rejected. Ordered
batches are intentionally non-atomic, so inspect every item result.

Project deletion requires all three values:

```json
{
  "projectID": "<immutable UUID>",
  "confirmProjectName": "<exact current case-sensitive name>",
  "confirmation": "DELETE_PROJECT_AND_ALL_MEMORY"
}
```

## Optional OpenCode Plugin

The plugin is a separate package so the moving OpenCode beta dependency never
enters the MCP-only runtime. Its safe default is `off`.

```jsonc
{
  "plugins": [
    {
      "package": "@vaur94/agz-memory-plugin@0.4.0-beta.1",
      "options": {
        "mode": "off",
        "autoCreateProjects": false,
        "bindings": [],
        "capture": {
          "enabled": false,
          "allowedKinds": ["preference", "decision"],
          "minConfidence": 0.95
        },
        "retrieval": {
          "semanticBackend": "none",
          "timeoutMs": 300,
          "maxCards": 8,
          "maxCharacters": 4800
        }
      }
    }
  ]
}
```

Bindings are explicit allowlist entries. The plugin never selects a memory
project by basename and never auto-creates one:

```jsonc
{
  "memoryProjectID": "<UUID from project_list>",
  "opencodeProjectID": "<ctx.location.project.id>",
  "canonicalDirectory": "/absolute/canonical/project/path",
  "workspaceID": "<optional workspace ID>"
}
```

The rollout modes are cumulative:

| Mode | Capture | Retrieval | Injection | Auto-write |
|---|---:|---:|---:|---:|
| `off` | No | No | No | No |
| `shadow-capture` | Redacted audit only | No | No | No |
| `shadow-retrieval` | Yes | Metrics only | No | No |
| `inject` | Yes | Yes | Bounded | No |
| `auto-write` | Yes | Yes | Bounded | Explicit high-confidence decisions/preferences only |

Injection is fail-open, summary-only, limited to eight cards and 4,800
characters, and wrapped as `trust="untrusted"`. A memory timeout or binding
error does not block the main OpenCode request.

## Capture Safety

The canonical event contract remains `opencode2-memory.capture/1` for database
and event compatibility with earlier releases.

- Native session/message/ordinal/tool IDs produce deterministic SHA-256
  idempotency keys. SQLite uniqueness is the final duplicate guard.
- Projection discards reasoning, tool input/output, attachments, files, system
  parts, diffs, environment data, and provider state.
- Text is redacted before extraction and again inside the core before any DB
  insert.
- Private keys, credential URIs, multiple high-risk secrets, and canaries are
  quarantined without a text payload.
- Event JSON is limited to 16 KiB; automatic content is limited to 4,800
  characters.
- `[memory:off]` disables capture for that user message.
- Auto-write initially accepts only explicit `preference` and `decision`
  candidates at confidence `>= 0.95`.

## Schema V9

Schema v9 preserves project, note, edge, timestamp, status, and pin identities
while adding:

- `project_bindings`
- `capture_checkpoints`
- `capture_events`
- `note_provenance`
- `note_revisions`
- `index_outbox`

Every committed note state has provenance and a full revision snapshot. Note
create, patch, pin, supersession, FTS triggers, and derived-index outbox writes
share transactions. Normal recall only returns `active` notes.

FTS5 now uses external content and insert/update/delete triggers rather than
manual synchronization.

## Backup, Upgrade, And Restore

The admin binary writes JSON to stdout and sanitized errors to stderr:

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin doctor
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin backup
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin upgrade --to 9
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin outbox status
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin capture status
```

Every schema upgrade takes an atomic migration lock and creates a verified
`VACUUM INTO` snapshot plus a SHA-256 manifest before DDL runs. Integrity,
foreign keys, table counts, revision invariants, and FTS counts are checked.

Restore is dry-run unless the manifest hash and confirmation are supplied:

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin restore \
  /path/to/memory.sqlite.backup/<manifest>.manifest.json

bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin restore \
  /path/to/memory.sqlite.backup/<manifest>.manifest.json \
  --sha256 <manifest-database-sha256> \
  --confirm RESTORE_DATABASE_FROM_VERIFIED_BACKUP
```

Stop every MCP/plugin writer before an upgrade or restore. The current database
is preserved as `failed-restore-source-*`; WAL/SHM sidecars are quarantined.
See [`docs/backup-restore-runbook.md`](docs/backup-restore-runbook.md).

## Semantic Backend Decision

Production remains `semanticBackend: "none"`. The exact vendor contract review
did not produce a complete live A/B proof for all required server-side project
filter, deterministic delete, purge, leakage, and latency gates. SQLite
lexical+graph retrieval is therefore the production path. See
[`benchmark/baselines/vendor-decision.json`](benchmark/baselines/vendor-decision.json).

## Development

```sh
bun install
bun test
bun run check
bun run build
npm pack --dry-run --json
```

The test suite includes MCP snapshots, legacy and v8-to-v9 migration fixtures,
backup/restore, revisions, outbox FIFO, capture idempotency, secret quarantine,
retrieval isolation, bounded formatter, and exact-beta plugin hook smoke tests.

# OpenCode2 Memory

Persistent, project-scoped memory exposed to OpenCode V2 as a Bun-powered stdio
MCP server. The server uses `@modelcontextprotocol/server` v2, implements
schema v8, and publishes memory usage guidance through MCP server
instructions. It is configured as an MCP server, not as an OpenCode plugin.

## Run

```sh
bunx @vaur94/opencode2-memory@0.3.0
```

The process communicates with its MCP client over stdin/stdout.

## OpenCode V2 Configuration

Add the server to `opencode.json` or `opencode.jsonc` under `mcp.servers`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "opencode2-memory": {
        "type": "local",
        "command": ["bunx", "@vaur94/opencode2-memory@0.3.0"],
        "environment": {
          "OPENCODE_MEMORY_DATABASE_PATH": "{env:OPENCODE_MEMORY_DATABASE_PATH}"
        },
        "codemode": false
      }
    }
  }
}
```

Set the database path before starting OpenCode, or replace the `{env:...}`
value with a literal path:

```sh
export OPENCODE_MEMORY_DATABASE_PATH="$HOME/.local/share/opencode-memory/memory.sqlite"
```

`mcp.servers` and `type: "local"` are the OpenCode V2 configuration shape.
`codemode: false` keeps the MCP tools on the provider's direct tool list
instead of exposing them through Code Mode. OpenCode may display a tool with
the server prefix, such as `opencode2-memory_project_list`; the MCP tool names
below are the names registered by this server.

## Database And Scope

`OPENCODE_MEMORY_DATABASE_PATH` selects the SQLite database. When it is not
set, the default is:

```text
~/.local/share/opencode-memory/memory.sqlite
```

Schema v8 stores projects in `projects`, notes in `notes`, same-project graph
edges in `note_edges`, and searchable fields in the `notes_fts` FTS5 table.

- Each project has an immutable UUID `id` and a renameable `name`.
- Project names are unique case-insensitively after the server's Unicode
  normalization and whitespace cleanup.
- Every note and edge belongs to exactly one project. Search, reads, writes,
  pins, and links never cross a project boundary.
- `pinned` is per note. Pinned matching notes are ordered before unpinned
  matches during recall.

There is no global memory namespace in the current API. A project must be
created before its first note is stored.

## Tools

All five `memory_*` tools require exactly one project selector: `projectID` or
`projectName`. They reject requests with neither selector or with both. The
immutable UUID is preferred for long-lived references; the current project
name is a convenient case-insensitive lookup.

- `project_list`: List every project with its immutable ID, current name, note
  count, and pinned-note count. Use this before selecting a project by ID.
- `project_create`: Create an empty project with `projectName`. The returned
  UUID is immutable; the unique name can later be changed.
- `project_update`: Rename a project with `projectID` and its new
  `projectName`. Renaming does not change the ID or detach notes.
- `project_delete`: Permanently delete one project and all notes, pinned state,
  same-project edges, and FTS search records owned by it. This requires
  `projectID`, `confirmProjectName` matching the current name exactly, and the
  literal `DELETE_PROJECT_AND_ALL_MEMORY` in `confirmation`.
- `memory_recall`: Search one project with `query` or up to 10 `queries` using
  FTS5 BM25 and one-hop active graph expansion. Pinned matching notes are
  prioritized. Inline cards include content; indexed cards can be expanded
  with `memory_read`.
- `memory_update`: Create a note, patch an active note by `id`, or permanently
  delete one note with `delete: true`. A note deletion also removes its
  same-project edges. Up to 10 ordered, non-atomic updates are accepted in one
  call; inspect every item result because earlier operations remain applied if
  a later item fails. Do not batch destructive deletes unless partial completion
  is acceptable. Pin state is changed only with `memory_pin`.
- `memory_pin`: Set or clear the pinned state for one active note in the
  selected project. Pinning never moves or deletes content.
- `memory_link`: Create one graph edge or up to 10 edges between active notes
  in the selected project. Link batches are also ordered and non-atomic.
  Cross-project links and self-links are rejected.
  Supported predicates are `SUPPORTS`, `DERIVED_FROM`, `PART_OF`, `ABOUT`,
  `PRECEDES`, and `SUPERSEDES`.
- `memory_read`: Read one note or up to 10 notes from the selected project,
  including full content, pin state, project identity, and same-project graph
  edges.

## Safety And Injection

Call `project_list` before choosing a project when the UUID or current name is
not already known. Prefer `projectID` after selection because names can be
renamed. Verify a note ID before using `delete: true`.

`project_delete` is irreversible. Do not call it unless deletion is explicitly
intended. Before calling it, verify the UUID and current case-sensitive name
from `project_list`, then provide all required fields exactly:

```json
{
  "projectID": "<project UUID>",
  "confirmProjectName": "<exact current name>",
  "confirmation": "DELETE_PROJECT_AND_ALL_MEMORY"
}
```

The server publishes usage guidance through MCP `instructions`, but it never
injects notes into OpenCode context automatically. Agents must call
`memory_recall` when they need relevant project history. Store only durable,
verified facts, decisions, procedures, research, preferences, or substantial
completed work; do not store transcripts, guesses, secrets, or routine
progress.

## Migration

### From the plugin

Remove the old `plugins` entry before enabling this MCP server so two processes
do not open the same database. If the plugin used a custom `databasePath`, move
that exact path to `OPENCODE_MEMORY_DATABASE_PATH`; otherwise the default path
is unchanged. Back up the SQLite file, start the MCP server, and verify an
existing note with `project_list` and `memory_recall` before removing the
backup.

### Schema v8 and legacy data

Opening a database applies a one-way migration. A database with a schema newer
than v8 is rejected.

- Existing global or v5 notes whose project IDs are not represented by a
  project record are adopted into generated UUID legacy projects. The generated
  names are based on the legacy ID, for example `Legacy Global` or `Legacy`,
  with a suffix when needed.
- During a pre-v8 upgrade, an existing `pinned` column is copied when present.
  Pre-v5 pin state is therefore preserved when that column exists. v5 pin data
  that was already lost cannot be reconstructed and remains unpinned.
- The note and edge tables are rebuilt with project foreign keys and the FTS5
  index is rebuilt from the migrated notes.
- Legacy cross-project edges are dropped. Same-project edges are kept; edges
  with missing endpoints are skipped.
- Active legacy `memory_associations` whose endpoints are in the same project
  are imported as graph edges. Known predicates are preserved; other kinds map
  to `ABOUT`.

### Legacy v2 data

When legacy v2 tables are present, a backup is created as
`<database>.v2-backup` when one does not already exist.

- Active `memory_items` and their current versions become `notes`.
- Legacy kinds are mapped to current kinds; active document sources and chunks
  become one indexed `research` note per document.
- Active `memory_edges` become `note_edges`; supported predicates are preserved
  and unknown predicates map to `ABOUT`. Older active `memory_links` also map
  to `ABOUT`.
- Edges are imported only when both notes belong to the same project. Legacy
  cross-project edges are dropped.
- Active same-project `memory_associations` are also imported; unknown kinds
  map to `ABOUT`.
- v2 pin state is not reconstructed by this migration.

Migration is one-way; data that was discarded or had already been forgotten
cannot be recovered. See [ARCHITECTURE.md](ARCHITECTURE.md) for the storage
model and migration details.

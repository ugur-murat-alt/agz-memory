# AGZ Memory

English | [Türkçe](README.tr.md)

AGZ Memory gives OpenCode V2 a durable, project-scoped linked memory. It ships
as two independently usable packages that advance at the same version:

- `@vaur94/agz-memory`: a nine-tool MCP server, TypeScript core, and recovery
  CLI backed by SQLite.
- `@vaur94/agz-memory-plugin`: an optional OpenCode V2 adapter for bounded
  retrieval and deliberately staged automatic capture.

**0.5.1 status:** This repository documents a candidate only. It does not claim
npm publication, a Git tag, or a merge.

The MCP server is ready for normal use. The plugin starts inert: no project is
created, no session is captured, and no context is injected until an explicit
binding and rollout mode are configured.

## Why AGZ Memory

- Every read and mutation is scoped by an immutable project UUID or unique
  project name.
- Notes can be pinned, linked, superseded, revised, searched, and inspected
  without mixing projects.
- SQLite schema v11 is the canonical source of truth; optional semantic indexes
  are replaceable derivatives.
- Destructive project deletion requires the immutable ID, exact current name,
  and a fixed confirmation phrase.
- Backup manifests include row counts, SQLite integrity results, size, and
  SHA-256 before restore is allowed.
- Automatic capture is redacted, bounded, idempotent, and disabled by default.

## Compatibility

| Component | Supported version |
|---|---|
| Core and MCP | `0.5.1` |
| OpenCode plugin | `0.5.1` |
| OpenCode V2 | `0.0.0-beta-18743` |
| `@opencode-ai/plugin` | `0.0.0-beta-18743` |
| Bun | `>=1.3.14` |
| SQLite schema | `11` |

The MCP server is not tied to an OpenCode beta. The optional plugin disables
itself unless the running OpenCode version exactly matches the supported beta.

## Install The MCP Server

Run the server directly:

```sh
bunx @vaur94/agz-memory@0.5.1
```

Or register it in OpenCode V2 under `mcp.servers`:

```jsonc
{
  "skills": [
    "https://raw.githubusercontent.com/ugur-murat-alt/agz-memory/v0.5.1/skills/"
  ],
  "mcp": {
    "servers": {
      "agz-memory": {
        "type": "local",
        "command": ["bunx", "@vaur94/agz-memory@0.5.1"],
        "environment": {
          "OPENCODE_MEMORY_DATABASE_PATH": "{env:OPENCODE_MEMORY_DATABASE_PATH}"
        },
        "codemode": false
      }
    }
  }
}
```

The npm package contains the versioned `agz-memory` skill catalog, but npm
installation alone does not make a skill discoverable. The explicit `skills`
entry above lets OpenCode download and advertise the same workflow lazily. The
MCP remains fully usable without it because the server supplies concise
`initialize` instructions and complete tool schemas on every connection.

Installation must not edit `~/.config/opencode/AGENTS.md`. That file is
user-owned, ambient policy for every project, not an extension installation
surface. Teams may maintain their own memory policy there, but AGZ Memory does
not require one. `codemode: false` is intentional for this small fixed catalog:
it exposes all nine tools directly. If Code Mode is enabled instead, the server
instructions, tool descriptions, and optional skill still describe the same
workflow.

The default database is
`~/.local/share/opencode-memory/memory.sqlite`. Set
`OPENCODE_MEMORY_DATABASE_PATH` before OpenCode starts to use another path.
The database file is created with user-only permissions.

## Use The Nine Tools

OpenCode exposes the tools with the configured server prefix, for example
`agz-memory_project_list`. The MCP protocol names remain:

| Tool | Purpose |
|---|---|
| `project_list` | List project identities and note counts. |
| `project_create` | Create an empty project with a unique name. |
| `project_update` | Rename a project without changing its UUID. |
| `project_delete` | Permanently delete one confirmed project and all owned data. |
| `memory_recall` | Search one project with one or up to ten queries. |
| `memory_update` | Create, patch, or explicitly delete notes in one project. |
| `memory_pin` | Prioritize or unprioritize one active note. |
| `memory_link` | Add typed links between notes in the same project. |
| `memory_read` | Read full notes, pin state, project identity, and graph neighbors. |

Recommended sequence:

1. Call `project_list` and reuse an existing project when it represents the
   same durable workspace.
2. Call `project_create` only when no matching project exists.
3. Keep the returned `projectID`; names can change, UUIDs cannot.
4. Call `memory_recall` before relying on historical decisions.
5. Store only durable, verified facts, decisions, procedures, preferences,
   research, context, or tasks. Do not store transcripts, secrets, or guesses.

All multi-item mutations are ordered and non-atomic. Inspect every result:
earlier items remain applied when a later item fails.

## Add The Optional Plugin

Keep the MCP server configured, then add the exact plugin package with inert
options:

```jsonc
{
  "plugins": [
    {
      "package": "@vaur94/agz-memory-plugin@0.5.1",
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

The plugin opens the same database path as the MCP server. It rejects unknown
configuration fields, automatic project creation, unsupported semantic
backends, oversized limits, and conflicting bindings.

## Bind Projects Explicitly

The plugin does nothing without exactly one matching binding. Each binding maps
an OpenCode project/workspace/location to an existing AGZ Memory project:

```jsonc
{
  "memoryProjectID": "11111111-1111-4111-8111-111111111111",
  "opencodeProjectID": "your-opencode-project-id",
  "canonicalDirectory": "/absolute/canonical/project/path",
  "workspaceID": ""
}
```

`memoryProjectID` must come from `project_list`. The directory is resolved with
the filesystem and compared with the active OpenCode location. Only a hash of
that canonical path is persisted. A mismatched location or duplicate mapping
disables the plugin rather than selecting a project heuristically.

## Roll Out Safely

Modes are intentionally one-way stages:

| Mode | Capture | Retrieval | Injection | Note writes |
|---|---|---|---|---|
| `off` | No | No | No | No |
| `shadow-capture` | Redacted audit only | No | No | No |
| `shadow-retrieval` | Optional redacted audit | Measured only | No | No |
| `inject` | Optional redacted audit | Lexical and graph | Bounded, untrusted | No |
| `auto-write` | Policy-gated | Lexical and graph | Bounded, untrusted | High-confidence candidates only |

Advance one stage at a time and inspect `agz-memory-admin capture status`,
database growth, retrieval latency, and false matches before proceeding. To
disable retrieval, injection, and every capture channel for one complete turn,
include `[memory:off]` in that prompt. Reconciliation reconstructs this boundary
from session history after a restart.
Returning to `off` is always safe and does not delete stored data.

Semantic retrieval remains hard-disabled. `semanticBackend` must be `none`
until a vendor passes project isolation, delete, purge, rebuild, leakage,
quality, and latency gates.

## Operate And Recover

The admin CLI reads the same `OPENCODE_MEMORY_DATABASE_PATH`:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin doctor
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin backup
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin upgrade --to 11
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin capture status
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin outbox status
```

Upgrades take an exclusive migration lock and create a verified backup before
changing the database. A failed migration attempts an automatic verified
restore. Restore and backup deletion use dry-run output plus explicit
confirmation values; never guess them.

Use [the backup and restore runbook](docs/backup-restore-runbook.md) for a full
rehearsal. Final `0.5.1` backup manifests use `agz-memory-backup/1`; prerelease
manifests must be handled by the prerelease that created them.

## Security Model

- Retrieved notes are wrapped in `<agz-memory-context trust="untrusted">` and
  escaped before injection. Stored text never becomes system policy.
- Capture projects only terminal user/assistant text and terminal tool status;
  reasoning, tool input, and tool output payloads are excluded.
- Credential patterns are redacted before persistence and again before note
  materialization. Private-key material is quarantined without a payload.
- Capture events are idempotent by stable source identity and retained with
  bounded payload lifetimes.
- Project ownership is enforced in every note and edge query. Cross-project
  links and backend hits are rejected.
- The SQLite database is canonical. Derived-index outbox rows contain identity
  and hashes, not note payloads.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Develop And Verify

```sh
bun install --frozen-lockfile
bun run release:verify
bun run check
bun test
bun run test:property
bun run test:stress
bun run test:restore
bun run benchmark:gate
bun run build
npm pack --dry-run --json
```

`release:verify` rejects package-version drift, mismatched bilingual sections,
stale release pins, an incomplete AGZ-001 through AGZ-068 resolution table, and
any tracked reintroduction of the retired project name.
The test suite covers project isolation, destructive confirmation, migration,
backup/restore, capture safety, revisions, provenance, FTS, retrieval, outbox,
and the exact nine-tool MCP surface.

## Project Resources

- [Architecture](ARCHITECTURE.md)
- [Changelog](CHANGELOG.md)
- [Backup and restore runbook](docs/backup-restore-runbook.md)
- [Schema 11 contract](docs/schema-v11.md)
- [Review resolution](docs/review-resolution.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [GitHub repository](https://github.com/ugur-murat-alt/agz-memory)
- [npm core package](https://www.npmjs.com/package/@vaur94/agz-memory)
- [npm plugin package](https://www.npmjs.com/package/@vaur94/agz-memory-plugin)

## License

[MIT](LICENSE)

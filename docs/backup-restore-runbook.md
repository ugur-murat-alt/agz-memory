# Backup And Restore Runbook

## Preconditions

1. Record `OPENCODE_MEMORY_DATABASE_PATH`.
2. Disable the OpenCode memory plugin or keep it in `off` mode.
3. Stop every MCP/plugin process that can write the database. Version `0.3.0`
   does not understand the v9 migration lock.
4. Confirm the database and backup directory are owned by the current user.

## Upgrade To Schema V9

```sh
export OPENCODE_MEMORY_DATABASE_PATH="$HOME/.local/share/opencode-memory/memory.sqlite"

bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin doctor
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin backup
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin upgrade --to 9
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin doctor
```

Do not start a writer if the final doctor report has `ok: false`. Preserve the
manifest path and SHA-256 printed by `backup`.

## Restore Rehearsal

The first invocation is a dry run:

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin restore \
  "$OPENCODE_MEMORY_DATABASE_PATH.backup/<backup>.manifest.json"
```

Verify `targetPath`, `sourceSchema`, row counts, and `sha256`. Then run:

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin restore \
  "$OPENCODE_MEMORY_DATABASE_PATH.backup/<backup>.manifest.json" \
  --sha256 <manifest-database-sha256> \
  --confirm RESTORE_DATABASE_FROM_VERIFIED_BACKUP
```

The prior database is retained as `failed-restore-source-*`. Run `doctor` and a
read-only MCP `project_list`/`memory_recall` smoke before enabling writers.

## Stale Migration Lock

Inspect `<database>.migration.lock/owner.json`. Never break a live owner.

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin unlock \
  --owner <exact-owner-id> \
  --confirm BREAK_STALE_MIGRATION_LOCK
```

The command refuses a live process with the same process-start marker.
If `owner.json` is missing or unreadable, inspect the lock directory first and
use `--owner ORPHANED` with the same confirmation phrase. Never use this while
another migration process may still be starting.

## Backup Pruning

Pruning is dry-run by default and returns a digest:

```sh
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin backup prune
bunx --package @vaur94/agz-memory@0.4.0-beta.1 agz-memory-admin backup prune \
  --digest <dry-run-digest> \
  --confirm DELETE_VERIFIED_BACKUPS
```

Do not prune the last known-good pre-upgrade backup until migration and restore
rehearsals are complete.

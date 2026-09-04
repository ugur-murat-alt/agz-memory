# AGZ Memory Backup And Restore Runbook

English | [Türkçe](backup-restore-runbook.tr.md)

This runbook applies to `@vaur94/agz-memory@0.5.1` and SQLite schema v11.

## Preconditions

1. Export the exact production database path.
2. Set the plugin to `mode: "off"` and `capture.enabled: false`.
3. Stop every MCP, plugin, or admin process that can write the database.
4. Confirm that the database directory and backup directory are owned by the
   current user and are not symlinks.
5. Keep enough free space for the database, its WAL checkpoint, one verified
   backup, and one preserved restore source.

```sh
export OPENCODE_MEMORY_DATABASE_PATH="$HOME/.local/share/opencode-memory/memory.sqlite"
```

Do not proceed with a guessed or empty path.

## Health Check And Upgrade

Run a read-only health report first:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin doctor
```

`ok` must be `true`. Record `schemaVersion`, row counts, and invariant counts.
Then create a standalone verified backup and upgrade:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin backup
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin upgrade --to 11
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin doctor
```

The upgrade itself creates another verified pre-migration backup when the
database schema is older than v11. Preserve each printed manifest path and
SHA-256. Do not start a writer if the final report has `ok: false`.

## Verify A Backup

A backup pair lives under `<database>.backup/`:

```text
schema-vN-<timestamp>-<uuid>.sqlite
schema-vN-<timestamp>-<uuid>.manifest.json
```

The manifest format is `agz-memory-backup/1`. `agz-memory-admin restore` verifies
that the manifest and database are regular files in the same backup directory,
then checks size, SHA-256, SQLite integrity, foreign keys, and row counts.

Final `0.5.1` does not accept prerelease manifest formats. Use the originating
prerelease to restore such a backup, run its doctor check, and only then upgrade
that restored database with `0.5.1`.

## Restore Rehearsal

Keep all writers stopped. First request a dry run by omitting confirmation:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin restore \
  "$OPENCODE_MEMORY_DATABASE_PATH.backup/<backup>.manifest.json"
```

Compare `targetPath`, `sourceSchema`, `targetSchema`, row counts, size, and
SHA-256 with the recorded backup. Then use the exact manifest hash:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin restore \
  "$OPENCODE_MEMORY_DATABASE_PATH.backup/<backup>.manifest.json" \
  --sha256 <manifest-database-sha256> \
  --confirm RESTORE_DATABASE_FROM_VERIFIED_BACKUP
```

Restore installs a copied and verified database atomically. The replaced source
is retained as `failed-restore-source-*`; do not delete it until the restored
database passes all checks.

## Post-Restore Validation

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin doctor
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin capture status
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin outbox status
```

Start only the MCP server and perform read-only `project_list`, `memory_recall`,
and `memory_read` smoke calls. Compare project/note counts with the manifest.
Only after those checks pass should OpenCode be restarted. Keep the plugin in
`off` until a separate rollout decision is made.

## Retained Maintenance Gate

`<database>.maintenance/owner.json` with `state: recovery-required` means a
previous restore could not verify its rollback. It is never removed
automatically. Stop every MCP/plugin process, preserve the database, sidecars,
gate, and restore artifacts, then select a verified backup. Supply the exact
recorded owner ID only on the restoring command:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin restore <manifest> \
  --sha256 <manifest-sha256> \
  --confirm RESTORE_DATABASE_FROM_VERIFIED_BACKUP \
  --maintenance-owner <owner-id> \
  --maintenance-confirm RECOVER_RETAINED_MAINTENANCE_GATE
```

Remote, live, malformed, or otherwise unverifiable owners remain blocked. Never
delete the gate manually; the recovery restore atomically takes ownership while
the gate directory remains present.

## Stale Migration Lock

The lock is `<database>.migration.lock/owner.json`. Never remove it while the
recorded process is alive or any writer may still hold the database.

Inspect the owner file, verify the PID/host/start time, and request a dry-run
style error first if uncertain. Break only a proven stale lock with the exact
owner ID and confirmation:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin unlock \
  --owner <owner-id> \
  --confirm BREAK_STALE_MIGRATION_LOCK
```

Run `doctor` immediately afterward. A stale lock is evidence of an interrupted
operation; it is not permission to skip database validation.

## Prune Verified Backups

The first command is non-destructive and returns a digest over the exact backup
set:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin backup prune
```

Review every listed manifest/database pair. Delete only that unchanged set:

```sh
bunx --package @vaur94/agz-memory@0.5.1 agz-memory-admin backup prune \
  --digest <dry-run-digest> \
  --confirm DELETE_VERIFIED_BACKUPS
```

The command refuses deletion when any manifest, database, hash, size, or set
membership changed after the dry run. Keep at least one separately protected,
recent, restore-tested backup according to your retention policy.

## Abort Conditions

Stop and investigate if any of these occur:

- `doctor` returns `ok: false`.
- SQLite integrity or foreign-key checks fail.
- Backup row counts differ from the source.
- A migration lock owner may still be live.
- The manifest is outside the configured backup root or is a symlink.
- The restore SHA-256 differs from the dry run.
- The final project/note counts differ from the chosen backup.

Do not repair the only copy in place. Preserve the database, WAL/SHM sidecars,
lock directory, manifests, and command output before further diagnosis.

# ADR: Cross-Process Database Maintenance Gate

Status: Accepted

Date: 2026-09-02

## Context

SQLite WAL coordinates transactions but does not make replacing the database pathname safe while another process holds an open connection. An old connection can continue to use the replaced inode and its WAL after restore. Before schema 11, the migration lock serialized migration owners only; normal MCP and plugin handles did not participate.

AGZ Memory must run on Linux, macOS, and Windows under Bun. Bun does not currently expose one portable shared/exclusive advisory-file-lock API for this package, so schema 11 uses a conservative filesystem protocol and fails closed whenever ownership cannot be established.

## Decision

Every normal database handle owns a lease for its complete lifetime. Migration, restore, backup publication, and prune use one exclusive maintenance gate associated with the canonical database path.

### Normal Open

1. Resolve and validate the canonical path and parent policy.
2. Reject an existing maintenance gate.
3. Publish a private lease file by exclusive staging and atomic rename. Its record contains an opaque owner ID, PID, process-start marker, hostname, and creation time. It contains no database content or configured private path.
4. Check the maintenance gate again. If it appeared, remove only the caller's verified lease and retry or fail.
5. Open and validate SQLite.
6. Keep the lease until statements and the SQLite handle are closed.

The second gate check closes the race where maintenance creates the gate between the first check and lease publication. Maintenance either observes the published lease, or the opener observes the gate and withdraws.

### Maintenance

1. Atomically create the gate. Only one owner can succeed.
2. Validate the gate owner record after publication.
3. Enumerate leases. A local lease is stale only when PID liveness and process-start identity prove that its owner is gone or the PID was reused. A remote-host or unverifiable lease remains active and blocks maintenance.
4. If any active lease exists, remove only the caller's gate and return `active_database_handles`.
5. Perform the operation without exposing a normal handle.
6. Verify the installed canonical database before removing the gate.

There is no `--force` bypass for active or unverifiable leases. Stale cleanup requires current owner identity checks. Gate and lease deletion never recursively removes an unverified replacement pathname.

Migration waiters recheck the canonical schema under a normal lease while they
still own the migration lock. A waiter that finds the target schema returns that
handle without creating another maintenance gate. After a successful migration,
the owner releases the maintenance gate and publishes its normal lease before
releasing the migration lock. This handoff prevents queued stale observations
from creating a new gate between migration completion and reopen.

An active gate left by a crashed local process is reclaimed in place: an
exclusive takeover record serializes contenders and atomically replaces the
stale owner while the gate directory remains continuously present. A reused PID
is stale only when both process-start markers exist and differ. Remote owners,
live owners, unavailable markers, malformed records, and missing records remain
fail-closed.

`retain()` atomically persists `state: recovery-required` before returning. Such
a gate is never reclaimed automatically. A verified restore may take it over
only with the exact recorded owner ID and
`RECOVER_RETAINED_MAINTENANCE_GATE`; the restore keeps the gate continuously
held and validates the installed database before release.

### Restore

While the maintenance gate is held and no leases exist:

1. Open the backup and manifest through the validated no-symlink policy.
2. Copy the source into a private same-parent staging file while streaming SHA-256 and byte count.
3. Validate manifest hash/size, application ID, database UUID/product, schema version/fingerprint, row counts, `integrity_check`, and `foreign_key_check` on the staging inode.
4. Checkpoint and preserve the current canonical database.
5. Fsync staging and its parent, atomically replace the canonical pathname, and quarantine stale WAL/SHM files.
6. Reopen the installed target and repeat identity, fingerprint, count, and health validation.
7. On failure, restore the preserved source while still holding the gate. If rollback cannot be verified, retain the gate as a recovery-required marker and fail closed.

Backup hashing is streaming. Restore never copies a pathname that was validated and then reopened as the source of truth.

## Platform Policy

- The database, backup root, manifest, maintenance gate, lease registry, lock records, and their existing parents must not be symbolic links.
- Existing components must have the expected file type and private ownership/permissions when the platform exposes those attributes.
- New files use exclusive creation and private modes.
- An unsupported no-follow or identity check causes the sensitive operation to fail closed rather than silently weaken the policy.
- Process-start markers use the strongest local facility available. An unavailable marker never justifies breaking a live lease.

## Consequences

- Restore is offline-safe, not an online hot swap.
- Long-lived MCP/plugin handles explicitly block maintenance until clean shutdown.
- A crashed owner can be reclaimed only with verifiable stale-owner evidence.
- The protocol is cooperative against same-user processes; it does not protect a database directory writable by an untrusted account. Unsafe ownership or permissions are rejected.

## Rejected Alternatives

- WAL checkpoint alone was rejected because it does not invalidate old file descriptors.
- PID-only lock files were rejected because PIDs are reused.
- Unconditional stale timeout and `--force` were rejected because a paused live writer could lose acknowledged writes.
- Path-only verify-then-copy was rejected because it leaves a TOCTOU window.

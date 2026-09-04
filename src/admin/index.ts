#!/usr/bin/env bun

import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "fs";
import { basename, dirname, resolve } from "path";
import { resolveConfig } from "../config";
import { openMemoryDatabase, openReadOnlyMemoryDatabase } from "../db";
import {
  createVerifiedBackup,
  restoreVerifiedBackup,
  verifyBackupManifest,
} from "../db/backup";
import { acquireMigrationLock, breakMigrationLock } from "../db/migration-lock";
import {
  acquireMaintenanceGate,
  type MaintenanceGate,
  type MaintenanceRecovery,
} from "../db/maintenance";
import { doctorDatabase } from "./doctor";
import { SCHEMA_VERSION } from "../types";
import { PRODUCT_VERSION } from "../version";
import { quarantinePrivacyReport } from "./quarantine";
import { runResumableReindex } from "./reindex";

export async function runAdmin(argv = process.argv.slice(2)): Promise<unknown> {
  const parsed = parseAdminArguments(argv);
  const configuredDatabasePath = resolveConfig().databasePath;
  const database = parsed.command === "init"
    ? undefined
    : requireExistingDatabase(configuredDatabasePath, parsed.databaseID);
  const databasePath = database?.path ?? configuredDatabasePath;
  const [command, subcommand] = [parsed.command, parsed.subcommand];

  if (command === "init") {
    const opened = openMemoryDatabase(databasePath);
    try {
      return withDatabaseIdentity({ initialized: true }, databaseIdentity(opened.db, databasePath));
    } finally {
      opened.close();
    }
  }

  if (command === "doctor") {
    requireExistingDatabase(databasePath);
    const opened = openReadOnlyMemoryDatabase(databasePath);
    try {
      return withDatabaseIdentity(doctorDatabase(opened.db), database!);
    } finally {
      opened.close();
    }
  }

  if (command === "backup" && subcommand !== "prune") {
    requireExistingDatabase(databasePath);
    return withExclusiveMaintenance(databasePath, readSchemaVersion(databasePath), () => {
      const db = new Database(databasePath);
      try {
        const version = schemaVersion(db);
        return withDatabaseIdentity(createVerifiedBackup(db, databasePath, version, version, PRODUCT_VERSION), database!);
      } finally {
        db.close();
      }
    });
  }

  if (command === "upgrade") {
    if (option(argv, "--to") !== String(SCHEMA_VERSION)) {
      throw new Error(`only --to ${SCHEMA_VERSION} is supported`);
    }
    const opened = openMemoryDatabase(databasePath);
    try {
      return withDatabaseIdentity(doctorDatabase(opened.db), database!);
    } finally {
      opened.close();
    }
  }

  if (command === "restore") {
    const manifestPath = subcommand;
    if (!manifestPath) throw new Error("restore manifest path is required");
    assertInsideBackupRoot(databasePath, manifestPath);
    const verified = verifyBackupManifest(manifestPath);
    const confirmation = option(argv, "--confirm");
    const expectedHash = option(argv, "--sha256");
    if (!confirmation || !expectedHash) {
      return withDatabaseIdentity({ dryRun: true, manifest: verified.manifest, targetPath: databasePath }, database!);
    }
    if (expectedHash !== verified.manifest.sha256) throw new Error("restore manifest hash mismatch");
    const maintenanceOwner = option(argv, "--maintenance-owner");
    const maintenanceConfirmation = option(argv, "--maintenance-confirm");
    if ((maintenanceOwner === undefined) !== (maintenanceConfirmation === undefined)) {
      throw new Error("retained maintenance recovery requires both owner and confirmation");
    }
    const recovery =
      maintenanceOwner && maintenanceConfirmation
        ? {
            ownerID: maintenanceOwner,
            confirmation: maintenanceConfirmation,
          }
        : undefined;
    if (
      recovery &&
      recovery.confirmation !== "RECOVER_RETAINED_MAINTENANCE_GATE"
    ) {
      throw new Error("invalid retained maintenance recovery confirmation");
    }
    return withExclusiveMaintenance(
      databasePath,
      verified.manifest.sourceSchema,
      (maintenance) => {
        const preservedPath = restoreVerifiedBackup(
          manifestPath,
          databasePath,
          confirmation,
          maintenance,
          expectedHash,
        );
        return withDatabaseIdentity({ restored: true, preservedPath, manifest: verified.manifest }, database!);
      },
      recovery as MaintenanceRecovery | undefined,
    );
  }

  if (command === "unlock") {
    const ownerID = option(argv, "--owner");
    const confirmation = option(argv, "--confirm");
    if (!ownerID || !confirmation) throw new Error("unlock requires --owner and --confirm");
    breakMigrationLock(databasePath, ownerID, confirmation);
    return withDatabaseIdentity({ unlocked: true, ownerID }, database!);
  }

  if (command === "reindex") {
    const backend = option(argv, "--backend");
    if (!backend || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(backend)) {
      throw new Error("reindex requires a valid --backend");
    }
    return withDatabaseIdentity(
      runResumableReindex(
        databasePath,
        database!.databaseID,
        backend,
        Number(option(argv, "--batch-size") ?? 100),
        option(argv, "--max-batches") === undefined ? undefined : Number(option(argv, "--max-batches")),
      ),
      database!,
    );
  }

  if (command === "outbox" && subcommand === "status") {
    return withDatabase(databasePath, (db) => withDatabaseIdentity({
      states: db
        .query("SELECT state, COUNT(*) AS count FROM index_outbox GROUP BY state ORDER BY state")
        .all(),
      oldestPendingAt: (
        db.query("SELECT MIN(created_at) AS value FROM index_outbox WHERE state IN ('pending','leased')").get() as {
          value: number | null;
        }
      ).value,
    }, database!));
  }

  if (command === "outbox" && subcommand === "retry") {
    const id = Number(argv[2]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("outbox retry requires a positive id");
    return withDatabase(databasePath, (db) => {
      const result = db
        .query(
          `UPDATE index_outbox
              SET state = 'pending', available_at = ?, lease_owner = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL,
                  completed_at = NULL, last_error_code = NULL, attempt_count = 0
             WHERE id = ? AND state = 'dead'`,
        )
        .run(Date.now(), id);
      pruneTerminalOutbox(db);
      return withDatabaseIdentity({ id, retried: result.changes === 1 }, database!);
    });
  }

  if (command === "capture" && subcommand === "status") {
    return withDatabase(databasePath, (db) => withDatabaseIdentity({
      events: db
        .query("SELECT state, COUNT(*) AS count FROM capture_events GROUP BY state ORDER BY state")
        .all(),
      checkpoints: db
        .query("SELECT state, COUNT(*) AS count FROM capture_checkpoints GROUP BY state ORDER BY state")
        .all(),
      quarantinePrivacy: quarantinePrivacyReport(db),
    }, database!));
  }

  if (command === "backup" && subcommand === "prune") {
    return withExclusiveMaintenance(databasePath, SCHEMA_VERSION, () => {
      const entries = backupEntries(databasePath);
      const root = resolve(`${databasePath}.backup`);
      const digest = createHash("sha256")
        .update(
          `${resolve(databasePath)}\0${root}\n${entries
            .map(
              (entry) =>
                `${basename(entry.manifest)}\0${basename(entry.database)}\0${entry.sha256}\0${entry.size}\0${entry.manifestHash}`,
            )
            .join("\n")}`,
        )
        .digest("hex");
      if (option(argv, "--confirm") !== "DELETE_VERIFIED_BACKUPS") {
        return withDatabaseIdentity({ dryRun: true, digest, backups: entries }, database!);
      }
      if (option(argv, "--digest") !== digest) throw new Error("backup prune digest mismatch");
      const currentEntries = entries.map((entry) => {
        const current = verifiedBackupEntry(root, entry.manifest);
        if (
          current.database !== entry.database ||
          current.sha256 !== entry.sha256 ||
          current.size !== entry.size ||
          current.manifestHash !== entry.manifestHash
        ) {
          throw new Error(`backup changed after confirmation: ${basename(entry.manifest)}`);
        }
        return current;
      });
      for (const current of currentEntries) {
        rmSync(current.database, { force: true });
        rmSync(current.manifest, { force: true });
      }
      return withDatabaseIdentity({ deleted: entries.length, digest }, database!);
    });
  }

  throw new Error(`unknown admin command: ${argv.join(" ")}`);
}

const TERMINAL_OUTBOX_RETENTION = 10_000;

interface AdminArguments {
  command: string;
  subcommand?: string;
  databaseID?: string;
}

interface DatabaseIdentity {
  path: string;
  databaseID: string;
}

/** Parse the complete argv before opening the database so malformed input is never a mutation. */
function parseAdminArguments(argv: string[]): AdminArguments {
  if (argv.length === 0) throw new Error("admin command is required");
  const [command, subcommand] = argv;
  const forms: Record<string, { positional: number; flags: readonly string[] }> = {
    init: { positional: 0, flags: ["--database-id"] },
    doctor: { positional: 0, flags: ["--database-id"] },
    backup: { positional: subcommand === "prune" ? 1 : 0, flags: subcommand === "prune" ? ["--confirm", "--digest", "--database-id"] : ["--database-id"] },
    upgrade: { positional: 0, flags: ["--to", "--database-id"] },
    restore: { positional: 1, flags: ["--confirm", "--sha256", "--maintenance-owner", "--maintenance-confirm", "--database-id"] },
    unlock: { positional: 0, flags: ["--owner", "--confirm", "--database-id"] },
    reindex: { positional: 0, flags: ["--backend", "--batch-size", "--max-batches", "--database-id"] },
    outbox: { positional: subcommand === "retry" ? 2 : subcommand === "status" ? 1 : -1, flags: ["--database-id"] },
    capture: { positional: subcommand === "status" ? 1 : -1, flags: ["--database-id"] },
  };
  const form = forms[command];
  if (!form || form.positional < 0) throw new Error(`unknown admin command: ${argv.join(" ")}`);
  let positional = command === "restore" ? 2 : subcommand ? 2 : 1;
  if (command === "backup" && subcommand !== "prune") positional = 1;
  if (command === "init" || command === "doctor" || command === "upgrade" || command === "unlock" || command === "reindex") positional = 1;
  if (command === "outbox" && subcommand === "retry") positional = 3;
  const seen = new Set<string>();
  for (let index = positional; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("admin arguments must use unique --flag value pairs");
    }
    if (!form.flags.includes(flag) || seen.has(flag)) throw new Error(`invalid or duplicate admin argument: ${flag}`);
    seen.add(flag);
  }
  // No implicit positional values are accepted after the command/subcommand.
  if (command === "restore" && (!subcommand || subcommand.startsWith("--"))) {
    throw new Error("restore manifest path is required");
  }
  if ((command === "outbox" || command === "capture") && !subcommand) {
    throw new Error(`unknown admin command: ${argv.join(" ")}`);
  }
  return { command, subcommand, databaseID: option(argv, "--database-id") };
}

function withDatabase<T>(databasePath: string, action: (db: Database) => T): T {
  const opened = openMemoryDatabase(databasePath);
  try {
    return action(opened.db);
  } finally {
    opened.close();
  }
}

function withExclusiveMaintenance<T>(
  databasePath: string,
  schemaVersion: number,
  action: (maintenance: MaintenanceGate) => T,
  recovery?: MaintenanceRecovery,
): T {
  const lock = acquireMigrationLock(databasePath, schemaVersion);
  try {
    const maintenance = acquireMaintenanceGate(databasePath, recovery);
    try {
      return action(maintenance);
    } finally {
      maintenance.release();
    }
  } finally {
    lock.release();
  }
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requireExistingDatabase(databasePath: string, expectedID?: string): DatabaseIdentity {
  if (!existsSync(databasePath)) throw new Error("database does not exist");
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("database must be a regular file");
  const canonicalPath = realpathSync(databasePath);
  if (canonicalPath !== resolve(databasePath)) throw new Error("database path must be canonical");
  const opened = openReadOnlyMemoryDatabase(canonicalPath);
  try {
    const identity = databaseIdentity(opened.db, canonicalPath);
    if (expectedID !== undefined && expectedID !== identity.databaseID) throw new Error("database id mismatch");
    return identity;
  } finally {
    opened.close();
  }
}

function databaseIdentity(db: Database, databasePath: string): DatabaseIdentity {
  const row = db.query("SELECT database_id FROM agz_meta WHERE id = 1").get() as
    | { database_id: string }
    | undefined;
  if (!row?.database_id) throw new Error("database identity is missing");
  return { path: realpathSync(databasePath), databaseID: row.database_id };
}

function withDatabaseIdentity<T extends object>(result: T, identity: DatabaseIdentity): T & {
  databasePath: string;
  databaseID: string;
} {
  return { ...result, databasePath: identity.path, databaseID: identity.databaseID };
}

function pruneTerminalOutbox(db: Database): void {
  db.query(
    `DELETE FROM index_outbox WHERE id IN (
       SELECT id FROM index_outbox WHERE state IN ('succeeded','dead')
       ORDER BY completed_at DESC, id DESC LIMIT -1 OFFSET ?
     )`,
  ).run(TERMINAL_OUTBOX_RETENTION);
}

function readSchemaVersion(databasePath: string): number {
  const db = new Database(databasePath, { readonly: true });
  try {
    return schemaVersion(db);
  } finally {
    db.close();
  }
}

function schemaVersion(db: Database): number {
  const row = db.query("SELECT MAX(version) AS version FROM schema_state").get() as {
    version: number | null;
  };
  if (row.version === null) throw new Error("schema version is missing");
  return row.version;
}

function assertInsideBackupRoot(databasePath: string, manifestPath: string): void {
  const root = resolve(`${databasePath}.backup`);
  const candidate = resolve(manifestPath);
  if (dirname(candidate) !== root) throw new Error("manifest must be inside the database backup directory");
}

function backupEntries(databasePath: string): Array<{
  manifest: string;
  database: string;
  sha256: string;
  size: number;
  manifestHash: string;
}> {
  const root = resolve(`${databasePath}.backup`);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".manifest.json"))
    .sort()
    .map((name) => verifiedBackupEntry(root, resolve(root, name)));
}

function verifiedBackupEntry(root: string, manifest: string): {
  manifest: string;
  database: string;
  sha256: string;
  size: number;
  manifestHash: string;
} {
  const candidate = resolve(manifest);
  if (dirname(candidate) !== root) throw new Error("backup manifest escaped the backup directory");
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup manifest must be a regular file");
  const bytes = readFileSync(candidate);
  const verified = verifyBackupManifest(candidate);
  if (dirname(verified.databasePath) !== root) {
    throw new Error("backup database escaped the backup directory");
  }
  return {
    manifest: candidate,
    database: verified.databasePath,
    sha256: verified.manifest.sha256,
    size: verified.manifest.size,
    manifestHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  try {
    const result = await runAdmin();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (typeof result === "object" && result && "ok" in result && result.ok === false) {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(
      `[agz-memory-admin] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

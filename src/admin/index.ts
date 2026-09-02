#!/usr/bin/env bun

import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "fs";
import { basename, dirname, resolve } from "path";
import { resolveConfig } from "../config";
import { openMemoryDatabase, openReadOnlyMemoryDatabase } from "../db";
import { hashTuple } from "../hash";
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
import { deriveDocument } from "../retrieval/derived";
import { PRODUCT_VERSION } from "../version";

export async function runAdmin(argv = process.argv.slice(2)): Promise<unknown> {
  const databasePath = resolveConfig().databasePath;
  const [command, subcommand] = argv;
  if (!command) throw new Error("admin command is required");

  if (command === "doctor") {
    requireExistingDatabase(databasePath);
    const opened = openReadOnlyMemoryDatabase(databasePath);
    try {
      return doctorDatabase(opened.db);
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
        return createVerifiedBackup(db, databasePath, version, version, PRODUCT_VERSION);
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
      return doctorDatabase(opened.db);
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
      return { dryRun: true, manifest: verified.manifest, targetPath: databasePath };
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
        return { restored: true, preservedPath, manifest: verified.manifest };
      },
      recovery as MaintenanceRecovery | undefined,
    );
  }

  if (command === "unlock") {
    const ownerID = option(argv, "--owner");
    const confirmation = option(argv, "--confirm");
    if (!ownerID || !confirmation) throw new Error("unlock requires --owner and --confirm");
    breakMigrationLock(databasePath, ownerID, confirmation);
    return { unlocked: true, ownerID };
  }

  if (command === "reindex") {
    const backend = option(argv, "--backend");
    if (!backend || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(backend)) {
      throw new Error("reindex requires a valid --backend");
    }
    const opened = openMemoryDatabase(databasePath);
    try {
      const now = Date.now();
      let queued = 0;
      let purges = 0;
      const quarantined: Record<string, number> = {};
      let generation = 0;
      const insert = opened.db.query(`
        INSERT INTO index_outbox
          (backend, operation_key, operation, project_id, note_id, revision, content_hash,
           generation, lease_generation, fence, state, attempt_count, available_at,
           heartbeat_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', 0, ?, NULL, ?)
      `);
      opened.db.exec("BEGIN IMMEDIATE");
      try {
        generation = (
          opened.db
            .query(
              "SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM index_outbox WHERE backend = ?",
            )
            .get(backend) as { generation: number }
        ).generation;
        const projects = opened.db
          .query("SELECT id FROM projects ORDER BY id")
          .all() as Array<{ id: string }>;
        const notes = opened.db
          .query("SELECT * FROM notes WHERE status = 'active' ORDER BY project_id, id")
          .all() as Array<{
          id: string;
          project_id: string;
          current_revision: number;
          kind: string;
          title: string;
          summary: string;
          content: string;
        }>;
        for (const project of projects) {
          const operation = "purge-project" as const;
          const operationKey = outboxOperationKey(
            backend,
            operation,
            project.id,
            null,
            null,
            null,
            generation,
          );
          purges += insert.run(
            backend,
            operationKey,
            operation,
            project.id,
            null,
            null,
            null,
            generation,
            now,
            now,
          ).changes;
        }
        for (const note of notes) {
          const document = deriveDocument({
            projectID: note.project_id,
            noteID: note.id,
            revision: note.current_revision,
            kind: note.kind,
            title: note.title,
            summary: note.summary,
            content: note.content,
          });
          if (!document) {
            quarantined.derived_document_unavailable =
              (quarantined.derived_document_unavailable ?? 0) + 1;
            continue;
          }
          const operation = "upsert-note" as const;
          const operationKey = outboxOperationKey(
            backend,
            operation,
            note.project_id,
            note.id,
            note.current_revision,
            document.contentHash,
            generation,
          );
          queued += insert.run(
            backend,
            operationKey,
            operation,
            note.project_id,
            note.id,
            note.current_revision,
            document.contentHash,
            generation,
            now,
            now,
          ).changes;
        }
        opened.db.exec("COMMIT");
      } catch (error) {
        try {
          opened.db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      return { backend, generation, purges, queued, quarantined };
    } finally {
      opened.close();
    }
  }

  if (command === "outbox" && subcommand === "status") {
    return withDatabase(databasePath, (db) => ({
      states: db
        .query("SELECT state, COUNT(*) AS count FROM index_outbox GROUP BY state ORDER BY state")
        .all(),
      oldestPendingAt: (
        db.query("SELECT MIN(created_at) AS value FROM index_outbox WHERE state IN ('pending','leased')").get() as {
          value: number | null;
        }
      ).value,
    }));
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
                  completed_at = NULL, last_error_code = NULL
            WHERE id = ? AND state = 'dead'`,
        )
        .run(Date.now(), id);
      return { id, retried: result.changes === 1 };
    });
  }

  if (command === "capture" && subcommand === "status") {
    return withDatabase(databasePath, (db) => ({
      events: db
        .query("SELECT state, COUNT(*) AS count FROM capture_events GROUP BY state ORDER BY state")
        .all(),
      checkpoints: db
        .query("SELECT state, COUNT(*) AS count FROM capture_checkpoints GROUP BY state ORDER BY state")
        .all(),
    }));
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
        return { dryRun: true, digest, backups: entries };
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
      return { deleted: entries.length, digest };
    });
  }

  throw new Error(`unknown admin command: ${argv.join(" ")}`);
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

function requireExistingDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) throw new Error(`database does not exist: ${databasePath}`);
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

function outboxOperationKey(
  backend: string,
  operation: "upsert-note" | "delete-note" | "purge-project",
  projectID: string,
  noteID: string | null,
  revision: number | null,
  contentHash: string | null,
  generation: number,
): string {
  return hashTuple("outbox-operation", 2, [
    backend,
    operation,
    projectID,
    noteID,
    revision,
    contentHash,
    generation,
  ]);
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

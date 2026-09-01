import { createHash, randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { assertHealthyDatabase, inspectDatabase } from "./health";

export const BACKUP_FORMAT = "agz-memory-backup/1" as const;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  productVersion: string;
  sourceSchema: number;
  targetSchema: number;
  createdAt: string;
  sqliteVersion: string;
  databaseFile: string;
  sha256: string;
  size: number;
  counts: Record<string, number>;
  integrity: "ok";
  foreignKeyViolations: 0;
}

export interface VerifiedBackup {
  databasePath: string;
  manifestPath: string;
  manifest: BackupManifest;
}

export function createVerifiedBackup(
  db: Database,
  databasePath: string,
  sourceSchema: number,
  targetSchema: number,
  productVersion: string,
): VerifiedBackup {
  const sourceHealth = assertHealthyDatabase(db);
  const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  if (checkpoint.busy !== 0) throw new Error("database WAL checkpoint is busy");

  const backupDirectory = `${databasePath}.backup`;
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = `schema-v${sourceSchema}-${stamp}-${randomUUID()}`;
  const finalDatabasePath = join(backupDirectory, `${stem}.sqlite`);
  const finalManifestPath = join(backupDirectory, `${stem}.manifest.json`);
  const temporaryDatabasePath = `${finalDatabasePath}.tmp`;
  const temporaryManifestPath = `${finalManifestPath}.tmp`;

  try {
    db.exec(`VACUUM INTO '${escapeSql(temporaryDatabasePath)}'`);
    chmodSync(temporaryDatabasePath, 0o600);
    const verification = new Database(temporaryDatabasePath, { readonly: true });
    let backupHealth;
    let sqliteVersion: string;
    try {
      backupHealth = assertHealthyDatabase(verification);
      sqliteVersion = (verification.query("SELECT sqlite_version() AS version").get() as {
        version: string;
      }).version;
    } finally {
      verification.close();
    }
    if (JSON.stringify(backupHealth.counts) !== JSON.stringify(sourceHealth.counts)) {
      throw new Error("backup row counts differ from source database");
    }
    const bytes = readFileSync(temporaryDatabasePath);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      productVersion,
      sourceSchema,
      targetSchema,
      createdAt: new Date().toISOString(),
      sqliteVersion,
      databaseFile: basename(finalDatabasePath),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      counts: backupHealth.counts,
      integrity: "ok",
      foreignKeyViolations: 0,
    };
    writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    fsyncPath(temporaryDatabasePath);
    fsyncPath(temporaryManifestPath);
    renameSync(temporaryDatabasePath, finalDatabasePath);
    renameSync(temporaryManifestPath, finalManifestPath);
    fsyncPath(backupDirectory);
    return { databasePath: finalDatabasePath, manifestPath: finalManifestPath, manifest };
  } catch (error) {
    rmSync(temporaryDatabasePath, { force: true });
    rmSync(temporaryManifestPath, { force: true });
    throw error;
  }
}

export function verifyBackupManifest(manifestPath: string): VerifiedBackup {
  const resolvedManifestPath = resolve(manifestPath);
  const manifestStat = lstatSync(resolvedManifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("backup manifest must be a regular file");
  }
  const manifest = JSON.parse(readFileSync(resolvedManifestPath, "utf8")) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error("unsupported backup manifest format");
  }
  if (
    typeof manifest.databaseFile !== "string" ||
    !manifest.databaseFile ||
    basename(manifest.databaseFile) !== manifest.databaseFile
  ) {
    throw new Error("backup databaseFile must be a basename");
  }
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error("backup manifest sha256 is invalid");
  }
  if (!Number.isSafeInteger(manifest.size) || manifest.size < 0) {
    throw new Error("backup manifest size is invalid");
  }
  const manifestDirectory = dirname(resolvedManifestPath);
  const databasePath = resolve(manifestDirectory, manifest.databaseFile);
  if (dirname(databasePath) !== manifestDirectory) {
    throw new Error("backup database file must stay inside the manifest directory");
  }
  if (!existsSync(databasePath)) throw new Error("backup database file is missing");
  const databaseStat = lstatSync(databasePath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw new Error("backup database must be a regular file");
  }
  const bytes = readFileSync(databasePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== manifest.sha256 || databaseStat.size !== manifest.size) {
    throw new Error("backup hash or size mismatch");
  }
  const db = new Database(databasePath, { readonly: true });
  try {
    const health = assertHealthyDatabase(db);
    if (JSON.stringify(health.counts) !== JSON.stringify(manifest.counts)) {
      throw new Error("backup manifest row counts do not match");
    }
  } finally {
    db.close();
  }
  return { databasePath, manifestPath: resolvedManifestPath, manifest };
}

export function restoreVerifiedBackup(
  manifestPath: string,
  targetPath: string,
  confirmation: string,
): string {
  if (confirmation !== "RESTORE_DATABASE_FROM_VERIFIED_BACKUP") {
    throw new Error("invalid restore confirmation");
  }
  const verified = verifyBackupManifest(manifestPath);
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.restore-${randomUUID()}.tmp`;
  const preserved = `${targetPath}.failed-restore-source-${Date.now()}-${randomUUID()}`;
  const movedSidecars: Array<{ source: string; quarantine: string }> = [];
  let hasPreservedSource = false;
  let preservedSourceHealthy = false;
  let targetInstalled = false;
  try {
    copyFileSync(verified.databasePath, temporary);
    chmodSync(temporary, 0o600);
    fsyncPath(temporary);
    if (existsSync(targetPath)) {
      preservedSourceHealthy = checkpointSource(targetPath);
      copyFileSync(targetPath, preserved);
      chmodSync(preserved, 0o600);
      fsyncPath(preserved);
      if (preservedSourceHealthy) verifyDatabaseFile(preserved);
      for (const suffix of ["-wal", "-shm"]) {
        const source = `${targetPath}${suffix}`;
        if (!existsSync(source)) continue;
        const preservedSidecar = `${preserved}${suffix}`;
        copyFileSync(source, preservedSidecar);
        chmodSync(preservedSidecar, 0o600);
        fsyncPath(preservedSidecar);
      }
      fsyncPath(dirname(targetPath));
      hasPreservedSource = true;
    }
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${targetPath}${suffix}`;
      if (!existsSync(source)) continue;
      const quarantine = `${source}.quarantine-${randomUUID()}`;
      renameSync(source, quarantine);
      movedSidecars.push({ source, quarantine });
    }
    renameSync(temporary, targetPath);
    targetInstalled = true;
    fsyncPath(dirname(targetPath));
    verifyDatabaseFile(targetPath);
    for (const { quarantine } of movedSidecars) {
      rmSync(quarantine, { recursive: true, force: true });
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    rmSync(temporary, { force: true });
    if (targetInstalled) {
      try {
        for (const suffix of ["-wal", "-shm"]) {
          rmSync(`${targetPath}${suffix}`, { recursive: true, force: true });
        }
        if (hasPreservedSource) {
          const rollback = `${targetPath}.rollback-${randomUUID()}.tmp`;
          copyFileSync(preserved, rollback);
          chmodSync(rollback, 0o600);
          fsyncPath(rollback);
          rmSync(targetPath, { force: true });
          renameSync(rollback, targetPath);
        } else {
          rmSync(targetPath, { force: true });
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const { source, quarantine } of movedSidecars.reverse()) {
      if (!existsSync(quarantine)) continue;
      try {
        rmSync(source, { recursive: true, force: true });
        renameSync(quarantine, source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (
      targetInstalled &&
      hasPreservedSource &&
      preservedSourceHealthy &&
      rollbackErrors.length === 0
    ) {
      try {
        fsyncPath(dirname(targetPath));
        verifyDatabaseFile(targetPath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "restore failed and rollback was incomplete");
    }
    throw error;
  }
  return preserved;
}

export function inspectBackupDatabase(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return inspectDatabase(db);
  } finally {
    db.close();
  }
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function checkpointSource(path: string): boolean {
  let db: Database | undefined;
  try {
    db = new Database(path);
    const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    if (checkpoint.busy !== 0) throw new Error("source database WAL checkpoint is busy");
    try {
      assertHealthyDatabase(db);
      return true;
    } catch {
      return false;
    }
  } catch (error) {
    if (isBusyError(error)) throw error;
    return false;
  } finally {
    db?.close();
  }
}

function verifyDatabaseFile(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    assertHealthyDatabase(db);
  } finally {
    db.close();
  }
}

function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  }
  return error instanceof Error && /\b(?:busy|locked)\b/i.test(error.message);
}

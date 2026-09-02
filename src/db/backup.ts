import { createHash, randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { platform } from "os";
import { assertHealthyDatabase, inspectDatabase } from "./health";
import { assertLegacySchemaIdentity } from "./legacy-health";
import {
  acquireMaintenanceGate,
  assertMaintenanceGateFor,
  assertNoSymbolicLinks,
  ensureDatabaseParent,
  type MaintenanceGate,
} from "./maintenance";

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
  try {
    assertManifestSourceSchema(db, sourceHealth.schemaVersion, sourceSchema);
  } catch {
    throw new Error(
      `backup source schema v${sourceSchema} does not match database schema v${sourceHealth.schemaVersion ?? "unknown"}`,
    );
  }
  const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  if (checkpoint.busy !== 0) throw new Error("database WAL checkpoint is busy");

  const backupDirectory = `${databasePath}.backup`;
  assertNoSymbolicLinks(databasePath);
  assertNoSymbolicLinks(backupDirectory, true);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const backupRootStat = lstatSync(backupDirectory);
  if (!backupRootStat.isDirectory() || backupRootStat.isSymbolicLink()) {
    throw new Error("backup root must be a directory and not a symbolic link");
  }
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
      assertManifestSourceSchema(verification, backupHealth.schemaVersion, sourceSchema);
      sqliteVersion = (verification.query("SELECT sqlite_version() AS version").get() as {
        version: string;
      }).version;
    } finally {
      verification.close();
    }
    if (JSON.stringify(backupHealth.counts) !== JSON.stringify(sourceHealth.counts)) {
      throw new Error("backup row counts differ from source database");
    }
    const digest = hashRegularFile(temporaryDatabasePath);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      productVersion,
      sourceSchema,
      targetSchema,
      createdAt: new Date().toISOString(),
      sqliteVersion,
      databaseFile: basename(finalDatabasePath),
      sha256: digest.sha256,
      size: digest.size,
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
  assertNoSymbolicLinks(manifestPath);
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
    !Number.isSafeInteger(manifest.sourceSchema) ||
    manifest.sourceSchema < 2 ||
    manifest.sourceSchema > 11
  ) {
    throw new Error("backup manifest source schema is invalid");
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
  const digest = hashRegularFile(databasePath);
  if (
    digest.sha256 !== manifest.sha256 ||
    digest.size !== manifest.size ||
    databaseStat.size !== manifest.size
  ) {
    throw new Error("backup hash or size mismatch");
  }
  const db = new Database(databasePath, { readonly: true });
  try {
    const health = assertHealthyDatabase(db);
    if (JSON.stringify(health.counts) !== JSON.stringify(manifest.counts)) {
      throw new Error("backup manifest row counts do not match");
    }
    assertManifestSourceSchema(db, health.schemaVersion, manifest.sourceSchema);
  } finally {
    db.close();
  }
  return { databasePath, manifestPath: resolvedManifestPath, manifest };
}

export function restoreVerifiedBackup(
  manifestPath: string,
  targetPath: string,
  confirmation: string,
  existingGate?: MaintenanceGate,
  expectedSha256?: string,
): string {
  if (confirmation !== "RESTORE_DATABASE_FROM_VERIFIED_BACKUP") {
    throw new Error("invalid restore confirmation");
  }
  ensureDatabaseParent(targetPath);
  const gate = existingGate ?? acquireMaintenanceGate(targetPath);
  const releaseGate = existingGate === undefined;
  try {
    return restoreUnderGate(manifestPath, targetPath, gate, expectedSha256);
  } finally {
    if (releaseGate) gate.release();
  }
}

function restoreUnderGate(
  manifestPath: string,
  targetPath: string,
  gate: MaintenanceGate,
  expectedSha256?: string,
): string {
  assertMaintenanceGateFor(gate, targetPath);
  const verified = verifyBackupManifest(manifestPath);
  if (expectedSha256 !== undefined && verified.manifest.sha256 !== expectedSha256) {
    throw new Error("restore manifest hash mismatch");
  }
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.restore-${randomUUID()}.tmp`;
  const preserved = `${targetPath}.failed-restore-source-${Date.now()}-${randomUUID()}`;
  const movedSidecars: Array<{ source: string; quarantine: string }> = [];
  let hasPreservedSource = false;
  let preservedSourceHealthy = false;
  let targetInstalled = false;
  try {
    copyVerifiedSource(verified, temporary);
    if (existsSync(targetPath)) {
      preservedSourceHealthy = checkpointSource(targetPath);
      copyRegularFile(targetPath, preserved);
      for (const suffix of ["-wal", "-shm"]) {
        const source = `${targetPath}${suffix}`;
        if (!existsSync(source)) continue;
        const preservedSidecar = `${preserved}${suffix}`;
        copyRegularFile(source, preservedSidecar);
      }
      if (preservedSourceHealthy) verifyDatabaseFile(preserved);
      fsyncPath(dirname(targetPath));
      hasPreservedSource = true;
    }
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${targetPath}${suffix}`;
      if (!existsSync(source)) continue;
      const quarantine = `${source}.quarantine-${randomUUID()}`;
      quarantineRegularFile(source, quarantine);
      movedSidecars.push({ source, quarantine });
    }
    renameSync(temporary, targetPath);
    targetInstalled = true;
    fsyncPath(dirname(targetPath));
    verifyInstalledBackup(targetPath, verified.manifest);
    for (const { quarantine } of movedSidecars) {
      unlinkRegularFile(quarantine);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    rmSync(temporary, { force: true });
    if (targetInstalled) {
      try {
        for (const suffix of ["-wal", "-shm"]) {
          unlinkRegularFile(`${targetPath}${suffix}`, true);
        }
        if (hasPreservedSource) {
          const rollback = `${targetPath}.rollback-${randomUUID()}.tmp`;
          copyRegularFile(preserved, rollback);
          unlinkRegularFile(targetPath);
          renameSync(rollback, targetPath);
        } else {
          unlinkRegularFile(targetPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const { source, quarantine } of movedSidecars.reverse()) {
      if (!existsSync(quarantine)) continue;
      try {
        if (existsSync(source)) throw new Error("restore sidecar path was replaced during rollback");
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
      gate.retain();
      throw new AggregateError([error, ...rollbackErrors], "restore failed and rollback was incomplete");
    }
    throw error;
  }
  return preserved;
}

function copyVerifiedSource(verified: VerifiedBackup, target: string): void {
  assertNoSymbolicLinks(verified.databasePath);
  const source = openSync(verified.databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: number | undefined;
  try {
    const before = fstatSync(source);
    if (!before.isFile()) throw new Error("backup database must be a regular file");
    destination = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const read = readSync(source, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) {
        written += writeSync(destination, buffer, written, read - written);
      }
      size += read;
    }
    const after = fstatSync(source);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error("backup database changed while it was copied");
    }
    if (size !== verified.manifest.size || hash.digest("hex") !== verified.manifest.sha256) {
      throw new Error("backup hash or size mismatch during restore copy");
    }
    fsyncSync(destination);
  } finally {
    if (destination !== undefined) closeSync(destination);
    closeSync(source);
  }
  chmodSync(target, 0o600);
  verifyDatabaseMatchesManifest(target, verified.manifest);
}

function verifyDatabaseMatchesManifest(path: string, manifest: BackupManifest): void {
  const db = new Database(path, { readonly: true });
  try {
    const health = assertHealthyDatabase(db);
    assertManifestSourceSchema(db, health.schemaVersion, manifest.sourceSchema);
    if (JSON.stringify(health.counts) !== JSON.stringify(manifest.counts)) {
      throw new Error("backup manifest row counts do not match");
    }
  } finally {
    db.close();
  }
}

function verifyInstalledBackup(path: string, manifest: BackupManifest): void {
  const digest = hashRegularFile(path);
  if (digest.size !== manifest.size) {
    throw new Error("installed backup size does not match manifest");
  }
  if (digest.sha256 !== manifest.sha256) {
    throw new Error("installed backup hash does not match manifest");
  }
  verifyDatabaseMatchesManifest(path, manifest);
}

function assertManifestSourceSchema(
  db: Database,
  actualSchema: number | undefined,
  sourceSchema: number,
): void {
  if (!Number.isSafeInteger(sourceSchema) || sourceSchema < 2 || sourceSchema > 11) {
    throw new Error("backup manifest source schema does not match database");
  }
  if (actualSchema === sourceSchema) {
    if (sourceSchema >= 2 && sourceSchema <= 10) {
      try {
        assertLegacySchemaIdentity(db, sourceSchema);
      } catch {
        throw new Error("backup manifest source schema does not match database");
      }
    }
    return;
  }
  if (sourceSchema === 2 && actualSchema === undefined && hasTable(db, "memory_items")) {
    try {
      assertLegacySchemaIdentity(db, sourceSchema);
      return;
    } catch {
      throw new Error("backup manifest source schema does not match database");
    }
  }
  throw new Error("backup manifest source schema does not match database");
}

function hasTable(db: Database, table: string): boolean {
  return (
    db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { count: number }
  ).count > 0;
}


function hashRegularFile(path: string): { sha256: string; size: number } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${path} must be a regular file`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      size !== after.size
    ) {
      throw new Error(`${path} changed while it was hashed`);
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    closeSync(descriptor);
  }
}

function copyRegularFile(sourcePath: string, targetPath: string): void {
  assertNoSymbolicLinks(sourcePath);
  const source = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target: number | undefined;
  try {
    const before = fstatSync(source);
    if (!before.isFile()) throw new Error(`${sourcePath} must be a regular file`);
    target = openSync(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const read = readSync(source, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      let written = 0;
      while (written < read) written += writeSync(target, buffer, written, read - written);
    }
    const after = fstatSync(source);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`${sourcePath} changed while it was copied`);
    }
    fsyncSync(target);
  } finally {
    if (target !== undefined) closeSync(target);
    closeSync(source);
  }
}

function quarantineRegularFile(source: string, quarantine: string): void {
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("database sidecar must be a regular file");
  }
  renameSync(source, quarantine);
  const after = lstatSync(quarantine);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("database sidecar changed while it was quarantined");
  }
}

function unlinkRegularFile(path: string, allowMissing = false): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} must be a regular file`);
    rmSync(path);
  } catch (error) {
    if (allowMissing && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
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
  const stat = lstatSync(path);
  if (platform() === "win32" && stat.isDirectory()) return;
  const descriptor = openSync(path, platform() === "win32" ? "r+" : "r");
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

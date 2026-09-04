import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { hostname } from "os";
import { join } from "path";
import { openMemoryDatabase, openReadOnlyMemoryDatabase } from "../db";
import { hashTuple } from "../hash";
import { deriveDocument } from "../retrieval/derived";

const MAX_BATCH_SIZE = 500;

type Phase = "purges" | "notes";
interface State {
  databaseID: string;
  databaseFile: FileIdentity;
  backend: string;
  generation: number;
  phase: Phase;
  projectID: string | null;
  noteID: string | null;
  startedAt: number;
  snapshot: string;
  purges: number;
  queued: number;
  quarantined: number;
}

interface FileIdentity { dev: number; ino: number; }
interface SidecarDirectory extends FileIdentity { path: string; fd: number; }
interface PrivateJsonFile { value: unknown; identity: FileIdentity; }

export interface ProcessStartMarkerReaders {
  readLinuxStat?: (pid: number) => string | null;
  readMacOSPs?: (pid: number) => string | null;
}

export interface ReindexTestOptions {
  /** Test-only fault point after a durable batch commit but before its cursor is saved. */
  afterCommitBeforeStateWrite?: () => void;
  /** Test-only fault point immediately before the batch's database identity verification. */
  beforeBatchDatabaseIdentity?: () => void;
  /** Test-only synchronization point after a stale lock is classified but before takeover. */
  beforeStaleLockTakeover?: () => void;
  /** Test-only synchronization point while the owner lock is held. */
  afterOwnerLockAcquired?: () => void;
}

export interface ReindexOwnerMetadata {
  ownerID: string;
  pid: number;
  processStart: string;
  hostname: string;
  createdAt: number;
}

export function classifyReindexOwner(
  owner: unknown,
  localHostname: string,
  processAlive: boolean,
  currentProcessStart: string | null,
): "live" | "stale" | "unverifiable" {
  if (!isOwnerMetadata(owner) || owner.hostname !== localHostname) return "unverifiable";
  if (!processAlive) return "stale";
  if (!currentProcessStart) return "unverifiable";
  return currentProcessStart === owner.processStart ? "live" : "stale";
}

export function runResumableReindex(
  path: string,
  databaseID: string,
  backend: string,
  batchSize: number,
  maxBatches?: number,
  testOptions: ReindexTestOptions = {},
) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`reindex --batch-size must be 1..${MAX_BATCH_SIZE}`);
  }
  if (maxBatches !== undefined && (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 10_000)) {
    throw new Error("reindex --max-batches must be 1..10000");
  }
  const databaseFile = captureDatabaseFile(path);
  const directory = openSidecarDirectory(path);
  const file = join(directory.path, `${createHash("sha256").update(backend).digest("hex")}.json`);
  const release = acquireOwnerLock(file, directory, testOptions);
  try {
    testOptions.afterOwnerLockAcquired?.();
    const existing = readState(file, directory, path, databaseID, backend);
    let state = existing ?? createState(path, databaseID, backend, databaseFile);
    if (!existing) writeState(file, directory, state);
    let batches = 0;
    while (true) {
      const result = runBatch(path, state, batchSize, testOptions);
      state = result.state;
      batches++;
      if (result.done) {
        removePrivateFile(file, directory, "reindex state file", true);
        return {
          backend,
          generation: state.generation,
          purges: state.purges,
          queued: state.queued,
          quarantined: state.quarantined,
          resumed: existing !== undefined,
        };
      }
      testOptions.afterCommitBeforeStateWrite?.();
      writeState(file, directory, state);
      if (maxBatches !== undefined && batches >= maxBatches) {
        return {
          backend,
          generation: state.generation,
          purges: state.purges,
          queued: state.queued,
          quarantined: state.quarantined,
          incomplete: true,
          resumed: existing !== undefined,
        };
      }
    }
  } finally {
    try {
      release();
    } finally {
      closeSync(directory.fd);
    }
  }
}

function acquireOwnerLock(stateFile: string, directory: SidecarDirectory, testOptions: ReindexTestOptions): () => void {
  const lock = `${stateFile}.lock`;
  assertReindexOwnerLivenessSupported();
  const processStart = readReindexProcessStartMarker(process.pid);
  if (!processStart) throw new Error(`reindex owner liveness is unavailable on ${process.platform}`);
  const owner: ReindexOwnerMetadata = {
    ownerID: randomUUID(),
    pid: process.pid,
    processStart,
    hostname: hostname(),
    createdAt: Date.now(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      assertSidecarDirectory(directory);
      fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, `${JSON.stringify(owner)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      assertSidecarDirectory(directory);
      return () => {
        const current = readPrivateJsonFile(lock, directory, "reindex owner lock", false);
        if (!current || !isOwnerMetadata(current.value) || current.value.ownerID !== owner.ownerID) {
          throw new Error("reindex owner lock changed before release");
        }
        removeOwnedPrivateFile(lock, directory, "reindex owner lock", current.identity, owner.ownerID);
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (!hasCode(error, "EEXIST") || attempt === 2) throw new Error("reindex already owned");
      const observed = readPrivateJsonFile(lock, directory, "reindex owner lock", false);
      if (!observed || !isOwnerMetadata(observed.value)) throw new Error("reindex owner lock is unverifiable");
      const current = observed.value;
      const pid = current.pid;
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (probe) {
        if (!hasCode(probe, "ESRCH")) throw new Error("reindex owner lock is unverifiable");
      }
      const status = classifyReindexOwner(current, hostname(), alive, alive ? readReindexProcessStartMarker(pid) : null);
      if (status === "live") throw new Error("reindex already owned");
      if (status === "unverifiable") throw new Error("reindex owner lock is unverifiable");
      testOptions.beforeStaleLockTakeover?.();
      quarantineStaleLock(lock, directory, observed.identity, current, owner.ownerID);
    }
  }
  throw new Error("reindex already owned");
}

export function readReindexProcessStartMarker(
  pid: number,
  platform = process.platform,
  readers: ProcessStartMarkerReaders = {},
): string | null {
  if (platform === "linux") {
    try {
      const value = "readLinuxStat" in readers ? readers.readLinuxStat?.(pid) : readFileSync(`/proc/${pid}/stat`, "utf8");
      if (!value) return null;
    const close = value.lastIndexOf(")");
      if (close < 0) return null;
    const start = value.slice(close + 1).trim().split(/\s+/)[19];
    return start ? `linux:${start}` : null;
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    try {
      const output = "readMacOSPs" in readers ? readers.readMacOSPs?.(pid) : readMacOSProcessStart(pid);
      return output ? `macos:${output}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function assertReindexOwnerLivenessSupported(platform = process.platform): void {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`reindex owner liveness is unsupported on ${platform}`);
  }
}

function readMacOSProcessStart(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const marker = result.stdout.trim();
  return marker || null;
}

function createState(path: string, databaseID: string, backend: string, databaseFile: FileIdentity): State {
  preflightDatabaseIdentity(path, databaseID, databaseFile);
  const opened = openMemoryDatabase(path);
  try {
    assertDatabaseIdentity(path, opened.db, databaseID, databaseFile);
    const generation = (
      opened.db.query("SELECT COALESCE(MAX(generation), 0) + 1 AS value FROM index_outbox WHERE backend = ?").get(backend) as { value: number }
    ).value;
    return {
      databaseID,
      databaseFile,
      backend,
      generation,
      phase: "purges",
      projectID: null,
      noteID: null,
      startedAt: Date.now(),
      snapshot: randomUUID(),
      purges: 0,
      queued: 0,
      quarantined: 0,
    };
  } finally {
    opened.close();
  }
}

function runBatch(
  path: string,
  state: State,
  limit: number,
  testOptions: ReindexTestOptions,
): { state: State; done: boolean } {
  preflightDatabaseIdentity(path, state.databaseID, state.databaseFile);
  const opened = openMemoryDatabase(path);
  try {
    const next = { ...state };
    testOptions.beforeBatchDatabaseIdentity?.();
    assertDatabaseIdentity(path, opened.db, state.databaseID, state.databaseFile);
    opened.db.exec("BEGIN IMMEDIATE");
    try {
      if (next.phase === "purges") {
        const rows = opened.db.query("SELECT id FROM projects WHERE id > ? ORDER BY id LIMIT ?").all(next.projectID ?? "", limit + 1) as Array<{ id: string }>;
        for (const row of rows.slice(0, limit)) {
          insert(opened.db, next, "purge-project", row.id, null, null, null);
          next.purges++;
          next.projectID = row.id;
        }
        if (rows.length <= limit) {
          next.phase = "notes";
          next.projectID = null;
          next.noteID = null;
        }
      } else {
        const rows = opened.db.query("SELECT id, project_id, current_revision, kind, title, summary, content FROM notes WHERE status = 'active' AND (project_id > ? OR (project_id = ? AND id > ?)) ORDER BY project_id, id LIMIT ?").all(next.projectID ?? "", next.projectID ?? "", next.noteID ?? "", limit + 1) as Array<{ id: string; project_id: string; current_revision: number; kind: string; title: string; summary: string; content: string }>;
        for (const row of rows.slice(0, limit)) {
          next.projectID = row.project_id;
          next.noteID = row.id;
          const document = deriveDocument({ projectID: row.project_id, noteID: row.id, revision: row.current_revision, kind: row.kind, title: row.title, summary: row.summary, content: row.content });
          if (!document) {
            next.quarantined++;
            continue;
          }
          insert(opened.db, next, "upsert-note", row.project_id, row.id, row.current_revision, document.contentHash);
          next.queued++;
        }
        if (rows.length <= limit) {
          opened.db.exec("COMMIT");
          return { state: next, done: true };
        }
      }
      opened.db.exec("COMMIT");
      return { state: next, done: false };
    } catch (error) {
      try { opened.db.exec("ROLLBACK"); } catch { /* transaction was already committed */ }
      throw error;
    }
  } finally {
    opened.close();
  }
}

function captureDatabaseFile(path: string): FileIdentity {
  const stat = regularFile(path, "database");
  return { dev: stat.dev, ino: stat.ino };
}

function assertDatabaseIdentity(path: string, db: Database, databaseID: string, expectedFile: FileIdentity): void {
  const stat = regularFile(path, "database");
  if (!sameFile(stat, expectedFile)) throw new Error("reindex database file changed");
  const row = db.query("SELECT database_id FROM agz_meta WHERE id = 1").get() as { database_id?: string } | undefined;
  if (row?.database_id !== databaseID) throw new Error("reindex database identity changed");
}

/** Confirms file and AGZ identity without permitting initialization or migration. */
function preflightDatabaseIdentity(path: string, databaseID: string, expectedFile: FileIdentity): void {
  if (!sameFile(regularFile(path, "database"), expectedFile)) {
    throw new Error("reindex database file changed; remove state and restart reindex");
  }
  const opened = openReadOnlyMemoryDatabase(path);
  try {
    assertDatabaseIdentity(path, opened.db, databaseID, expectedFile);
  } finally {
    opened.close();
  }
  if (!sameFile(regularFile(path, "database"), expectedFile)) {
    throw new Error("reindex database file changed; remove state and restart reindex");
  }
}

function insert(db: Database, state: State, operation: "purge-project" | "upsert-note", projectID: string, noteID: string | null, revision: number | null, contentHash: string | null): void {
  const key = hashTuple("outbox-operation", 2, [state.backend, operation, projectID, noteID, revision, contentHash, state.generation]);
  if (db.query("SELECT 1 FROM index_outbox WHERE operation_key = ?").get(key)) return;
  db.query("INSERT INTO index_outbox (backend, operation_key, operation, project_id, note_id, revision, content_hash, generation, lease_generation, fence, state, attempt_count, available_at, heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', 0, ?, NULL, ?)").run(state.backend, key, operation, projectID, noteID, revision, contentHash, state.generation, Date.now(), Date.now());
}

function openSidecarDirectory(databasePath: string): SidecarDirectory {
  if (process.platform === "win32" || !constants.O_DIRECTORY || !constants.O_NOFOLLOW) {
    throw new Error("reindex sidecar directory security is unsupported on this platform");
  }
  const path = `${databasePath}.reindex`;
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) {
    throw new Error("reindex state directory is unsafe");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) throw new Error("reindex state directory changed while opening");
    const directory = { path, fd, dev: opened.dev, ino: opened.ino };
    assertSidecarDirectory(directory);
    return directory;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertSidecarDirectory(directory: SidecarDirectory): void {
  const opened = fstatSync(directory.fd);
  const current = lstatSync(directory.path);
  if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || !sameFile(opened, directory) || !sameFile(current, directory) || (current.mode & 0o077) !== 0) {
    throw new Error("reindex state directory changed");
  }
}

function readState(path: string, directory: SidecarDirectory, databasePath: string, databaseID: string, backend: string): State | undefined {
  const parsed = readPrivateJson(path, directory, "reindex state file", true);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== "object") throw new Error("reindex state is invalid");
  const state = parsed as State;
  if (state.databaseID !== databaseID || state.backend !== backend || !isFileIdentity(state.databaseFile) || !Number.isSafeInteger(state.generation) || state.generation < 1 || (state.phase !== "purges" && state.phase !== "notes") || !Number.isSafeInteger(state.startedAt) || typeof state.snapshot !== "string" || !/^[0-9a-f-]{36}$/i.test(state.snapshot) || !nullableString(state.projectID) || !nullableString(state.noteID) || ![state.purges, state.queued, state.quarantined].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("reindex state is invalid");
  }
  if (!sameFile(regularFile(databasePath, "database"), state.databaseFile)) {
    throw new Error("reindex state is stale; remove state and restart reindex");
  }
  return state;
}

function readPrivateJson(path: string, directory: SidecarDirectory, label: string, optional: boolean): unknown | undefined {
  return readPrivateJsonFile(path, directory, label, optional)?.value;
}

function readPrivateJsonFile(path: string, directory: SidecarDirectory, label: string, optional: boolean): PrivateJsonFile | undefined {
  let fd: number | undefined;
  try {
    assertSidecarDirectory(directory);
    const before = regularFile(path, label);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) throw new Error(`${label} changed while opening`);
    const raw = readFileSync(fd, "utf8");
    const after = regularFile(path, label);
    if (!sameFile(after, opened)) throw new Error(`${label} changed while reading`);
    assertSidecarDirectory(directory);
    return { value: JSON.parse(raw), identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) {
    if (optional && hasCode(error, "ENOENT")) {
      assertSidecarDirectory(directory);
      return undefined;
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function quarantineStaleLock(
  lock: string,
  directory: SidecarDirectory,
  observedIdentity: FileIdentity,
  observedOwner: ReindexOwnerMetadata,
  contenderID: string,
): void {
  const quarantine = `${lock}.${contenderID}.stale`;
  assertReplacementTargetSafe(quarantine, "reindex stale lock quarantine");
  try {
    renameSync(lock, quarantine);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  const claimed = readPrivateJsonFile(quarantine, directory, "reindex stale lock quarantine", false);
  if (!claimed || !sameFile(claimed.identity, observedIdentity) || !isOwnerMetadata(claimed.value) || claimed.value.ownerID !== observedOwner.ownerID) {
    throw new Error("reindex owner lock changed during stale takeover");
  }
  removeOwnedPrivateFile(quarantine, directory, "reindex stale lock quarantine", observedIdentity, observedOwner.ownerID);
}

function removeOwnedPrivateFile(
  path: string,
  directory: SidecarDirectory,
  label: string,
  expectedIdentity: FileIdentity,
  expectedOwnerID: string,
): void {
  const current = readPrivateJsonFile(path, directory, label, false);
  if (!current || !sameFile(current.identity, expectedIdentity) || !isOwnerMetadata(current.value) || current.value.ownerID !== expectedOwnerID) {
    throw new Error(`${label} changed before removal`);
  }
  removePrivateFile(path, directory, label, false);
}

function writeState(path: string, directory: SidecarDirectory, state: State): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    assertSidecarDirectory(directory);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    writeSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    regularFile(temporary, "reindex temporary state file");
    assertSidecarDirectory(directory);
    assertReplacementTargetSafe(path, "reindex state file");
    renameSync(temporary, path);
    created = false;
    assertSidecarDirectory(directory);
    fsyncSync(directory.fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) removePrivateFile(temporary, directory, "reindex temporary state file", true);
  }
}

function removePrivateFile(path: string, directory: SidecarDirectory, label: string, optional: boolean): void {
  try {
    assertSidecarDirectory(directory);
    regularFile(path, label);
    rmSync(path);
    assertSidecarDirectory(directory);
    fsyncSync(directory.fd);
  } catch (error) {
    if (optional && hasCode(error, "ENOENT")) {
      assertSidecarDirectory(directory);
      return;
    }
    throw error;
  }
}

function regularFile(path: string, label: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`${label} is unsafe`);
  return stat;
}

function assertReplacementTargetSafe(path: string, label: string): void {
  try {
    regularFile(path, label);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isFileIdentity(value: unknown): value is FileIdentity {
  return Boolean(value && typeof value === "object" && Number.isSafeInteger((value as FileIdentity).dev) && Number.isSafeInteger((value as FileIdentity).ino));
}

function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
function isOwnerMetadata(value: unknown): value is ReindexOwnerMetadata {
  return Boolean(value && typeof value === "object" && typeof (value as ReindexOwnerMetadata).ownerID === "string" && (value as ReindexOwnerMetadata).ownerID && Number.isSafeInteger((value as ReindexOwnerMetadata).pid) && (value as ReindexOwnerMetadata).pid > 0 && typeof (value as ReindexOwnerMetadata).processStart === "string" && (value as ReindexOwnerMetadata).processStart && typeof (value as ReindexOwnerMetadata).hostname === "string" && (value as ReindexOwnerMetadata).hostname && Number.isSafeInteger((value as ReindexOwnerMetadata).createdAt));
}

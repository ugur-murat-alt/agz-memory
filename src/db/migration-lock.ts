import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { hostname } from "os";

export interface MigrationLockOwner {
  ownerID: string;
  pid: number;
  processStartMarker: string;
  hostname: string;
  startedAt: number;
  targetSchema: number;
}

export interface MigrationLock {
  path: string;
  owner: MigrationLockOwner;
  release(): void;
}

export function migrationLockPath(databasePath: string): string {
  return `${databasePath}.migration.lock`;
}

export function acquireMigrationLock(
  databasePath: string,
  targetSchema: number,
  timeoutMs = 30_000,
): MigrationLock {
  const path = migrationLockPath(databasePath);
  const owner: MigrationLockOwner = {
    ownerID: randomUUID(),
    pid: process.pid,
    processStartMarker: processStartMarker(process.pid) ?? "unavailable",
    hostname: hostname(),
    startedAt: Date.now(),
    targetSchema,
  };
  const deadline = Date.now() + timeoutMs;
  const stagedOwner = `${path}.owner-${owner.ownerID}.tmp`;
  writeFileSync(stagedOwner, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  try {
    while (true) {
      let created = false;
      try {
        mkdirSync(path, { mode: 0o700 });
        created = true;
        renameSync(stagedOwner, `${path}/owner.json`);
        break;
      } catch (error) {
        if (created) {
          rmSync(path, { recursive: true, force: true });
          throw error;
        }
        if (!isAlreadyExistsError(error)) throw error;
        if (Date.now() >= deadline) {
          const current = readMigrationLockOwner(path);
          throw new Error(
            `migration lock is held${current ? ` by ${current.ownerID} (pid ${current.pid})` : ""}`,
          );
        }
        Bun.sleepSync(Math.min(250, Math.max(25, deadline - Date.now())));
      }
    }
  } finally {
    rmSync(stagedOwner, { force: true });
  }
  let released = false;
  return {
    path,
    owner,
    release() {
      if (released) return;
      const current = readMigrationLockOwner(path);
      if (current?.ownerID !== owner.ownerID) {
        throw new Error("migration lock ownership changed before release");
      }
      rmSync(path, { recursive: true, force: true });
      released = true;
    },
  };
}

export function readMigrationLockOwner(path: string): MigrationLockOwner | undefined {
  try {
    return JSON.parse(readFileSync(`${path}/owner.json`, "utf8")) as MigrationLockOwner;
  } catch {
    return undefined;
  }
}

export function breakMigrationLock(
  databasePath: string,
  ownerID: string,
  confirmation: string,
): void {
  if (confirmation !== "BREAK_STALE_MIGRATION_LOCK") {
    throw new Error("invalid migration lock confirmation");
  }
  const path = migrationLockPath(databasePath);
  const owner = readMigrationLockOwner(path);
  if (!owner) {
    if (ownerID !== "ORPHANED" || !existsSync(path)) throw new Error("migration lock owner mismatch");
    rmSync(path, { recursive: true, force: true });
    return;
  }
  if (owner.ownerID !== ownerID) throw new Error("migration lock owner mismatch");
  if (owner.hostname === hostname() && processIsAlive(owner.pid)) {
    const currentMarker = processStartMarker(owner.pid);
    if (!currentMarker || currentMarker === owner.processStartMarker) {
      throw new Error(`migration lock process ${owner.pid} is still alive`);
    }
  }
  rmSync(path, { recursive: true, force: true });
}

function processStartMarker(pid: number): string | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(/\s+/);
    return fields[21];
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code: unknown }).code) === "EEXIST",
  );
}

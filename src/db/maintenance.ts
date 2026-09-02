import { randomUUID } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { hostname, platform } from "os";
import { basename, dirname, join, parse, resolve } from "path";

interface OwnerRecord {
  ownerID: string;
  pid: number;
  processStart: string | null;
  hostname: string;
  createdAt: number;
  state: "active" | "recovery-required";
}

export interface DatabaseLease {
  databasePath: string;
  release: () => void;
}

export interface MaintenanceGate {
  databasePath: string;
  release: () => void;
  assertOwned: () => void;
  retain: () => void;
}

export interface MaintenanceRecovery {
  ownerID: string;
  confirmation: "RECOVER_RETAINED_MAINTENANCE_GATE";
}

export function acquireDatabaseLease(databasePath: string): DatabaseLease {
  const canonicalPath = canonicalDatabasePath(databasePath);
  const gatePath = maintenanceGatePath(canonicalPath);
  const leaseDirectory = databaseLeaseDirectory(canonicalPath);
  assertNoSymbolicLinks(dirname(canonicalPath));
  assertNoSymbolicLinks(canonicalPath, true);
  assertProtocolPath(gatePath, "maintenance gate", true);
  if (existsSync(gatePath)) throw new Error("maintenance_gate_active");

  ensurePrivateDirectory(leaseDirectory, "database lease registry");
  const owner = ownerRecord();
  const temporaryPath = join(leaseDirectory, `.${owner.ownerID}.tmp`);
  const leasePath = join(leaseDirectory, `${owner.ownerID}.json`);
  try {
    writeExclusiveRecord(temporaryPath, owner);
    renameSync(temporaryPath, leasePath);
    fsyncPath(leaseDirectory);
    assertProtocolPath(gatePath, "maintenance gate", true);
    if (existsSync(gatePath)) {
      removeOwnedRecord(leasePath, owner.ownerID);
      throw new Error("maintenance_gate_active");
    }
  } catch (error) {
    removeFreshRecord(temporaryPath);
    removeOwnedRecord(leasePath, owner.ownerID);
    throw error;
  }

  let released = false;
  return {
    databasePath: canonicalPath,
    release: () => {
      if (released) return;
      removeOwnedRecord(leasePath, owner.ownerID);
      released = true;
    },
  };
}

export function acquireMaintenanceGate(
  databasePath: string,
  recovery?: MaintenanceRecovery,
): MaintenanceGate {
  const canonicalPath = canonicalDatabasePath(databasePath);
  const gatePath = maintenanceGatePath(canonicalPath);
  const leaseDirectory = databaseLeaseDirectory(canonicalPath);
  assertNoSymbolicLinks(dirname(canonicalPath));
  assertNoSymbolicLinks(canonicalPath, true);
  assertProtocolPath(gatePath, "maintenance gate", true);
  assertProtocolPath(leaseDirectory, "database lease registry", true);

  const owner = ownerRecord();
  let created = false;
  let gateStat: { dev: number; ino: number };
  try {
    mkdirSync(gatePath, { mode: 0o700 });
    created = true;
    gateStat = lstatSync(gatePath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    gateStat = claimStaleGate(gatePath, owner, recovery);
  }

  const ownerPath = join(gatePath, "owner.json");
  try {
    if (created) {
      writeExclusiveRecord(ownerPath, owner);
      fsyncPath(gatePath);
    }
    rejectActiveLeases(leaseDirectory);
  } catch (error) {
    removeFreshGate(gatePath, owner.ownerID, gateStat.dev, gateStat.ino);
    throw error;
  }

  let released = false;
  let retained = false;
  const assertOwned = () => {
    if (released) throw new Error("maintenance_gate_not_owned");
    const record = readOwnerRecord(ownerPath, "maintenance gate owner");
    if (record.ownerID !== owner.ownerID) throw new Error("maintenance_gate_not_owned");
  };
  return {
    databasePath: canonicalPath,
    assertOwned,
    retain: () => {
      assertOwned();
      replaceOwnerRecord(ownerPath, owner.ownerID, {
        ...owner,
        state: "recovery-required",
      });
      retained = true;
    },
    release: () => {
      if (released || retained) return;
      assertOwned();
      removeOwnedGate(gatePath, owner.ownerID);
      released = true;
    },
  };
}

export function recoverStaleMaintenanceGate(
  databasePath: string,
  validate: () => void,
): boolean {
  const canonicalPath = canonicalDatabasePath(databasePath);
  if (!existsSync(maintenanceGatePath(canonicalPath))) return false;
  const gate = acquireMaintenanceGate(canonicalPath);
  try {
    validate();
  } catch (error) {
    gate.retain();
    throw error;
  } finally {
    gate.release();
  }
  return true;
}

export function assertMaintenanceGateFor(gate: MaintenanceGate, databasePath: string): void {
  if (gate.databasePath !== canonicalDatabasePath(databasePath)) {
    throw new Error("maintenance_gate_target_mismatch");
  }
  gate.assertOwned();
}

export function canonicalDatabasePath(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  assertNoSymbolicLinks(parent);
  return join(resolve(parent), basename(absolute));
}

export function ensureDatabaseParent(path: string): void {
  const parent = dirname(resolve(path));
  assertNoSymbolicLinks(parent);
  const existed = existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNoSymbolicLinks(parent);
  if (!existed) chmodSync(parent, 0o700);
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("database parent must be a directory");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("database parent must be owned by the current user");
  }
  if (platform() !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error("database parent must not be group or world writable");
  }
}

export function assertNoSymbolicLinks(path: string, allowMissingLeaf = false): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${current}`);
    } catch (error) {
      if (isMissing(error) && (allowMissingLeaf ? index === parts.length - 1 : true)) return;
      throw error;
    }
  }
}

function maintenanceGatePath(databasePath: string): string {
  return `${databasePath}.maintenance`;
}

function databaseLeaseDirectory(databasePath: string): string {
  return `${databasePath}.leases`;
}

function ensurePrivateDirectory(path: string, label: string): void {
  assertProtocolPath(path, label, true);
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  chmodSync(path, 0o700);
}

function assertProtocolPath(path: string, label: string, allowMissing: boolean): void {
  assertNoSymbolicLinks(path, allowMissing);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
}

function writeExclusiveRecord(path: string, owner: OwnerRecord): void {
  writeFileSync(path, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fsyncPath(path);
}

function rejectActiveLeases(leaseDirectory: string): void {
  if (!existsSync(leaseDirectory)) return;
  const directoryStat = lstatSync(leaseDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("database lease registry must be a directory");
  }
  for (const entry of readdirSync(leaseDirectory)) {
    if (!entry.endsWith(".json")) continue;
    const leasePath = join(leaseDirectory, entry);
    const before = lstatSync(leasePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("database lease must be a regular file");
    const lease = readOwnerRecord(leasePath, "database lease");
    if (ownerIsActive(lease)) throw new Error("active_database_handles");
    const after = lstatSync(leasePath);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("database lease changed during stale-owner verification");
    }
    unlinkSync(leasePath);
  }
  fsyncPath(leaseDirectory);
}

function ownerStatus(
  owner: OwnerRecord,
): "active" | "stale" | "unverifiable" | "recovery-required" {
  if (owner.state === "recovery-required") return "recovery-required";
  if (owner.hostname !== hostname()) return "unverifiable";
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return "stale";
    }
    return "unverifiable";
  }
  const currentStart = processStartMarker(owner.pid);
  if (owner.processStart === null || currentStart === null) return "unverifiable";
  return owner.processStart === currentStart ? "active" : "stale";
}

function ownerIsActive(owner: OwnerRecord): boolean {
  return ownerStatus(owner) !== "stale";
}

function ownerRecord(): OwnerRecord {
  return {
    ownerID: randomUUID(),
    pid: process.pid,
    processStart: processStartMarker(process.pid),
    hostname: hostname(),
    createdAt: Date.now(),
    state: "active",
  };
}

function processStartMarker(pid: number): string | null {
  if (platform() !== "linux") return null;
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    const fields = value.slice(close + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime ? `linux:${startTime}` : null;
  } catch {
    return null;
  }
}

function readOwnerRecord(path: string, label: string): OwnerRecord {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnerRecord>;
  if (
    typeof parsed.ownerID !== "string" ||
    !parsed.ownerID ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid! <= 0 ||
    (parsed.processStart !== null &&
      (typeof parsed.processStart !== "string" || !parsed.processStart)) ||
    typeof parsed.hostname !== "string" ||
    !parsed.hostname ||
    !Number.isSafeInteger(parsed.createdAt) ||
    parsed.createdAt! < 0 ||
    (parsed.state !== undefined &&
      parsed.state !== "active" &&
      parsed.state !== "recovery-required")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return { ...parsed, state: parsed.state ?? "active" } as OwnerRecord;
}

function claimStaleGate(
  gatePath: string,
  owner: OwnerRecord,
  recovery?: MaintenanceRecovery,
): { dev: number; ino: number } {
  const gate = lstatSync(gatePath);
  if (!gate.isDirectory() || gate.isSymbolicLink()) {
    throw new Error("maintenance gate must be a directory");
  }
  const ownerPath = join(gatePath, "owner.json");
  const claimPath = join(gatePath, "takeover.json");
  acquireTakeoverClaim(claimPath, owner);
  try {
    const before = lstatSync(ownerPath);
    const previous = readOwnerRecord(ownerPath, "maintenance gate owner");
    const status = ownerStatus(previous);
    if (status === "active") throw new Error("maintenance_gate_active");
    if (status === "unverifiable") throw new Error("maintenance_gate_unverifiable");
    if (status === "recovery-required") {
      if (
        recovery?.ownerID !== previous.ownerID ||
        recovery.confirmation !== "RECOVER_RETAINED_MAINTENANCE_GATE"
      ) {
        throw new Error("maintenance_gate_recovery_required");
      }
    }
    const currentGate = lstatSync(gatePath);
    const currentOwner = lstatSync(ownerPath);
    if (
      currentGate.dev !== gate.dev ||
      currentGate.ino !== gate.ino ||
      currentOwner.dev !== before.dev ||
      currentOwner.ino !== before.ino ||
      readOwnerRecord(ownerPath, "maintenance gate owner").ownerID !== previous.ownerID
    ) {
      throw new Error("maintenance gate changed during stale-owner verification");
    }
    renameSync(claimPath, ownerPath);
    fsyncPath(gatePath);
    return { dev: gate.dev, ino: gate.ino };
  } catch (error) {
    removeOwnedRecord(claimPath, owner.ownerID);
    throw error;
  }
}

function acquireTakeoverClaim(path: string, owner: OwnerRecord): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeExclusiveRecord(path, owner);
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const before = lstatSync(path);
      const existing = readOwnerRecord(path, "maintenance takeover owner");
      const status = ownerStatus(existing);
      if (status === "active") throw new Error("maintenance_gate_active");
      if (status !== "stale") throw new Error("maintenance_gate_unverifiable");
      const after = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("maintenance takeover changed during stale-owner verification");
      }
      unlinkSync(path);
      fsyncPath(dirname(path));
    }
  }
  throw new Error("maintenance_gate_active");
}

function replaceOwnerRecord(
  ownerPath: string,
  ownerID: string,
  replacement: OwnerRecord,
): void {
  const temporary = `${ownerPath}.${ownerID}.tmp`;
  try {
    writeExclusiveRecord(temporary, replacement);
    if (readOwnerRecord(ownerPath, "maintenance gate owner").ownerID !== ownerID) {
      throw new Error("maintenance_gate_not_owned");
    }
    renameSync(temporary, ownerPath);
    fsyncPath(dirname(ownerPath));
  } catch (error) {
    removeFreshRecord(temporary);
    throw error;
  }
}

function removeOwnedRecord(path: string, ownerID: string): void {
  try {
    if (readOwnerRecord(path, "owner record").ownerID !== ownerID) return;
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function removeOwnedGate(gatePath: string, ownerID: string): void {
  const ownerPath = join(gatePath, "owner.json");
  try {
    if (readOwnerRecord(ownerPath, "maintenance gate owner").ownerID !== ownerID) return;
    unlinkSync(ownerPath);
    rmdirSync(gatePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function removeFreshRecord(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return;
    unlinkSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function removeFreshGate(gatePath: string, ownerID: string, device: number, inode: number): void {
  try {
    const gate = lstatSync(gatePath);
    if (!gate.isDirectory() || gate.isSymbolicLink() || gate.dev !== device || gate.ino !== inode) return;
    const ownerPath = join(gatePath, "owner.json");
    try {
      const record = readOwnerRecord(ownerPath, "maintenance gate owner");
      if (record.ownerID !== ownerID) return;
      unlinkSync(ownerPath);
    } catch (error) {
      if (!isMissing(error)) removeFreshRecord(ownerPath);
    }
    rmdirSync(gatePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function fsyncPath(path: string): void {
  const stat = lstatSync(path);
  if (platform() === "win32" && stat.isDirectory()) return;
  const descriptor = openSync(path, platform() === "win32" ? constants.O_RDWR : constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { join, resolve } from "path";
import { createVerifiedBackup, restoreVerifiedBackup } from "../../src/db/backup";
import { openMemoryDatabase } from "../../src/db";
import { openReadOnlyMemoryDatabase } from "../../src/db";
import { acquireMaintenanceGate } from "../../src/db/maintenance";
import { runAdmin } from "../../src/admin";

describe("cross-process database maintenance", () => {
  test("blocks restore while another process owns a database lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-maintenance-process-"));
    const databasePath = join(directory, "memory.sqlite");
    const readyPath = join(directory, "ready");
    const releasePath = join(directory, "release");
    const opened = openMemoryDatabase(databasePath);
    const backup = createVerifiedBackup(opened.db, databasePath, 11, 11, "test");
    opened.close();
    const modulePath = resolve(import.meta.dir, "../../src/db.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { existsSync, writeFileSync } from "fs";
          import { openMemoryDatabase } from ${JSON.stringify(modulePath)};
          const opened = openMemoryDatabase(${JSON.stringify(databasePath)});
          writeFileSync(${JSON.stringify(readyPath)}, "ready\\n");
          while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(10);
          opened.close();
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      await waitForPath(readyPath);
      expect(() =>
        restoreVerifiedBackup(
          backup.manifestPath,
          databasePath,
          "RESTORE_DATABASE_FROM_VERIFIED_BACKUP",
        ),
      ).toThrow("active_database_handles");
      writeFileSync(releasePath, "release\n");
      expect(await child.exited).toBe(0);
    } finally {
      writeFileSync(releasePath, "release\n");
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("blocks administrative backup and prune while a database handle is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-admin-maintenance-"));
    const databasePath = join(directory, "memory.sqlite");
    const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    process.env.OPENCODE_MEMORY_DATABASE_PATH = databasePath;
    const opened = openMemoryDatabase(databasePath);
    try {
      await expect(runAdmin(["backup"])).rejects.toThrow("active_database_handles");
      await expect(runAdmin(["backup", "prune"])).rejects.toThrow("active_database_handles");
    } finally {
      opened.close();
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("publishes a lease for read-only doctor access", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-doctor-lease-"));
    const databasePath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(databasePath);
    opened.close();
    const doctor = openReadOnlyMemoryDatabase(databasePath);
    try {
      expect(() => acquireMaintenanceGate(databasePath)).toThrow("active_database_handles");
    } finally {
      doctor.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a group or world writable database parent", () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-parent-mode-"));
    chmodSync(directory, 0o777);
    try {
      expect(() => openMemoryDatabase(join(directory, "memory.sqlite"))).toThrow(
        "database parent must not be group or world writable",
      );
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("removes a verifiably dead local lease before maintenance", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-maintenance-stale-"));
    const databasePath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(databasePath);
    opened.close();
    const leaseDirectory = `${databasePath}.leases`;
    writeFileSync(
      join(leaseDirectory, "dead.json"),
      `${JSON.stringify({
        ownerID: "dead-owner",
        pid: 2_147_483_647,
        processStart: "linux:dead",
        hostname: hostname(),
        createdAt: 1,
      })}\n`,
      { mode: 0o600 },
    );

    try {
      const gate = acquireMaintenanceGate(databasePath);
      gate.release();
      expect(existsSync(join(leaseDirectory, "dead.json"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains a poisoned maintenance gate until explicit recovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-maintenance-retain-"));
    const databasePath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(databasePath);
    opened.close();
    const gate = acquireMaintenanceGate(databasePath);
    gate.retain();
    gate.release();

    try {
      expect(existsSync(`${databasePath}.maintenance`)).toBe(true);
      expect(
        JSON.parse(readFileSync(`${databasePath}.maintenance/owner.json`, "utf8")),
      ).toMatchObject({ state: "recovery-required" });
      expect(() => openMemoryDatabase(databasePath)).toThrow(
        "maintenance_gate_recovery_required",
      );
      const ownerID = (
        JSON.parse(readFileSync(`${databasePath}.maintenance/owner.json`, "utf8")) as {
          ownerID: string;
        }
      ).ownerID;
      expect(() =>
        acquireMaintenanceGate(databasePath, {
          ownerID: "wrong-owner",
          confirmation: "RECOVER_RETAINED_MAINTENANCE_GATE",
        }),
      ).toThrow("maintenance_gate_recovery_required");
      const recovered = acquireMaintenanceGate(databasePath, {
        ownerID,
        confirmation: "RECOVER_RETAINED_MAINTENANCE_GATE",
      });
      recovered.release();
      expect(existsSync(`${databasePath}.maintenance`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recovers a gate left by a verifiably dead local owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-maintenance-dead-gate-"));
    const databasePath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(databasePath);
    opened.close();
    const modulePath = resolve(import.meta.dir, "../../src/db/maintenance.ts");
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `
        import { acquireMaintenanceGate } from ${JSON.stringify(modulePath)};
        acquireMaintenanceGate(${JSON.stringify(databasePath)});
      `,
    ]);

    try {
      expect(await child.exited).toBe(0);
      expect(existsSync(`${databasePath}.maintenance`)).toBe(true);
      const recovered = openMemoryDatabase(databasePath);
      recovered.close();
      expect(existsSync(`${databasePath}.maintenance`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recovers a local maintenance owner after PID reuse", () => {
    if (process.platform !== "linux") return;
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-maintenance-pid-reuse-"));
    const databasePath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(databasePath);
    opened.close();
    const gatePath = `${databasePath}.maintenance`;
    mkdirSync(gatePath, { mode: 0o700 });
    writeFileSync(
      join(gatePath, "owner.json"),
      `${JSON.stringify({
        ownerID: "reused-owner",
        pid: process.pid,
        processStart: "linux:not-this-process",
        hostname: hostname(),
        createdAt: 1,
        state: "active",
      })}\n`,
      { mode: 0o600 },
    );

    try {
      const recovered = openMemoryDatabase(databasePath);
      recovered.close();
      expect(existsSync(gatePath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps remote and malformed maintenance owners fail closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-maintenance-unverifiable-"));
    const databasePath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(databasePath);
    opened.close();
    const gatePath = `${databasePath}.maintenance`;
    mkdirSync(gatePath, { mode: 0o700 });
    writeFileSync(
      join(gatePath, "owner.json"),
      `${JSON.stringify({
        ownerID: "remote-owner",
        pid: process.pid,
        processStart: null,
        hostname: `${hostname()}-remote`,
        createdAt: 1,
        state: "active",
      })}\n`,
      { mode: 0o600 },
    );

    try {
      expect(() => openMemoryDatabase(databasePath)).toThrow(
        "maintenance_gate_unverifiable",
      );
      expect(existsSync(gatePath)).toBe(true);
      writeFileSync(join(gatePath, "owner.json"), "{}\n", { mode: 0o600 });
      expect(() => openMemoryDatabase(databasePath)).toThrow(
        "maintenance gate owner is invalid",
      );
      expect(existsSync(gatePath)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

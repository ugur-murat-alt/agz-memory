import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createVerifiedBackup, restoreVerifiedBackup, verifyBackupManifest } from "../../src/db/backup";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { acquireMigrationLock, breakMigrationLock, migrationLockPath } from "../../src/db/migration-lock";
import { runAdmin } from "../../src/admin";

describe("backup, restore, and migration lock", () => {
  test("verifies a backup and restores it without overwriting the previous database", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-restore-"));
    const path = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(path);
    const store = new MemoryStore(opened.db);
    const projectID = store.createProject("Restore").project!.projectID;
    store.update(projectID, { kind: "fact", title: "before", summary: "before" });
    const backup = createVerifiedBackup(opened.db, path, 9, 9, "test");
    expect(verifyBackupManifest(backup.manifestPath).manifest.sha256).toBe(backup.manifest.sha256);
    store.update(projectID, { kind: "fact", title: "after", summary: "after" });
    opened.close();

    const preserved = restoreVerifiedBackup(
      backup.manifestPath,
      path,
      "RESTORE_DATABASE_FROM_VERIFIED_BACKUP",
    );
    expect(existsSync(preserved)).toBe(true);
    const restored = openMemoryDatabase(path);
    expect((restored.db.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(1);
    expect(new MemoryStore(restored.db).recall(projectID, "before")).toHaveLength(1);
    restored.close();
    const source = new Database(preserved, { readonly: true });
    expect((source.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(2);
    source.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("keeps the live database intact when an active reader blocks the WAL checkpoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-restore-busy-"));
    const path = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(path);
    const store = new MemoryStore(opened.db);
    const projectID = store.createProject("Busy Restore").project!.projectID;
    store.update(projectID, { kind: "fact", title: "before", summary: "before" });
    const backup = createVerifiedBackup(opened.db, path, 9, 9, "test");
    opened.close();

    const reader = new Database(path);
    reader.exec("PRAGMA journal_mode=WAL; BEGIN");
    reader.query("SELECT COUNT(*) FROM notes").get();
    const writer = new Database(path);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    writer
      .query(
        `INSERT INTO notes
          (id, project_id, kind, title, summary, content, size_class, pinned, status,
           current_revision, content_hash, created_at, updated_at)
         VALUES ('busy-note', ?, 'fact', 'after', 'after', '', 'inline', 0, 'active', 1, ?, 1, 1)`,
      )
      .run(projectID, "a".repeat(64));
    writer.close();

    expect(() =>
      restoreVerifiedBackup(backup.manifestPath, path, "RESTORE_DATABASE_FROM_VERIFIED_BACKUP"),
    ).toThrow("WAL checkpoint is busy");
    reader.exec("ROLLBACK");
    reader.close();
    const check = new Database(path, { readonly: true });
    expect((check.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(2);
    check.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("restores a verified backup over an unhealthy target and preserves the corrupt source", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-restore-corrupt-"));
    const path = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(path);
    const store = new MemoryStore(opened.db);
    const projectID = store.createProject("Corrupt Restore").project!.projectID;
    store.update(projectID, { kind: "fact", title: "recoverable", summary: "recoverable" });
    const backup = createVerifiedBackup(opened.db, path, 9, 9, "test");
    opened.close();
    writeFileSync(path, "corrupt-source");

    const preserved = restoreVerifiedBackup(
      backup.manifestPath,
      path,
      "RESTORE_DATABASE_FROM_VERIFIED_BACKUP",
    );
    expect(readFileSync(preserved, "utf8")).toBe("corrupt-source");
    const restored = new Database(path, { readonly: true });
    expect((restored.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(1);
    restored.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("rejects escaped backup files and binds prune confirmation to manifest contents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-prune-"));
    const path = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(path);
    new MemoryStore(opened.db).createProject("Prune");
    const backup = createVerifiedBackup(opened.db, path, 9, 9, "test");
    opened.close();
    const original = JSON.parse(readFileSync(backup.manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      backup.manifestPath,
      `${JSON.stringify({ ...original, databaseFile: "../../victim" }, null, 2)}\n`,
    );
    expect(() => verifyBackupManifest(backup.manifestPath)).toThrow("must be a basename");
    writeFileSync(backup.manifestPath, `${JSON.stringify(original, null, 2)}\n`);

    const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    process.env.OPENCODE_MEMORY_DATABASE_PATH = path;
    try {
      const dryRun = (await runAdmin(["backup", "prune"])) as { digest: string };
      const alternatePath = join(directory, "alternate.sqlite");
      cpSync(`${path}.backup`, `${alternatePath}.backup`, { recursive: true });
      process.env.OPENCODE_MEMORY_DATABASE_PATH = alternatePath;
      const alternate = (await runAdmin(["backup", "prune"])) as { digest: string };
      expect(alternate.digest).not.toBe(dryRun.digest);
      process.env.OPENCODE_MEMORY_DATABASE_PATH = path;
      writeFileSync(
        backup.manifestPath,
        `${JSON.stringify({ ...original, productVersion: "tampered" }, null, 2)}\n`,
      );
      await expect(
        runAdmin([
          "backup",
          "prune",
          "--confirm",
          "DELETE_VERIFIED_BACKUPS",
          "--digest",
          dryRun.digest,
        ]),
      ).rejects.toThrow("digest mismatch");
      expect(existsSync(backup.databasePath)).toBe(true);
      expect(existsSync(backup.manifestPath)).toBe(true);
      writeFileSync(backup.manifestPath, `${JSON.stringify(original, null, 2)}\n`);
      const current = (await runAdmin(["backup", "prune"])) as { digest: string };
      const deleted = (await runAdmin([
        "backup",
        "prune",
        "--confirm",
        "DELETE_VERIFIED_BACKUPS",
        "--digest",
        current.digest,
      ])) as { deleted: number };
      expect(deleted.deleted).toBe(1);
      expect(existsSync(backup.databasePath)).toBe(false);
      expect(existsSync(backup.manifestPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("serializes live migration owners and only breaks a verified stale owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-lock-"));
    const path = join(directory, "memory.sqlite");
    const db = new Database(path, { create: true });
    db.close();
    const first = acquireMigrationLock(path, 9, 20);
    expect(() => acquireMigrationLock(path, 9, 30)).toThrow("migration lock is held");
    expect(() => breakMigrationLock(path, first.owner.ownerID, "BREAK_STALE_MIGRATION_LOCK")).toThrow(
      "is still alive",
    );
    first.release();
    expect(existsSync(migrationLockPath(path))).toBe(false);
    mkdirSync(migrationLockPath(path), { mode: 0o700 });
    expect(() => breakMigrationLock(path, "wrong", "BREAK_STALE_MIGRATION_LOCK")).toThrow(
      "owner mismatch",
    );
    breakMigrationLock(path, "ORPHANED", "BREAK_STALE_MIGRATION_LOCK");
    expect(existsSync(migrationLockPath(path))).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });

  test("does not publish a migration lock when its owner record cannot be staged", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-lock-write-"));
    const path = join(directory, "memory.sqlite");
    chmodSync(directory, 0o500);
    try {
      expect(() => acquireMigrationLock(path, 9, 0)).toThrow();
      expect(existsSync(migrationLockPath(path))).toBe(false);
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { symlinkSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { createVerifiedBackup, restoreVerifiedBackup } from "../../src/db/backup";

describe("database path symlink policy", () => {
  test("rejects a symlink at the canonical database path", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-db-symlink-"));
    const realPath = join(directory, "real.sqlite");
    const linkedPath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(realPath);
    opened.close();
    symlinkSync(realPath, linkedPath, "file");
    let linked: ReturnType<typeof openMemoryDatabase> | undefined;

    try {
      expect(() => {
        linked = openMemoryDatabase(linkedPath);
        return linked;
      }).toThrow(/symbolic|symlink|canonical path/i);
    } finally {
      linked?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a symlink at the backup root", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-backup-symlink-"));
    const databasePath = join(directory, "memory.sqlite");
    const backupRoot = `${databasePath}.backup`;
    const realBackupRoot = join(directory, "real-backup");
    mkdirSync(realBackupRoot);
    const opened = openMemoryDatabase(databasePath);

    try {
      symlinkSync(realBackupRoot, backupRoot, "dir");
      expect(() => createVerifiedBackup(opened.db, databasePath, 11, 11, "test")).toThrow(
        /symbolic|symlink|backup root/i,
      );
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a symlink in an intermediate database directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-parent-symlink-"));
    const realParent = join(directory, "real-parent");
    const linkedParent = join(directory, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent, "dir");

    try {
      expect(() => openMemoryDatabase(join(linkedParent, "memory.sqlite"))).toThrow(
        /symbolic|symlink/i,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a directory masquerading as a SQLite sidecar without deleting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-sidecar-directory-"));
    const databasePath = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(databasePath);
    const backup = createVerifiedBackup(opened.db, databasePath, 11, 11, "test");
    opened.close();
    const sidecar = `${databasePath}-wal`;
    rmSync(sidecar, { force: true });
    mkdirSync(sidecar);

    try {
      expect(() =>
        restoreVerifiedBackup(
          backup.manifestPath,
          databasePath,
          "RESTORE_DATABASE_FROM_VERIFIED_BACKUP",
        ),
      ).toThrow(/sidecar|regular file/i);
      expect(() => mkdirSync(join(sidecar, "still-present"))).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

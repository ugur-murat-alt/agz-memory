import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { createVerifiedBackup, restoreVerifiedBackup } from "../../src/db/backup";
import { MemoryStore } from "../../src/store";

describe("verified restore source identity", () => {
  test("does not install a replacement at a source path after manifest verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-restore-toctou-"));
    const targetPath = join(directory, "memory.sqlite");
    const alternatePath = join(directory, "alternate.sqlite");
    const displacedPath = join(directory, "validated.sqlite");
    const target = openMemoryDatabase(targetPath);
    let targetClosed = false;
    let backup: ReturnType<typeof createVerifiedBackup>;

    try {
      const targetStore = new MemoryStore(target.db);
      const targetProject = targetStore.createProject("Original").project!.projectID;
      targetStore.update(targetProject, {
        kind: "fact",
        title: "original",
        summary: "original",
        content: "original",
      });
      backup = createVerifiedBackup(target.db, targetPath, 11, 11, "test");
      target.close();
      targetClosed = true;

      const alternate = openMemoryDatabase(alternatePath);
      const alternateStore = new MemoryStore(alternate.db);
      const alternateProject = alternateStore.createProject("Replacement").project!.projectID;
      alternateStore.update(alternateProject, {
        kind: "fact",
        title: "replacement",
        summary: "replacement",
        content: "replacement",
      });
      alternate.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      alternate.close();

      let swapped = false;
      const originalParse = JSON.parse;
      let hashReads = 0;
      const swapSource = () => {
        if (swapped) return;
        swapped = true;
        renameSync(backup.databasePath, displacedPath);
        renameSync(alternatePath, backup.databasePath);
      };
      JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
        const parsed = originalParse(text, reviver) as unknown;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          (parsed as { format?: unknown }).format !== "agz-memory-backup/1"
        ) {
          return parsed;
        }
        return new Proxy(parsed as Record<string, unknown>, {
          get(targetObject, property, receiver) {
            if (property === "sha256" && ++hashReads === 3) swapSource();
            return Reflect.get(targetObject, property, receiver);
          },
        });
      }) as typeof JSON.parse;

      try {
        try {
          restoreVerifiedBackup(
            backup.manifestPath,
            targetPath,
            "RESTORE_DATABASE_FROM_VERIFIED_BACKUP",
          );
        } catch {
          // Rejecting a replaced source is safe; the target assertion below covers both safe outcomes.
        }
      } finally {
        JSON.parse = originalParse;
      }

      expect(swapped).toBe(true);
      const installed = new Database(targetPath, { readonly: true });
      try {
        expect(installed.query("SELECT title FROM notes").get()).toEqual({ title: "original" });
      } finally {
        installed.close();
      }
    } finally {
      if (!targetClosed) target.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

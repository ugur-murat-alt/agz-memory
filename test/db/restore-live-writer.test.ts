import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { createVerifiedBackup, restoreVerifiedBackup } from "../../src/db/backup";
import { MemoryStore } from "../../src/store";

describe("restore maintenance gate", () => {
  test("refuses restore while an openMemoryDatabase handle is live", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-restore-live-"));
    const path = join(directory, "memory.sqlite");
    const seeded = openMemoryDatabase(path);
    const store = new MemoryStore(seeded.db);
    const projectID = store.createProject("Live writer").project!.projectID;
    store.update(projectID, { operation: "create", kind: "fact", title: "before", summary: "before" });
    const backup = createVerifiedBackup(seeded.db, path, 11, 11, "test");
    seeded.close();
    const opened = openMemoryDatabase(path);

    try {
      new MemoryStore(opened.db).update(projectID, { operation: "create", kind: "fact", title: "after", summary: "after" });

      expect(() =>
        restoreVerifiedBackup(
          backup.manifestPath,
          path,
          "RESTORE_DATABASE_FROM_VERIFIED_BACKUP",
        ),
      ).toThrow(/active[_ ]database[_ ]handles|maintenance gate/i);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

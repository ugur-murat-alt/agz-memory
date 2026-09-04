import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runAdmin } from "../../src/admin";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";

describe("admin strict database boundary", () => {
  test("rejects malformed arguments and an incorrect identity before reindex mutation", async () => {
      const fixture = setup();
    try {
      fixture.opened.close();
      await expect(runAdmin(["reindex", "--backend", "test", "--backend", "other"])).rejects.toThrow("duplicate");
      await expect(runAdmin(["reindex", "--backend", "test", "--unknown", "x"])).rejects.toThrow("invalid");
      await expect(runAdmin(["reindex", "--backend", "test", "--database-id", "wrong"])).rejects.toThrow("database id mismatch");
      const inspected = openMemoryDatabase(fixture.path);
      try {
        expect(inspected.db.query("SELECT COUNT(*) AS count FROM index_outbox").get()).toMatchObject({ count: 0 });
      } finally { inspected.close(); }
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a configured symlink without opening or mutating its target", async () => {
    if (process.platform === "win32") return;
    const fixture = setup();
    const link = join(fixture.directory, "link.sqlite");
    symlinkSync(fixture.path, link);
    const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    process.env.OPENCODE_MEMORY_DATABASE_PATH = link;
    try {
      fixture.opened.close();
      await expect(runAdmin(["doctor"])).rejects.toThrow("regular file");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
      fixture.cleanup();
    }
  });

  test("manual dead retry resets only the retry budget and reports canonical identity", async () => {
    const fixture = setup();
    try {
      const now = Date.now();
      fixture.opened.db.query(
        `INSERT INTO index_outbox (backend, operation_key, operation, project_id, note_id, revision, content_hash,
          generation, lease_generation, fence, state, attempt_count, available_at, created_at, completed_at)
         VALUES ('test', ?, 'purge-project', ?, NULL, NULL, NULL, 1, 4, 7, 'dead', 10, ?, ?, ?)`,
      ).run("a".repeat(64), fixture.projectID, now, now, now);
      fixture.opened.close();
      const result = await runAdmin(["outbox", "retry", "1", "--database-id", fixture.databaseID]) as {
        retried: boolean; databasePath: string; databaseID: string;
      };
      expect(result).toMatchObject({ retried: true, databaseID: fixture.databaseID, databasePath: fixture.path });
      const inspected = openMemoryDatabase(fixture.path);
      try {
        expect(inspected.db.query("SELECT state, attempt_count, lease_generation, fence FROM index_outbox WHERE id = 1").get())
          .toMatchObject({ state: "pending", attempt_count: 0, lease_generation: 4, fence: 7 });
      } finally { inspected.close(); }
    } finally {
      fixture.cleanup();
    }
  });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-admin-parser-"));
  const path = join(directory, "memory.sqlite");
  const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
  process.env.OPENCODE_MEMORY_DATABASE_PATH = path;
  const opened = openMemoryDatabase(path);
  const projectID = new MemoryStore(opened.db).createProject("Admin parser").project!.projectID;
  const databaseID = (opened.db.query("SELECT database_id FROM agz_meta WHERE id = 1").get() as { database_id: string }).database_id;
  return {
    directory, path, opened, projectID, databaseID,
    cleanup() {
      opened.close();
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

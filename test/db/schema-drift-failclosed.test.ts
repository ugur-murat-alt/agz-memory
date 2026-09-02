import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";

describe("schema fingerprint validation", () => {
  test("fails closed when a known trigger has changed under the same name", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-schema-drift-"));
    const path = join(directory, "memory.sqlite");
    const opened = openMemoryDatabase(path);
    new MemoryStore(opened.db).createProject("Schema drift");
    opened.close();

    const altered = new Database(path);
    altered.exec("DROP TRIGGER notes_fts_ai; CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN SELECT 1; END;");
    altered.close();
    let reopened: ReturnType<typeof openMemoryDatabase> | undefined;

    try {
      expect(() => {
        reopened = openMemoryDatabase(path);
        return reopened;
      }).toThrow("schema_fingerprint_mismatch");
      const unchanged = new Database(path, { readonly: true });
      try {
        expect(
          (unchanged.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'notes_fts_ai'").get() as { sql: string }).sql,
        ).toContain("SELECT 1");
      } finally {
        unchanged.close();
      }
    } finally {
      reopened?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";

describe("database identity", () => {
  test("rejects an unrelated nonempty SQLite database on normal open", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-unrecognized-"));
    const path = join(directory, "unrelated.sqlite");
    const database = new Database(path, { create: true });
    database.exec("CREATE TABLE unrelated (value TEXT NOT NULL); INSERT INTO unrelated VALUES ('keep');");
    database.close();
    let opened: ReturnType<typeof openMemoryDatabase> | undefined;

    try {
      expect(() => {
        opened = openMemoryDatabase(path);
        return opened;
      }).toThrow("unrecognized_database");
      const unchanged = new Database(path, { readonly: true });
      try {
        expect(unchanged.query("SELECT value FROM unrelated").get()).toEqual({ value: "keep" });
      } finally {
        unchanged.close();
      }
    } finally {
      opened?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

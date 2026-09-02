import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { doctorDatabase } from "../../src/admin/doctor";
import { assertSchemaV11 } from "../../src/db/health";
import { schemaFingerprint } from "../../src/db/schema";
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
        expect(doctorDatabase(unchanged)).toMatchObject({
          ok: false,
          failures: expect.arrayContaining(["schema_fingerprint_mismatch"]),
        });
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

  test("ignores SQLite-version-specific FTS shadow table DDL rendering", () => {
    const first = new Database(":memory:");
    const second = new Database(":memory:");
    try {
      first.exec("CREATE TABLE notes_fts_data(id INTEGER PRIMARY KEY, block BLOB)");
      second.exec("CREATE TABLE notes_fts_data ( id INTEGER PRIMARY KEY, block BLOB )");
      expect(schemaFingerprint(first)).toBe(schemaFingerprint(second));
    } finally {
      first.close();
      second.close();
    }
  });

  test("preserves a busy signal from schema identity checks for bounded retry", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const db = {
      query(sql: string) {
        if (sql.includes("sqlite_master")) return { get: () => ({ count: 1 }) };
        return { get: () => { throw busy; } };
      },
    } as unknown as Database;
    let thrown: unknown;
    try {
      assertSchemaV11(db);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(busy);
  });
});

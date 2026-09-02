import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
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

  test("rejects a future schema without changing its bytes, mode, or journal policy", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-future-"));
    const path = join(directory, "future.sqlite");
    const database = new Database(path, { create: true });
    database.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE schema_state (version INTEGER PRIMARY KEY); INSERT INTO schema_state VALUES (99);",
    );
    database.close();
    chmodSync(path, 0o640);
    const beforeHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const beforeMode = statSync(path).mode & 0o777;

    try {
      expect(() => openMemoryDatabase(path)).toThrow(
        "database schema v99 is newer than supported v11",
      );
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(beforeHash);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(beforeMode);
      const unchanged = new Database(path, { readonly: true });
      try {
        expect(unchanged.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      } finally {
        unchanged.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    test(`rejects a foreign database claiming schema ${version} without side effects`, () => {
      const directory = mkdtempSync(join(tmpdir(), `agz-memory-foreign-v${version}-`));
      const path = join(directory, "foreign.sqlite");
      const database = new Database(path, { create: true });
      database.exec(
        `PRAGMA journal_mode=DELETE;
         CREATE TABLE schema_state (version INTEGER PRIMARY KEY);
         INSERT INTO schema_state VALUES (${version});
         CREATE TABLE unrelated (value TEXT NOT NULL);
         INSERT INTO unrelated VALUES ('keep');`,
      );
      database.close();
      chmodSync(path, 0o640);
      const beforeHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      const beforeMode = statSync(path).mode & 0o777;

      try {
        expect(() => openMemoryDatabase(path)).toThrow("unrecognized_database");
        expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(beforeHash);
        if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(beforeMode);
        const unchanged = new Database(path, { readonly: true });
        try {
          expect(unchanged.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
          expect(unchanged.query("SELECT value FROM unrelated").get()).toEqual({ value: "keep" });
        } finally {
          unchanged.close();
        }
        for (const artifact of [
          `${path}.leases`,
          `${path}.maintenance`,
          `${path}.migration.lock`,
          `${path}.backup`,
        ]) {
          expect(existsSync(artifact)).toBe(false);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("rejects a schema-less database that only mimics the legacy v2 root table", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-foreign-v2-root-"));
    const path = join(directory, "foreign.sqlite");
    const database = new Database(path, { create: true });
    database.exec(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, subject_key TEXT NOT NULL,
        kind TEXT NOT NULL, lifecycle_state TEXT NOT NULL, current_version_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    database.close();
    const beforeHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    try {
      expect(() => openMemoryDatabase(path)).toThrow("unrecognized_database");
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(beforeHash);
      expect(existsSync(`${path}.backup`)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

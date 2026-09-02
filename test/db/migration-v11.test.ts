import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const PROVENANCE_ID = "33333333-3333-4333-8333-333333333333";

describe("schema v11 migration", () => {
  test("opens schema v10 data as v11 without losing the project or note", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-v10-v11-"));
    const path = join(directory, "memory.sqlite");
    await createV10Fixture(path);

    try {
      const opened = openMemoryDatabase(path);
      try {
        expect(opened.db.query("SELECT version FROM schema_state").all()).toEqual([{ version: 11 }]);
        expect(
          opened.db
            .query("SELECT project_id, id, title, content FROM notes WHERE project_id = ? AND id = ?")
            .get(PROJECT_ID, NOTE_ID),
        ).toEqual({
          project_id: PROJECT_ID,
          id: NOTE_ID,
          title: "preserved",
          content: "preserved content",
        });
      } finally {
        opened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function createV10Fixture(path: string): Promise<void> {
  const schema = await Bun.file(join(import.meta.dir, "../fixtures/schema-v10.sql")).text();
  const hash = createHash("sha256")
    .update("fact\0preserved\0preserved summary\0preserved content", "utf8")
    .digest("hex");
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    db.exec(schema);
    db.query("INSERT INTO projects VALUES (?, 'Preserve v10', 'preserve v10', 1, 1)").run(PROJECT_ID);
    db.query(`
      INSERT INTO notes
        (id, project_id, kind, title, summary, content, size_class, pinned, status,
         supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
      VALUES (?, ?, 'fact', 'preserved', 'preserved summary', 'preserved content',
              'inline', 0, 'active', NULL, 1, NULL, ?, 1, 1)
    `).run(NOTE_ID, PROJECT_ID, hash);
    db.query(`
      INSERT INTO note_provenance (id, project_id, note_id, source_type, created_at)
      VALUES (?, ?, ?, 'mcp-manual', 1)
    `).run(PROVENANCE_ID, PROJECT_ID, NOTE_ID);
    db.query(`
      INSERT INTO note_revisions
        (project_id, note_id, revision, kind, title, summary, content, size_class,
         pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at)
      VALUES (?, ?, 1, 'fact', 'preserved', 'preserved summary', 'preserved content',
              'inline', 0, 'active', NULL, NULL, ?, ?, 1)
    `).run(PROJECT_ID, NOTE_ID, hash, PROVENANCE_ID);
    expect(db.query("SELECT version FROM schema_state").get()).toEqual({ version: 10 });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

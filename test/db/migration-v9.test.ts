import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { doctorDatabase } from "../../src/admin/doctor";
import { noteContentHash } from "../../src/hash";

describe("schema migration", () => {
  test("preserves v8 rows and creates schema v11 revision, provenance, FTS, and backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-v8-v10-"));
    const path = join(directory, "memory.sqlite");
    createV8Database(path);

    const opened = openMemoryDatabase(path);
    expect(opened.db.query("SELECT version FROM schema_state").all()).toEqual([{ version: 11 }]);
    expect(
      opened.db
        .query(
          "SELECT id, project_id, pinned, status, created_at, updated_at, current_revision FROM notes ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "note-a",
        project_id: "11111111-1111-4111-8111-111111111111",
        pinned: 1,
        status: "active",
        created_at: 10,
        updated_at: 20,
        current_revision: 1,
      },
      {
        id: "note-b",
        project_id: "11111111-1111-4111-8111-111111111111",
        pinned: 0,
        status: "superseded",
        created_at: 11,
        updated_at: 21,
        current_revision: 1,
      },
    ]);
    expect(
      (
        opened.db
          .query("SELECT content_hash FROM notes WHERE id = 'note-a'")
          .get() as { content_hash: string }
      ).content_hash,
    ).toBe(noteContentHash("fact", "Alpha", "Alpha summary", "Alpha content"));
    expect(count(opened.db, "note_revisions")).toBe(2);
    expect(count(opened.db, "note_provenance")).toBe(2);
    expect(count(opened.db, "notes_fts")).toBe(2);
    expect(count(opened.db, "note_edges")).toBe(1);
    expect(doctorDatabase(opened.db).ok).toBe(true);

    opened.db.query("UPDATE notes SET title = 'Gamma' WHERE id = 'note-a'").run();
    expect(
      (
        opened.db
          .query("SELECT COUNT(*) AS count FROM notes_fts WHERE notes_fts MATCH 'Gamma'")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    opened.db.query("DELETE FROM notes WHERE id = 'note-b'").run();
    expect(count(opened.db, "notes_fts")).toBe(1);
    opened.close();

    const backupDirectory = `${path}.backup`;
    const manifestsBefore = readdirSync(backupDirectory).filter((name) => name.endsWith(".manifest.json"));
    const reopened = openMemoryDatabase(path);
    reopened.close();
    expect(readdirSync(backupDirectory).filter((name) => name.endsWith(".manifest.json"))).toEqual(
      manifestsBefore,
    );
    rmSync(directory, { recursive: true, force: true });
  });
});

function createV8Database(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL,
      size_class TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      supersedes_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(project_id, id)
    );
    CREATE TABLE note_edges (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL, target_id TEXT NOT NULL, predicate TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(project_id, source_id, target_id, predicate),
      FOREIGN KEY (project_id, source_id) REFERENCES notes(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, target_id) REFERENCES notes(project_id, id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, summary, content, tokenize='unicode61');
    CREATE TABLE schema_state (version INTEGER PRIMARY KEY);
    INSERT INTO schema_state VALUES (8);
    INSERT INTO projects VALUES ('11111111-1111-4111-8111-111111111111', 'Alpha', 'alpha', 1, 2);
    INSERT INTO notes VALUES (
      'note-a', '11111111-1111-4111-8111-111111111111', 'fact', 'Alpha',
      'Alpha summary', 'Alpha content', 'inline', 1, 'active', NULL, 10, 20
    );
    INSERT INTO notes VALUES (
      'note-b', '11111111-1111-4111-8111-111111111111', 'fact', 'Beta',
      'Beta summary', 'Beta content', 'inline', 0, 'superseded', NULL, 11, 21
    );
    INSERT INTO note_edges VALUES (
      'edge-a', '11111111-1111-4111-8111-111111111111', 'note-a', 'note-b', 'ABOUT', 30
    );
    INSERT INTO notes_fts VALUES ('note-a', 'Alpha', 'Alpha summary', 'Alpha content');
    INSERT INTO notes_fts VALUES ('note-b', 'Beta', 'Beta summary', 'Beta content');
  `);
  db.close();
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

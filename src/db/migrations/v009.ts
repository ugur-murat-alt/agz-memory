import { createHash, randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { FTS_V9, SCHEMA_V9_TABLES, rebuildFts } from "../schema";

interface LegacyNoteRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  size_class: string;
  pinned: number;
  status: string;
  supersedes_id: string | null;
  created_at: number;
  updated_at: number;
}

export function migrateV8ToV9(db: Database): void {
  const notes = db.query("SELECT * FROM notes ORDER BY rowid").all() as LegacyNoteRow[];
  db.exec(`
    DROP TABLE IF EXISTS capture_checkpoints;
    DROP TABLE IF EXISTS capture_events;
    DROP TABLE IF EXISTS project_bindings;
    DROP TABLE IF EXISTS note_revisions;
    DROP TABLE IF EXISTS note_provenance;
    DROP TABLE IF EXISTS index_outbox;
    DROP TABLE IF EXISTS note_edges_v9;
    DROP TABLE IF EXISTS notes_v9;
  `);
  db.exec(`
    CREATE TABLE notes_v9 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('decision','fact','procedure','context','research','preference','task')),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      size_class TEXT NOT NULL CHECK (size_class IN ('inline','indexed')),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
      supersedes_id TEXT,
      current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
      subject_key TEXT,
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, id)
    );
    CREATE TABLE note_edges_v9 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      predicate TEXT NOT NULL CHECK (predicate IN ('SUPPORTS','DERIVED_FROM','PART_OF','ABOUT','PRECEDES','SUPERSEDES')),
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, source_id, target_id, predicate),
      FOREIGN KEY (project_id, source_id) REFERENCES notes_v9(project_id, id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, target_id) REFERENCES notes_v9(project_id, id) ON DELETE CASCADE
    );
    INSERT INTO note_edges_v9 SELECT * FROM note_edges;
  `);
  const insert = db.query(`
    INSERT INTO notes_v9
      (id, project_id, kind, title, summary, content, size_class, pinned, status,
       supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
  `);
  const hashes = new Map<string, string>();
  for (const note of notes) {
    const hash = noteContentHash(note.kind, note.title, note.summary, note.content);
    hashes.set(note.id, hash);
    insert.run(
      note.id,
      note.project_id,
      note.kind,
      note.title,
      note.summary,
      note.content,
      note.size_class,
      note.pinned,
      note.status,
      note.supersedes_id,
      hash,
      note.created_at,
      note.updated_at,
    );
  }

  db.exec(`
    DROP TRIGGER IF EXISTS notes_fts_ai;
    DROP TRIGGER IF EXISTS notes_fts_ad;
    DROP TRIGGER IF EXISTS notes_fts_au;
    DROP TABLE IF EXISTS notes_fts;
    DROP TABLE note_edges;
    DROP TABLE notes;
    ALTER TABLE notes_v9 RENAME TO notes;
    ALTER TABLE note_edges_v9 RENAME TO note_edges;
  `);
  db.exec(SCHEMA_V9_TABLES);
  for (const note of notes) {
    const provenanceID = randomUUID();
    db.query(`
      INSERT INTO note_provenance
        (id, project_id, note_id, source_type, created_at)
      VALUES (?, ?, ?, 'migration', ?)
    `).run(provenanceID, note.project_id, note.id, note.updated_at);
    db.query(`
      INSERT INTO note_revisions
        (project_id, note_id, revision, kind, title, summary, content, size_class,
         pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      note.project_id,
      note.id,
      note.kind,
      note.title,
      note.summary,
      note.content,
      note.size_class,
      note.pinned,
      note.status,
      note.supersedes_id,
      hashes.get(note.id)!,
      provenanceID,
      note.updated_at,
    );
  }
  db.exec(FTS_V9);
  rebuildFts(db);
  db.query("DELETE FROM schema_state").run();
  db.query("INSERT INTO schema_state(version) VALUES (9)").run();
}

export function noteContentHash(kind: string, title: string, summary: string, content: string): string {
  return createHash("sha256")
    .update(`${kind}\0${title}\0${summary}\0${content}`, "utf8")
    .digest("hex");
}

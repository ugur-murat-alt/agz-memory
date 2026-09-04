import { Database } from "bun:sqlite";

export function createDataBearingLegacyV2(path: string, options: { brokenForeignKey?: boolean } = {}): void {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES memory_identities(id), subject_key TEXT NOT NULL,
      kind TEXT NOT NULL, lifecycle_state TEXT NOT NULL, current_version_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_versions (id TEXT PRIMARY KEY, summary TEXT, content TEXT);
    CREATE TABLE memory_identities (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE document_sources (id TEXT PRIMARY KEY, project_root TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, status TEXT);
    CREATE TABLE document_chunks (source_id TEXT, memory_id TEXT);
    CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT);
    INSERT INTO memory_identities VALUES ('identity-1', 'legacy-project');
    INSERT INTO memory_versions VALUES ('version-1', 'legacy summary', 'legacy content');
    INSERT INTO memory_items VALUES ('research-source-1', '${options.brokenForeignKey ? "missing-identity" : "identity-1"}', 'legacy title', 'fact', 'active', 'version-1', 1, 2);
    INSERT INTO document_sources VALUES ('source-1', NULL, 'legacy document', 1, 2, 'active');
    INSERT INTO document_chunks VALUES ('source-1', 'memory-1');
    INSERT INTO memories VALUES ('memory-1', 'document content');
  `);
  db.close();
}

import type { Database } from "bun:sqlite";

export interface DatabaseHealth {
  integrity: string;
  foreignKeyViolations: unknown[];
  schemaVersion?: number;
  counts: Record<string, number>;
}

export function inspectDatabase(db: Database): DatabaseHealth {
  const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string })
    .integrity_check;
  const foreignKeyViolations = db.query("PRAGMA foreign_key_check").all();
  const schemaVersion = hasTable(db, "schema_state")
    ? (db.query("SELECT MAX(version) AS version FROM schema_state").get() as {
        version: number | null;
      }).version ?? undefined
    : undefined;
  const counts: Record<string, number> = {};
  for (const table of [
    "projects",
    "notes",
    "note_edges",
    "notes_fts",
    "project_bindings",
    "capture_events",
    "capture_checkpoints",
    "note_provenance",
    "note_revisions",
    "index_outbox",
  ]) {
    if (!hasTable(db, table)) continue;
    counts[table] = (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }).count;
  }
  return { integrity, foreignKeyViolations, schemaVersion, counts };
}

export function assertHealthyDatabase(db: Database): DatabaseHealth {
  const health = inspectDatabase(db);
  if (health.integrity !== "ok") {
    throw new Error(`database integrity check failed: ${health.integrity}`);
  }
  if (health.foreignKeyViolations.length > 0) {
    throw new Error(`database foreign key check failed: ${health.foreignKeyViolations.length} violation(s)`);
  }
  return health;
}

export function hasTable(db: Database, table: string): boolean {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(table) as { count: number };
  return row.count > 0;
}

export function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (row) => row.name === column,
  );
}

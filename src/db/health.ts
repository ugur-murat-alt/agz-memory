import type { Database } from "bun:sqlite";
import {
  APPLICATION_ID,
  HASH_POLICY,
  PRODUCT_ID,
  expectedSchemaFingerprint,
  schemaFingerprint,
} from "./schema";

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
  if (health.schemaVersion === 11) assertSchemaV11(db);
  return health;
}

export function assertSchemaV11(db: Database): void {
  try {
    if (!hasTable(db, "agz_meta")) throw new Error("missing metadata table");
    const applicationID = (db.query("PRAGMA application_id").get() as { application_id: number })
      .application_id;
    if (applicationID !== APPLICATION_ID) throw new Error("application id mismatch");

    const states = db.query("SELECT version FROM schema_state").all() as Array<{ version: number }>;
    if (states.length !== 1 || states[0]?.version !== 11) throw new Error("schema state mismatch");

    const metadata = db
      .query(
        `SELECT id, database_id, product_id, schema_version, schema_fingerprint, hash_policy, created_at
           FROM agz_meta`,
      )
      .all() as Array<{
      id: number;
      database_id: string;
      product_id: string;
      schema_version: number;
      schema_fingerprint: string;
      hash_policy: string;
      created_at: number;
    }>;
    if (metadata.length !== 1) throw new Error("metadata cardinality mismatch");
    const [meta] = metadata;
    if (
      !meta ||
      meta.id !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meta.database_id) ||
      meta.product_id !== PRODUCT_ID ||
      meta.schema_version !== 11 ||
      meta.hash_policy !== HASH_POLICY ||
      !/^[0-9a-f]{64}$/.test(meta.schema_fingerprint) ||
      !Number.isSafeInteger(meta.created_at) ||
      meta.created_at < 0
    ) {
      throw new Error("metadata value mismatch");
    }

    const expected = expectedSchemaFingerprint();
    if (meta.schema_fingerprint !== expected || schemaFingerprint(db) !== expected) {
      throw new Error("schema fingerprint mismatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "schema_fingerprint_mismatch") throw error;
    throw new Error("schema_fingerprint_mismatch");
  }
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

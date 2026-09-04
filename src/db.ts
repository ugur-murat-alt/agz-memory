import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, lstatSync } from "fs";
import { hashRoot } from "./identity";
import { normalizeProjectName } from "./project";
import { PREDICATES, SCHEMA_VERSION } from "./types";
import { createVerifiedBackup, restoreVerifiedBackup, type VerifiedBackup } from "./db/backup";
import { assertHealthyDatabase, assertSchemaV11, isSQLiteBusyError } from "./db/health";
import { assertLegacySchemaIdentity } from "./db/legacy-health";
import { acquireMigrationLock, type MigrationLock } from "./db/migration-lock";
import {
  acquireDatabaseLease,
  acquireMaintenanceGate,
  ensureDatabaseParent,
  recoverStaleMaintenanceGate,
  type DatabaseLease,
  type MaintenanceGate,
} from "./db/maintenance";
import { migrateV8ToV9 } from "./db/migrations/v009";
import { migrateV9ToV10 } from "./db/migrations/v010";
import { migrateV10ToV11 } from "./db/migrations/v011";
import { APPLICATION_ID, createSchemaV11 } from "./db/schema";
import { PRODUCT_VERSION } from "./version";

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, id)
);
CREATE INDEX IF NOT EXISTS notes_project_idx ON notes(project_id, status);
CREATE TABLE IF NOT EXISTS note_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  predicate TEXT NOT NULL CHECK (predicate IN ('SUPPORTS','DERIVED_FROM','PART_OF','ABOUT','PRECEDES','SUPERSEDES')),
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, source_id, target_id, predicate),
  FOREIGN KEY (project_id, source_id) REFERENCES notes(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_id) REFERENCES notes(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS note_edges_source_idx ON note_edges(project_id, source_id);
CREATE INDEX IF NOT EXISTS note_edges_target_idx ON note_edges(project_id, target_id);
CREATE TABLE IF NOT EXISTS schema_state (version INTEGER PRIMARY KEY);
`;

// Pre-open validation can overlap a just-created SQLite schema on Windows. Keep
// retries confined to this read-only probe; the post-lock probe remains authoritative.
const PRE_OPEN_PROBE_TIMEOUT_MS = 5_000;

export interface OpenedDB {
  db: Database;
  close: () => void;
}

export type MigrationStage =
  | "source-validation"
  | "backup-checkpoint"
  | "v2-import"
  | "v8-to-v9"
  | "v9-to-v10"
  | "v10-to-v11"
  | "fingerprint"
  | "deep-health";

export interface MigrationTiming {
  phases: Array<{ stage: MigrationStage; elapsedMs: number }>;
}

export function createMigrationTimingCollector(): MigrationTiming {
  return { phases: [] };
}

function timeMigrationStage<T>(timing: MigrationTiming | undefined, stage: MigrationStage, work: () => T): T {
  if (!timing) return work();
  const started = performance.now();
  try {
    return work();
  } finally {
    timing.phases.push({ stage, elapsedMs: Math.round((performance.now() - started) * 1000) / 1000 });
  }
}

export function openMemoryDatabase(path: string, options: { timing?: MigrationTiming } = {}): OpenedDB {
  ensureDatabaseParent(path);
  assertSupportedDatabaseBeforeOpen(path, false);
  recoverStaleMaintenanceGate(path, () => assertSupportedDatabaseBeforeOpen(path));
  let lock: MigrationLock | undefined = acquireMigrationLock(path, SCHEMA_VERSION);
  let lease: DatabaseLease | undefined = acquireDatabaseLease(path);
  let db: Database;
  try {
    assertSupportedDatabaseBeforeOpen(path, false);
    db = openDatabase(path);
  } catch (error) {
    lease.release();
    lock.release();
    throw error;
  }
  let dbOpen = true;
  let maintenance: MaintenanceGate | undefined;
  let backup: VerifiedBackup | undefined;
  try {
    const existingVersion = getSchemaVersion(db);
    if (existingVersion && existingVersion.version > SCHEMA_VERSION) {
      throw new Error(
        `database schema v${existingVersion.version} is newer than supported v${SCHEMA_VERSION}`,
      );
    }

    const hasObjects = hasApplicationObjects(db);
    if (!hasObjects) {
      db.close();
      dbOpen = false;
      lease.release();
      lease = undefined;
      lease = acquireDatabaseLease(path);
      assertSupportedDatabaseBeforeOpen(path, false);
      db = openDatabase(path);
      dbOpen = true;
      if (hasApplicationObjects(db)) {
        const initializedVersion = getSchemaVersion(db);
        if (initializedVersion?.version !== SCHEMA_VERSION) {
          throw new Error("database changed during initialization");
        }
        db.exec("PRAGMA foreign_keys=ON");
        assertHealthyDatabase(db);
        lock.release();
        lock = undefined;
        const opened = openedWithLease(db, lease);
        lease = undefined;
        return opened;
      }
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      db.transaction(() => createSchemaV11(db))();
      assertHealthyDatabase(db);
      lock.release();
      lock = undefined;
      const opened = openedWithLease(db, lease);
      lease = undefined;
      return opened;
    }

    const hasV11Marker = hasV11IdentityMarker(db);
    if (!existingVersion && hasV11Marker) {
      assertSchemaV11(db);
    }
    if (existingVersion && existingVersion.version < SCHEMA_VERSION && hasV11Marker) {
      assertSchemaV11(db);
    }
    if (!existingVersion && !hasLegacyV2(db)) throw new Error("unrecognized_database");

    if (existingVersion?.version === SCHEMA_VERSION) {
      db.exec("PRAGMA foreign_keys=ON");
      assertHealthyDatabase(db);
      lock.release();
      lock = undefined;
      const opened = openedWithLease(db, lease);
      lease = undefined;
      return opened;
    }

    if ((existingVersion?.version ?? 0) < SCHEMA_VERSION) {
      db.close();
      dbOpen = false;
      lease.release();
      lease = undefined;
      lease = acquireDatabaseLease(path);
      assertSupportedDatabaseBeforeOpen(path, false);
      db = openDatabase(path);
      dbOpen = true;
      let migrationVersion = getSchemaVersion(db);
      if (migrationVersion && migrationVersion.version > SCHEMA_VERSION) {
        throw new Error(
          `database schema v${migrationVersion.version} is newer than supported v${SCHEMA_VERSION}`,
        );
      }
      if (!migrationVersion && hasV11IdentityMarker(db)) assertSchemaV11(db);
      if (migrationVersion && migrationVersion.version < SCHEMA_VERSION && hasV11IdentityMarker(db)) {
        assertSchemaV11(db);
      }
      if (!migrationVersion && !hasLegacyV2(db)) throw new Error("unrecognized_database");
      if ((migrationVersion?.version ?? 0) === SCHEMA_VERSION) {
        db.exec("PRAGMA foreign_keys=ON");
        assertHealthyDatabase(db);
        lock.release();
        lock = undefined;
        const opened = openedWithLease(db, lease);
        lease = undefined;
        return opened;
      }
      db.close();
      dbOpen = false;
      lease.release();
      lease = undefined;

      maintenance = acquireMaintenanceGate(path);
      timeMigrationStage(options.timing, "source-validation", () => assertSupportedDatabaseBeforeOpen(path, false));
      db = openDatabase(path);
      dbOpen = true;
      migrationVersion = getSchemaVersion(db);
      if (migrationVersion && migrationVersion.version > SCHEMA_VERSION) {
        throw new Error(
          `database schema v${migrationVersion.version} is newer than supported v${SCHEMA_VERSION}`,
        );
      }
      if (!migrationVersion && hasV11IdentityMarker(db)) assertSchemaV11(db);
      if (migrationVersion && migrationVersion.version < SCHEMA_VERSION && hasV11IdentityMarker(db)) {
        assertSchemaV11(db);
      }
      if (!migrationVersion && !hasLegacyV2(db)) throw new Error("unrecognized_database");
      if ((migrationVersion?.version ?? 0) === SCHEMA_VERSION) {
        db.close();
        dbOpen = false;
        const handoff = handoffMaintenanceToLease(path, maintenance);
        maintenance = undefined;
        db = handoff.db;
        dbOpen = true;
        lease = handoff.lease;
        db.exec("PRAGMA foreign_keys=ON");
        assertHealthyDatabase(db);
        lock.release();
        lock = undefined;
        const opened = openedWithLease(db, lease);
        lease = undefined;
        return opened;
      }
      backup = timeMigrationStage(options.timing, "backup-checkpoint", () =>
        createVerifiedBackup(db, path, migrationVersion?.version ?? 2, SCHEMA_VERSION, PRODUCT_VERSION),
      );
      db.exec("PRAGMA foreign_keys=OFF");
      if (!migrationVersion && hasLegacyV2(db)) {
        db.exec(DDL);
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, summary, content, tokenize='unicode61')");
        timeMigrationStage(options.timing, "v2-import", () => migrateFromV2(db, path));
      } else if (!migrationVersion) {
        db.exec(DDL);
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, summary, content, tokenize='unicode61')");
        db.transaction(() => {
          adoptLegacyProjectIDs(db);
          db.query("DELETE FROM schema_state").run();
          db.query("INSERT INTO schema_state (version) VALUES (8)").run();
        })();
      } else if (migrationVersion.version < 8) {
        db.exec(DDL);
        db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, summary, content, tokenize='unicode61')");
        migrateToV8(db);
      }

      let version = getSchemaVersion(db)?.version ?? 8;
      if (version < 9) {
        timeMigrationStage(options.timing, "v8-to-v9", () =>
          db.transaction(() => migrateV8ToV9(db))(),
        );
        version = 9;
      }
      if (version < 10) {
        timeMigrationStage(options.timing, "v9-to-v10", () =>
          db.transaction(() => migrateV9ToV10(db))(),
        );
        version = 10;
      }
      if (version < SCHEMA_VERSION) {
        timeMigrationStage(options.timing, "v10-to-v11", () =>
          db.transaction(() => {
            db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
            migrateV10ToV11(db);
          })(),
        );
      }
      db.exec("PRAGMA foreign_keys=ON");
      if ((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys !== 1) {
        throw new Error("failed to enable database foreign keys");
      }
      timeMigrationStage(options.timing, "fingerprint", () => assertSchemaV11(db));
      timeMigrationStage(options.timing, "deep-health", () =>
        assertHealthyDatabase(db, { verifySchema: false }),
      );
      console.warn(
        `[agz-memory] migrated to v${SCHEMA_VERSION} (backup: ${backup.manifestPath})`,
      );
      backup = undefined;
      db.close();
      dbOpen = false;
      const handoff = handoffMaintenanceToLease(path, maintenance);
      maintenance = undefined;
      db = handoff.db;
      dbOpen = true;
      lease = handoff.lease;
      db.exec("PRAGMA foreign_keys=ON");
      assertHealthyDatabase(db);
      lock.release();
      lock = undefined;
      const opened = openedWithLease(db, lease);
      lease = undefined;
      return opened;
    }

    db.exec("PRAGMA foreign_keys=ON");
    assertHealthyDatabase(db);
    db.exec("PRAGMA foreign_keys=ON");
    lock.release();
    lock = undefined;
    const opened = openedWithLease(db, lease);
    lease = undefined;
    return opened;
  } catch (error) {
    if (dbOpen) db.close();
    if (backup) {
      try {
        restoreVerifiedBackup(
          backup.manifestPath,
          path,
          "RESTORE_DATABASE_FROM_VERIFIED_BACKUP",
          maintenance,
        );
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "migration and automatic restore failed");
      }
    }
    throw error;
  } finally {
    lease?.release();
    maintenance?.release();
    lock?.release();
  }
}

export function openReadOnlyMemoryDatabase(path: string): OpenedDB {
  assertSupportedDatabaseBeforeOpen(path);
  recoverStaleMaintenanceGate(path, () => assertSupportedDatabaseBeforeOpen(path));
  const lease = acquireDatabaseLease(path);
  try {
    assertSupportedDatabaseBeforeOpen(path);
    assertDatabasePath(path);
    const db = new Database(path, { readonly: true });
    try {
      assertDatabasePath(path);
      assertSupportedDatabase(db);
      db.exec("PRAGMA busy_timeout=5000");
      return openedWithLease(db, lease);
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    lease.release();
    throw error;
  }
}

function handoffMaintenanceToLease(
  path: string,
  maintenance: MaintenanceGate,
): { db: Database; lease: DatabaseLease } {
  maintenance.release();
  const lease = acquireDatabaseLease(path);
  try {
    return { db: openDatabase(path), lease };
  } catch (error) {
    lease.release();
    throw error;
  }
}

function openedWithLease(db: Database, lease: DatabaseLease): OpenedDB {
  let closed = false;
  return {
    db,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        lease.release();
      }
    },
  };
}

function openDatabase(path: string): Database {
  assertDatabasePath(path);
  const db = new Database(path, { create: true });
  try {
    assertDatabasePath(path);
    db.exec("PRAGMA query_only=ON");
    assertSupportedDatabase(db);
    db.exec("PRAGMA query_only=OFF");
    chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA journal_mode=WAL");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function assertSupportedDatabaseBeforeOpen(path: string, verifyHealth = true): void {
  const deadline = Date.now() + PRE_OPEN_PROBE_TIMEOUT_MS;
  while (true) {
    try {
      assertSupportedDatabaseBeforeOpenOnce(path, verifyHealth);
      return;
    } catch (error) {
      if (!isSQLiteBusyError(error) || Date.now() >= deadline) throw error;
      Bun.sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }
}

function assertSupportedDatabaseBeforeOpenOnce(path: string, verifyHealth: boolean): void {
  assertDatabasePath(path);
  if (!existsSync(path)) return;
  const db = new Database(path, { readonly: true });
  try {
    assertDatabasePath(path);
    assertSupportedDatabase(db, verifyHealth);
  } finally {
    db.close();
  }
}

function assertSupportedDatabase(db: Database, verifyHealth = true): void {
  const existingVersion = getSchemaVersion(db);
  if (existingVersion && existingVersion.version > SCHEMA_VERSION) {
    throw new Error(
      `database schema v${existingVersion.version} is newer than supported v${SCHEMA_VERSION}`,
    );
  }
  if (!hasApplicationObjects(db)) return;
  const hasV11Marker = hasV11IdentityMarker(db);
  if (!existingVersion) {
    if (!hasLegacyV2(db)) throw new Error("unrecognized_database");
    assertLegacySchemaIdentity(db, 2, { verifyHealth });
    return;
  }
  if (existingVersion.version === SCHEMA_VERSION || hasV11Marker) {
    assertSchemaV11(db);
    return;
  }
  if (existingVersion.version < 2 || existingVersion.version > 10) {
    throw new Error("unrecognized_database");
  }
  assertLegacySchemaIdentity(db, existingVersion.version, { verifyHealth });
}

function assertDatabasePath(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("database path must not be a symbolic link");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function getSchemaVersion(db: Database): { version: number } | undefined {
  if (!hasTable(db, "schema_state")) return undefined;
  let rows: Array<{ version: unknown }>;
  try {
    rows = db.query("SELECT version FROM schema_state").all() as Array<{
      version: unknown;
    }>;
  } catch (error) {
    if (isSQLiteBusyError(error)) throw error;
    throw new Error("unrecognized_database");
  }
  if (
    rows.length !== 1 ||
    typeof rows[0]?.version !== "number" ||
    !Number.isSafeInteger(rows[0].version)
  ) {
    throw new Error("unrecognized_database");
  }
  return { version: rows[0].version };
}

function migrateToV8(db: Database): void {
  db.transaction(() => {
    adoptLegacyProjectIDs(db);
    importLegacyAssociations(db);
    if (hasColumn(db, "notes", "current_revision")) {
      dropLegacyV2Tables(db);
      db.query("DELETE FROM schema_state").run();
      db.query("INSERT INTO schema_state (version) VALUES (8)").run();
      return;
    }
    db.exec(`
      DROP TRIGGER IF EXISTS notes_fts_ai;
      DROP TRIGGER IF EXISTS notes_fts_ad;
      DROP TRIGGER IF EXISTS notes_fts_au;
      DROP TABLE IF EXISTS notes_fts;
    `);
    const pinned = hasColumn(db, "notes", "pinned") ? "pinned" : "0";
    db.exec(`
      CREATE TABLE notes_v7 (
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, id)
      );
      INSERT INTO notes_v7
        (id, project_id, kind, title, summary, content, size_class, pinned, status, supersedes_id, created_at, updated_at)
      SELECT id, project_id, kind, title, summary, content, size_class, ${pinned}, status, supersedes_id, created_at, updated_at
        FROM notes;
      CREATE TABLE note_edges_v7 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        predicate TEXT NOT NULL CHECK (predicate IN ('SUPPORTS','DERIVED_FROM','PART_OF','ABOUT','PRECEDES','SUPERSEDES')),
        created_at INTEGER NOT NULL,
        UNIQUE(project_id, source_id, target_id, predicate),
        FOREIGN KEY (project_id, source_id) REFERENCES notes_v7(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, target_id) REFERENCES notes_v7(project_id, id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO note_edges_v7
        (id, project_id, source_id, target_id, predicate, created_at)
      SELECT e.id, source.project_id, e.source_id, e.target_id, e.predicate, e.created_at
        FROM note_edges e
        JOIN notes source ON source.id = e.source_id
        JOIN notes target ON target.id = e.target_id
       WHERE source.project_id = target.project_id;
      DROP TABLE note_edges;
      DROP TABLE notes;
      ALTER TABLE notes_v7 RENAME TO notes;
      ALTER TABLE note_edges_v7 RENAME TO note_edges;
    `);
    dropLegacyV2Tables(db);
    db.query("DELETE FROM schema_state").run();
    db.query("INSERT INTO schema_state (version) VALUES (8)").run();
  })();
}

function adoptLegacyProjectIDs(db: Database): void {
  const existingProjects = db.query("SELECT id FROM projects").all() as Array<{ id: string }>;
  for (const { id: legacyID } of existingProjects) {
    if (isUUID(legacyID)) continue;
    const id = randomUUID();
    db.query("UPDATE projects SET id = ? WHERE id = ?").run(id, legacyID);
    db.query("UPDATE notes SET project_id = ? WHERE project_id = ?").run(id, legacyID);
    db.query("UPDATE note_edges SET project_id = ? WHERE project_id = ?").run(id, legacyID);
  }

  const rows = db.query("SELECT DISTINCT project_id FROM notes").all() as Array<{
    project_id: string;
  }>;
  for (const { project_id: legacyID } of rows) {
    if (db.query("SELECT id FROM projects WHERE id = ?").get(legacyID)) continue;
    const id = randomUUID();
    const name = uniqueLegacyProjectName(db, legacyID);
    const now = Date.now();
    db.query(
      "INSERT INTO projects (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, name, normalizeProjectName(name), now, now);
    db.query("UPDATE notes SET project_id = ? WHERE project_id = ?").run(id, legacyID);
    db.query("UPDATE note_edges SET project_id = ? WHERE project_id = ?").run(id, legacyID);
  }
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function uniqueLegacyProjectName(db: Database, legacyID: string): string {
  const base = legacyID === "global" ? "Legacy Global" : legacyID === "legacy" ? "Legacy" : `Legacy ${legacyID.slice(0, 12)}`;
  let name = base;
  let suffix = 2;
  while (db.query("SELECT id FROM projects WHERE normalized_name = ?").get(normalizeProjectName(name))) {
    name = `${base} ${suffix++}`;
  }
  return name;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function hasLegacyV2(db: Database): boolean {
  return hasTable(db, "memory_items");
}

function hasApplicationObjects(db: Database): boolean {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .get() as { count: number };
  return row.count > 0;
}

function hasV11IdentityMarker(db: Database): boolean {
  if (hasTable(db, "agz_meta")) return true;
  return (db.query("PRAGMA application_id").get() as { application_id: number }).application_id === APPLICATION_ID;
}

function hasTable(db: Database, table: string): boolean {
  const row = db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?").get(table) as
    | { n: number }
    | undefined;
  return (row?.n ?? 0) > 0;
}

const KIND_MAP: Record<string, string> = {
  decision: "decision",
  fact: "fact",
  observation: "fact",
  experiment: "fact",
  hypothesis: "fact",
  open_question: "fact",
  rule: "fact",
  direction: "fact",
  constraint: "fact",
  procedure: "procedure",
  failure_remedy: "procedure",
  agent_behavior: "procedure",
  context: "context",
  preference: "preference",
};

function migrateFromV2(db: Database, path: string) {
  const requiredTables = ["memory_items", "memory_versions", "memory_identities"];
  const missingTables = requiredTables.filter((table) => !hasTable(db, table));
  if (missingTables.length > 0) {
    throw new Error(`unsupported legacy schema; missing tables: ${missingTables.join(", ")}`);
  }

  const backup = `${path}.v2-backup`;
  if (!existsSync(backup)) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(path, backup);
  }
  db.transaction(() => {
    migrateFromV2Data(db, backup, {
      documents: ["document_sources", "document_chunks", "memories"].every((table) =>
        hasTable(db, table),
      ),
      links: hasTable(db, "memory_links"),
      edges: hasTable(db, "memory_edges"),
    });
    adoptLegacyProjectIDs(db);
    dropLegacyV2Tables(db);
    db.query("DELETE FROM schema_state").run();
    db.query("INSERT INTO schema_state (version) VALUES (8)").run();
  })();
}

function dropLegacyV2Tables(db: Database): void {
  for (const table of [
    "document_chunks",
    "document_sources",
    "memories",
    "memory_associations",
    "memory_edges",
    "memory_links",
    "memory_identities",
    "memory_versions",
    "memory_items",
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

function migrateFromV2Data(
  db: Database,
  backup: string,
  options: { documents: boolean; links: boolean; edges: boolean },
) {
  const now = Date.now();

  db.query("DELETE FROM notes_fts").run();
  db.query("DELETE FROM note_edges").run();
  db.query("DELETE FROM notes").run();
  db.query("DELETE FROM projects").run();

  const items = db
    .query(
      `SELECT i.id AS item_id, i.subject_key, i.kind, i.created_at, i.updated_at,
              i.identity_id, v.summary, v.content
         FROM memory_items i
         LEFT JOIN memory_versions v ON v.id = i.current_version_id
        WHERE i.lifecycle_state = 'active'`,
    )
    .all() as Array<{
    item_id: string;
    subject_key: string;
    kind: string;
    created_at: number;
    updated_at: number;
    identity_id: string;
    summary: string | null;
    content: string | null;
  }>;

  const identities = new Map<string, string>();
  for (const row of db
    .query("SELECT id, project_id FROM memory_identities")
    .all() as Array<{ id: string; project_id: string | null }>) {
    if (row.project_id) identities.set(row.id, row.project_id);
  }

  let migratedNotes = 0;
  for (const item of items) {
    const projectID = identities.get(item.identity_id) ?? "legacy";
    const content = item.content ?? item.summary ?? "";
    const summary = item.summary ?? content.slice(0, 200);
    const title = item.subject_key;
    const kind = KIND_MAP[item.kind] ?? "fact";
    const sizeClass = content.length <= 1200 ? "inline" : "indexed";
    db.query(
      `INSERT INTO notes (id, project_id, kind, title, summary, content, size_class, status, supersedes_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    ).run(
      item.item_id,
      projectID,
      kind,
      title,
      summary,
      content,
      sizeClass,
      item.created_at,
      item.updated_at,
    );
    db.query("INSERT INTO notes_fts (id, title, summary, content) VALUES (?, ?, ?, ?)").run(
      item.item_id,
      title,
      summary,
      content,
    );
    migratedNotes++;
  }

  const sources = options.documents
    ? (db
        .query(
          `SELECT s.id, s.project_root, s.title, s.created_at, s.updated_at,
               GROUP_CONCAT(m.content, '\n\n') AS body
          FROM document_sources s
          JOIN document_chunks c ON c.source_id = s.id
          JOIN memories m ON m.id = c.memory_id
         WHERE s.status = 'active'
         GROUP BY s.id
         ORDER BY s.created_at`,
        )
        .all() as Array<{ id: string; project_root: string | null; title: string; created_at: number; updated_at: number; body: string | null }>)
    : [];

  for (const source of sources) {
    const content = source.body ?? "";
    if (!content.trim()) continue;
    const id = randomUUID();
    db.query(
      `INSERT INTO notes (id, project_id, kind, title, summary, content, size_class, status, supersedes_id, created_at, updated_at)
       VALUES (?, ?, 'research', ?, ?, ?, 'indexed', 'active', NULL, ?, ?)`,
    ).run(
      id,
      source.project_root ? hashRoot(source.project_root) : "legacy",
      source.title,
      content.slice(0, 200),
      content,
      source.created_at,
      source.updated_at,
    );
    db.query("INSERT INTO notes_fts (id, title, summary, content) VALUES (?, ?, ?, ?)").run(
      id,
      source.title,
      content.slice(0, 200),
      content,
    );
    migratedNotes++;
  }

  const noteIDs = new Set(
    (db.query("SELECT id FROM notes").all() as Array<{ id: string }>).map((r) => r.id),
  );
  let migratedEdges = 0;
  const edges = options.edges
    ? (db
        .query(
          `SELECT id, source_item_id, target_item_id, predicate, recorded_at
             FROM memory_edges
            WHERE lifecycle_state = 'active'`,
        )
        .all() as Array<{
        id: string;
        source_item_id: string;
        target_item_id: string;
        predicate: string;
        recorded_at: number;
      }>)
    : [];
  for (const edge of edges) {
    if (!noteIDs.has(edge.source_item_id) || !noteIDs.has(edge.target_item_id)) continue;
    if (edge.source_item_id === edge.target_item_id) continue;
    const sourceProject = noteProjectID(db, edge.source_item_id);
    if (sourceProject !== noteProjectID(db, edge.target_item_id)) continue;
    const predicate = (PREDICATES as readonly string[]).includes(edge.predicate)
      ? edge.predicate
      : "ABOUT";
    const result = db.query(
      "INSERT OR IGNORE INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      `edge-${edge.id}`,
      sourceProject,
      edge.source_item_id,
      edge.target_item_id,
      predicate,
      edge.recorded_at,
    );
    migratedEdges += result.changes;
  }

  const links = options.links
    ? (db
        .query("SELECT source_memory_id, target_memory_id FROM memory_links WHERE status = 'active'")
        .all() as Array<{ source_memory_id: string; target_memory_id: string }>)
    : [];
  for (const link of links) {
    if (!noteIDs.has(link.source_memory_id) || !noteIDs.has(link.target_memory_id)) continue;
    if (link.source_memory_id === link.target_memory_id) continue;
    const sourceProject = noteProjectID(db, link.source_memory_id);
    if (sourceProject !== noteProjectID(db, link.target_memory_id)) continue;
    const result = db.query(
      "INSERT OR IGNORE INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES (?, ?, ?, ?, 'ABOUT', ?)",
    ).run(`edge-${link.source_memory_id}-${link.target_memory_id}`, sourceProject, link.source_memory_id, link.target_memory_id, now);
    migratedEdges += result.changes;
  }

  migratedEdges += importLegacyAssociations(db);

  console.warn(
    `[agz-memory] v2→v3 migration complete: ${migratedNotes} notes, ${migratedEdges} edges (backup: ${backup})`,
  );
}

function importLegacyAssociations(db: Database): number {
  if (!hasTable(db, "memory_associations")) return 0;
  const associations = db
    .query(
      `SELECT id, left_item_id, right_item_id, kind, created_at
         FROM memory_associations
        WHERE lifecycle_state = 'active'`,
    )
    .all() as Array<{
    id: string;
    left_item_id: string;
    right_item_id: string;
    kind: string;
    created_at: number;
  }>;
  let imported = 0;
  for (const association of associations) {
    const source = db.query("SELECT project_id FROM notes WHERE id = ?").get(
      association.left_item_id,
    ) as { project_id: string } | undefined;
    const target = db.query("SELECT project_id FROM notes WHERE id = ?").get(
      association.right_item_id,
    ) as { project_id: string } | undefined;
    if (!source || !target || source.project_id !== target.project_id) continue;
    if (association.left_item_id === association.right_item_id) continue;
    const candidate = association.kind.toUpperCase();
    const predicate = (PREDICATES as readonly string[]).includes(candidate) ? candidate : "ABOUT";
    const result = db
      .query(
        "INSERT OR IGNORE INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `association-${association.id}`,
        source.project_id,
        association.left_item_id,
        association.right_item_id,
        predicate,
        association.created_at,
      );
    imported += result.changes;
  }
  return imported;
}

function noteProjectID(db: Database, noteID: string): string {
  return (db.query("SELECT project_id FROM notes WHERE id = ?").get(noteID) as {
    project_id: string;
  }).project_id;
}

import type { Database } from "bun:sqlite";
import { assertHealthyDatabase } from "./health";
import { assertV10SourceDatabase } from "./migrations/v011";

const V2_TABLES = [
  "memory_items", "memory_versions", "memory_identities", "document_sources",
  "document_chunks", "memories", "memory_links", "memory_edges", "memory_associations",
] as const;

const PRE_V8_OBJECTS = new Set([
  "index:note_edges_source_idx", "index:note_edges_target_idx", "index:notes_project_idx",
  "table:note_edges", "table:notes", "table:notes_fts", "table:notes_fts_config",
  "table:notes_fts_content", "table:notes_fts_data", "table:notes_fts_docsize",
  "table:notes_fts_idx", "table:projects", "table:schema_state",
  ...V2_TABLES.map((table) => `table:${table}`),
]);

const PRE_V8_COLUMNS = {
  schema_state: ["version"],
  projects: ["id", "name", "normalized_name", "created_at", "updated_at"],
  notes: [
    "id", "project_id", "kind", "title", "summary", "content", "size_class", "status",
    "supersedes_id", "created_at", "updated_at",
  ],
  note_edges: ["id", "project_id", "source_id", "target_id", "predicate", "created_at"],
  notes_fts: ["id", "title", "summary", "content"],
} as const;

const V2_COLUMNS = {
  memory_items: [
    "id", "identity_id", "subject_key", "kind", "lifecycle_state", "current_version_id",
    "created_at", "updated_at",
  ],
  memory_versions: ["id", "summary", "content"],
  memory_identities: ["id", "project_id"],
} as const;

const V8_OBJECTS = new Set([
  "table:note_edges", "table:notes", "table:notes_fts", "table:notes_fts_config",
  "table:notes_fts_content", "table:notes_fts_data", "table:notes_fts_docsize",
  "table:notes_fts_idx", "table:projects", "table:schema_state",
]);

const V9_V10_OBJECTS = new Set([
  "index:capture_checkpoints_due_idx", "index:capture_events_note_idx",
  "index:capture_events_session_idx", "index:capture_events_state_idx",
  "index:index_outbox_due_idx", "index:note_edges_source_idx", "index:note_edges_target_idx",
  "index:notes_active_subject_idx", "index:notes_project_idx", "table:capture_checkpoints",
  "table:capture_events", "table:index_outbox", "table:note_edges", "table:note_provenance",
  "table:note_revisions", "table:notes", "table:notes_fts", "table:notes_fts_config",
  "table:notes_fts_data", "table:notes_fts_docsize",
  "table:notes_fts_idx", "table:project_bindings", "table:projects", "table:schema_state",
  "trigger:notes_fts_ad", "trigger:notes_fts_ai", "trigger:notes_fts_au",
]);

const V9_V10_COLUMNS: Record<string, readonly string[]> = {
  schema_state: ["version"],
  projects: ["id", "name", "normalized_name", "created_at", "updated_at"],
  notes: [
    "id", "project_id", "kind", "title", "summary", "content", "size_class", "pinned",
    "status", "supersedes_id", "current_revision", "subject_key", "content_hash", "created_at",
    "updated_at",
  ],
  note_edges: ["id", "project_id", "source_id", "target_id", "predicate", "created_at"],
  project_bindings: [
    "binding_key", "project_id", "source", "source_project_id", "workspace_id",
    "canonical_path_hash", "created_at", "updated_at",
  ],
  capture_checkpoints: [
    "session_id", "binding_key", "project_id", "state", "last_message_id",
    "last_reconciled_at", "next_reconcile_at", "failure_count", "lease_owner",
    "lease_expires_at", "created_at", "updated_at",
  ],
  capture_events: [
    "idempotency_key", "contract", "project_id", "binding_key", "event_kind",
    "source_session_id", "source_message_id", "source_ordinal", "source_tool_call_id",
    "payload_json", "payload_hash", "redaction_version", "state", "attempt_count", "note_id",
    "last_error_code", "generation", "created_at", "updated_at", "processed_at",
  ],
  note_provenance: [
    "id", "project_id", "note_id", "source_type", "capture_event_id", "source_session_id",
    "source_message_id", "source_ordinal", "source_tool_call_id", "redaction_version",
    "extractor_version", "confidence", "created_at",
  ],
  note_revisions: [
    "project_id", "note_id", "revision", "kind", "title", "summary", "content", "size_class",
    "pinned", "status", "supersedes_id", "subject_key", "content_hash", "provenance_id",
    "created_at",
  ],
  index_outbox: [
    "id", "backend", "operation", "project_id", "note_id", "revision", "content_hash", "state",
    "attempt_count", "available_at", "lease_owner", "lease_expires_at", "last_error_code",
    "created_at", "completed_at",
  ],
};

export function assertLegacySchemaIdentity(db: Database, version: number): void {
  if (version < 2 || version > 10) throw new Error("unrecognized_database");
  const applicationID = (
    db.query("PRAGMA application_id").get() as { application_id: number }
  ).application_id;
  if (applicationID !== 0 || tableExists(db, "agz_meta")) throw new Error("unrecognized_database");
  if (version === 2 && tableExists(db, "memory_items")) {
    assertV2Identity(db);
    assertHealthyDatabase(db);
    return;
  }
  if (version < 8) {
    assertPreV8Identity(db, version);
    assertHealthyDatabase(db);
    return;
  }
  const states = db.query("SELECT version FROM schema_state").all() as Array<{ version: unknown }>;
  if (states.length !== 1 || states[0]?.version !== version) throw new Error("unrecognized_database");
  const rows = db.query(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ type: string; name: string }>;
  const actual = new Set(rows.map((row) => `${row.type}:${row.name}`));
  const allowed = version === 8 ? V8_OBJECTS : V9_V10_OBJECTS;
  const required = version === 8
    ? V8_OBJECTS
    : new Set([...V9_V10_OBJECTS].filter((name) => !name.startsWith("index:capture_events_")));
  if (
    actual.size > allowed.size ||
    [...actual].some((name) => !allowed.has(name)) ||
    [...required].some((name) => !actual.has(name))
  ) {
    throw new Error("unrecognized_database");
  }
  const columns = version === 8
    ? {
        projects: V9_V10_COLUMNS.projects!,
        notes: V9_V10_COLUMNS.notes!.filter(
          (name) => !["current_revision", "subject_key", "content_hash"].includes(name),
        ),
        note_edges: V9_V10_COLUMNS.note_edges!,
        schema_state: V9_V10_COLUMNS.schema_state!,
      }
    : V9_V10_COLUMNS;
  for (const [table, expected] of Object.entries(columns)) {
    const actualColumns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    if (JSON.stringify(actualColumns) !== JSON.stringify(expected)) {
      throw new Error("unrecognized_database");
    }
  }
  assertHealthyDatabase(db);
  if (version === 10) assertV10SourceDatabase(db);
}

function assertV2Identity(db: Database): void {
  const rows = db.query(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ type: string; name: string }>;
  const allowed = new Set(V2_TABLES.map((table) => `table:${table}`));
  const actual = new Set(rows.map((row) => `${row.type}:${row.name}`));
  if ([...actual].some((name) => !allowed.has(name))) throw new Error("unrecognized_database");
  for (const [table, expected] of Object.entries(V2_COLUMNS)) {
    assertColumns(db, table, expected);
  }
}

function assertPreV8Identity(db: Database, version: number): void {
  const rows = db.query(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ type: string; name: string }>;
  const actual = new Set(rows.map((row) => `${row.type}:${row.name}`));
  const required = ["table:notes", "table:note_edges", "table:schema_state"];
  if (
    [...actual].some((name) => !PRE_V8_OBJECTS.has(name)) ||
    required.some((name) => !actual.has(name)) ||
    (version === 7 && !actual.has("table:projects"))
  ) {
    throw new Error("unrecognized_database");
  }
  const states = db.query("SELECT version FROM schema_state").all() as Array<{ version: unknown }>;
  if (states.length !== 1 || states[0]?.version !== version) throw new Error("unrecognized_database");
  const noteColumns = columns(db, "notes");
  const expectedNotes = [...PRE_V8_COLUMNS.notes];
  const expectedPinnedNotes = [...expectedNotes.slice(0, 7), "pinned", ...expectedNotes.slice(7)];
  if (
    JSON.stringify(noteColumns) !== JSON.stringify(expectedNotes) &&
    JSON.stringify(noteColumns) !== JSON.stringify(expectedPinnedNotes)
  ) {
    throw new Error("unrecognized_database");
  }
  assertColumns(db, "note_edges", PRE_V8_COLUMNS.note_edges);
  assertColumns(db, "schema_state", PRE_V8_COLUMNS.schema_state);
  if (tableExists(db, "projects")) assertColumns(db, "projects", PRE_V8_COLUMNS.projects);
  if (tableExists(db, "notes_fts")) assertColumns(db, "notes_fts", PRE_V8_COLUMNS.notes_fts);
}

function assertColumns(db: Database, table: string, expected: readonly string[]): void {
  if (JSON.stringify(columns(db, table)) !== JSON.stringify(expected)) {
    throw new Error("unrecognized_database");
  }
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function tableExists(db: Database, table: string): boolean {
  return (
    db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { count: number }
  ).count > 0;
}

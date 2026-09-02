import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { captureIdempotencyKey } from "../../capture/identity";
import { CAPTURE_SCHEMA, parseCaptureEvent } from "../../capture/contract";
import { hashTuple, noteContentHash } from "../../hash";
import { deriveDocument } from "../../retrieval/derived";
import { KINDS, PREDICATES } from "../../types";
import {
  FTS_V9,
  SCHEMA_V11_TABLES,
  insertV11Identity,
  rebuildFts,
} from "../schema";

const LEGACY_CAPTURE_SCHEMA = "agz-memory.capture/1";
const CAPTURE_SCHEMAS = new Set([LEGACY_CAPTURE_SCHEMA, CAPTURE_SCHEMA]);
const KINDS_SET = new Set<string>(KINDS);
const PREDICATES_SET = new Set<string>(PREDICATES);

interface ProjectRow {
  id: string;
  name: string;
  normalized_name: string;
  created_at: number;
  updated_at: number;
}

interface NoteRow {
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
  current_revision: number;
  subject_key: string | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

interface EdgeRow {
  id: string;
  project_id: string;
  source_id: string;
  target_id: string;
  predicate: string;
  created_at: number;
}

interface BindingRow {
  binding_key: string;
  project_id: string;
  source: string;
  source_project_id: string;
  workspace_id: string;
  canonical_path_hash: string;
  created_at: number;
  updated_at: number;
}

interface CheckpointRow {
  session_id: string;
  binding_key: string;
  project_id: string;
  state: string;
  last_message_id: string | null;
  last_reconciled_at: number | null;
  next_reconcile_at: number;
  failure_count: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface CaptureRow {
  idempotency_key: string;
  contract: string;
  project_id: string;
  binding_key: string;
  event_kind: string;
  source_session_id: string;
  source_message_id: string | null;
  source_ordinal: number | null;
  source_tool_call_id: string | null;
  payload_json: string | null;
  payload_hash: string | null;
  redaction_version: string;
  state: string;
  attempt_count: number;
  note_id: string | null;
  last_error_code: string | null;
  generation: number;
  created_at: number;
  updated_at: number;
  processed_at: number | null;
}

interface ProvenanceRow {
  id: string;
  project_id: string;
  note_id: string;
  source_type: string;
  capture_event_id: string | null;
  source_session_id: string | null;
  source_message_id: string | null;
  source_ordinal: number | null;
  source_tool_call_id: string | null;
  redaction_version: string | null;
  extractor_version: string | null;
  confidence: number | null;
  created_at: number;
}

interface RevisionRow {
  project_id: string;
  note_id: string;
  revision: number;
  kind: string;
  title: string;
  summary: string;
  content: string;
  size_class: string;
  pinned: number;
  status: string;
  supersedes_id: string | null;
  subject_key: string | null;
  content_hash: string;
  provenance_id: string;
  created_at: number;
}

interface OutboxRow {
  id: number;
  backend: string;
  operation: string;
  project_id: string;
  note_id: string | null;
  revision: number | null;
  content_hash: string | null;
  state: string;
  attempt_count: number;
  available_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

interface SourceRows {
  projects: ProjectRow[];
  notes: NoteRow[];
  edges: EdgeRow[];
  bindings: BindingRow[];
  checkpoints: CheckpointRow[];
  captures: CaptureRow[];
  provenance: ProvenanceRow[];
  revisions: RevisionRow[];
  outbox: OutboxRow[];
}

interface MigratedRows extends SourceRows {
  bindingMap: Map<string, string>;
  captureMap: Map<string, string>;
}

export function migrateV10ToV11(db: Database): void {
  const source = readSourceRows(db);
  const migrated = transformRows(source);
  replaceWithV11(db, migrated);
  console.warn(
    `[agz-memory] v10→v11 migration complete: projects=${migrated.projects.length}, notes=${migrated.notes.length}, edges=${migrated.edges.length}, bindings=${migrated.bindings.length}, checkpoints=${migrated.checkpoints.length}, captures=${migrated.captures.length}, revisions=${migrated.revisions.length}, outbox=${migrated.outbox.length}`,
  );
}

export function assertV10SourceDatabase(db: Database): void {
  transformRows(readSourceRows(db));
}

function readSourceRows(db: Database): SourceRows {
  for (const table of [
    "projects",
    "notes",
    "note_edges",
    "project_bindings",
    "capture_checkpoints",
    "capture_events",
    "note_provenance",
    "note_revisions",
    "index_outbox",
    "schema_state",
  ]) {
    requireTable(db, table);
  }
  if (!hasTable(db, "notes_fts")) fail("notes_fts", "schema", "source_schema");
  validateSourceObjects(db);

  const states = selectRows<{ version: number }>(db, "schema_state", "SELECT version FROM schema_state");
  if (states.length !== 1 || states[0]?.version !== 10) fail("schema_state", "schema", "source_schema");

  const projects = selectRows<ProjectRow>(
    db,
    "projects",
    "SELECT id, name, normalized_name, created_at, updated_at FROM projects ORDER BY rowid",
  );
  const notes = selectRows<NoteRow>(
    db,
    "notes",
    `SELECT id, project_id, kind, title, summary, content, size_class, pinned, status,
            supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at
       FROM notes ORDER BY rowid`,
  );
  const edges = selectRows<EdgeRow>(
    db,
    "note_edges",
    "SELECT id, project_id, source_id, target_id, predicate, created_at FROM note_edges ORDER BY rowid",
  );
  const bindings = selectRows<BindingRow>(
    db,
    "project_bindings",
    `SELECT binding_key, project_id, source, source_project_id, workspace_id,
            canonical_path_hash, created_at, updated_at
       FROM project_bindings ORDER BY rowid`,
  );
  const checkpoints = selectRows<CheckpointRow>(
    db,
    "capture_checkpoints",
    `SELECT session_id, binding_key, project_id, state, last_message_id,
            last_reconciled_at, next_reconcile_at, failure_count, lease_owner,
            lease_expires_at, created_at, updated_at
       FROM capture_checkpoints ORDER BY rowid`,
  );
  const captures = selectRows<CaptureRow>(
    db,
    "capture_events",
    `SELECT idempotency_key, contract, project_id, binding_key, event_kind,
            source_session_id, source_message_id, source_ordinal, source_tool_call_id,
            payload_json, payload_hash, redaction_version, state, attempt_count,
            note_id, last_error_code, generation, created_at, updated_at, processed_at
       FROM capture_events ORDER BY rowid`,
  );
  const provenance = selectRows<ProvenanceRow>(
    db,
    "note_provenance",
    `SELECT id, project_id, note_id, source_type, capture_event_id,
            source_session_id, source_message_id, source_ordinal, source_tool_call_id,
            redaction_version, extractor_version, confidence, created_at
       FROM note_provenance ORDER BY rowid`,
  );
  const revisions = selectRows<RevisionRow>(
    db,
    "note_revisions",
    `SELECT project_id, note_id, revision, kind, title, summary, content, size_class,
            pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at
       FROM note_revisions ORDER BY rowid`,
  );
  const outbox = selectRows<OutboxRow>(
    db,
    "index_outbox",
    `SELECT id, backend, operation, project_id, note_id, revision, content_hash,
            state, attempt_count, available_at, lease_owner, lease_expires_at,
            last_error_code, created_at, completed_at
       FROM index_outbox ORDER BY id`,
  );
  return { projects, notes, edges, bindings, checkpoints, captures, provenance, revisions, outbox };
}

function validateSourceObjects(db: Database): void {
  const expected = new Set([
    "index\0capture_checkpoints_due_idx",
    "index\0capture_events_note_idx",
    "index\0capture_events_session_idx",
    "index\0capture_events_state_idx",
    "index\0index_outbox_due_idx",
    "index\0note_edges_source_idx",
    "index\0note_edges_target_idx",
    "index\0notes_active_subject_idx",
    "index\0notes_project_idx",
    "table\0capture_checkpoints",
    "table\0capture_events",
    "table\0index_outbox",
    "table\0note_edges",
    "table\0note_provenance",
    "table\0note_revisions",
    "table\0notes",
    "table\0notes_fts",
    "table\0notes_fts_config",
    "table\0notes_fts_data",
    "table\0notes_fts_docsize",
    "table\0notes_fts_idx",
    "table\0project_bindings",
    "table\0projects",
    "table\0schema_state",
    "trigger\0notes_fts_ad",
    "trigger\0notes_fts_ai",
    "trigger\0notes_fts_au",
  ]);
  const actual = db
    .query("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as Array<{ type: string; name: string }>;
  if (
    actual.length !== expected.size ||
    actual.some((object) => !expected.has(`${object.type}\0${object.name}`))
  ) {
    fail("database", "schema", "source_schema");
  }
}

function transformRows(source: SourceRows): MigratedRows {
  const projectIDs = new Set<string>();
  const normalizedProjectNames = new Set<string>();
  for (const project of source.projects) {
    requireString(project.id, "projects", project.id, "project_id_invalid");
    requireString(project.name, "projects", project.id, "project_name_invalid");
    requireString(project.normalized_name, "projects", project.id, "project_name_invalid");
    requireInteger(project.created_at, "projects", project.id, "timestamp_invalid");
    requireInteger(project.updated_at, "projects", project.id, "timestamp_invalid");
    if (projectIDs.has(project.id)) fail("projects", project.id, "duplicate_row");
    if (normalizedProjectNames.has(project.normalized_name)) {
      fail("projects", project.id, "duplicate_normalized_name");
    }
    projectIDs.add(project.id);
    normalizedProjectNames.add(project.normalized_name);
  }

  const noteMap = new Map<string, NoteRow>();
  const noteIDs = new Set<string>();
  for (const note of source.notes) {
    requireString(note.id, "notes", note.id, "note_id_invalid");
    requireString(note.project_id, "notes", note.id, "project_id_invalid");
    if (!projectIDs.has(note.project_id)) fail("notes", note.id, "cross_project_reference");
    requireKind(note.kind, "notes", note.id);
    requireString(note.title, "notes", note.id, "note_value_invalid");
    requireString(note.summary, "notes", note.id, "note_value_invalid");
    requireString(note.content, "notes", note.id, "note_value_invalid");
    if (note.size_class !== "inline" && note.size_class !== "indexed") {
      fail("notes", note.id, "note_value_invalid");
    }
    if (note.pinned !== 0 && note.pinned !== 1) fail("notes", note.id, "note_value_invalid");
    if (!new Set(["active", "superseded", "archived"]).has(note.status)) {
      fail("notes", note.id, "note_value_invalid");
    }
    requireNullableString(note.supersedes_id, "notes", note.id, "note_value_invalid");
    requireIntegerAtLeast(note.current_revision, 1, "notes", note.id, "revision_invalid");
    requireNullableString(note.subject_key, "notes", note.id, "note_value_invalid");
    requireString(note.content_hash, "notes", note.id, "hash_invalid");
    const legacyHash = legacyNoteContentHash(note.kind, note.title, note.summary, note.content);
    const v2Hash = noteContentHash(note.kind, note.title, note.summary, note.content);
    if (note.content_hash !== legacyHash && note.content_hash !== v2Hash) {
      fail("notes", note.id, "hash_invalid");
    }
    requireInteger(note.created_at, "notes", note.id, "timestamp_invalid");
    requireInteger(note.updated_at, "notes", note.id, "timestamp_invalid");
    if (noteMap.has(noteKey(note.project_id, note.id))) fail("notes", note.id, "duplicate_row");
    noteMap.set(noteKey(note.project_id, note.id), note);
    noteIDs.add(note.id);
  }
  const activeSubjects = new Set<string>();
  for (const note of source.notes) {
    if (note.supersedes_id !== null) {
      const superseded = noteMap.get(noteKey(note.project_id, note.supersedes_id));
      if (!superseded || note.supersedes_id === note.id) {
        fail("notes", note.id, "cross_project_reference");
      }
    }
    if (note.status === "active" && note.subject_key !== null) {
      const subject = hashTuple("active-subject", 2, [note.project_id, note.kind, note.subject_key]);
      if (activeSubjects.has(subject)) fail("notes", note.id, "duplicate_active_subject");
      activeSubjects.add(subject);
    }
  }

  const edges = source.edges.map((edge) => {
    requireString(edge.id, "note_edges", edge.id, "edge_id_invalid");
    requireString(edge.project_id, "note_edges", edge.id, "project_id_invalid");
    requireString(edge.source_id, "note_edges", edge.id, "edge_value_invalid");
    requireString(edge.target_id, "note_edges", edge.id, "edge_value_invalid");
    const sourceNote = noteMap.get(noteKey(edge.project_id, edge.source_id));
    const targetNote = noteMap.get(noteKey(edge.project_id, edge.target_id));
    if (!projectIDs.has(edge.project_id) || !sourceNote || !targetNote) {
      fail("note_edges", edge.id, "cross_project_reference");
    }
    if (!PREDICATES_SET.has(edge.predicate)) fail("note_edges", edge.id, "edge_value_invalid");
    requireInteger(edge.created_at, "note_edges", edge.id, "timestamp_invalid");
    return edge;
  });

  const bindingMap = new Map<string, string>();
  const bindingProjects = new Map<string, string>();
  const bindingKeys = new Set<string>();
  const bindings = source.bindings.map((binding) => {
    requireHash(binding.binding_key, "project_bindings", binding.binding_key, "binding_id_invalid");
    requireString(binding.project_id, "project_bindings", binding.binding_key, "project_id_invalid");
    if (!projectIDs.has(binding.project_id)) {
      fail("project_bindings", binding.binding_key, "cross_project_reference");
    }
    if (binding.source !== "opencode-v2") fail("project_bindings", binding.binding_key, "binding_value_invalid");
    requireString(binding.source_project_id, "project_bindings", binding.binding_key, "binding_value_invalid");
    requireString(binding.workspace_id, "project_bindings", binding.binding_key, "binding_value_invalid");
    requireHash(binding.canonical_path_hash, "project_bindings", binding.binding_key, "hash_invalid");
    requireInteger(binding.created_at, "project_bindings", binding.binding_key, "timestamp_invalid");
    requireInteger(binding.updated_at, "project_bindings", binding.binding_key, "timestamp_invalid");
    const nextKey = hashTuple("project-binding", 2, [
      binding.source,
      binding.source_project_id,
      binding.workspace_id,
      binding.canonical_path_hash,
    ]);
    if (bindingKeys.has(nextKey)) fail("project_bindings", binding.binding_key, "identity_collision");
    bindingKeys.add(nextKey);
    bindingMap.set(binding.binding_key, nextKey);
    bindingProjects.set(binding.binding_key, binding.project_id);
    return { ...binding, binding_key: nextKey };
  });

  const checkpointIdentities = new Set<string>();
  const checkpoints = source.checkpoints.map((checkpoint) => {
    requireNonEmptyString(checkpoint.session_id, "capture_checkpoints", checkpoint.session_id, "checkpoint_id_invalid");
    requireHash(checkpoint.binding_key, "capture_checkpoints", checkpoint.session_id, "checkpoint_value_invalid");
    requireString(checkpoint.project_id, "capture_checkpoints", checkpoint.session_id, "project_id_invalid");
    const nextBinding = bindingMap.get(checkpoint.binding_key);
    if (!nextBinding || checkpoint.project_id !== bindingProjects.get(checkpoint.binding_key)) {
      fail("capture_checkpoints", checkpoint.session_id, "cross_project_reference");
    }
    if (checkpoint.state !== "active" && checkpoint.state !== "idle" && checkpoint.state !== "unavailable" && checkpoint.state !== "closed") {
      fail("capture_checkpoints", checkpoint.session_id, "checkpoint_value_invalid");
    }
    requireNullableString(checkpoint.last_message_id, "capture_checkpoints", checkpoint.session_id, "checkpoint_value_invalid");
    requireNullableInteger(checkpoint.last_reconciled_at, "capture_checkpoints", checkpoint.session_id, "timestamp_invalid");
    requireInteger(checkpoint.next_reconcile_at, "capture_checkpoints", checkpoint.session_id, "timestamp_invalid");
    requireIntegerAtLeast(checkpoint.failure_count, 0, "capture_checkpoints", checkpoint.session_id, "checkpoint_value_invalid");
    requireNullableString(checkpoint.lease_owner, "capture_checkpoints", checkpoint.session_id, "checkpoint_value_invalid");
    requireNullableInteger(checkpoint.lease_expires_at, "capture_checkpoints", checkpoint.session_id, "timestamp_invalid");
    requireInteger(checkpoint.created_at, "capture_checkpoints", checkpoint.session_id, "timestamp_invalid");
    requireInteger(checkpoint.updated_at, "capture_checkpoints", checkpoint.session_id, "timestamp_invalid");
    const identity = hashTuple("checkpoint-identity", 2, [nextBinding, checkpoint.session_id]);
    if (checkpointIdentities.has(identity)) {
      fail("capture_checkpoints", checkpoint.session_id, "identity_collision");
    }
    checkpointIdentities.add(identity);
    return { ...checkpoint, binding_key: nextBinding, last_message_id: null };
  });

  const captureMap = new Map<string, string>();
  const captureProjects = new Map<string, string>();
  const captureKeys = new Set<string>();
  const captures = source.captures.map((capture) => {
    requireHash(capture.idempotency_key, "capture_events", capture.idempotency_key, "capture_id_invalid");
    requireString(capture.project_id, "capture_events", capture.idempotency_key, "project_id_invalid");
    requireHash(capture.binding_key, "capture_events", capture.idempotency_key, "binding_id_invalid");
    const nextBinding = bindingMap.get(capture.binding_key);
    const bindingProjectID = bindingProjects.get(capture.binding_key);
    if (!nextBinding || !bindingProjectID || capture.project_id !== bindingProjectID) {
      fail("capture_events", capture.idempotency_key, "cross_project_reference");
    }
    const migrated = migrateCapture(capture, nextBinding, noteMap, noteIDs);
    if (captureKeys.has(migrated.idempotency_key)) {
      fail("capture_events", capture.idempotency_key, "identity_collision");
    }
    captureKeys.add(migrated.idempotency_key);
    captureMap.set(capture.idempotency_key, migrated.idempotency_key);
    captureProjects.set(capture.idempotency_key, capture.project_id);
    return migrated;
  });

  const provenanceKeys = new Set<string>();
  const provenance = source.provenance.map((row) => {
    requireString(row.id, "note_provenance", row.id, "provenance_id_invalid");
    requireString(row.project_id, "note_provenance", row.id, "project_id_invalid");
    requireString(row.note_id, "note_provenance", row.id, "note_id_invalid");
    if (!noteMap.has(noteKey(row.project_id, row.note_id))) {
      fail("note_provenance", row.id, "cross_project_reference");
    }
    if (!new Set(["mcp-manual", "opencode-capture", "migration", "legacy-import", "admin"]).has(row.source_type)) {
      fail("note_provenance", row.id, "provenance_value_invalid");
    }
    requireNullableString(row.capture_event_id, "note_provenance", row.id, "provenance_value_invalid");
    if (row.capture_event_id !== null) {
      if (!captureMap.has(row.capture_event_id)) fail("note_provenance", row.id, "capture_reference_invalid");
      if (captureProjects.get(row.capture_event_id) !== row.project_id) {
        fail("note_provenance", row.id, "cross_project_reference");
      }
    }
    requireNullableString(row.source_session_id, "note_provenance", row.id, "provenance_value_invalid");
    requireNullableString(row.source_message_id, "note_provenance", row.id, "provenance_value_invalid");
    requireNullableInteger(row.source_ordinal, "note_provenance", row.id, "provenance_value_invalid");
    requireNullableString(row.source_tool_call_id, "note_provenance", row.id, "provenance_value_invalid");
    requireNullableString(row.redaction_version, "note_provenance", row.id, "provenance_value_invalid");
    requireNullableString(row.extractor_version, "note_provenance", row.id, "provenance_value_invalid");
    if (row.confidence !== null && (!Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)) {
      fail("note_provenance", row.id, "provenance_value_invalid");
    }
    requireInteger(row.created_at, "note_provenance", row.id, "timestamp_invalid");
    const key = noteKey(row.project_id, row.id);
    if (provenanceKeys.has(key)) fail("note_provenance", row.id, "duplicate_row");
    provenanceKeys.add(key);
    return {
      ...row,
      capture_event_id: row.capture_event_id === null ? null : captureMap.get(row.capture_event_id)!,
    };
  });

  const provenanceMap = new Map(
    provenance.map((row) => [noteKey(row.project_id, row.id), row] as const),
  );

  const revisionMap = new Map<string, RevisionRow>();
  const revisions = source.revisions.map((revision) => {
    requireString(revision.project_id, "note_revisions", revision.note_id, "project_id_invalid");
    requireString(revision.note_id, "note_revisions", revision.note_id, "note_id_invalid");
    const note = noteMap.get(noteKey(revision.project_id, revision.note_id));
    const provenanceRow = provenanceMap.get(
      noteKey(revision.project_id, revision.provenance_id),
    );
    if (!note || !provenanceRow) fail("note_revisions", revision.note_id, "cross_project_reference");
    requireIntegerAtLeast(revision.revision, 1, "note_revisions", revision.note_id, "revision_invalid");
    requireKind(revision.kind, "note_revisions", revision.note_id);
    requireString(revision.title, "note_revisions", revision.note_id, "revision_value_invalid");
    requireString(revision.summary, "note_revisions", revision.note_id, "revision_value_invalid");
    requireString(revision.content, "note_revisions", revision.note_id, "revision_value_invalid");
    if (revision.size_class !== "inline" && revision.size_class !== "indexed") {
      fail("note_revisions", revision.note_id, "revision_value_invalid");
    }
    if (revision.pinned !== 0 && revision.pinned !== 1) fail("note_revisions", revision.note_id, "revision_value_invalid");
    if (!new Set(["active", "superseded", "archived"]).has(revision.status)) {
      fail("note_revisions", revision.note_id, "revision_value_invalid");
    }
    requireNullableString(revision.supersedes_id, "note_revisions", revision.note_id, "revision_value_invalid");
    if (revision.supersedes_id !== null) {
      if (revision.supersedes_id === revision.note_id) {
        fail("note_revisions", revision.note_id, "revision_value_invalid");
      }
      if (!noteMap.has(noteKey(revision.project_id, revision.supersedes_id))) {
        fail("note_revisions", revision.note_id, "cross_project_reference");
      }
    }
    requireNullableString(revision.subject_key, "note_revisions", revision.note_id, "revision_value_invalid");
    requireString(revision.content_hash, "note_revisions", revision.note_id, "hash_invalid");
    const legacyHash = legacyNoteContentHash(
      revision.kind,
      revision.title,
      revision.summary,
      revision.content,
    );
    const v2Hash = noteContentHash(revision.kind, revision.title, revision.summary, revision.content);
    if (revision.content_hash !== legacyHash && revision.content_hash !== v2Hash) {
      fail("note_revisions", revision.note_id, "hash_invalid");
    }
    requireInteger(revision.created_at, "note_revisions", revision.note_id, "timestamp_invalid");
    const key = revisionKey(revision.project_id, revision.note_id, revision.revision);
    if (revisionMap.has(key)) fail("note_revisions", revision.note_id, "duplicate_row");
    const migrated = {
      ...revision,
      content_hash: noteContentHash(revision.kind, revision.title, revision.summary, revision.content),
    };
    revisionMap.set(key, migrated);
    return migrated;
  });

  for (const note of source.notes) {
    const current = revisionMap.get(revisionKey(note.project_id, note.id, note.current_revision));
    if (!current) fail("note_revisions", note.id, "revision_invalid");
    for (let revision = 1; revision <= note.current_revision; revision++) {
      if (!revisionMap.has(revisionKey(note.project_id, note.id, revision))) {
        fail("note_revisions", note.id, "revision_invalid");
      }
    }
    if (
      current.kind !== note.kind ||
      current.title !== note.title ||
      current.summary !== note.summary ||
      current.content !== note.content ||
      current.size_class !== note.size_class ||
      current.pinned !== note.pinned ||
      current.status !== note.status ||
      current.supersedes_id !== note.supersedes_id ||
      current.subject_key !== note.subject_key ||
      current.content_hash !== noteContentHash(note.kind, note.title, note.summary, note.content)
    ) {
      fail("note_revisions", note.id, "revision_invalid");
    }
  }

  const activeOperations = new Set<string>();
  const outbox = source.outbox.map((row) => {
    requireIntegerAtLeast(row.id, 1, "index_outbox", String(row.id), "outbox_value_invalid");
    requireNonEmptyString(row.backend, "index_outbox", String(row.id), "outbox_value_invalid");
    requireString(row.operation, "index_outbox", String(row.id), "outbox_operation_invalid");
    requireString(row.project_id, "index_outbox", String(row.id), "project_id_invalid");
    requireNullableString(row.note_id, "index_outbox", String(row.id), "outbox_operation_invalid");
    requireNullableInteger(row.revision, "index_outbox", String(row.id), "outbox_operation_invalid");
    requireNullableString(row.content_hash, "index_outbox", String(row.id), "outbox_operation_invalid");
    if (row.state !== "pending" && row.state !== "leased" && row.state !== "succeeded" && row.state !== "dead") {
      fail("index_outbox", String(row.id), "outbox_value_invalid");
    }
    requireIntegerAtLeast(row.attempt_count, 0, "index_outbox", String(row.id), "outbox_value_invalid");
    requireInteger(row.available_at, "index_outbox", String(row.id), "timestamp_invalid");
    requireNullableString(row.lease_owner, "index_outbox", String(row.id), "outbox_value_invalid");
    requireNullableInteger(row.lease_expires_at, "index_outbox", String(row.id), "timestamp_invalid");
    requireNullableString(row.last_error_code, "index_outbox", String(row.id), "outbox_value_invalid");
    requireInteger(row.created_at, "index_outbox", String(row.id), "timestamp_invalid");
    requireNullableInteger(row.completed_at, "index_outbox", String(row.id), "timestamp_invalid");

    let contentHash: string | null = null;
    let state = row.state;
    let leaseOwner = row.lease_owner;
    let leaseExpiresAt = row.lease_expires_at;
    let completedAt = row.completed_at;
    if (row.operation === "upsert-note") {
      if (row.note_id === null || row.revision === null || row.content_hash === null) {
        fail("index_outbox", String(row.id), "outbox_operation_invalid");
      }
      requireNonEmptyString(row.note_id, "index_outbox", String(row.id), "outbox_operation_invalid");
      requireIntegerAtLeast(row.revision, 1, "index_outbox", String(row.id), "outbox_operation_invalid");
      requireHash(row.content_hash, "index_outbox", String(row.id), "hash_invalid");
      const revision = revisionMap.get(revisionKey(row.project_id, row.note_id, row.revision));
      if (!revision) {
        // V10 intentionally retained completed/dead outbox history after its
        // project or note was deleted. Its worker treated an active orphan as
        // stale success, so normalize that state while preserving its hash.
        contentHash = row.content_hash;
        if (state === "pending" || state === "leased") {
          state = "succeeded";
          leaseOwner = null;
          leaseExpiresAt = null;
          completedAt = row.completed_at ?? row.created_at;
        }
      } else {
        const document = deriveDocument({
          projectID: revision.project_id,
          noteID: revision.note_id,
          revision: revision.revision,
          kind: revision.kind,
          title: revision.title,
          summary: revision.summary,
          content: revision.content,
        });
        if (!document) fail("index_outbox", String(row.id), "derived_identity_unavailable");
        const legacyContentHash = legacyNoteContentHash(
          document.kind,
          document.title,
          document.summary,
          document.content,
        );
        if (row.content_hash !== document.contentHash && row.content_hash !== legacyContentHash) {
          fail("index_outbox", String(row.id), "hash_invalid");
        }
        contentHash = document.contentHash;
      }
    } else if (row.operation === "delete-note") {
      if (row.note_id === null || row.revision === null) {
        fail("index_outbox", String(row.id), "outbox_operation_invalid");
      }
      requireNonEmptyString(row.note_id, "index_outbox", String(row.id), "outbox_operation_invalid");
      requireIntegerAtLeast(row.revision, 1, "index_outbox", String(row.id), "outbox_operation_invalid");
      if (row.content_hash !== null) {
        requireHash(row.content_hash, "index_outbox", String(row.id), "hash_invalid");
      }
    } else if (row.operation === "purge-project") {
      if (row.note_id !== null || row.revision !== null || row.content_hash !== null) {
        fail("index_outbox", String(row.id), "outbox_operation_invalid");
      }
    } else {
      fail("index_outbox", String(row.id), "outbox_operation_invalid");
    }
    if (state === "leased") state = "pending";
    leaseOwner = null;
    leaseExpiresAt = null;
    let generation = 0;
    if (state === "pending" || state === "leased") {
      let activeKey = hashTuple("outbox-active", 2, [
        row.backend,
        row.operation,
        row.project_id,
        row.note_id,
        row.revision,
        generation,
      ]);
      while (activeOperations.has(activeKey)) {
        generation++;
        activeKey = hashTuple("outbox-active", 2, [
          row.backend,
          row.operation,
          row.project_id,
          row.note_id,
          row.revision,
          generation,
        ]);
      }
      activeOperations.add(activeKey);
    }
    const operationKey = hashTuple("outbox-operation", 2, [
      row.backend,
      row.operation,
      row.project_id,
      row.note_id,
      row.revision,
      contentHash,
      generation,
    ]);
    return {
      ...row,
      operation_key: operationKey,
      content_hash: contentHash,
      state,
      lease_owner: leaseOwner,
      lease_expires_at: leaseExpiresAt,
      completed_at: completedAt,
      generation,
      lease_generation: 0,
      fence: 0,
      heartbeat_at: null,
    } as OutboxRow & {
      operation_key: string;
      generation: number;
      lease_generation: number;
      fence: number;
      heartbeat_at: null;
    };
  });

  const migratedNotes = source.notes.map((note) => ({
    ...note,
    content_hash: noteContentHash(note.kind, note.title, note.summary, note.content),
  }));
  return {
    projects: source.projects,
    notes: migratedNotes,
    edges,
    bindings,
    checkpoints,
    captures,
    provenance,
    revisions,
    outbox,
    bindingMap,
    captureMap,
  };
}

function migrateCapture(
  row: CaptureRow,
  bindingKey: string,
  notes: Map<string, NoteRow>,
  noteIDs: Set<string>,
): CaptureRow {
  requireHash(row.idempotency_key, "capture_events", row.idempotency_key, "capture_id_invalid");
  if (!CAPTURE_SCHEMAS.has(row.contract)) fail("capture_events", row.idempotency_key, "capture_contract_invalid");
  requireString(row.project_id, "capture_events", row.idempotency_key, "project_id_invalid");
  requireString(row.event_kind, "capture_events", row.idempotency_key, "capture_identity_invalid");
  requireNonEmptyString(row.source_session_id, "capture_events", row.idempotency_key, "capture_identity_invalid");
  requireNullableString(row.source_message_id, "capture_events", row.idempotency_key, "capture_identity_invalid");
  requireNullableInteger(row.source_ordinal, "capture_events", row.idempotency_key, "capture_identity_invalid");
  requireNullableString(row.source_tool_call_id, "capture_events", row.idempotency_key, "capture_identity_invalid");
  requireString(row.redaction_version, "capture_events", row.idempotency_key, "capture_value_invalid");
  if (!new Set(["pending", "shadowed", "review", "materialized", "duplicate", "ignored", "rejected", "quarantined", "failed", "dead"]).has(row.state)) {
    fail("capture_events", row.idempotency_key, "capture_value_invalid");
  }
  requireIntegerAtLeast(row.attempt_count, 0, "capture_events", row.idempotency_key, "capture_value_invalid");
  if (row.note_id !== null && notes.get(noteKey(row.project_id, row.note_id)) === undefined) {
    if (noteIDs.has(row.note_id)) {
      fail("capture_events", row.idempotency_key, "cross_project_reference");
    }
  }
  requireNullableString(row.note_id, "capture_events", row.idempotency_key, "capture_value_invalid");
  requireNullableString(row.last_error_code, "capture_events", row.idempotency_key, "capture_value_invalid");
  requireIntegerAtLeast(row.generation, 0, "capture_events", row.idempotency_key, "capture_value_invalid");
  requireInteger(row.created_at, "capture_events", row.idempotency_key, "timestamp_invalid");
  requireInteger(row.updated_at, "capture_events", row.idempotency_key, "timestamp_invalid");
  requireNullableInteger(row.processed_at, "capture_events", row.idempotency_key, "timestamp_invalid");
  requireNullableString(row.payload_json, "capture_events", row.idempotency_key, "payload_value_invalid");
  requireNullableString(row.payload_hash, "capture_events", row.idempotency_key, "payload_value_invalid");

  if (row.payload_json === null) {
    if (row.payload_hash !== null) fail("capture_events", row.idempotency_key, "payload_identity_unavailable");
    let key: string;
    try {
      assertLegacyCaptureKey(row);
      key = captureKeyFromColumns(row, bindingKey);
    } catch {
      fail("capture_events", row.idempotency_key, "capture_identity_invalid");
    }
    return { ...row, idempotency_key: key, contract: CAPTURE_SCHEMA, binding_key: bindingKey };
  }

  if (row.payload_hash === null) fail("capture_events", row.idempotency_key, "payload_identity_unavailable");
  const legacyPayloadHash = sha256(row.payload_json);
  const v2PayloadHash = hashTuple("capture-payload", 2, [row.payload_json]);
  if (row.payload_hash !== legacyPayloadHash && row.payload_hash !== v2PayloadHash) {
    fail("capture_events", row.idempotency_key, "payload_identity_mismatch");
  }

  let raw: Record<string, unknown>;
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    raw = value as Record<string, unknown>;
  } catch {
    fail("capture_events", row.idempotency_key, "payload_invalid");
  }
  if (raw.schema !== row.contract || raw.idempotencyKey !== row.idempotency_key) {
    fail("capture_events", row.idempotency_key, "payload_identity_mismatch");
  }
  if (raw.projectID !== row.project_id || raw.bindingKey !== row.binding_key || raw.kind !== row.event_kind) {
    fail("capture_events", row.idempotency_key, "cross_project_reference");
  }
  const source = raw.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("capture_events", row.idempotency_key, "capture_identity_invalid");
  }
  let nextKey: string;
  try {
    nextKey = captureKeyFromPayload(row.event_kind, bindingKey, source as Record<string, unknown>, raw.signal);
  } catch {
    fail("capture_events", row.idempotency_key, "capture_identity_invalid");
  }
  const candidate = {
    ...raw,
    schema: CAPTURE_SCHEMA,
    idempotencyKey: nextKey,
    projectID: row.project_id,
    bindingKey,
  };
  let parsed: ReturnType<typeof parseCaptureEvent>;
  try {
    parsed = parseCaptureEvent(candidate);
  } catch {
    fail("capture_events", row.idempotency_key, "capture_identity_invalid");
  }
  if (
    parsed.kind !== row.event_kind ||
    parsed.source.sessionID !== row.source_session_id ||
    (parsed.source.messageID ?? null) !== row.source_message_id ||
    (parsed.source.ordinal ?? null) !== row.source_ordinal ||
    (parsed.source.toolCallID ?? null) !== row.source_tool_call_id
  ) {
    fail("capture_events", row.idempotency_key, "capture_identity_mismatch");
  }
  const payload = JSON.stringify(parsed);
  return {
    ...row,
    idempotency_key: nextKey,
    contract: CAPTURE_SCHEMA,
    binding_key: bindingKey,
    payload_json: payload,
    payload_hash: capturePayloadHash(parsed),
  };
}

function captureKeyFromColumns(row: CaptureRow, bindingKey: string): string {
  if (row.event_kind === "user-candidate") {
    requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
    if (row.source_ordinal !== null || row.source_tool_call_id !== null) {
      fail("capture_events", row.idempotency_key, "capture_identity_invalid");
    }
    return captureIdempotencyKey({
      kind: "user",
      bindingKey,
      sessionID: row.source_session_id,
      messageID: row.source_message_id,
    });
  }
  if (row.event_kind === "assistant-candidate") {
    requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
    if (row.source_ordinal === null || row.source_tool_call_id !== null) {
      fail("capture_events", row.idempotency_key, "capture_identity_invalid");
    }
    return captureIdempotencyKey({
      kind: "assistant",
      bindingKey,
      sessionID: row.source_session_id,
      assistantMessageID: row.source_message_id,
      ordinal: row.source_ordinal,
    });
  }
  if (row.event_kind === "session-summary") {
    requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
    if (row.source_ordinal !== null || row.source_tool_call_id !== null) {
      fail("capture_events", row.idempotency_key, "capture_identity_invalid");
    }
    return captureIdempotencyKey({
      kind: "summary",
      bindingKey,
      sessionID: row.source_session_id,
      checkpointMessageID: row.source_message_id,
    });
  }
  if (row.event_kind === "tool-signal") {
    requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
    if (row.source_ordinal !== null || !row.source_tool_call_id) {
      fail("capture_events", row.idempotency_key, "capture_identity_invalid");
    }
    const status = legacyToolStatus(row);
    return captureIdempotencyKey({
      kind: "tool",
      bindingKey,
      sessionID: row.source_session_id,
      assistantMessageID: row.source_message_id,
      toolCallID: row.source_tool_call_id,
      terminalStatus: status,
    });
  }
  fail("capture_events", row.idempotency_key, "capture_identity_invalid");
}

function assertLegacyCaptureKey(row: CaptureRow): void {
  let expected: string;
  if (row.event_kind === "user-candidate") {
    requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
    expected = legacyCaptureKey([
      "user",
      row.binding_key,
      row.source_session_id,
      row.source_message_id,
    ]);
  } else if (row.event_kind === "assistant-candidate") {
    requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
    if (row.source_ordinal === null) fail("capture_events", row.idempotency_key, "capture_identity_invalid");
    expected = legacyCaptureKey([
      "assistant",
      row.binding_key,
      row.source_session_id,
      row.source_message_id,
      String(row.source_ordinal),
    ]);
  } else if (row.event_kind === "session-summary") {
    requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
    expected = legacyCaptureKey([
      "summary",
      row.binding_key,
      row.source_session_id,
      row.source_message_id,
    ]);
  } else if (row.event_kind === "tool-signal") {
    legacyToolStatus(row);
    return;
  } else {
    fail("capture_events", row.idempotency_key, "capture_identity_invalid");
  }
  if (row.idempotency_key !== expected) {
    fail("capture_events", row.idempotency_key, "capture_identity_mismatch");
  }
}

function legacyToolStatus(row: CaptureRow): "completed" | "error" {
  requireSourceMessage(row.source_message_id, "capture_events", row.idempotency_key);
  if (!row.source_tool_call_id) fail("capture_events", row.idempotency_key, "capture_identity_invalid");
  const completed = legacyCaptureKey([
    "tool",
    row.binding_key,
    row.source_session_id,
    row.source_message_id,
    row.source_tool_call_id,
    "completed",
  ]);
  const errored = legacyCaptureKey([
    "tool",
    row.binding_key,
    row.source_session_id,
    row.source_message_id,
    row.source_tool_call_id,
    "error",
  ]);
  if (row.idempotency_key === completed) return "completed";
  if (row.idempotency_key === errored) return "error";
  fail("capture_events", row.idempotency_key, "capture_identity_mismatch");
}

function legacyCaptureKey(fields: readonly string[]): string {
  return sha256(["capture/1", ...fields].join("\0"));
}

function captureKeyFromPayload(
  eventKind: string,
  bindingKey: string,
  source: Record<string, unknown>,
  signal: unknown,
): string {
  const sessionID = source.sessionID;
  const messageID = source.messageID;
  if (typeof sessionID !== "string" || !sessionID) throw new Error("invalid source");
  if (eventKind === "user-candidate") {
    if (typeof messageID !== "string" || !messageID || hasOwn(source, "ordinal") || hasOwn(source, "toolCallID")) {
      throw new Error("invalid source");
    }
    return captureIdempotencyKey({ kind: "user", bindingKey, sessionID, messageID });
  }
  if (eventKind === "assistant-candidate") {
    if (typeof messageID !== "string" || !messageID || typeof source.ordinal !== "number" || hasOwn(source, "toolCallID")) {
      throw new Error("invalid source");
    }
    return captureIdempotencyKey({
      kind: "assistant",
      bindingKey,
      sessionID,
      assistantMessageID: messageID,
      ordinal: source.ordinal,
    });
  }
  if (eventKind === "session-summary") {
    if (typeof messageID !== "string" || !messageID || hasOwn(source, "ordinal") || hasOwn(source, "toolCallID")) {
      throw new Error("invalid source");
    }
    return captureIdempotencyKey({ kind: "summary", bindingKey, sessionID, checkpointMessageID: messageID });
  }
  if (eventKind === "tool-signal") {
    const status = signal && typeof signal === "object" ? (signal as { status?: unknown }).status : undefined;
    const toolCallID = source.toolCallID;
    if (
      typeof messageID !== "string" ||
      !messageID ||
      typeof toolCallID !== "string" ||
      !toolCallID ||
      hasOwn(source, "ordinal") ||
      (status !== "completed" && status !== "error")
    ) {
      throw new Error("invalid source");
    }
    return captureIdempotencyKey({
      kind: "tool",
      bindingKey,
      sessionID,
      assistantMessageID: messageID,
      toolCallID,
      terminalStatus: status,
    });
  }
  throw new Error("invalid event kind");
}

function replaceWithV11(db: Database, rows: MigratedRows): void {
  db.exec(`
    DROP TRIGGER IF EXISTS notes_fts_ai;
    DROP TRIGGER IF EXISTS notes_fts_ad;
    DROP TRIGGER IF EXISTS notes_fts_au;
    DROP TABLE IF EXISTS notes_fts;
    DROP TABLE IF EXISTS index_outbox;
    DROP TABLE IF EXISTS note_revisions;
    DROP TABLE IF EXISTS note_provenance;
    DROP TABLE IF EXISTS capture_events;
    DROP TABLE IF EXISTS capture_checkpoints;
    DROP TABLE IF EXISTS project_bindings;
    DROP TABLE IF EXISTS note_edges;
    DROP TABLE IF EXISTS notes;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS schema_state;
    DROP TABLE IF EXISTS agz_meta;
  `);
  db.exec(SCHEMA_V11_TABLES);
  db.exec(FTS_V9);

  for (const row of rows.projects) {
    insertRow("projects", row.id, () => {
      db.query(
        "INSERT INTO projects (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(row.id, row.name, row.normalized_name, row.created_at, row.updated_at);
    });
  }
  for (const row of rows.notes) {
    insertRow("notes", row.id, () => {
      db.query(
        `INSERT INTO notes
           (id, project_id, kind, title, summary, content, size_class, pinned, status,
            supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.project_id,
        row.kind,
        row.title,
        row.summary,
        row.content,
        row.size_class,
        row.pinned,
        row.status,
        row.supersedes_id,
        row.current_revision,
        row.subject_key,
        row.content_hash,
        row.created_at,
        row.updated_at,
      );
    });
  }
  for (const row of rows.bindings) {
    insertRow("project_bindings", row.binding_key, () => {
      db.query(
        `INSERT INTO project_bindings
           (binding_key, project_id, source, source_project_id, workspace_id,
            canonical_path_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.binding_key,
        row.project_id,
        row.source,
        row.source_project_id,
        row.workspace_id,
        row.canonical_path_hash,
        row.created_at,
        row.updated_at,
      );
    });
  }
  for (const row of rows.checkpoints) {
    insertRow("capture_checkpoints", row.session_id, () => {
      db.query(
        `INSERT INTO capture_checkpoints
           (session_id, binding_key, project_id, state, last_message_id,
            last_reconciled_at, next_reconcile_at, failure_count, lease_owner,
            lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.session_id,
        row.binding_key,
        row.project_id,
        row.state,
        row.last_message_id,
        row.last_reconciled_at,
        row.next_reconcile_at,
        row.failure_count,
        row.lease_owner,
        row.lease_expires_at,
        row.created_at,
        row.updated_at,
      );
    });
  }
  for (const row of rows.captures) {
    insertRow("capture_events", row.idempotency_key, () => {
      db.query(
        `INSERT INTO capture_events
           (idempotency_key, contract, project_id, binding_key, event_kind,
            source_session_id, source_message_id, source_ordinal, source_tool_call_id,
            payload_json, payload_hash, redaction_version, state, attempt_count,
            note_id, last_error_code, generation, created_at, updated_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.idempotency_key,
        row.contract,
        row.project_id,
        row.binding_key,
        row.event_kind,
        row.source_session_id,
        row.source_message_id,
        row.source_ordinal,
        row.source_tool_call_id,
        row.payload_json,
        row.payload_hash,
        row.redaction_version,
        row.state,
        row.attempt_count,
        row.note_id,
        row.last_error_code,
        row.generation,
        row.created_at,
        row.updated_at,
        row.processed_at,
      );
    });
  }
  for (const row of rows.provenance) {
    insertRow("note_provenance", row.id, () => {
      db.query(
        `INSERT INTO note_provenance
           (id, project_id, note_id, source_type, capture_event_id, source_session_id,
            source_message_id, source_ordinal, source_tool_call_id, redaction_version,
            extractor_version, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.project_id,
        row.note_id,
        row.source_type,
        row.capture_event_id,
        row.source_session_id,
        row.source_message_id,
        row.source_ordinal,
        row.source_tool_call_id,
        row.redaction_version,
        row.extractor_version,
        row.confidence,
        row.created_at,
      );
    });
  }
  for (const row of rows.revisions) {
    insertRow("note_revisions", row.note_id, () => {
      db.query(
        `INSERT INTO note_revisions
           (project_id, note_id, revision, kind, title, summary, content, size_class,
            pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.project_id,
        row.note_id,
        row.revision,
        row.kind,
        row.title,
        row.summary,
        row.content,
        row.size_class,
        row.pinned,
        row.status,
        row.supersedes_id,
        row.subject_key,
        row.content_hash,
        row.provenance_id,
        row.created_at,
      );
    });
  }
  for (const row of rows.edges) {
    insertRow("note_edges", row.id, () => {
      db.query(
        "INSERT INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(row.id, row.project_id, row.source_id, row.target_id, row.predicate, row.created_at);
    });
  }
  for (const row of rows.outbox as Array<OutboxRow & {
    operation_key: string;
    generation: number;
    lease_generation: number;
    fence: number;
    heartbeat_at: number | null;
  }>) {
    insertRow("index_outbox", String(row.id), () => {
      db.query(
        `INSERT INTO index_outbox
           (id, backend, operation_key, operation, project_id, note_id, revision,
            content_hash, generation, lease_generation, fence, state, attempt_count,
            available_at, lease_owner, lease_expires_at, heartbeat_at, last_error_code,
            created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.backend,
        row.operation_key,
        row.operation,
        row.project_id,
        row.note_id,
        row.revision,
        row.content_hash,
        row.generation,
        row.lease_generation,
        row.fence,
        row.state,
        row.attempt_count,
        row.available_at,
        row.lease_owner,
        row.lease_expires_at,
        row.heartbeat_at,
        row.last_error_code,
        row.created_at,
        row.completed_at,
      );
    });
  }
  rebuildFts(db);
  db.query("INSERT INTO schema_state(version) VALUES (11)").run();
  insertV11Identity(db);
}

function revisionKey(projectID: string, noteID: string, revision: number): string {
  return `${projectID.length}:${projectID}:${noteID.length}:${noteID}:${revision}`;
}

function noteKey(projectID: string, noteID: string): string {
  return `${projectID.length}:${projectID}:${noteID.length}:${noteID}`;
}

function requireTable(db: Database, table: string): void {
  if (!hasTable(db, table)) fail(table, "schema", "source_schema");
}

function hasTable(db: Database, table: string): boolean {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(table) as { count: number };
  return row.count > 0;
}

function selectRows<T>(db: Database, table: string, sql: string): T[] {
  try {
    return db.query(sql).all() as T[];
  } catch {
    fail(table, "schema", "source_schema");
  }
}

function insertRow(table: string, identity: string, insert: () => void): void {
  try {
    insert();
  } catch {
    fail(table, identity, "row_constraint");
  }
}

function requireString(value: unknown, table: string, identity: string, code: string): asserts value is string {
  if (typeof value !== "string") fail(table, identity, code);
}

function requireNonEmptyString(
  value: unknown,
  table: string,
  identity: string,
  code: string,
): asserts value is string {
  requireString(value, table, identity, code);
  if (value.length === 0) fail(table, identity, code);
}

function requireNullableString(
  value: unknown,
  table: string,
  identity: string,
  code: string,
): asserts value is string | null {
  if (value !== null && typeof value !== "string") fail(table, identity, code);
}

function requireInteger(value: unknown, table: string, identity: string, code: string): asserts value is number {
  if (!Number.isSafeInteger(value)) fail(table, identity, code);
}

function requireNullableInteger(
  value: unknown,
  table: string,
  identity: string,
  code: string,
): asserts value is number | null {
  if (value !== null && !Number.isSafeInteger(value)) fail(table, identity, code);
}

function requireIntegerAtLeast(
  value: unknown,
  minimum: number,
  table: string,
  identity: string,
  code: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(table, identity, code);
  }
}

function requireHash(value: unknown, table: string, identity: string, code: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) fail(table, identity, code);
}

function requireKind(value: unknown, table: string, identity: string): asserts value is string {
  if (typeof value !== "string" || !KINDS_SET.has(value)) fail(table, identity, "kind_invalid");
}

function requireSourceMessage(value: string | null, table: string, identity: string): asserts value is string {
  if (typeof value !== "string" || !value) fail(table, identity, "capture_identity_invalid");
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function legacyNoteContentHash(kind: string, title: string, summary: string, content: string): string {
  return createHash("sha256").update(`${kind}\0${title}\0${summary}\0${content}`, "utf8").digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function capturePayloadHash(event: ReturnType<typeof parseCaptureEvent>): string {
  const canonical = structuredClone(event);
  canonical.source.observedAt = 0;
  return hashTuple("capture-payload", 2, [JSON.stringify(canonical)]);
}

function fail(table: string, identity: unknown, code: string): never {
  const safeIdentity =
    typeof identity === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(identity) ? identity : "redacted";
  throw new Error(`schema_v11_migration_${code} table=${table} row=${safeIdentity}`);
}

import type { Database } from "bun:sqlite";
import { deriveDocument } from "../retrieval/derived";
import { hashTuple, noteContentHash } from "../hash";
import { assertSchemaV11, inspectDatabase, hasTable } from "../db/health";
import { SCHEMA_VERSION } from "../types";

export interface DoctorReport {
  ok: boolean;
  health: ReturnType<typeof inspectDatabase>;
  warnings: string[];
  failures: string[];
  invariants: Record<string, number>;
}

export function doctorDatabase(db: Database): DoctorReport {
  const health = inspectDatabase(db);
  const warnings: string[] = [];
  const failures: string[] = [];
  const invariants: Record<string, number> = {};
  if (health.integrity !== "ok") failures.push("integrity_check_failed");
  if (health.foreignKeyViolations.length > 0) failures.push("foreign_key_violation");
  if (health.schemaVersion === undefined) failures.push("schema_state_missing");
  else if (health.schemaVersion > SCHEMA_VERSION) failures.push("schema_newer_than_runtime");
  else if (health.schemaVersion < SCHEMA_VERSION) warnings.push("schema_upgrade_required");
  if (health.schemaVersion === SCHEMA_VERSION) {
    try {
      assertSchemaV11(db);
    } catch {
      failures.push("schema_fingerprint_mismatch");
    }
  }

  if (hasTable(db, "notes_fts") && hasTable(db, "notes")) {
    invariants.notes = count(db, "SELECT COUNT(*) AS count FROM notes");
    invariants.fts = count(db, "SELECT COUNT(*) AS count FROM notes_fts");
    if (invariants.notes !== invariants.fts) failures.push("fts_count_mismatch");
  }
  if (health.schemaVersion === SCHEMA_VERSION) {
    invariants.missingCurrentRevisions = count(
      db,
      `SELECT COUNT(*) AS count
         FROM notes n
         LEFT JOIN note_revisions r
           ON r.project_id = n.project_id
          AND r.note_id = n.id
          AND r.revision = n.current_revision
        WHERE r.note_id IS NULL`,
    );
    invariants.noteContentHashMismatches = canonicalHashMismatches(db, "notes");
    invariants.revisionContentHashMismatches = canonicalHashMismatches(db, "note_revisions");
    invariants.currentRevisionMismatches = count(
      db,
      `SELECT COUNT(*) AS count
         FROM notes n
         JOIN note_revisions r
           ON r.project_id = n.project_id
          AND r.note_id = n.id
          AND r.revision = n.current_revision
        WHERE n.kind IS NOT r.kind
           OR n.title IS NOT r.title
           OR n.summary IS NOT r.summary
           OR n.content IS NOT r.content
           OR n.size_class IS NOT r.size_class
           OR n.pinned IS NOT r.pinned
           OR n.status IS NOT r.status
           OR n.supersedes_id IS NOT r.supersedes_id
           OR n.subject_key IS NOT r.subject_key
           OR n.content_hash IS NOT r.content_hash`,
    );
    invariants.revisionGaps = count(
      db,
      `SELECT COUNT(*) AS count FROM (
         SELECT n.project_id, n.id
           FROM notes n
           LEFT JOIN note_revisions r
             ON r.project_id = n.project_id AND r.note_id = n.id
          GROUP BY n.project_id, n.id, n.current_revision
         HAVING COUNT(r.revision) <> n.current_revision
             OR MIN(r.revision) IS NOT 1
             OR MAX(r.revision) IS NOT n.current_revision
       )`,
    );
    invariants.missingProvenance = count(
      db,
      `SELECT COUNT(*) AS count
         FROM note_revisions r
         LEFT JOIN note_provenance p
           ON p.project_id = r.project_id AND p.id = r.provenance_id
        WHERE p.id IS NULL`,
    );
    invariants.bindingConflicts = count(
      db,
      `SELECT COUNT(*) AS count FROM (
         SELECT source, source_project_id, workspace_id
           FROM project_bindings
          GROUP BY source, source_project_id, workspace_id
         HAVING COUNT(DISTINCT project_id) > 1
       )`,
    );
    invariants.deadOutbox = count(
      db,
      "SELECT COUNT(*) AS count FROM index_outbox WHERE state = 'dead'",
    );
    invariants.invalidOutboxOperations = count(
      db,
      `SELECT COUNT(*) AS count FROM index_outbox
        WHERE (operation = 'upsert-note'
               AND (note_id IS NULL OR revision IS NULL OR revision < 1
                    OR content_hash IS NULL OR length(content_hash) <> 64))
           OR (operation = 'delete-note'
               AND (note_id IS NULL OR revision IS NULL OR revision < 1
                    OR content_hash IS NOT NULL))
           OR (operation = 'purge-project'
               AND (note_id IS NOT NULL OR revision IS NOT NULL OR content_hash IS NOT NULL))
           OR operation NOT IN ('upsert-note', 'delete-note', 'purge-project')`,
    );
    invariants.invalidOutboxLeases = count(
      db,
      `SELECT COUNT(*) AS count FROM index_outbox
        WHERE (state = 'leased' AND (lease_owner IS NULL OR lease_expires_at IS NULL))
           OR (state <> 'leased'
               AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL OR heartbeat_at IS NOT NULL))`,
    );
    invariants.orphanedOutboxProjects = count(
      db,
      `SELECT COUNT(*) AS count FROM index_outbox o
        LEFT JOIN projects p ON p.id = o.project_id
       WHERE p.id IS NULL`,
    );
    invariants.outboxOperationKeyMismatches = outboxOperationKeyMismatches(db);
    invariants.derivedHashMismatches = derivedHashMismatches(db);
    invariants.dueCheckpoints = count(
      db,
      "SELECT COUNT(*) AS count FROM capture_checkpoints WHERE next_reconcile_at <= ? AND state = 'active'",
      Date.now(),
    );
    for (const [name, value] of Object.entries(invariants)) {
      if (
        [
          "missingCurrentRevisions",
          "noteContentHashMismatches",
          "revisionContentHashMismatches",
          "currentRevisionMismatches",
          "revisionGaps",
          "missingProvenance",
          "bindingConflicts",
          "invalidOutboxOperations",
          "invalidOutboxLeases",
          "outboxOperationKeyMismatches",
          "derivedHashMismatches",
        ].includes(name) &&
        value > 0
      ) {
        failures.push(name);
      }
    }
  }
  return { ok: failures.length === 0, health, warnings, failures, invariants };
}

function canonicalHashMismatches(db: Database, table: "notes" | "note_revisions"): number {
  const rows = db
    .query(`SELECT kind, title, summary, content, content_hash FROM ${table}`)
    .iterate() as IterableIterator<{
    kind: string;
    title: string;
    summary: string;
    content: string;
    content_hash: string;
  }>;
  let mismatches = 0;
  for (const row of rows) {
    if (row.content_hash !== noteContentHash(row.kind, row.title, row.summary, row.content)) {
      mismatches++;
    }
  }
  return mismatches;
}

function count(db: Database, sql: string, ...bindings: Array<string | number>): number {
  return (db.query(sql).get(...bindings) as { count: number }).count;
}

function outboxOperationKeyMismatches(db: Database): number {
  const rows = db
    .query(
      `SELECT backend, operation, project_id, note_id, revision, content_hash,
              generation, operation_key
         FROM index_outbox
        ORDER BY id`,
    )
    .all() as Array<{
    backend: string;
    operation: "upsert-note" | "delete-note" | "purge-project";
    project_id: string;
    note_id: string | null;
    revision: number | null;
    content_hash: string | null;
    generation: number;
    operation_key: string;
  }>;
  let mismatches = 0;
  for (const row of rows) {
    const expected = hashTuple("outbox-operation", 2, [
      row.backend,
      row.operation,
      row.project_id,
      row.note_id,
      row.revision,
      row.content_hash,
      row.generation,
    ]);
    if (row.operation_key !== expected) mismatches++;
  }
  return mismatches;
}

function derivedHashMismatches(db: Database): number {
  const rows = db
    .query(
      `SELECT o.content_hash, n.project_id, n.id, n.current_revision,
              n.kind, n.title, n.summary, n.content
         FROM index_outbox o
         JOIN notes n ON n.project_id = o.project_id AND n.id = o.note_id
        WHERE o.operation = 'upsert-note'
          AND o.state IN ('pending', 'leased')
          AND n.status = 'active'
          AND n.current_revision = o.revision`,
    )
    .all() as Array<{
    content_hash: string | null;
    project_id: string;
    id: string;
    current_revision: number;
    kind: string;
    title: string;
    summary: string;
    content: string;
  }>;
  let mismatches = 0;
  for (const row of rows) {
    const document = deriveDocument({
      projectID: row.project_id,
      noteID: row.id,
      revision: row.current_revision,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      content: row.content,
    });
    if (!document || document.contentHash !== row.content_hash) mismatches++;
  }
  return mismatches;
}

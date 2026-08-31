import type { Database } from "bun:sqlite";
import { inspectDatabase, hasTable } from "../db/health";
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
    invariants.dueCheckpoints = count(
      db,
      "SELECT COUNT(*) AS count FROM capture_checkpoints WHERE next_reconcile_at <= ? AND state = 'active'",
      Date.now(),
    );
    for (const [name, value] of Object.entries(invariants)) {
      if (["missingCurrentRevisions", "missingProvenance", "bindingConflicts"].includes(name) && value > 0) {
        failures.push(name);
      }
    }
  }
  return { ok: failures.length === 0, health, warnings, failures, invariants };
}

function count(db: Database, sql: string, ...bindings: Array<string | number>): number {
  return (db.query(sql).get(...bindings) as { count: number }).count;
}

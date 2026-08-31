import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { DerivedDocument, RetrievalBackend } from "../retrieval/contract";
import { deriveDocument } from "../retrieval/derived";

export type OutboxOutcome = "idle" | "succeeded" | "stale" | "quarantined" | "retry" | "dead";

export class OutboxWorker {
  private readonly workerID = randomUUID();

  constructor(
    private db: Database,
    private backends: ReadonlyMap<string, RetrievalBackend>,
    private now: () => number = Date.now,
    private random: () => number = Math.random,
  ) {}

  async processNext(): Promise<OutboxOutcome> {
    const now = this.now();
    const leaseExpiresAt = now + 30_000;
    const row = this.db.query(`
      UPDATE index_outbox
         SET state = 'leased', lease_owner = ?, lease_expires_at = ?,
             attempt_count = attempt_count + 1
       WHERE id = (
         SELECT candidate.id
           FROM index_outbox candidate
          WHERE ((candidate.state = 'pending' AND candidate.available_at <= ?)
              OR (candidate.state = 'leased' AND candidate.lease_expires_at <= ?))
            AND NOT EXISTS (
              SELECT 1 FROM index_outbox earlier
               WHERE earlier.backend = candidate.backend
                 AND earlier.project_id = candidate.project_id
                 AND earlier.id < candidate.id
                 AND earlier.state IN ('pending','leased')
            )
          ORDER BY candidate.backend, candidate.project_id, candidate.id
          LIMIT 1
       )
         AND ((state = 'pending' AND available_at <= ?)
           OR (state = 'leased' AND lease_expires_at <= ?))
      RETURNING *
    `).get(this.workerID, leaseExpiresAt, now, now, now, now) as OutboxRow | undefined;
    if (!row) return "idle";
    const backend = this.backends.get(row.backend);
    if (!backend) return this.fail(row, "backend_unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      if (row.operation === "purge-project") {
        await backend.purgeProject(row.project_id, controller.signal);
      } else if (row.operation === "delete-note") {
        if (!row.note_id) throw new Error("invalid_outbox_row");
        await backend.delete({ projectID: row.project_id, noteID: row.note_id }, controller.signal);
      } else {
        const note = this.db
          .query("SELECT * FROM notes WHERE project_id = ? AND id = ?")
          .get(row.project_id, row.note_id) as NoteRow | undefined;
        if (!note || note.current_revision !== row.revision || note.status !== "active") {
          this.succeed(row.id);
          return "stale";
        }
        const exported = exportDocument(note);
        if (!exported || exported.contentHash !== row.content_hash) {
          this.succeed(row.id);
          return exported ? "stale" : "quarantined";
        }
        await backend.upsert(exported, controller.signal);
      }
      this.succeed(row.id);
      return "succeeded";
    } catch (error) {
      return this.fail(row, sanitizeError(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private succeed(id: number): void {
    this.db.query(`
      UPDATE index_outbox
         SET state = 'succeeded', completed_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error_code = NULL
       WHERE id = ? AND lease_owner = ?
    `).run(this.now(), id, this.workerID);
  }

  private fail(row: OutboxRow, errorCode: string): "retry" | "dead" {
    const dead = row.attempt_count >= 10;
    const availableAt = this.now() + retryDelay(row.attempt_count, this.random());
    this.db.query(`
      UPDATE index_outbox
         SET state = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = ?, completed_at = ?
       WHERE id = ? AND lease_owner = ?
    `).run(
      dead ? "dead" : "pending",
      availableAt,
      errorCode,
      dead ? this.now() : null,
      row.id,
      this.workerID,
    );
    return dead ? "dead" : "retry";
  }
}

function exportDocument(note: NoteRow): DerivedDocument | undefined {
  return deriveDocument({
    projectID: note.project_id,
    noteID: note.id,
    revision: note.current_revision,
    kind: note.kind,
    title: note.title,
    summary: note.summary,
    content: note.content,
  });
}

function retryDelay(attempt: number, random: number): number {
  if (attempt <= 1) return 0;
  const base = attempt === 2 ? 1_000 : attempt === 3 ? 5_000 : attempt === 4 ? 30_000 : Math.min(900_000, 30_000 * 2 ** (attempt - 4));
  return Math.floor(base * (0.9 + random * 0.2));
}

function sanitizeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|unauthorized|forbidden/i.test(message)) return "authentication";
  if (/invalid|malformed|schema/i.test(message)) return "invalid_response";
  return "backend_failure";
}

interface OutboxRow {
  id: number;
  backend: string;
  operation: "upsert-note" | "delete-note" | "purge-project";
  project_id: string;
  note_id: string | null;
  revision: number | null;
  content_hash: string | null;
  attempt_count: number;
}

interface NoteRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  status: string;
  current_revision: number;
  content_hash: string;
}

import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type {
  BackendOperationContext,
  DerivedDocument,
  OutboxBackend,
} from "../retrieval/contract";
import { deriveDocument } from "../retrieval/derived";

const LEASE_DURATION_MS = 30_000;
const BACKEND_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export type OutboxOutcome =
  | "idle"
  | "succeeded"
  | "stale"
  | "quarantined"
  | "retry"
  | "dead"
  | "lost_lease";

export class OutboxWorker {
  private readonly workerID = randomUUID();

  constructor(
    private db: Database,
    private backends: ReadonlyMap<string, OutboxBackend>,
    private now: () => number = Date.now,
    private random: () => number = Math.random,
  ) {
    for (const backend of backends.values()) {
      if (backend.outboxProtocol !== "agz-memory-outbox/1") {
        throw new Error("outbox_backend_fencing_required");
      }
    }
  }

  async processNext(): Promise<OutboxOutcome> {
    const row = this.claim(this.now());
    if (!row) return "idle";

    const backend = this.backends.get(row.backend);
    if (!backend) return this.fail(row, "backend_unavailable");

    const controller = new AbortController();
    const operation: BackendOperationContext = {
      operationKey: row.operation_key,
      sequence: row.id,
      fence: row.fence,
    };
    let lostLease = false;
    const heartbeat = setInterval(() => {
      if (lostLease) return;
      try {
        const heartbeatAt = this.now();
        const result = this.db
          .query(
            `UPDATE index_outbox
                SET heartbeat_at = ?, lease_expires_at = ?
              WHERE id = ? AND state = 'leased' AND lease_owner = ?
                AND lease_generation = ? AND fence = ?`,
          )
          .run(
            heartbeatAt,
            heartbeatAt + LEASE_DURATION_MS,
            row.id,
            this.workerID,
            row.lease_generation,
            row.fence,
          );
        if (result.changes !== 1) {
          lostLease = true;
          controller.abort();
        }
      } catch {
        lostLease = true;
        controller.abort();
      }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      if (row.operation === "purge-project") {
        await this.runBackend(
          (signal) => backend.purgeProject(row.project_id, signal, operation),
          controller,
        );
      } else if (row.operation === "delete-note") {
        if (!row.note_id) throw new Error("invalid_outbox_row");
        await this.runBackend(
          (signal) =>
            backend.delete(
              { projectID: row.project_id, noteID: row.note_id! },
              signal,
              operation,
            ),
          controller,
        );
      } else {
        const note = this.db
          .query("SELECT * FROM notes WHERE project_id = ? AND id = ?")
          .get(row.project_id, row.note_id) as NoteRow | undefined;
        if (!note || note.current_revision !== row.revision || note.status !== "active") {
          return this.stale(row, lostLease);
        }
        const exported = exportDocument(note);
        if (!exported || exported.contentHash !== row.content_hash) {
          return this.stale(row, lostLease, exported ? "stale" : "quarantined");
        }
        await this.runBackend(
          (signal) => backend.upsert(exported, signal, operation),
          controller,
        );
      }

      if (lostLease) return "lost_lease";
      return this.succeed(row);
    } catch (error) {
      if (lostLease) return "lost_lease";
      return this.fail(row, sanitizeError(error));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private claim(now: number): OutboxRow | undefined {
    const leaseExpiresAt = now + LEASE_DURATION_MS;
    return this.db
      .query(`
        UPDATE index_outbox
           SET state = 'leased', lease_owner = ?, lease_expires_at = ?,
               heartbeat_at = ?, lease_generation = lease_generation + 1,
               fence = fence + 1, attempt_count = attempt_count + 1
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
           AND ((index_outbox.state = 'pending' AND index_outbox.available_at <= ?)
             OR (index_outbox.state = 'leased' AND index_outbox.lease_expires_at <= ?))
         RETURNING *
      `)
      .get(this.workerID, leaseExpiresAt, now, now, now, now, now) as OutboxRow | undefined;
  }

  private async runBackend<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    return withHardTimeout(operation, controller, BACKEND_TIMEOUT_MS);
  }

  private stale(
    row: OutboxRow,
    lostLease: boolean,
    outcome: "stale" | "quarantined" = "stale",
  ): OutboxOutcome {
    if (lostLease) return "lost_lease";
    const transition = this.succeed(row);
    return transition === "succeeded" ? outcome : transition;
  }

  private succeed(row: OutboxRow): "succeeded" | "lost_lease" {
    const result = this.db
      .query(`
        UPDATE index_outbox
           SET state = 'succeeded', completed_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, heartbeat_at = NULL, last_error_code = NULL
         WHERE id = ? AND state = 'leased' AND lease_owner = ?
           AND lease_generation = ? AND fence = ?
      `)
      .run(this.now(), row.id, this.workerID, row.lease_generation, row.fence);
    return result.changes === 1 ? "succeeded" : "lost_lease";
  }

  private fail(row: OutboxRow, errorCode: string): "retry" | "dead" | "lost_lease" {
    const dead = row.attempt_count >= 10;
    const availableAt = this.now() + retryDelay(row.attempt_count, this.random());
    const result = this.db
      .query(`
        UPDATE index_outbox
           SET state = ?, available_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, heartbeat_at = NULL,
               last_error_code = ?, completed_at = ?
         WHERE id = ? AND state = 'leased' AND lease_owner = ?
           AND lease_generation = ? AND fence = ?
      `)
      .run(
        dead ? "dead" : "pending",
        availableAt,
        errorCode,
        dead ? this.now() : null,
        row.id,
        this.workerID,
        row.lease_generation,
        row.fence,
      );
    if (result.changes !== 1) return "lost_lease";
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
  const base =
    attempt === 2
      ? 1_000
      : attempt === 3
        ? 5_000
        : attempt === 4
          ? 30_000
          : Math.min(900_000, 30_000 * 2 ** (attempt - 4));
  return Math.floor(base * (0.9 + random * 0.2));
}

function sanitizeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|deadline/i.test(message)) return "timeout";
  if (/auth|unauthorized|forbidden/i.test(message)) return "authentication";
  if (/invalid|malformed|schema/i.test(message)) return "invalid_response";
  return "backend_failure";
}

async function withHardTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const pending = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await new Promise<T>((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (timer) clearTimeout(timer);
        callback();
      };
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        finish(() => reject(new Error("backend_timeout")));
      }, timeoutMs);
      pending.then(
        (value) => {
          if (timedOut) return;
          finish(() => resolve(value));
        },
        (error) => {
          if (timedOut) return;
          finish(() => reject(error));
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface OutboxRow {
  id: number;
  backend: string;
  operation_key: string;
  operation: "upsert-note" | "delete-note" | "purge-project";
  project_id: string;
  note_id: string | null;
  revision: number | null;
  content_hash: string | null;
  generation: number;
  lease_generation: number;
  fence: number;
  state: "pending" | "leased" | "succeeded" | "dead";
  attempt_count: number;
  available_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
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
}

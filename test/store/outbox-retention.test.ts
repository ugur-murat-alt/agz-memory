import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import type {
  BackendHealth,
  BackendOperationContext,
  DerivedDocument,
  DerivedRef,
  OutboxBackend,
  RankedHit,
} from "../../src/retrieval/contract";
import { OutboxWorker } from "../../src/store/outbox";

describe("outbox terminal retention", () => {
  test("prunes oldest terminal rows after success and dead transitions without touching active evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-outbox-retention-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    let now = 100;
    try {
      const insert = opened.db.query(`
        INSERT INTO index_outbox
          (backend, operation_key, operation, project_id, generation, lease_generation,
           fence, state, attempt_count, available_at, lease_owner, lease_expires_at,
           heartbeat_at, completed_at, created_at)
        VALUES (?, ?, 'purge-project', ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertTerminal = (state: "succeeded" | "dead", completedAt: number) =>
        insert.run("archive", keyFor(completedAt), `archive-${completedAt}`, state, 1, 0, null, null, null, completedAt, completedAt);

      opened.db.transaction(() => {
        insertTerminal("succeeded", 1);
        insertTerminal("dead", 2);
        insertTerminal("succeeded", 3);
        insertTerminal("dead", 4);
        insert.run("evidence", keyFor(5), "pending-evidence", "pending", 0, 10_000, null, null, null, null, 5);
        insert.run("evidence", keyFor(6), "leased-evidence", "leased", 1, 0, "other-worker", 10_000, 0, null, 6);
        insert.run("worker", keyFor(7), "success", "pending", 0, 0, null, null, null, null, 7);
      })();

      const backend = new RetentionBackend();
      const worker = new OutboxWorker(
        opened.db,
        new Map([[backend.id, backend]]),
        () => now++,
        () => 0,
        { terminalRetention: 3, terminalPruneInterval: 1 },
      );

      expect(await worker.processNext()).toBe("succeeded");

      insert.run("worker", keyFor(8), "dead", "pending", 9, 0, null, null, null, null, 8);
      backend.fail = true;
      expect(await worker.processNext()).toBe("dead");

      const terminalRows = opened.db.query(`
        SELECT operation_key, state FROM index_outbox
         WHERE state IN ('succeeded', 'dead')
         ORDER BY completed_at, id
      `).all() as Array<{ operation_key: string; state: string }>;
      expect(terminalRows).toEqual([
        { operation_key: keyFor(4), state: "dead" },
        { operation_key: keyFor(7), state: "succeeded" },
        { operation_key: keyFor(8), state: "dead" },
      ]);
      expect(opened.db.query("SELECT state FROM index_outbox WHERE operation_key = ?").all(keyFor(5))).toEqual([
        { state: "pending" },
      ]);
      expect(opened.db.query("SELECT state FROM index_outbox WHERE operation_key = ?").all(keyFor(6))).toEqual([
        { state: "leased" },
      ]);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function keyFor(value: number): string {
  return value.toString(16).padStart(64, "0");
}

class RetentionBackend implements OutboxBackend {
  readonly id = "worker";
  readonly outboxProtocol = "agz-memory-outbox/1" as const;
  fail = false;

  async upsert(_document: DerivedDocument, _signal: AbortSignal, _operation: BackendOperationContext): Promise<void> {}
  async delete(_ref: DerivedRef, _signal: AbortSignal, _operation: BackendOperationContext): Promise<void> {}
  async purgeProject(_projectID: string, _signal: AbortSignal, _operation: BackendOperationContext): Promise<void> {
    if (this.fail) throw new Error("backend failure");
  }
  async query(): Promise<RankedHit[]> {
    return [];
  }
  async health(): Promise<BackendHealth> {
    return { ok: true };
  }
}

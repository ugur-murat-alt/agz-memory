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
import { MemoryStore } from "../../src/store";
import { OutboxWorker } from "../../src/store/outbox";

describe("outbox worker", () => {
  test("delivers project FIFO operations idempotently and leaves canonical writes committed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-outbox-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const backend = new FakeBackend();
    const store = new MemoryStore(opened.db, [backend.id]);
    const projectID = store.createProject("Outbox").project!.projectID;
    const noteID = store.update(projectID, {
      operation: "create",
      kind: "fact",
      title: "outbox",
      summary: "outbox",
    }).id!;
    store.pin(projectID, noteID, true);
    store.update(projectID, { operation: "delete", id: noteID });
    store.deleteProject(projectID, "Outbox");
    const worker = new OutboxWorker(opened.db, new Map([[backend.id, backend]]));
    const outcomes: string[] = [];
    while (true) {
      const outcome = await worker.processNext();
      if (outcome === "idle") break;
      outcomes.push(outcome);
    }
    expect(outcomes).toEqual(["stale", "stale", "succeeded", "succeeded"]);
    expect(backend.operations.map((value) => value.split(":").slice(0, -2).join(":"))).toEqual([
      `delete:${projectID}:${noteID}`,
      `purge:${projectID}`,
    ]);
    const contexts = backend.operations.map((value) => value.split(":").slice(-2).map(Number));
    expect(contexts[0]![0]).toBeLessThan(contexts[1]![0]!);
    expect(contexts.map(([, fence]) => fence)).toEqual([1, 1]);
    expect(
      (
        opened.db
          .query("SELECT COUNT(*) AS count FROM index_outbox WHERE state = 'succeeded'")
          .get() as { count: number }
      ).count,
    ).toBe(4);
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

class FakeBackend implements OutboxBackend {
  readonly id = "fake@1";
  readonly outboxProtocol = "agz-memory-outbox/1";
  readonly operations: string[] = [];
  async upsert(document: DerivedDocument, _signal: AbortSignal, operation: BackendOperationContext): Promise<void> {
    this.operations.push(`upsert:${document.projectID}:${document.noteID}:${document.revision}:${operation.sequence}:${operation.fence}`);
  }
  async delete(ref: DerivedRef, _signal: AbortSignal, operation: BackendOperationContext): Promise<void> {
    this.operations.push(`delete:${ref.projectID}:${ref.noteID}:${operation.sequence}:${operation.fence}`);
  }
  async purgeProject(projectID: string, _signal: AbortSignal, operation: BackendOperationContext): Promise<void> {
    this.operations.push(`purge:${projectID}:${operation.sequence}:${operation.fence}`);
  }
  async query(): Promise<RankedHit[]> {
    return [];
  }
  async health(): Promise<BackendHealth> {
    return { ok: true };
  }
}

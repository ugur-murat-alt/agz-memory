import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import type {
  BackendHealth,
  DerivedDocument,
  DerivedRef,
  RankedHit,
  RetrievalBackend,
} from "../../src/retrieval/contract";
import { MemoryStore } from "../../src/store";
import { OutboxWorker } from "../../src/store/outbox";

describe("outbox worker", () => {
  test("delivers project FIFO operations idempotently and leaves canonical writes committed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-outbox-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const backend = new FakeBackend();
    const store = new MemoryStore(opened.db, [backend.id]);
    const projectID = store.createProject("Outbox").project!.projectID;
    const noteID = store.update(projectID, {
      kind: "fact",
      title: "outbox",
      summary: "outbox",
    }).id!;
    store.pin(projectID, noteID, true);
    store.update(projectID, { id: noteID, delete: true });
    store.deleteProject(projectID, "Outbox");
    const worker = new OutboxWorker(opened.db, new Map([[backend.id, backend]]));
    const outcomes: string[] = [];
    while (true) {
      const outcome = await worker.processNext();
      if (outcome === "idle") break;
      outcomes.push(outcome);
    }
    expect(outcomes).toEqual(["stale", "stale", "succeeded", "succeeded"]);
    expect(backend.operations).toEqual([`delete:${projectID}:${noteID}`, `purge:${projectID}`]);
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

class FakeBackend implements RetrievalBackend {
  readonly id = "fake@1";
  readonly operations: string[] = [];
  async upsert(document: DerivedDocument): Promise<void> {
    this.operations.push(`upsert:${document.projectID}:${document.noteID}:${document.revision}`);
  }
  async delete(ref: DerivedRef): Promise<void> {
    this.operations.push(`delete:${ref.projectID}:${ref.noteID}`);
  }
  async purgeProject(projectID: string): Promise<void> {
    this.operations.push(`purge:${projectID}`);
  }
  async query(): Promise<RankedHit[]> {
    return [];
  }
  async health(): Promise<BackendHealth> {
    return { ok: true };
  }
}

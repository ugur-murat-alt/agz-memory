import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { evaluate } from "../../benchmark/evaluate";
import { runAdmin } from "../../src/admin/index";
import { openMemoryDatabase } from "../../src/db";
import { deriveDocument } from "../../src/retrieval/derived";
import { formatUntrustedContext } from "../../src/retrieval/formatter";
import { hashTuple } from "../../src/hash";
import type {
  BackendHealth,
  BackendOperationContext,
  DerivedDocument,
  DerivedRef,
  OutboxBackend,
  RankedHit,
  RetrievalBackend,
} from "../../src/retrieval/contract";
import { weightedReciprocalRankFusion } from "../../src/retrieval/fusion";
import { MemoryStore } from "../../src/store";
import { OutboxWorker } from "../../src/store/outbox";
import { RetrievalStore } from "../../src/store/retrieval";

describe("retrieval hardening regressions", () => {
  const reindexTest = process.platform === "win32" ? test.skip : test;
  test("AGZ-036 accepts a backend hash derived after redaction", async () => {
    const fixture = openFixture();
    try {
      const projectID = fixture.store.createProject("Derived hash").project!.projectID;
      const noteID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Redacted source",
        summary: "Derived retrieval document",
        content: "Bearer abcdefghijkl",
      }).id!;
      const row = fixture.opened.db.query(`
        SELECT current_revision, kind, title, summary, content, content_hash
          FROM notes
         WHERE id = ?
      `).get(noteID) as {
        current_revision: number;
        kind: string;
        title: string;
        summary: string;
        content: string;
        content_hash: string;
      };
      const derived = deriveDocument({
        projectID,
        noteID,
        revision: row.current_revision,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        content: row.content,
      });
      expect(derived).toBeDefined();
      expect(derived!.content).toContain("[REDACTED:bearer]");
      expect(derived!.contentHash).not.toBe(row.content_hash);

      const backend = backendWithQuery(async () => [
        {
          noteID,
          channel: "semantic" as const,
          rank: 1,
          revision: row.current_revision,
          contentHash: derived!.contentHash,
        },
      ]);
      const result = await new RetrievalStore(fixture.opened.db, backend).retrieve({
        projectID,
        query: "semantic-only",
        limit: 8,
        deadlineAt: Date.now() + 500,
        semantic: "on",
      });

      expect(result.cards.map((card) => card.id)).toEqual([noteID]);
      expect(result.rejectedBackendHits).toBe(0);
    } finally {
      closeFixture(fixture);
    }
  });

  test("AGZ-037 turns a malformed backend result into a lexical fallback", async () => {
    const fixture = openFixture();
    try {
      const projectID = fixture.store.createProject("Malformed result").project!.projectID;
      const noteID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Malformed backend fallback",
        summary: "The lexical result remains usable",
      }).id!;
      const backend = backendWithQuery(async () => null as unknown as RankedHit[]);
      const result = await new RetrievalStore(fixture.opened.db, backend).retrieve({
        projectID,
        query: "Malformed",
        limit: 8,
        deadlineAt: Date.now() + 500,
        semantic: "on",
      });

      expect(result.semanticFallback).toBe(true);
      expect(result.cards.map((card) => card.id)).toEqual([noteID]);
    } finally {
      closeFixture(fixture);
    }
  });

  test("AGZ-037 rejects a huge backend result before per-hit SQL work", async () => {
    const fixture = openFixture();
    try {
      const projectID = fixture.store.createProject("Huge result").project!.projectID;
      const noteID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Huge backend fallback",
        summary: "The lexical result remains bounded",
      }).id!;
      const hugeResult = Array.from({ length: 1_001 }, () => ({
        noteID,
        channel: "semantic" as const,
        rank: 1,
      }));
      const backend = backendWithQuery(async () => hugeResult);
      const queryCounter = instrumentQueries(fixture.opened.db);
      try {
        const result = await new RetrievalStore(fixture.opened.db, backend).retrieve({
          projectID,
          query: "Huge",
          limit: 8,
          deadlineAt: Date.now() + 1_000,
          semantic: "on",
        });

        expect(result.semanticFallback).toBe(true);
        expect(result.cards.map((card) => card.id)).toEqual([noteID]);
        expect(queryCounter.count()).toBeLessThanOrEqual(8);
      } finally {
        queryCounter.restore();
      }
    } finally {
      closeFixture(fixture);
    }
  });

  test("applies one deadline to the complete retrieval pipeline", async () => {
    const fixture = openFixture();
    const originalNow = Date.now;
    try {
      const projectID = fixture.store.createProject("Deadline").project!.projectID;
      fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Deadline lexical result",
        summary: "A result must not outlive the deadline",
      });
      const backend = backendWithQuery(async () => []);
      let clockReads = 0;
      Date.now = () => (clockReads++ < 2 ? 0 : 101);
      const result = await new RetrievalStore(fixture.opened.db, backend).retrieve({
        projectID,
        query: "Deadline",
        limit: 8,
        deadlineAt: 100,
        semantic: "on",
      });

      expect(result.cards).toEqual([]);
    } finally {
      Date.now = originalNow;
      closeFixture(fixture);
    }
  });

  test("uses bounded batch SQL when validating backend hits", async () => {
    const fixture = openFixture();
    try {
      const projectID = fixture.store.createProject("Batch SQL").project!.projectID;
      const noteIDs = Array.from({ length: 20 }, (_, index) =>
        fixture.store.update(projectID, {
          operation: "create",
          kind: "fact",
          title: `Semantic record ${index}`,
          summary: `Stored semantic summary ${index}`,
          content: `Stored semantic content ${index}`,
        }).id!,
      );
      const rows = fixture.opened.db.query(
        `SELECT id, current_revision, kind, title, summary, content
           FROM notes WHERE project_id = ? ORDER BY id`,
      ).all(projectID) as Array<{
        id: string;
        current_revision: number;
        kind: string;
        title: string;
        summary: string;
        content: string;
      }>;
      const hits = rows.map((row, index) => ({
        noteID: row.id,
        channel: "semantic" as const,
        rank: index + 1,
        revision: row.current_revision,
        contentHash: deriveDocument({
          projectID,
          noteID: row.id,
          revision: row.current_revision,
          kind: row.kind,
          title: row.title,
          summary: row.summary,
          content: row.content,
        })!.contentHash,
      }));
      const backend = backendWithQuery(async () => hits);
      const queryCounter = instrumentQueries(fixture.opened.db);
      try {
        const result = await new RetrievalStore(fixture.opened.db, backend).retrieve({
          projectID,
          query: "backend-only",
          limit: 8,
          deadlineAt: Date.now() + 1_000,
          semantic: "on",
        });

        expect(result.cards).toHaveLength(8);
        expect(queryCounter.count()).toBeLessThanOrEqual(8);
      } finally {
        queryCounter.restore();
      }
    } finally {
      closeFixture(fixture);
    }
  });

  test("keeps fused ordering stable under channel permutation", () => {
    const channels: RankedHit[] = [
      { noteID: "alpha", channel: "lexical", rank: 1 },
      { noteID: "alpha", channel: "semantic", rank: 1 },
      { noteID: "beta", channel: "lexical", rank: 2 },
    ];
    const forward = weightedReciprocalRankFusion(channels);
    const reverse = weightedReciprocalRankFusion([...channels].reverse());

    expect(forward.map((hit) => hit.noteID)).toEqual(["alpha", "beta"]);
    expect(reverse.map((hit) => hit.noteID)).toEqual(["alpha", "beta"]);
    expect(scores(forward)).toEqual(scores(reverse));
  });

  test("keeps directed graph endpoints intact in either retrieval direction", async () => {
    const fixture = openFixture();
    try {
      const projectID = fixture.store.createProject("Direction").project!.projectID;
      const sourceID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Origin source",
        summary: "Origin record",
      }).id!;
      const targetID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Destination target",
        summary: "Destination record",
      }).id!;
      expect(fixture.store.link(projectID, sourceID, targetID, "SUPPORTS").ok).toBe(true);

      const sourceResult = await new RetrievalStore(fixture.opened.db).retrieve({
        projectID,
        query: "Origin",
        limit: 8,
        deadlineAt: Date.now() + 500,
        semantic: "off",
      });
      const targetNeighbor = sourceResult.cards.find((card) => card.id === targetID);
      expect(targetNeighbor).toMatchObject({ id: targetID, via: "neighbor", predicates: ["SUPPORTS"] });

      const targetResult = await new RetrievalStore(fixture.opened.db).retrieve({
        projectID,
        query: "Destination",
        limit: 8,
        deadlineAt: Date.now() + 500,
        semantic: "off",
      });
      const sourceNeighbor = targetResult.cards.find((card) => card.id === sourceID);
      expect(sourceNeighbor).toMatchObject({ id: sourceID, via: "neighbor", predicates: ["SUPPORTS"] });
      expect(fixture.store.read(projectID, sourceID).edges).toMatchObject([
        { sourceID, targetID, predicate: "SUPPORTS" },
      ]);
    } finally {
      closeFixture(fixture);
    }
  });

  test("does not split a Unicode code point while formatting context", () => {
    const formatted = formatUntrustedContext(
      "unicode-project",
      [
        {
          id: "unicode-note",
          projectID: "unicode-project",
          projectName: "Unicode",
          kind: "fact",
          title: "Unicode",
          summary: "😀".repeat(100),
          sizeClass: "indexed",
          pinned: false,
          via: "match",
        },
      ],
      { maxCards: 1, maxCharacters: 280 },
    );

    expect(formatted).toBeDefined();
    expect(formatted).toContain("😀");
    expect(formatted).toEndWith("</agz-memory-context>");
    expect(hasUnpairedSurrogate(formatted!)).toBe(false);
  });

  test("AGZ-044 hard-times out a backend that ignores AbortSignal", async () => {
    const fixture = openFixture(["hung-backend"]);
    const originalSetTimeout = globalThis.setTimeout;
    const timerHost = globalThis as unknown as { setTimeout: typeof setTimeout };
    try {
      const projectID = fixture.store.createProject("Hard timeout").project!.projectID;
      fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Hung backend",
        summary: "The worker must return",
      });
      const backend = backendWithQuery(async () => [], "hung-backend");
      backend.upsert = async () => {
        await new Promise<void>(() => {});
      };
      const worker = new OutboxWorker(fixture.opened.db, new Map([[backend.id, backend]]));
      timerHost.setTimeout = ((handler: any, timeout?: number, ...args: any[]) =>
        originalSetTimeout(handler, Math.min(timeout ?? 0, 25), ...args)) as typeof setTimeout;
      const outcome = await Promise.race([
        worker.processNext(),
        new Promise<"test-timeout">((resolve) => originalSetTimeout(() => resolve("test-timeout"), 100)),
      ]);

      expect(outcome).toBe("retry");
    } finally {
      timerHost.setTimeout = originalSetTimeout;
      closeFixture(fixture);
    }
  });

  test("AGZ-045 fences a stolen lease and reports the lost lease", async () => {
    const fixture = openFixture(["lease-backend"]);
    try {
      const projectID = fixture.store.createProject("Lease fencing").project!.projectID;
      fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Lease row",
        summary: "Lease fencing record",
      });
      let callCount = 0;
      const operations: BackendOperationContext[] = [];
      let releaseFirst!: () => void;
      let firstStarted!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstStartedSignal = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const backend = backendWithQuery(async () => [], "lease-backend");
      backend.upsert = async (_document, _signal, operation) => {
        callCount++;
        if (!operation) throw new Error("missing outbox operation context");
        operations.push(operation);
        if (callCount === 1) {
          firstStarted();
          await firstGate;
          return;
        }
        throw new Error("backend failure");
      };
      const baseTime = Date.now();
      const firstWorker = new OutboxWorker(
        fixture.opened.db,
        new Map([[backend.id, backend]]),
        () => baseTime,
        () => 0.5,
      );
      const firstOutcomePromise = firstWorker.processNext();
      await firstStartedSignal;

      const secondWorker = new OutboxWorker(
        fixture.opened.db,
        new Map([[backend.id, backend]]),
        () => baseTime + 30_001,
        () => 0.5,
      );
      expect(await secondWorker.processNext()).toBe("retry");
      releaseFirst();
      const firstOutcome = await firstOutcomePromise;
      const row = fixture.opened.db.query(`
        SELECT state, lease_owner, last_error_code
          FROM index_outbox
         WHERE backend = ? AND project_id = ?
      `).get(backend.id, projectID) as {
        state: string;
        lease_owner: string | null;
        last_error_code: string | null;
      };

      expect(callCount).toBe(2);
      expect(operations.map(({ sequence }) => sequence)).toEqual([
        operations[0]!.sequence,
        operations[0]!.sequence,
      ]);
      expect(operations.map(({ fence }) => fence)).toEqual([1, 2]);
      expect(firstOutcome).not.toBe("succeeded");
      expect(row).toMatchObject({ state: "pending", lease_owner: null, last_error_code: "backend_failure" });
    } finally {
      closeFixture(fixture);
    }
  });

  reindexTest("AGZ-047 queues every active note despite old succeeded rows", async () => {
    const fixture = openFixture();
    const backendID = "reindex-backend";
    const previousPath = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    try {
      const projectID = fixture.store.createProject("Generation reindex").project!.projectID;
      const oldNoteID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Already succeeded",
        summary: "This row belongs to an earlier index generation",
      }).id!;
      const newNoteID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Needs indexing",
        summary: "This active note must be queued",
      }).id!;
      const oldRow = fixture.opened.db.query(
        "SELECT current_revision, content_hash FROM notes WHERE id = ?",
      ).get(oldNoteID) as { current_revision: number; content_hash: string };
      const now = Date.now();
      const oldOperationKey = hashTuple("outbox-operation", 2, [
        backendID,
        "upsert-note",
        projectID,
        oldNoteID,
        oldRow.current_revision,
        oldRow.content_hash,
        0,
      ]);
      fixture.opened.db.query(`
        INSERT INTO index_outbox
          (backend, operation_key, operation, project_id, note_id, revision, content_hash,
           generation, lease_generation, fence, state, attempt_count, available_at,
           heartbeat_at, completed_at, created_at)
        VALUES (?, ?, 'upsert-note', ?, ?, ?, ?, 0, 0, 0, 'succeeded', 4, ?, NULL, ?, ?)
      `).run(
        backendID,
        oldOperationKey,
        projectID,
        oldNoteID,
        oldRow.current_revision,
        oldRow.content_hash,
        now,
        now,
        now,
      );
      process.env.OPENCODE_MEMORY_DATABASE_PATH = fixture.path;

      const result = (await runAdmin(["reindex", "--backend", backendID])) as {
        backend: string;
        queued: number;
      };
      const rows = fixture.opened.db.query(`
        SELECT note_id, state
          FROM index_outbox
         WHERE backend = ? AND project_id = ? AND operation = 'upsert-note'
         ORDER BY id
      `).all(backendID, projectID) as Array<{ note_id: string; state: string }>;

      expect(result).toMatchObject({ backend: backendID, queued: 2 });
      expect(rows.filter((row) => row.state === "pending")).toHaveLength(2);
      expect(rows.some((row) => row.note_id === oldNoteID)).toBe(true);
      expect(rows.some((row) => row.note_id === newNoteID)).toBe(true);
    } finally {
      restoreEnvironment("OPENCODE_MEMORY_DATABASE_PATH", previousPath);
      closeFixture(fixture);
    }
  });

  reindexTest("AGZ-047 snapshots after a concurrent canonical writer commits", async () => {
    const fixture = openFixture();
    const backendID = "reindex-concurrent-backend";
    try {
      const projectID = fixture.store.createProject("Concurrent generation reindex").project!.projectID;
      const deletedNoteID = fixture.store.update(projectID, {
        operation: "create",
        kind: "fact",
        title: "Delete during reindex",
        summary: "A stale snapshot must not queue this note after the purge",
      }).id!;
      fixture.opened.db.exec("BEGIN IMMEDIATE");
      fixture.opened.db.query("DELETE FROM notes WHERE project_id = ? AND id = ?").run(projectID, deletedNoteID);

      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../src/admin/index.ts"), "reindex", "--backend", backendID],
        {
          env: { ...process.env, OPENCODE_MEMORY_DATABASE_PATH: fixture.path },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await Bun.sleep(100);
      fixture.opened.db.exec("COMMIT");
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);

      const rows = fixture.opened.db.query(`
        SELECT operation, note_id
          FROM index_outbox
         WHERE backend = ? AND project_id = ?
         ORDER BY id
      `).all(backendID, projectID) as Array<{ operation: string; note_id: string | null }>;
      expect(rows[0]).toEqual({ operation: "purge-project", note_id: null });
      expect(rows.some((row) => row.note_id === deletedNoteID)).toBe(false);
    } finally {
      try {
        fixture.opened.db.exec("ROLLBACK");
      } catch {}
      closeFixture(fixture);
    }
  });

  test("AGZ-055 keeps semantic backend requests within a UTF-8 byte bound", async () => {
    const fixture = openFixture();
    try {
      const projectID = fixture.store.createProject("Request bytes").project!.projectID;
      const calls: Array<{ query: string; limit: number }> = [];
      const backend = backendWithQuery(async (_projectID, query, limit) => {
        calls.push({ query, limit });
        return [];
      });
      await new RetrievalStore(fixture.opened.db, backend).retrieve({
        projectID,
        query: "😀 ".repeat(800),
        limit: 8,
        deadlineAt: Date.now() + 500,
        semantic: "on",
      });

      expect(calls).toHaveLength(1);
      expect(Buffer.byteLength(calls[0]!.query, "utf8")).toBeLessThanOrEqual(1_200);
      expect(calls[0]!.limit).toBeLessThanOrEqual(40);
    } finally {
      closeFixture(fixture);
    }
  });

  test("AGZ-055 clamps an oversized retrieval request to the hard card bound", async () => {
    const fixture = openFixture();
    try {
      const projectID = fixture.store.createProject("Card bounds").project!.projectID;
      for (let index = 0; index < 12; index++) {
        fixture.store.update(projectID, {
          operation: "create",
          kind: "fact",
          title: `Bounded card ${index}`,
          summary: "bounded retrieval candidate",
          content: "bounded retrieval candidate",
        });
      }
      const result = await new RetrievalStore(fixture.opened.db).retrieve({
        projectID,
        query: "bounded",
        limit: 100,
        deadlineAt: Date.now() + 500,
        semantic: "off",
      });

      expect(result.cards).toHaveLength(8);
    } finally {
      closeFixture(fixture);
    }
  });

  test("AGZ-059 keeps deduplicated benchmark metrics in the unit interval", () => {
    const metrics = evaluate(
      [{ goldNoteIDs: ["gold"], rankedNoteIDs: ["gold", "gold", "noise"] }],
      3,
    );

    for (const value of Object.values(metrics)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(metrics).toEqual({ recall: 1, mrr: 1, ndcg: 1 });
  });
});

function openFixture(indexBackends: readonly string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-retrieval-hardening-"));
  const path = join(directory, "memory.sqlite");
  const opened = openMemoryDatabase(path);
  return { directory, path, opened, store: new MemoryStore(opened.db, indexBackends) };
}

function closeFixture(fixture: ReturnType<typeof openFixture>): void {
  fixture.opened.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function backendWithQuery(
  query: RetrievalBackend["query"],
  id = "retrieval-backend",
): RetrievalBackend & OutboxBackend {
  return {
    id,
    outboxProtocol: "agz-memory-outbox/1",
    async upsert(_document: DerivedDocument, _signal: AbortSignal): Promise<void> {},
    async delete(_ref: DerivedRef, _signal: AbortSignal): Promise<void> {},
    async purgeProject(_projectID: string, _signal: AbortSignal): Promise<void> {},
    query,
    async health(_signal: AbortSignal): Promise<BackendHealth> {
      return { ok: true };
    },
  };
}

function instrumentQueries(db: Database): { count: () => number; restore: () => void } {
  const instance = db as unknown as { query: (...args: any[]) => any };
  const previous = instance.query;
  const original = previous.bind(db);
  let count = 0;
  instance.query = (...args: any[]) => {
    count++;
    return original(...args);
  };
  return {
    count: () => count,
    restore: () => {
      instance.query = previous;
    },
  };
}

function scores(hits: readonly { noteID: string; score: number }[]): Record<string, number> {
  return Object.fromEntries(hits.map((hit) => [hit.noteID, hit.score]));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) {
        return true;
      }
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      if (index === 0 || value.charCodeAt(index - 1) < 0xd800 || value.charCodeAt(index - 1) > 0xdbff) {
        return true;
      }
    }
  }
  return false;
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

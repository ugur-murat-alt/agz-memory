import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join, resolve } from "path";
import { runAdmin } from "../../src/admin";
import { assertReindexOwnerLivenessSupported, classifyReindexOwner, readReindexProcessStartMarker, runResumableReindex } from "../../src/admin/reindex";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";

const workerPath = resolve(import.meta.dir, "reindex-process-worker.ts");
const posixTest = process.platform === "win32" ? test.skip : test;
const windowsTest = process.platform === "win32" ? test : test.skip;

describe("resumable admin reindex", () => {
  windowsTest("fails closed without creating reindex state on Windows", async () => {
    await withDatabase(async ({ path, databaseID }) => {
      expect(() => runResumableReindex(path, databaseID, "windows", 1, 1)).toThrow();
      expect(existsSync(`${path}.reindex`)).toBe(false);
    });
  });

  posixTest("persists generation and keyset cursor across bounded invocations without duplicate outbox rows", async () => {
    await withDatabase(async ({ path, databaseID, store }) => {
      const projectID = store.createProject("Resumable reindex").project!.projectID;
      for (let index = 0; index < 3; index++) store.update(projectID, { operation: "create", kind: "fact", title: `note-${index}`, summary: "resume" });
      const interrupted = await runAdmin(["reindex", "--backend", "resume", "--batch-size", "1", "--max-batches", "1"]) as { generation: number; incomplete: boolean; resumed: boolean };
      expect(interrupted).toMatchObject({ generation: 1, incomplete: true, resumed: false });
      const resumed = await runAdmin(["reindex", "--backend", "resume", "--batch-size", "1"]) as { generation: number; queued: number; resumed: boolean };
      expect(resumed).toMatchObject({ generation: 1, queued: 3, resumed: true });
      expect(outboxCount(path, "resume")).toBe(4);
      expect(databaseID).toBeTruthy();
    });
  });

  test("classifies PID reuse as stale only when the recorded process-start marker differs", () => {
    const owner = { ownerID: "owner", pid: 42, processStart: "linux:old", hostname: "host", createdAt: 1 };
    expect(classifyReindexOwner(owner, "host", true, "linux:old")).toBe("live");
    expect(classifyReindexOwner(owner, "host", true, "linux:new")).toBe("stale");
    expect(classifyReindexOwner(owner, "host", false, null)).toBe("stale");
    expect(classifyReindexOwner(owner, "other-host", true, "linux:old")).toBe("unverifiable");
  });

  test("reads macOS start markers from the trusted reader and fails closed on Windows", () => {
    expect(readReindexProcessStartMarker(42, "darwin", {
      readMacOSPs: (pid) => pid === 42 ? "Mon Jan  1 00:00:00 2024" : null,
    })).toBe("macos:Mon Jan  1 00:00:00 2024");
    expect(readReindexProcessStartMarker(42, "darwin", { readMacOSPs: () => null })).toBeNull();
    expect(() => assertReindexOwnerLivenessSupported("win32")).toThrow("reindex owner liveness is unsupported on win32");
  });

  posixTest("rejects a same-database-ID backup replacement rather than resuming its cursor", async () => {
    await withDatabase(async ({ directory, path, databaseID, store }) => {
      store.createProject("Backup replacement");
      expect(runResumableReindex(path, databaseID, "backup-replacement", 1, 1)).toMatchObject({ incomplete: true });
      const replacement = join(directory, "same-id-backup.sqlite");
      copyFileSync(path, replacement);
      renameSync(replacement, path);
      expect(() => runResumableReindex(path, databaseID, "backup-replacement", 1)).toThrow("reindex state is stale; remove state and restart reindex");
    });
  });

  posixTest("does not initialize or migrate an old or empty replacement during identity preflight", async () => {
    await withDatabase(async ({ directory, path, databaseID }) => {
      for (const kind of ["old", "empty"] as const) {
        const replacement = join(directory, `${kind}-replacement.sqlite`);
        const raw = new Database(replacement);
        try {
          raw.exec("PRAGMA journal_mode=DELETE");
          if (kind === "old") raw.exec("CREATE TABLE legacy_schema (id INTEGER PRIMARY KEY)");
        } finally {
          raw.close();
        }
        chmodSync(replacement, 0o600);
        renameSync(replacement, path);
        rmSync(`${path}-wal`, { force: true });
        rmSync(`${path}-shm`, { force: true });
        const before = readFileSync(path);
        const beforeInspection = new Database(path, { readonly: true });
        try {
          const names = beforeInspection.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
          expect(names.map(({ name }) => name)).toEqual(kind === "old" ? ["legacy_schema"] : []);
        } finally {
          beforeInspection.close();
        }
        expect(() => runResumableReindex(path, databaseID, `preflight-${kind}`, 1)).toThrow();
        expect(readFileSync(path)).toEqual(before);
        const inspected = new Database(path, { readonly: true });
        try {
          const names = inspected.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
          expect(names.map(({ name }) => name)).toEqual(kind === "old" ? ["legacy_schema"] : []);
        } finally {
          inspected.close();
        }
      }
    });
  });

  posixTest("continues past a cursor row deleted between resumptions", async () => {
    await withDatabase(async ({ path, databaseID, store }) => {
      const projectID = store.createProject("Deletion tolerance").project!.projectID;
      for (let index = 0; index < 3; index++) store.update(projectID, { operation: "create", kind: "fact", title: `note-${index}`, summary: "resume" });
      const first = runResumableReindex(path, databaseID, "deleted-cursor", 1, 2);
      expect(first).toMatchObject({ incomplete: true, queued: 1 });
      const cursor = JSON.parse(readFileSync(join(`${path}.reindex`, stateName("deleted-cursor")), "utf8")) as { noteID: string };
      const opened = openMemoryDatabase(path);
      try { opened.db.query("DELETE FROM notes WHERE id = ?").run(cursor.noteID); } finally { opened.close(); }
      const resumed = runResumableReindex(path, databaseID, "deleted-cursor", 1);
      expect(resumed).toMatchObject({ resumed: true, queued: 3, purges: 1 });
      // The committed row for the later-deleted cursor remains an outbox record;
      // resume advances strictly past it and does not lose the two later notes.
      expect(outboxCount(path, "deleted-cursor")).toBe(4);
    });
  });

  posixTest("rejects a database replacement before the affected batch mutates or reports", async () => {
    await withDatabase(async ({ directory, path, databaseID, store }) => {
      store.createProject("Database replacement");
      const replacement = join(directory, "replacement.sqlite");
      copyFileSync(path, replacement);
      let checks = 0;
      expect(() => runResumableReindex(path, databaseID, "replacement", 1, undefined, {
        beforeBatchDatabaseIdentity() {
          checks++;
          if (checks === 2) renameSync(replacement, path);
        },
      })).toThrow("reindex database file changed");
      // Only the completed first batch exists in the replacement snapshot; the
      // checked second batch never begins a transaction or returns a report.
      expect(outboxCount(path, "replacement")).toBe(1);
    });
  });

  posixTest("reuses its generation after a commit-before-state-write crash without duplicate terminal rows", async () => {
    await withDatabase(async ({ path, databaseID, store }) => {
      store.createProject("Crash one");
      store.createProject("Crash two");
      expect(() => runResumableReindex(path, databaseID, "crash-resume", 1, undefined, {
        afterCommitBeforeStateWrite() { throw new Error("simulated crash"); },
      })).toThrow("simulated crash");
      const terminal = openMemoryDatabase(path);
      try { terminal.db.query("UPDATE index_outbox SET state = 'succeeded', completed_at = ? WHERE backend = 'crash-resume'").run(Date.now()); } finally { terminal.close(); }
      const resumed = runResumableReindex(path, databaseID, "crash-resume", 1);
      expect(resumed).toMatchObject({ generation: 1, purges: 2, queued: 0, resumed: true });
      const inspected = openMemoryDatabase(path);
      try {
        expect(inspected.db.query("SELECT COUNT(*) AS count FROM index_outbox WHERE backend = 'crash-resume' AND generation = 1").get()).toMatchObject({ count: 2 });
        expect(inspected.db.query("SELECT COUNT(*) AS count FROM index_outbox WHERE backend = 'crash-resume' AND state = 'succeeded'").get()).toMatchObject({ count: 1 });
      } finally { inspected.close(); }
    });
  });

  posixTest("fails closed when the pinned sidecar directory is replaced before a state write", async () => {
    await withDatabase(async ({ path, databaseID, store }) => {
      store.createProject("Sidecar replacement");
      const sidecar = `${path}.reindex`;
      const parked = `${sidecar}.parked`;
      expect(() => runResumableReindex(path, databaseID, "sidecar-swap", 1, undefined, {
        afterCommitBeforeStateWrite() {
          renameSync(sidecar, parked);
          mkdirSync(sidecar, { mode: 0o700 });
        },
      })).toThrow("reindex state directory changed");
      expect(existsSync(join(sidecar, stateName("sidecar-swap")))).toBe(false);
    });
  });

  posixTest("fails closed on a sidecar state symlink instead of replacing its target", async () => {
    await withDatabase(async ({ directory, path, databaseID, store }) => {
      store.createProject("Sidecar symlink");
      const first = runResumableReindex(path, databaseID, "state-symlink", 1, 1);
      expect(first).toMatchObject({ incomplete: true });
      const state = join(`${path}.reindex`, stateName("state-symlink"));
      const victim = join(directory, "victim");
      writeFileSync(victim, "do-not-touch");
      rmSync(state);
      symlinkSync(victim, state);
      expect(() => runResumableReindex(path, databaseID, "state-symlink", 1)).toThrow("reindex state file is unsafe");
      expect(readFileSync(victim, "utf8")).toBe("do-not-touch");
    });
  });

  posixTest("an exact full final page completes without another incomplete invocation", async () => {
    await withDatabase(async ({ path, databaseID, store }) => {
      const projectID = store.createProject("Exact page").project!.projectID;
      for (let index = 0; index < 2; index++) store.update(projectID, { operation: "create", kind: "fact", title: `note-${index}`, summary: "exact" });
      const result = runResumableReindex(path, databaseID, "exact-page", 2);
      expect(result).toMatchObject({ queued: 2, purges: 1 });
      expect(result).not.toHaveProperty("incomplete");
      expect(existsSync(join(`${path}.reindex`, stateName("exact-page")))).toBe(false);
    });
  });

  posixTest("actual child processes race for one owner and exactly one fails while the winner completes", async () => {
    await withDatabase(async ({ directory, path, store }) => {
      const projectID = store.createProject("Owner race").project!.projectID;
      for (let index = 0; index < 300; index++) store.update(projectID, { operation: "create", kind: "fact", title: `note-${index}`, summary: "race" });
      const start = join(directory, "start");
      const children = ["one", "two"].map((worker) => Bun.spawn({ cmd: [process.execPath, workerPath], env: { ...process.env, AGZ_REINDEX_DATABASE: path, AGZ_REINDEX_START: start, AGZ_REINDEX_WORKER: worker }, stdout: "pipe", stderr: "pipe" }));
      await waitFor(() => existsSync(`${start}.ready-one`) && existsSync(`${start}.ready-two`));
      writeFileSync(start, "go\n");
      const results = await Promise.all(children.map(async (child) => ({ exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
      expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(1);
      expect(results.find((result) => result.exitCode !== 0)?.stderr).toContain("reindex already owned");
    });
  }, 20_000);

  posixTest("two stale-lock contenders elect one takeover owner without removing its new lock", async () => {
    await withDatabase(async ({ directory, path, store }) => {
      const projectID = store.createProject("Stale owner race").project!.projectID;
      for (let index = 0; index < 300; index++) store.update(projectID, { operation: "create", kind: "fact", title: `note-${index}`, summary: "race" });
      const start = join(directory, "stale-start");
      const sidecar = `${path}.reindex`;
      mkdirSync(sidecar, { mode: 0o700 });
      writeFileSync(join(sidecar, `${stateName("owner-race")}.lock`), `${JSON.stringify({ ownerID: "dead-owner", pid: 999_999_999, processStart: "linux:dead", hostname: hostname(), createdAt: 1 })}\n`, { mode: 0o600 });
      const children = ["one", "two"].map((worker) => Bun.spawn({ cmd: [process.execPath, workerPath], env: { ...process.env, AGZ_REINDEX_DATABASE: path, AGZ_REINDEX_START: start, AGZ_REINDEX_WORKER: worker, AGZ_REINDEX_STALE_BARRIER: "1", AGZ_REINDEX_HOLD_OWNER: "1" }, stdout: "pipe", stderr: "pipe" }));
      await waitFor(() => existsSync(`${start}.ready-one`) && existsSync(`${start}.ready-two`));
      writeFileSync(start, "go\n");
      await waitFor(() => existsSync(`${start}.observed-one`) && existsSync(`${start}.observed-two`));
      writeFileSync(`${start}.takeover`, "go\n");
      await waitFor(() => existsSync(`${start}.acquired-one`) || existsSync(`${start}.acquired-two`));
      await Bun.sleep(100);
      expect(["one", "two"].filter((worker) => existsSync(`${start}.acquired-${worker}`))).toHaveLength(1);
      writeFileSync(`${start}.release`, "go\n");
      const results = await Promise.all(children.map(async (child) => ({ exitCode: await child.exited, stderr: await new Response(child.stderr).text() })));
      if (results.filter((result) => result.exitCode === 0).length !== 1) {
        throw new Error(`unexpected stale-lock race results: ${JSON.stringify(results)}`);
      }
      expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
      expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(1);
      expect(results.find((result) => result.exitCode !== 0)?.stderr).toContain("reindex already owned");
    });
  }, 20_000);
});

async function withDatabase(action: (context: { directory: string; path: string; databaseID: string; store: MemoryStore }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-reindex-resume-"));
  const path = join(directory, "memory.sqlite");
  const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
  process.env.OPENCODE_MEMORY_DATABASE_PATH = path;
  const opened = openMemoryDatabase(path);
  try {
    const databaseID = (opened.db.query("SELECT database_id FROM agz_meta WHERE id = 1").get() as { database_id: string }).database_id;
    await action({ directory, path, databaseID, store: new MemoryStore(opened.db) });
  } finally {
    opened.close();
    if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
    else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

function outboxCount(path: string, backend: string): number {
  const opened = openMemoryDatabase(path);
  try { return (opened.db.query("SELECT COUNT(*) AS count FROM index_outbox WHERE backend = ?").get(backend) as { count: number }).count; } finally { opened.close(); }
}

function stateName(backend: string): string {
  return new Bun.CryptoHasher("sha256").update(backend).digest("hex") + ".json";
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("workers did not become ready");
    await Bun.sleep(10);
  }
}

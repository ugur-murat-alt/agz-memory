import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { launchWorkers, type WorkerEvent } from "../helpers/concurrency-harness";

const WORKERS = 8;
const PROJECT_ROUNDS = 14;
const BINDING_ROUNDS = 8;
const workerPath = resolve(import.meta.dir, "binding-race-worker.ts");

describe("AGZ-005 project and binding uniqueness races", () => {
  test("turns concurrent duplicate project creation into one winner and structured conflicts", async () => {
    const result = await runProjectCreateRace();
    expect(result.workerFailures).toEqual([]);
    expect({
      successes: result.results.filter((value) => value.ok === true).length,
      conflicts: result.results.filter((value) => value.ok === false).length,
      thrown: result.results.filter((value) => "thrown" in value),
      projectCount: result.projectCount,
    }).toEqual({
      successes: PROJECT_ROUNDS,
      conflicts: (WORKERS - 1) * PROJECT_ROUNDS,
      thrown: [],
      projectCount: PROJECT_ROUNDS,
    });
  });

  test("keeps identical bindings idempotent when all workers race the same unique key", async () => {
    const result = await runBindingRace(false);
    expect(result.workerFailures).toEqual([]);
    expect(result.results.filter((value) => "thrown" in value)).toEqual([]);
    expect(result.results.filter((value) => value.ok === true)).toHaveLength(WORKERS * BINDING_ROUNDS);
    expect(result.bindingRows).toBe(BINDING_ROUNDS);
    expect(result.nonTargetConflicts).toEqual([]);
  });

  test("reports binding_conflict instead of leaking unique-index errors for different targets", async () => {
    const result = await runBindingRace(true);
    expect(result.workerFailures).toEqual([]);
    expect(result.bindingRows).toBe(BINDING_ROUNDS);
    expect(result.invalidResults).toEqual([]);
    expect(result.nonTargetConflicts).toHaveLength((WORKERS / 2) * BINDING_ROUNDS);
  }, 20_000);
});

async function runProjectCreateRace(): Promise<ProjectRaceResult> {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-project-unique-race-"));
  const databasePath = join(directory, "memory.sqlite");
  const controlDirectory = join(directory, "control");
  mkdirSync(controlDirectory);
  const controller = openMemoryDatabase(databasePath);
  const group = launchWorkers(workerPath, WORKERS, {
    AGZ_DATABASE_PATH: databasePath,
    AGZ_CONTROL_DIRECTORY: controlDirectory,
    AGZ_START_PREFIX: "create-start",
    AGZ_RELEASE_PREFIX: "create-release",
    AGZ_BINDING_MODE: "create-project",
    AGZ_ROUNDS: String(PROJECT_ROUNDS),
  });

  try {
    await group.waitForCount((event) => event.type === "opened", WORKERS);
    for (let round = 0; round < PROJECT_ROUNDS; round++) {
      controller.db.exec("BEGIN IMMEDIATE");
      writeFileSync(join(controlDirectory, `create-start-${round}`), "start\n");
      await group.waitForCount(
        (event) => event.type === "snapshot-observed" && event.round === round,
        WORKERS,
      );
      controller.db.exec("ROLLBACK");
      await group.waitForCount(
        (event) => event.type === "result" && event.round === round,
        WORKERS,
      );
    }
    const exits = await group.finish();
    const workerFailures = collectFailures(group.events, exits);
    const results = group.events
      .filter((event) => event.type === "result")
      .map((event) => event.result as ResultPayload);
    const verified = openMemoryDatabase(databasePath);
    try {
      const projectCount = (
        verified.db.query("SELECT COUNT(*) AS count FROM projects").get() as { count: number }
      ).count;
      return { results, projectCount, workerFailures };
    } finally {
      verified.close();
    }
  } finally {
    await group.stop();
    try {
      controller.db.exec("ROLLBACK");
    } catch {}
    controller.close();
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
}

async function runBindingRace(conflicting: boolean): Promise<BindingRaceResult> {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-binding-race-"));
  const databasePath = join(directory, "memory.sqlite");
  const controlDirectory = join(directory, "control");
  const canonicalDirectory = join(directory, "canonical");
  mkdirSync(controlDirectory);
  mkdirSync(canonicalDirectory);
  const opened = openMemoryDatabase(databasePath);
  const store = new MemoryStore(opened.db);
  const targetA = store.createProject("Binding Target A").project!.projectID;
  const targetB = store.createProject("Binding Target B").project!.projectID;

  const group = launchWorkers(workerPath, WORKERS, {
    AGZ_DATABASE_PATH: databasePath,
    AGZ_CONTROL_DIRECTORY: controlDirectory,
    AGZ_START_PREFIX: "bind-start",
    AGZ_RELEASE_PREFIX: "bind-release",
    AGZ_BINDING_MODE: "bind-project",
    AGZ_ROUNDS: String(BINDING_ROUNDS),
    AGZ_BIND_TARGET_A: targetA,
    AGZ_BIND_TARGET_B: targetB,
    AGZ_BIND_CONFLICTING: String(conflicting),
    AGZ_CANONICAL_DIRECTORY: canonicalDirectory,
  });

  try {
    await group.waitForCount((event) => event.type === "opened", WORKERS);
    for (let round = 0; round < BINDING_ROUNDS; round++) {
      opened.db.exec("BEGIN IMMEDIATE");
      writeFileSync(join(controlDirectory, `bind-start-${round}`), "start\n");
      await group.waitForCount(
        (event) => event.type === "snapshot-observed" && event.round === round,
        WORKERS,
      );
      opened.db.exec("ROLLBACK");
      await group.waitForCount(
        (event) => event.type === "result" && event.round === round,
        WORKERS,
      );
    }
    const exits = await group.finish();
    const workerFailures = collectFailures(group.events, exits);
    const resultEvents = group.events.filter((event) => event.type === "result");
    const results = resultEvents.map((event) => ({
      worker: event.worker,
      round: event.round!,
      result: event.result as ResultPayload,
    }));
    const verified = openMemoryDatabase(databasePath);
    try {
      const rows = verified.db
        .query(
          `SELECT project_id, source_project_id
             FROM project_bindings
            WHERE source = 'opencode-v2' AND workspace_id = 'workspace-binding-race'
            ORDER BY source_project_id`,
        )
        .all() as Array<{ project_id: string; source_project_id: string }>;
      const rowsByRound = new Map(
        rows.map((row) => [Number(row.source_project_id.split("-").pop()), row.project_id]),
      );
      const invalidResults: string[] = [];
      const nonTargetConflicts: string[] = [];
      for (const entry of results) {
        const winner = rowsByRound.get(entry.round);
        const value = entry.result;
        const expectedTarget = conflicting && entry.worker % 2 === 1 ? targetB : targetA;
        if (!winner) {
          invalidResults.push(`round ${entry.round} has no committed binding`);
          continue;
        }
        if (value.ok === true) {
          if (value.projectID !== winner) {
            invalidResults.push(
              `worker ${entry.worker} round ${entry.round} returned ${String(value.projectID)} but ${winner} won`,
            );
          }
        } else if (conflicting && expectedTarget !== winner && isBindingConflict(value)) {
          nonTargetConflicts.push(`${entry.worker}:${entry.round}`);
        } else if (conflicting && expectedTarget === winner && isBindingConflict(value)) {
          invalidResults.push(`winner-target worker ${entry.worker} conflicted in round ${entry.round}`);
        } else {
          invalidResults.push(`unexpected binding result: ${JSON.stringify(value)}`);
        }
      }
      return {
        workerFailures,
        results: results.map(({ result }) => result),
        bindingRows: rows.length,
        invalidResults,
        nonTargetConflicts,
      };
    } finally {
      verified.close();
    }
  } finally {
    await group.stop();
    try {
      opened.db.exec("ROLLBACK");
    } catch {}
    opened.close();
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
}

function collectFailures(
  events: readonly WorkerEvent[],
  exits: readonly { worker: number; exitCode: number; stderr: string }[],
): string[] {
  return [
    ...exits
      .filter((exit) => exit.exitCode !== 0)
      .map((exit) => `worker ${exit.worker}: ${exit.stderr}`),
    ...events
      .filter((event) => event.type === "worker-error" || event.type === "raw-output")
      .map((event) => JSON.stringify(event)),
  ];
}

function isBindingConflict(result: ResultPayload): boolean {
  return (
    (typeof result.thrown === "string" && result.thrown === "binding_conflict") ||
    (result.ok === false && typeof result.reason === "string" && /binding_conflict/i.test(result.reason))
  );
}

interface ResultPayload {
  ok?: boolean;
  reason?: string;
  projectID?: string;
  thrown?: string;
  [key: string]: unknown;
}

interface ProjectRaceResult {
  results: ResultPayload[];
  projectCount: number;
  workerFailures: string[];
}

interface BindingRaceResult {
  workerFailures: string[];
  results: ResultPayload[];
  bindingRows: number;
  invalidResults: string[];
  nonTargetConflicts: string[];
}

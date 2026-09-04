import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { launchWorkers } from "../helpers/concurrency-harness";

const WORKERS = 8;
const UPDATE_ROUNDS = 13;
const PIN_ROUNDS = 8;
const workerPath = resolve(import.meta.dir, "note-update-worker.ts");

describe("AGZ-001 multiprocess note CAS and outbox", () => {
  test("rejects stale note updates and emits one outbox generation for every committed revision", async () => {
    const result = await runNoteRace("update", UPDATE_ROUNDS);
    expect(result.workerFailures).toEqual([]);
    expect({
      successes: result.successes.length,
      conflicts: result.conflicts.length,
      thrown: result.thrown,
      currentRevision: result.currentRevision,
      revisionRows: result.revisionRows,
      outboxRevisions: result.outboxRevisions,
    }).toEqual({
      successes: UPDATE_ROUNDS,
      conflicts: (WORKERS - 1) * UPDATE_ROUNDS,
      thrown: [],
      currentRevision: 1 + UPDATE_ROUNDS,
      revisionRows: 1 + UPDATE_ROUNDS,
      outboxRevisions: Array.from({ length: 1 + UPDATE_ROUNDS }, (_, index) => index + 1),
    });
  });

  test("rejects stale pin writes while preserving pin state, revisions, and outbox generations", async () => {
    const result = await runNoteRace("pin", PIN_ROUNDS);
    expect(result.workerFailures).toEqual([]);
    expect({
      successes: result.successes.length,
      conflicts: result.conflicts.length,
      thrown: result.thrown,
      pinned: result.pinned,
      currentRevision: result.currentRevision,
      revisionRows: result.revisionRows,
      outboxRevisions: result.outboxRevisions,
    }).toEqual({
      successes: PIN_ROUNDS,
      conflicts: (WORKERS - 1) * PIN_ROUNDS,
      thrown: [],
      pinned: PIN_ROUNDS % 2 === 1,
      currentRevision: 1 + PIN_ROUNDS,
      revisionRows: 1 + PIN_ROUNDS,
      outboxRevisions: Array.from({ length: 1 + PIN_ROUNDS }, (_, index) => index + 1),
    });
  });
});

async function runNoteRace(mode: "update" | "pin", rounds: number): Promise<RaceResult> {
  const directory = mkdtempSync(join(tmpdir(), `agz-memory-${mode}-race-`));
  const databasePath = join(directory, "memory.sqlite");
  const controlDirectory = join(directory, "control");
  const startFile = join(controlDirectory, "start");
  mkdirSync(controlDirectory);
  const opened = openMemoryDatabase(databasePath);
  const store = new MemoryStore(opened.db, ["fake@1"]);
  const projectID = store.createProject(`Note ${mode} race`).project!.projectID;
  const noteID = store.update(projectID, {
    operation: "create",
    kind: "fact",
    title: "initial",
    summary: "initial",
    content: "initial",
  }).id!;

  const group = launchWorkers(workerPath, WORKERS, {
    AGZ_DATABASE_PATH: databasePath,
    AGZ_CONTROL_DIRECTORY: controlDirectory,
    AGZ_START_FILE: startFile,
    AGZ_PROJECT_ID: projectID,
    AGZ_NOTE_ID: noteID,
    AGZ_NOTE_MODE: mode,
    AGZ_ROUNDS: String(rounds),
  });
  let parentTransactionOpen = false;

  try {
    await group.waitForCount((event) => event.type === "opened", WORKERS);
    for (let round = 0; round < rounds; round++) {
      opened.db.exec("BEGIN IMMEDIATE");
      parentTransactionOpen = true;
      writeFileSync(`${startFile}-${mode}-${round}`, "start\n");
      await group.waitForCount(
        (event) => event.type === "snapshot" && event.round === round,
        WORKERS,
      );
      opened.db.exec("ROLLBACK");
      parentTransactionOpen = false;
      await group.waitForCount(
        (event) => event.type === "result" && event.round === round,
        WORKERS,
      );
    }

    const exits = await group.finish();
    const workerFailures = [
      ...exits.filter((exit) => exit.exitCode !== 0).map((exit) => `worker ${exit.worker}: ${exit.stderr}`),
      ...group.events
        .filter((event) => event.type === "worker-error" || event.type === "raw-output")
        .map((event) => JSON.stringify(event)),
    ];
    const results = group.events
      .filter((event) => event.type === "result")
      .map((event) => event.result as ResultPayload);
    const successes = results.filter((value) => value.ok === true);
    const conflicts = results.filter((value) => value.ok === false);
    const thrown = results.filter((value) => "thrown" in value);

    const verified = openMemoryDatabase(databasePath);
    try {
      const note = verified.db
        .query("SELECT current_revision, pinned FROM notes WHERE project_id = ? AND id = ?")
        .get(projectID, noteID) as { current_revision: number; pinned: number };
      const revisionRows = (
        verified.db
          .query("SELECT COUNT(*) AS count FROM note_revisions WHERE project_id = ? AND note_id = ?")
          .get(projectID, noteID) as { count: number }
      ).count;
      const outboxRevisions = (
        verified.db
          .query(
            `SELECT revision
               FROM index_outbox
              WHERE backend = 'fake@1' AND operation = 'upsert-note'
                AND project_id = ? AND note_id = ?
              ORDER BY revision`,
          )
          .all(projectID, noteID) as Array<{ revision: number }>
      ).map(({ revision }) => revision);
      return {
        successes,
        conflicts,
        thrown,
        workerFailures,
        currentRevision: note.current_revision,
        revisionRows,
        outboxRevisions,
        pinned: note.pinned === 1,
      };
    } finally {
      verified.close();
    }
  } finally {
    if (parentTransactionOpen) {
      try {
        opened.db.exec("ROLLBACK");
      } catch {
        // The parent transaction may already have been rolled back by a failed barrier.
      }
    }
    await group.stop();
    opened.close();
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
}

interface ResultPayload {
  ok?: boolean;
  thrown?: string;
  [key: string]: unknown;
}

interface RaceResult {
  successes: ResultPayload[];
  conflicts: ResultPayload[];
  thrown: ResultPayload[];
  workerFailures: string[];
  currentRevision: number;
  revisionRows: number;
  outboxRevisions: number[];
  pinned: boolean;
}

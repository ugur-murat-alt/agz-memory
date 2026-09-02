import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import {
  emitWorkerEvent,
  overrideFirstQueryGet,
  waitForFile,
} from "../helpers/concurrency-harness";

const databasePath = required("AGZ_DATABASE_PATH");
const startFile = required("AGZ_START_FILE");
const releaseFile = required("AGZ_RELEASE_FILE");
const projectID = required("AGZ_PROJECT_ID");
const mode = required("AGZ_PROJECT_MODE") as "delete" | "rename";
const worker = Number(required("AGZ_CONCURRENCY_WORKER"));

const opened = openMemoryDatabase(databasePath);

try {
  emitWorkerEvent({ type: "opened", worker });
  await waitForFile(startFile);

  if (mode === "delete") {
    const snapshot = opened.db.query("SELECT * FROM projects WHERE id = ?").get(projectID) as
      | { id: string; name: string; updated_at: number }
      | undefined;
    if (!snapshot) throw new Error(`project ${projectID} disappeared before delete snapshot`);
    emitWorkerEvent({ type: "snapshot", worker, name: snapshot.name });
    await waitForFile(releaseFile);

    const staleDB = overrideFirstQueryGet(
      opened.db,
      (sql) => sql.includes("FROM projects WHERE id = ?"),
      snapshot,
    );
    const store = new MemoryStore(staleDB, ["fake@1"]);
    emitResult(worker, call(() => store.deleteProject(projectID, snapshot.name)));
  } else {
    const store = new MemoryStore(opened.db);
    emitResult(worker, call(() => store.updateProject(projectID, "Renamed Project")));
  }
} catch (error) {
  emitWorkerEvent({
    type: "worker-error",
    worker,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  opened.close();
}

function call(action: () => unknown): unknown {
  try {
    return action();
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

function emitResult(workerID: number, result: unknown): void {
  emitWorkerEvent({ type: "result", worker: workerID, result });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

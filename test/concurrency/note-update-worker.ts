import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import {
  emitWorkerEvent,
  observeFirstQueryGet,
  waitForFile,
} from "../helpers/concurrency-harness";

const databasePath = required("AGZ_DATABASE_PATH");
const startFile = required("AGZ_START_FILE");
const projectID = required("AGZ_PROJECT_ID");
const noteID = required("AGZ_NOTE_ID");
const mode = required("AGZ_NOTE_MODE") as "update" | "pin";
const rounds = Number(required("AGZ_ROUNDS"));
const worker = Number(required("AGZ_CONCURRENCY_WORKER"));

const opened = openMemoryDatabase(databasePath);

try {
  emitWorkerEvent({ type: "opened", worker });

  for (let round = 0; round < rounds; round++) {
    await waitForFile(`${startFile}-${mode}-${round}`);
    const observedDB = observeFirstQueryGet(opened.db, (sql) => sql.includes("FROM notes"), () => {
      emitWorkerEvent({ type: "snapshot", worker, round });
    });
    const store = new MemoryStore(observedDB, ["fake@1"]);
    const desiredPinned = round % 2 === 0;
    let result: unknown;
    try {
      result =
        mode === "update"
          ? store.update(projectID, {
              id: noteID,
              title: `worker ${worker} round ${round}`,
              summary: `worker ${worker} round ${round}`,
              content: `worker ${worker} round ${round}`,
              kind: "fact",
            })
          : store.pin(projectID, noteID, desiredPinned);
    } catch (error) {
      result = { thrown: error instanceof Error ? error.message : String(error) };
    }
    emitWorkerEvent({ type: "result", worker, round, result });
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

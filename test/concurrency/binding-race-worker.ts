import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { normalizeProjectName } from "../../src/project";
import { CaptureStore } from "../../src/store/capture";
import { MemoryStore } from "../../src/store";
import {
  emitWorkerEvent,
  observeFirstQueryGet,
  waitForFile,
} from "../helpers/concurrency-harness";

const databasePath = required("AGZ_DATABASE_PATH");
const controlDirectory = required("AGZ_CONTROL_DIRECTORY");
const startPrefix = required("AGZ_START_PREFIX");
const mode = required("AGZ_BINDING_MODE") as "create-project" | "bind-project";
const rounds = Number(required("AGZ_ROUNDS"));
const worker = Number(required("AGZ_CONCURRENCY_WORKER"));
const targetA = process.env.AGZ_BIND_TARGET_A;
const targetB = process.env.AGZ_BIND_TARGET_B;
const conflictingTargets = process.env.AGZ_BIND_CONFLICTING === "true";
const canonicalDirectory = process.env.AGZ_CANONICAL_DIRECTORY;

const opened = openMemoryDatabase(databasePath);

try {
  emitWorkerEvent({ type: "opened", worker });

  for (let round = 0; round < rounds; round++) {
    await waitForFile(join(controlDirectory, `${startPrefix}-${round}`));
    let result: unknown;
    if (mode === "create-project") {
      const name = `Unique Race Project ${round}`;
      const normalizedName = normalizeProjectName(name);
      const snapshot = opened.db
        .query("SELECT id FROM projects WHERE normalized_name = ?")
        .get(normalizedName);
      emitWorkerEvent({ type: "snapshot", worker, round, present: Boolean(snapshot) });
      const observedDB = observeFirstQueryGet(
        opened.db,
        (sql) => sql.includes("FROM projects WHERE normalized_name = ?"),
        () => emitWorkerEvent({ type: "snapshot-observed", worker, round }),
      );
      const store = new MemoryStore(observedDB);
      result = call(() => store.createProject(name));
    } else {
      const opencodeProjectID = `opencode-binding-race-${round}`;
      const workspaceID = "workspace-binding-race";
      const targetProjectID = conflictingTargets
        ? worker % 2 === 0
          ? requiredValue(targetA, "AGZ_BIND_TARGET_A")
          : requiredValue(targetB, "AGZ_BIND_TARGET_B")
        : requiredValue(targetA, "AGZ_BIND_TARGET_A");
      const snapshot = opened.db
        .query(
          `SELECT *
             FROM project_bindings
            WHERE source = 'opencode-v2' AND source_project_id = ? AND workspace_id = ?`,
        )
        .get(opencodeProjectID, workspaceID);
      emitWorkerEvent({ type: "snapshot", worker, round, present: Boolean(snapshot) });
      const observedDB = observeFirstQueryGet(
        opened.db,
        (sql) => sql.includes("FROM project_bindings"),
        () => emitWorkerEvent({ type: "snapshot-observed", worker, round }),
      );
      const capture = new CaptureStore(observedDB);
      result = call(() =>
        capture.bindProject({
          memoryProjectID: targetProjectID,
          opencodeProjectID,
          canonicalDirectory: requiredValue(canonicalDirectory, "AGZ_CANONICAL_DIRECTORY"),
          workspaceID,
        }),
      );
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

function call(action: () => unknown): unknown {
  try {
    return action();
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

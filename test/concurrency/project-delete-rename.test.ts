import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { launchWorkers } from "../helpers/concurrency-harness";

const DELETE_WORKERS = 8;
const workerPath = resolve(import.meta.dir, "project-delete-rename-worker.ts");

describe("AGZ-002 project delete and rename race", () => {
  test("does not delete a project after its confirmed name changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-project-race-"));
    const databasePath = join(directory, "memory.sqlite");
    const controlDirectory = join(directory, "control");
    mkdirSync(controlDirectory);
    const deleteStartFile = join(controlDirectory, "delete-start");
    const deleteReleaseFile = join(controlDirectory, "delete-release");
    const renameStartFile = join(controlDirectory, "rename-start");

    const opened = openMemoryDatabase(databasePath);
    const store = new MemoryStore(opened.db, ["fake@1"]);
    const projectID = store.createProject("Race Project").project!.projectID;
    const noteID = store.update(projectID, {
      kind: "fact",
      title: "survivor",
      summary: "survivor",
      content: "survivor",
    }).id!;
    opened.close();

    const deleters = launchWorkers(workerPath, DELETE_WORKERS, {
      AGZ_DATABASE_PATH: databasePath,
      AGZ_CONTROL_DIRECTORY: controlDirectory,
      AGZ_START_FILE: deleteStartFile,
      AGZ_RELEASE_FILE: deleteReleaseFile,
      AGZ_PROJECT_ID: projectID,
      AGZ_PROJECT_MODE: "delete",
    });
    let renamer: ReturnType<typeof launchWorkers> | undefined;
    try {
      await deleters.waitForCount((event) => event.type === "opened", DELETE_WORKERS);
      writeFileSync(deleteStartFile, "start\n");
      await deleters.waitForCount((event) => event.type === "snapshot", DELETE_WORKERS);

      renamer = launchWorkers(workerPath, 1, {
        AGZ_DATABASE_PATH: databasePath,
        AGZ_CONTROL_DIRECTORY: controlDirectory,
        AGZ_START_FILE: renameStartFile,
        AGZ_RELEASE_FILE: deleteReleaseFile,
        AGZ_PROJECT_ID: projectID,
        AGZ_PROJECT_MODE: "rename",
      });
      await renamer.waitForCount((event) => event.type === "opened", 1);
      writeFileSync(renameStartFile, "start\n");
      await renamer.waitForCount((event) => event.type === "result", 1);
      writeFileSync(deleteReleaseFile, "release\n");
      await deleters.waitForCount((event) => event.type === "result", DELETE_WORKERS);

      const deleteExits = await deleters.finish();
      const renameExits = await renamer.finish();
      const workerFailures = [
        ...deleteExits
          .filter((exit) => exit.exitCode !== 0)
          .map((exit) => `delete worker ${exit.worker}: ${exit.stderr}`),
        ...renameExits
          .filter((exit) => exit.exitCode !== 0)
          .map((exit) => `rename worker ${exit.worker}: ${exit.stderr}`),
        ...deleters.events
          .filter((event) => event.type === "worker-error" || event.type === "raw-output")
          .map((event) => JSON.stringify(event)),
        ...renamer.events
          .filter((event) => event.type === "worker-error" || event.type === "raw-output")
          .map((event) => JSON.stringify(event)),
      ];
      expect(workerFailures).toEqual([]);

      const deleteResults = deleters.events
        .filter((event) => event.type === "result")
        .map((event) => event.result as ResultPayload);
      const renameResult = renamer.events.find((event) => event.type === "result")!.result as ResultPayload;

      const verified = openMemoryDatabase(databasePath);
      try {
        const project = verified.db.query("SELECT name FROM projects WHERE id = ?").get(projectID) as
          | { name: string }
          | undefined;
        const notes = (
          verified.db
            .query("SELECT COUNT(*) AS count FROM notes WHERE project_id = ?")
            .get(projectID) as { count: number }
        ).count;
        const purgeRows = (
          verified.db
            .query(
              "SELECT COUNT(*) AS count FROM index_outbox WHERE operation = 'purge-project' AND project_id = ?",
            )
            .get(projectID) as { count: number }
        ).count;
        expect({
          renameOK: renameResult.ok,
          deleteOK: deleteResults.filter((result) => result.ok === true).length,
          projectName: project?.name,
          notes,
          purgeRows,
          noteIDStillPresent: Boolean(
            verified.db.query("SELECT id FROM notes WHERE project_id = ? AND id = ?").get(projectID, noteID),
          ),
          thrownDeletes: deleteResults.filter((result) => "thrown" in result),
        }).toEqual({
          renameOK: true,
          deleteOK: 0,
          projectName: "Renamed Project",
          notes: 1,
          purgeRows: 0,
          noteIDStillPresent: true,
          thrownDeletes: [],
        });
      } finally {
        verified.close();
      }
    } finally {
      await deleters.stop();
      await renamer?.stop();
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface ResultPayload {
  ok?: boolean;
  thrown?: string;
  [key: string]: unknown;
}

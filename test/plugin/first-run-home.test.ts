import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as coreModule from "../../src/core";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const { openMemoryCore } = coreModule;
const { fakeContext, testOptions } = await import("./harness");
const memoryPlugin = (await import("../../packages/opencode-plugin/src/index")).default;

describe("OpenCode V2 plugin first-run storage", () => {
  test("AGZ-033 creates the default database and parent directories below HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "agz-memory-plugin-home-"));
    const databasePath = join(home, ".local", "share", "opencode-memory", "memory.sqlite");
    expect(existsSync(databasePath)).toBe(false);

    try {
      const core = openMemoryCore(databasePath);
      core.close();
      expect(existsSync(databasePath)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("uses HOME for the plugin database when no override is set", async () => {
    const home = mkdtempSync(join(tmpdir(), "agz-memory-plugin-home-bound-"));
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-project-"));
    const databaseDirectory = join(home, ".local", "share", "opencode-memory");
    mkdirSync(databaseDirectory, { recursive: true });
    const databasePath = join(databaseDirectory, "memory.sqlite");
    const seeded = openMemoryCore(databasePath);
    const projectID = seeded.memory.createProject("HOME plugin project").project!.projectID;
    seeded.close();

    const previousHome = process.env.HOME;
    const previousDatabasePath = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    process.env.HOME = home;
    delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
    const harness = fakeContext(
      directory,
      testOptions("shadow-capture", projectID, directory),
    );
    let cleanup: (() => Promise<void> | void) | undefined;

    try {
      const setupResult = await memoryPlugin.setup(harness.context);
      if (typeof setupResult === "function") cleanup = setupResult;
      expect(cleanup).toBeTypeOf("function");
      expect(harness.sessionHooks.size).toBe(2);
      expect(harness.toolHooks.size).toBe(1);
    } finally {
      await cleanup?.();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDatabasePath === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previousDatabasePath;
      rmSync(directory, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

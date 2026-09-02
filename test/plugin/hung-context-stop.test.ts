import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as coreModule from "../../src/core";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const {
  deferred,
  fakeContext,
  microtaskBarrier,
  testOptions,
} = await import("./harness");
const { PluginRuntime } = await import("../../packages/opencode-plugin/src/runtime");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_KEY = "c".repeat(64);

describe("OpenCode V2 plugin shutdown", () => {
  test("AGZ-027 does not wait for a hung session context during stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-hung-context-"));
    const contextEntered = deferred<void>();
    const releaseContext = deferred<readonly unknown[]>();
    const harness = fakeContext(directory, {}, async () => {
      contextEntered.resolve(undefined);
      return releaseContext.promise;
    });
    const core = {
      capture: {
        runRetentionBacklog() {},
        markReconciled() {},
        ingest() {
          return { outcome: "shadowed", idempotencyKey: "" };
        },
      },
      retrieval: {
        async retrieve() {
          return { cards: [], semanticFallback: false, rejectedBackendHits: 0 };
        },
      },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const runtime = new PluginRuntime(
      harness.context,
      core,
      testOptions("shadow-capture", PROJECT_ID, directory),
      {
        bindingKey: BINDING_KEY,
        projectID: PROJECT_ID,
        directory,
        workspaceID: "",
        opencodeProjectID: "oc-project",
      },
    );
    let stopping: Promise<void> | undefined;

    try {
      await runtime.start();
      const internal = runtime as unknown as { queueReconcile(sessionID: string): void };
      internal.queueReconcile("session-1");
      await contextEntered.promise;

      let settled = false;
      stopping = runtime.stop().then(() => {
        settled = true;
      });
      await microtaskBarrier();
      expect(settled).toBe(true);
    } finally {
      releaseContext.resolve([]);
      if (stopping) await stopping;
      else await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

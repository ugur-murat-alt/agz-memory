import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as coreModule from "../../src/core";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const { deferred, fakeContext, testOptions } = await import("./harness");
const { PluginRuntime } = await import("../../packages/opencode-plugin/src/runtime");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_KEY = "b".repeat(64);
const SESSION_COUNT = 1_000;
const MAX_RECONCILE_CONCURRENCY = 4;

describe("OpenCode V2 plugin reconciliation backpressure", () => {
  test("AGZ-026 bounds reconciliation work across 1,000 sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-backpressure-"));
    const firstBatchEntered = deferred<void>();
    const releaseFirstBatch = deferred<void>();
    const allFinished = deferred<void>();
    let started = 0;
    let active = 0;
    let peak = 0;
    let finished = 0;
    const harness = fakeContext(directory, {}, async () => {
      started++;
      active++;
      peak = Math.max(peak, active);
      if (started === MAX_RECONCILE_CONCURRENCY) firstBatchEntered.resolve(undefined);
      await releaseFirstBatch.promise;
      active--;
      finished++;
      if (finished === SESSION_COUNT) allFinished.resolve(undefined);
      return [];
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

    try {
      await runtime.start();
      const internal = runtime as unknown as { queueReconcile(sessionID: string): void };
      for (let index = 0; index < SESSION_COUNT; index++) {
        internal.queueReconcile(`session-${index}`);
      }
      await firstBatchEntered.promise;
      releaseFirstBatch.resolve(undefined);
      await allFinished.promise;

      expect(started).toBe(SESSION_COUNT);
      expect(finished).toBe(SESSION_COUNT);
      expect(peak).toBeLessThanOrEqual(MAX_RECONCILE_CONCURRENCY);
    } finally {
      releaseFirstBatch.resolve(undefined);
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

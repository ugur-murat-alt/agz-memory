import { describe, expect, mock, test } from "bun:test";
import * as coreModule from "../../src/core";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const {
  deferred,
  fakeContext,
  microtaskBarrier,
  testOptions,
} = await import("./harness");
const { PluginRuntime } = await import("../../packages/opencode-plugin/src/runtime");
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_KEY = "d".repeat(64);
const OFF_HISTORY = [{ type: "user", id: "prompt-1", text: "[memory:off] keep this turn private" }];
const ACTIONS = ["prompt", "context", "tool", "event"] as const;
type Action = (typeof ACTIONS)[number];

describe("OpenCode V2 plugin turn opt-out", () => {
  test("AGZ-028 and AGZ-029 preserve opt-out across every hook order", async () => {
    const violations: string[] = [];
    for (const order of permutations(ACTIONS)) {
      const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-order-"));
      const ingested: unknown[] = [];
      const harness = fakeContext(directory, {}, OFF_HISTORY);
      const core = {
        capture: {
          runRetentionBacklog() {},
          markReconciled() {},
          ingest(event: unknown) {
            ingested.push(event);
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
        testOptions("inject", PROJECT_ID, directory),
        {
          bindingKey: BINDING_KEY,
          projectID: PROJECT_ID,
          directory,
          workspaceID: "",
          opencodeProjectID: "oc-project",
        },
      );
      const contextInput = {
        sessionID: "session-1",
        system: [{ type: "text" as const, text: "existing system text" }],
        messages: OFF_HISTORY,
      };

      try {
        await runtime.start();
        const internal = runtime as unknown as {
          handleEvent(event: unknown): Promise<void>;
        };
        for (const action of order) {
          if (action === "prompt") {
            await harness.sessionHooks.get("prompt")!({
              sessionID: "session-1",
              messageID: "prompt-1",
              prompt: { text: "[memory:off] keep this turn private" },
            });
          } else if (action === "context") {
            await harness.sessionHooks.get("context")!(contextInput);
          } else if (action === "tool") {
            await harness.toolHooks.get("execute.after")!({
              sessionID: "session-1",
              messageID: "assistant-1",
              id: "tool-1",
              tool: "bash",
              status: "completed",
            });
          } else {
            await internal.handleEvent({
              type: "session.text.ended",
              location: { directory, workspaceID: "" },
              data: {
                sessionID: "session-1",
                assistantMessageID: "assistant-1",
                text: "assistant text must not be captured",
                ordinal: 0,
              },
            });
          }
        }
        if (ingested.length !== 0) {
          violations.push(`${order.join(" -> ")}: captured ${ingested.length} event(s)`);
        }
        if (contextInput.system.length !== 1) {
          violations.push(`${order.join(" -> ")}: changed the context input`);
        }
      } finally {
        await runtime.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    }

    expect(violations).toEqual([]);
  });

  test("AGZ-029 deduplicates concurrent history probes before capture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-race-"));
    const historyEntered = deferred<void>();
    const releaseHistory = deferred<readonly unknown[]>();
    const ingested: unknown[] = [];
    const harness = fakeContext(directory, {}, async () => {
      historyEntered.resolve(undefined);
      return releaseHistory.promise;
    });
    const core = {
      capture: {
        runRetentionBacklog() {},
        markReconciled() {},
        ingest(event: unknown) {
          ingested.push(event);
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
      testOptions("inject", PROJECT_ID, directory),
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
      const internal = runtime as unknown as { handleEvent(event: unknown): Promise<void> };
      const tool = harness.toolHooks.get("execute.after")!({
        sessionID: "session-1",
        messageID: "assistant-1",
        id: "tool-1",
        tool: "bash",
        status: "completed",
      });
      const event = internal.handleEvent({
        type: "session.text.ended",
        location: { directory, workspaceID: "" },
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          text: "assistant text must not be captured",
          ordinal: 0,
        },
      });
      await historyEntered.promise;
      await microtaskBarrier();
      expect(harness.contextCallCount()).toBe(1);
      releaseHistory.resolve(OFF_HISTORY);
      await Promise.all([tool, event]);
      expect(ingested).toEqual([]);
    } finally {
      releaseHistory.resolve(OFF_HISTORY);
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [Array.from(values)];
  const result: T[][] = [];
  for (let index = 0; index < values.length; index++) {
    const remainder = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of permutations(remainder)) result.push([values[index]!, ...suffix]);
  }
  return result;
}

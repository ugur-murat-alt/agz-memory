import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as coreModule from "../../src/core";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const {
  deferred,
  fakeContext,
  testOptions,
} = await import("./harness");
const { PluginRuntime } = await import("../../packages/opencode-plugin/src/runtime");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_KEY = "a".repeat(64);

describe("OpenCode V2 plugin incremental reconciliation", () => {
  test("AGZ-025 processes only the suffix after the persisted checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-incremental-"));
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      type: "user",
      id: `message-${index}`,
      text: `I decided historical-${index}`,
    }));
    const ingested: Array<{ source: { messageID?: string } }> = [];
    const reconciled = deferred<void>();
    let reconciledLastMessageID: string | undefined;
    const core = {
      capture: {
        runRetentionBacklog() {},
        getCheckpoint() {
          return { sessionID: "session-1", lastMessageID: "message-998", state: "active" as const };
        },
        markReconciled(_sessionID: string, _state: string, lastMessageID?: string) {
          reconciledLastMessageID = lastMessageID;
          reconciled.resolve(undefined);
        },
        ingest(event: { source: { messageID?: string } }) {
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
    const harness = fakeContext(directory, {}, messages);
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
      internal.queueReconcile("session-1");
      await reconciled.promise;

      expect(ingested).toHaveLength(1);
      expect(ingested[0]!.source.messageID).toBe("message-999");
      expect(reconciledLastMessageID).toBe("message-999");
      expect(harness.contextCallCount()).toBe(1);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

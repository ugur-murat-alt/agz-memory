import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as coreModule from "../../src/core";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const { deferred, fakeContext, testOptions } = await import("./harness");
const { PluginRuntime } = await import("../../packages/opencode-plugin/src/runtime");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_KEY = "e".repeat(64);

describe("OpenCode V2 plugin late attach", () => {
  test("fails closed on tool terminal events without reading session history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-tool-terminal-"));
    const harness = fakeContext(directory, {}, Array.from({ length: 1_000 }, (_, id) => ({ id })));
    const checkpointCalls: string[] = [];
    const reconciled = deferred<void>();
    let marked = 0;
    const core = {
      capture: {
        runRetentionBacklog() {},
        getCheckpoint() { return undefined; },
        checkpoint(sessionID: string) { checkpointCalls.push(sessionID); },
        markReconciled() {
          marked++;
          if (marked === 2) reconciled.resolve(undefined);
        },
        ingest() { return { outcome: "shadowed", idempotencyKey: "" }; },
      },
      retrieval: { async retrieve() { return { cards: [], semanticFallback: false, rejectedBackendHits: 0 }; } },
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
      const internal = runtime as unknown as { handleEvent(event: unknown): Promise<void> };
      for (const [index, type] of ["session.tool.success", "session.tool.failed"].entries()) {
        await internal.handleEvent({
          type,
          location: { directory, workspaceID: "" },
          data: { sessionID: `tool-session-${index}` },
        });
      }
      await reconciled.promise;
      expect(checkpointCalls).toEqual(["tool-session-0", "tool-session-1"]);
      expect(harness.contextCallCount()).toBe(0);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("creates a verified checkpoint on the first terminal event and bounds cursor-less history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-late-attach-"));
    const history = Array.from({ length: 1_000 }, (_, index) => ({
      type: "user",
      id: `message-${index}`,
      text: `I prefer bounded history ${index}`,
    }));
    const reconciled = deferred<void>();
    const checkpointCalls: Array<[string, string, string]> = [];
    const ingested: unknown[] = [];
    let checkpoint: { sessionID: string; lastMessageID?: string; state: "active" } | undefined;
    let reconciliation: { state: string; lastMessageID?: string; failed?: boolean } | undefined;
    const harness = fakeContext(directory, {}, history);
    const core = {
      capture: {
        runRetentionBacklog() {},
        getCheckpoint() {
          return checkpoint;
        },
        checkpoint(sessionID: string, bindingKey: string, projectID: string) {
          checkpointCalls.push([sessionID, bindingKey, projectID]);
          checkpoint = { sessionID, state: "active" };
        },
        markReconciled(_sessionID: string, state: string, lastMessageID?: string, failed?: boolean) {
          reconciliation = { state, lastMessageID, failed };
          reconciled.resolve(undefined);
        },
        ingest(event: unknown) {
          ingested.push(event);
          return { outcome: "shadowed", idempotencyKey: "" };
        },
      },
      retrieval: { async retrieve() { return { cards: [], semanticFallback: false, rejectedBackendHits: 0 }; } },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const runtime = new PluginRuntime(
      harness.context,
      core,
      testOptions("shadow-capture", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );

    try {
      await runtime.start();
      const internal = runtime as unknown as { handleEvent(event: unknown): Promise<void> };
      await internal.handleEvent({
        type: "session.idle",
        location: { directory, workspaceID: "" },
        data: { sessionID: "existing-session" },
      });
      await reconciled.promise;

      expect(checkpointCalls).toEqual([["existing-session", BINDING_KEY, PROJECT_ID]]);
      expect(harness.contextCallCount()).toBe(0);
      expect(ingested).toEqual([]);
      expect(reconciliation).toEqual({ state: "unavailable", lastMessageID: undefined, failed: true });
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not create a checkpoint when session binding validation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-late-attach-foreign-"));
    let checkpoints = 0;
    const harness = fakeContext(directory, {}, [], {
      sessionProjectID: () => "foreign-project",
    });
    const core = {
      capture: {
        runRetentionBacklog() {},
        getCheckpoint() { throw new Error("must not read checkpoint"); },
        checkpoint() { checkpoints++; },
        markReconciled() {},
        ingest() { return { outcome: "shadowed", idempotencyKey: "" }; },
      },
      retrieval: { async retrieve() { return { cards: [], semanticFallback: false, rejectedBackendHits: 0 }; } },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const runtime = new PluginRuntime(
      harness.context,
      core,
      testOptions("shadow-capture", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );

    try {
      await runtime.start();
      await (runtime as unknown as { reconcile(sessionID: string): Promise<void> }).reconcile("foreign-session");
      expect(checkpoints).toBe(0);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps colliding external session IDs isolated by binding and project", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-late-attach-identity-"));
    const secondProjectID = "22222222-2222-4222-8222-222222222222";
    const secondBindingKey = "f".repeat(64);
    const checkpointCalls: Array<[string, string, string]> = [];
    const reconciled: Array<[string, string, string]> = [];
    const core = {
      capture: {
        runRetentionBacklog() {},
        getCheckpoint() { return undefined; },
        checkpoint(sessionID: string, bindingKey: string, projectID: string) {
          checkpointCalls.push([sessionID, bindingKey, projectID]);
        },
        markReconciled(sessionID: string, _state: string, _lastMessageID: string | undefined, _failed: boolean | undefined, bindingKey: string, projectID: string) {
          reconciled.push([sessionID, bindingKey, projectID]);
        },
        ingest() { return { outcome: "shadowed", idempotencyKey: "" }; },
      },
      retrieval: { async retrieve() { return { cards: [], semanticFallback: false, rejectedBackendHits: 0 }; } },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const firstContext = fakeContext(directory, {}, [{ type: "user", id: "first", text: "ordinary" }]);
    const secondContext = fakeContext(directory, {}, [{ type: "user", id: "second", text: "ordinary" }], {
      sessionProjectID: () => "oc-other",
    });
    const first = new PluginRuntime(
      firstContext.context,
      core,
      testOptions("shadow-capture", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );
    const second = new PluginRuntime(
      secondContext.context,
      core,
      testOptions("shadow-capture", secondProjectID, directory),
      { bindingKey: secondBindingKey, projectID: secondProjectID, directory, workspaceID: "", opencodeProjectID: "oc-other" },
    );

    try {
      await first.start();
      await second.start();
      await Promise.all([
        (first as unknown as { reconcile(sessionID: string): Promise<void> }).reconcile("shared-session"),
        (second as unknown as { reconcile(sessionID: string): Promise<void> }).reconcile("shared-session"),
      ]);
      expect(checkpointCalls).toEqual([
        ["shared-session", BINDING_KEY, PROJECT_ID],
        ["shared-session", secondBindingKey, secondProjectID],
      ]);
      expect(reconciled).toEqual(checkpointCalls);
    } finally {
      await first.stop();
      await second.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

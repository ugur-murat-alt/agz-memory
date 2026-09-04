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
    let reconciled = 0;
    const harness = fakeContext(directory, {}, async () => {
      contextEntered.resolve(undefined);
      return releaseContext.promise;
    });
    const core = {
      capture: {
        runRetentionBacklog() {},
        checkpoint() {},
        markReconciled() { reconciled++; },
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
      const internal = runtime as unknown as {
        turnOptedOut(sessionID: string, assistantMessageID?: string): Promise<boolean>;
      };
      void internal.turnOptedOut("session-1", "message-1").catch(() => {});
      await contextEntered.promise;

      let settled = false;
      stopping = runtime.stop().then(() => {
        settled = true;
      });
      await Promise.race([
        stopping,
        Bun.sleep(20).then(() => { throw new Error("stop did not settle promptly after abort"); }),
      ]);
      expect(settled).toBe(true);
      releaseContext.resolve([]);
      await microtaskBarrier();
      expect(reconciled).toBe(0);
    } finally {
      releaseContext.resolve([]);
      if (stopping) await stopping;
      else await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses one bounded deadline for hanging disposal, event stream, and reconcile work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-stop-deadline-"));
    let disposeStarted = 0;
    let eventStreamStarted = 0;
    let marked = 0;
    let ingested = 0;
    const harness = fakeContext(directory);
    const session = harness.context.session as unknown as {
      hook(name: string, callback: unknown): Promise<{ dispose(): Promise<void> }>;
    };
    const originalHook = session.hook.bind(session);
    session.hook = async (name, callback) => {
      await originalHook(name, callback);
      return {
        async dispose() {
          disposeStarted++;
          await new Promise<never>(() => {});
        },
      };
    };
    (harness.context.event as unknown as { subscribe(): AsyncIterable<unknown> }).subscribe = async function* () {
      eventStreamStarted++;
      await new Promise<never>(() => {});
    };
    const core = {
      capture: {
        runRetentionBacklog() {},
        checkpoint() {},
        markReconciled() { marked++; },
        ingest() { ingested++; return { outcome: "shadowed", idempotencyKey: "" }; },
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
      const internal = runtime as unknown as {
        queueReconcile(sessionID: string): void;
        reconcile(sessionID: string): Promise<void>;
      };
      internal.reconcile = async () => await new Promise<never>(() => {});
      internal.queueReconcile("session-1");
      await microtaskBarrier();
      const startedAt = Date.now();
      await Promise.race([
        runtime.stop(),
        Bun.sleep(200).then(() => { throw new Error("stop exceeded its shutdown deadline"); }),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(disposeStarted).toBe(2);
      expect(eventStreamStarted).toBe(1);
      expect(marked).toBe(0);
      expect(ingested).toBe(0);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

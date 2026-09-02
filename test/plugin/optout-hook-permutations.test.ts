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
const NORMAL_HISTORY = [{ type: "user", id: "prompt-0", text: "normal prior turn" }];
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
          checkpoint() {},
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

  test("AGZ-028 and AGZ-029 re-evaluate opt-out after a normal prior turn", async () => {
    const violations: string[] = [];
    for (const order of permutations(ACTIONS)) {
      const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-next-turn-"));
      const ingested: unknown[] = [];
      let history: readonly unknown[] = NORMAL_HISTORY;
      let retrievalCalls = 0;
      const harness = fakeContext(directory, {}, () => history);
      const core = {
        capture: {
          runRetentionBacklog() {},
          checkpoint() {},
          markReconciled() {},
          ingest(event: unknown) {
            ingested.push(event);
            return { outcome: "shadowed", idempotencyKey: "" };
          },
        },
        retrieval: {
          async retrieve() {
            retrievalCalls++;
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
        const prompt = harness.sessionHooks.get("prompt")!;
        const context = harness.sessionHooks.get("context")!;
        const internal = runtime as unknown as { handleEvent(event: unknown): Promise<void> };
        await prompt({
          sessionID: "session-1",
          messageID: "prompt-0",
          prompt: { text: "normal prior turn" },
        });
        await context({
          sessionID: "session-1",
          system: [],
          messages: NORMAL_HISTORY,
        });
        expect(retrievalCalls).toBe(1);
        const baselineIngested = ingested.length;
        const baselineRetrievals = retrievalCalls;
        history = OFF_HISTORY;
        const contextInput = {
          sessionID: "session-1",
          system: [{ type: "text" as const, text: "existing system text" }],
          messages: OFF_HISTORY,
        };

        for (const action of order) {
          if (action === "prompt") {
            await prompt({
              sessionID: "session-1",
              messageID: "prompt-1",
              prompt: { text: "[memory:off] keep this turn private" },
            });
          } else if (action === "context") {
            await context(contextInput);
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
        if (ingested.length !== baselineIngested) {
          violations.push(`${order.join(" -> ")}: captured the opted-out turn`);
        }
        if (retrievalCalls !== baselineRetrievals) {
          violations.push(`${order.join(" -> ")}: retrieved memory for the opted-out turn`);
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

  test("keeps a newer opt-out when an older prompt binding check finishes last", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-prompt-race-"));
    const firstGetEntered = deferred<void>();
    const releaseFirstGet = deferred<void>();
    let retrievalCalls = 0;
    const harness = fakeContext(directory, {}, OFF_HISTORY);
    const session = harness.context.session as unknown as {
      get(input: { sessionID: string }): Promise<unknown>;
    };
    const originalGet = session.get.bind(session);
    let getCalls = 0;
    session.get = async (input) => {
      getCalls++;
      if (getCalls === 1) {
        firstGetEntered.resolve(undefined);
        await releaseFirstGet.promise;
      }
      return originalGet(input);
    };
    const core = {
      capture: {
        runRetentionBacklog() {},
        checkpoint() {},
        markReconciled() {},
        ingest() {},
      },
      retrieval: {
        async retrieve() {
          retrievalCalls++;
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
      const prompt = harness.sessionHooks.get("prompt")!;
      const older = prompt({
        sessionID: "session-1",
        messageID: "prompt-0",
        prompt: { text: "normal prior turn" },
      });
      await firstGetEntered.promise;
      await prompt({
        sessionID: "session-1",
        messageID: "prompt-1",
        prompt: { text: "[memory:off] keep this turn private" },
      });
      releaseFirstGet.resolve(undefined);
      await older;
      const contextInput = {
        sessionID: "session-1",
        system: [{ type: "text" as const, text: "existing system text" }],
        messages: OFF_HISTORY,
      };
      await harness.sessionHooks.get("context")!(contextInput);
      expect(retrievalCalls).toBe(0);
      expect(contextInput.system).toHaveLength(1);
    } finally {
      releaseFirstGet.resolve(undefined);
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("releases prompt generations for deleted and non-matching sessions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-prompt-generation-lifecycle-"));
    const harness = fakeContext(directory, {}, NORMAL_HISTORY, {
      sessionProjectID: (sessionID) => sessionID === "foreign" ? "other-project" : "oc-project",
    });
    const core = {
      capture: {
        runRetentionBacklog() {},
        checkpoint() {},
        markReconciled() {},
        ingest() {},
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
      const prompt = harness.sessionHooks.get("prompt")!;
      const internal = runtime as unknown as {
        promptGenerations: Map<string, number>;
        handleEvent(event: unknown): Promise<void>;
      };
      await prompt({ sessionID: "foreign", messageID: "foreign-prompt", prompt: { text: "normal" } });
      expect(internal.promptGenerations.has("foreign")).toBe(false);
      await prompt({ sessionID: "session-1", messageID: "prompt-0", prompt: { text: "normal" } });
      expect(internal.promptGenerations.has("session-1")).toBe(true);
      await internal.handleEvent({
        type: "session.deleted",
        location: { directory, workspaceID: "" },
        data: { sessionID: "session-1" },
      });
      expect(internal.promptGenerations.has("session-1")).toBe(false);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps prompt opt-out fail-closed when its binding check fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-binding-error-"));
    let retrievalCalls = 0;
    const harness = fakeContext(directory, {}, NORMAL_HISTORY);
    const session = harness.context.session as unknown as {
      get(input: { sessionID: string }): Promise<unknown>;
    };
    const originalGet = session.get.bind(session);
    let getCalls = 0;
    session.get = async (input) => {
      getCalls++;
      if (getCalls === 1) throw new Error("temporary binding failure");
      return originalGet(input);
    };
    const core = {
      capture: { runRetentionBacklog() {}, checkpoint() {}, markReconciled() {}, ingest() {} },
      retrieval: {
        async retrieve() {
          retrievalCalls++;
          return { cards: [], semanticFallback: false, rejectedBackendHits: 0 };
        },
      },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const runtime = new PluginRuntime(
      harness.context,
      core,
      testOptions("inject", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );
    try {
      await runtime.start();
      await harness.sessionHooks.get("prompt")!({
        sessionID: "session-1",
        messageID: "prompt-private",
        prompt: { text: "[memory:off] private" },
      });
      const input = { sessionID: "session-1", system: [], messages: NORMAL_HISTORY };
      await harness.sessionHooks.get("context")!(input);
      expect(retrievalCalls).toBe(0);
      expect(input.system).toEqual([]);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans deleted session state without reading the deleted session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-deleted-cleanup-"));
    const reconciled: unknown[][] = [];
    const harness = fakeContext(directory, {}, NORMAL_HISTORY);
    const core = {
      capture: {
        runRetentionBacklog() {}, checkpoint() {}, ingest() {},
        markReconciled(...args: unknown[]) { reconciled.push(args); },
      },
      retrieval: { async retrieve() { return { cards: [], semanticFallback: false, rejectedBackendHits: 0 }; } },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const runtime = new PluginRuntime(
      harness.context,
      core,
      testOptions("inject", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );
    try {
      await runtime.start();
      await harness.sessionHooks.get("prompt")!({
        sessionID: "session-1",
        messageID: "prompt-1",
        prompt: { text: "[memory:off] private" },
      });
      const session = harness.context.session as unknown as {
        get(input: { sessionID: string }): Promise<unknown>;
      };
      session.get = async () => { throw new Error("SessionNotFoundError"); };
      const internal = runtime as unknown as {
        promptCache: Map<string, unknown>;
        turnStates: Map<string, unknown>;
        promptGenerations: Map<string, unknown>;
        handleEvent(event: unknown): Promise<void>;
      };
      await internal.handleEvent({
        type: "session.deleted",
        location: { directory, workspaceID: "" },
        data: { sessionID: "session-1" },
      });
      expect(internal.promptCache.has("session-1")).toBe(false);
      expect(internal.turnStates.has("session-1")).toBe(false);
      expect(internal.promptGenerations.has("session-1")).toBe(false);
      expect(reconciled).toHaveLength(1);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans stale prompt state after concurrent non-matching prompts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-foreign-prompt-race-"));
    const firstGetEntered = deferred<void>();
    const releaseFirstGet = deferred<void>();
    const harness = fakeContext(directory, {}, NORMAL_HISTORY, {
      sessionProjectID: () => "other-project",
    });
    const session = harness.context.session as unknown as {
      get(input: { sessionID: string }): Promise<unknown>;
    };
    const originalGet = session.get.bind(session);
    let getCalls = 0;
    session.get = async (input) => {
      getCalls++;
      if (getCalls === 1) {
        firstGetEntered.resolve(undefined);
        await releaseFirstGet.promise;
      }
      return originalGet(input);
    };
    const core = {
      capture: { runRetentionBacklog() {}, checkpoint() {}, markReconciled() {}, ingest() {} },
      retrieval: { async retrieve() { return { cards: [], semanticFallback: false, rejectedBackendHits: 0 }; } },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const runtime = new PluginRuntime(
      harness.context,
      core,
      testOptions("inject", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );
    try {
      await runtime.start();
      const prompt = harness.sessionHooks.get("prompt")!;
      const older = prompt({
        sessionID: "foreign",
        messageID: "prompt-private",
        prompt: { text: "[memory:off] private" },
      });
      await firstGetEntered.promise;
      await prompt({ sessionID: "foreign", messageID: "prompt-normal", prompt: { text: "normal" } });
      releaseFirstGet.resolve(undefined);
      await older;
      const internal = runtime as unknown as {
        turnStates: Map<string, unknown>;
        promptGenerations: Map<string, unknown>;
      };
      expect(internal.turnStates.has("foreign")).toBe(false);
      expect(internal.promptGenerations.has("foreign")).toBe(false);
    } finally {
      releaseFirstGet.resolve(undefined);
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
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

  test("keeps an opted-out turn private when its events arrive after the next prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-delayed-"));
    const ingested: unknown[] = [];
    const history = [
      ...OFF_HISTORY,
      {
        type: "assistant",
        id: "assistant-private",
        content: [{ type: "text", text: "private assistant answer" }],
      },
      { type: "user", id: "prompt-2", text: "normal next turn" },
    ];
    const harness = fakeContext(directory, {}, history);
    const core = {
      capture: {
        runRetentionBacklog() {},
        checkpoint() {},
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
      const prompt = harness.sessionHooks.get("prompt")!;
      await prompt({
        sessionID: "session-1",
        messageID: "prompt-1",
        prompt: { text: "[memory:off] keep this turn private" },
      });
      await prompt({
        sessionID: "session-1",
        messageID: "prompt-2",
        prompt: { text: "normal next turn" },
      });
      const baseline = ingested.length;
      await harness.toolHooks.get("execute.after")!({
        sessionID: "session-1",
        messageID: "assistant-private",
        id: "tool-private",
        tool: "bash",
        status: "completed",
      });
      const internal = runtime as unknown as { handleEvent(event: unknown): Promise<void> };
      await internal.handleEvent({
        type: "session.text.ended",
        location: { directory, workspaceID: "" },
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-private",
          text: "private assistant answer",
          ordinal: 0,
        },
      });
      expect(ingested).toHaveLength(baseline);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not let lagging history override a prompt opt-out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-lagging-"));
    let retrievalCalls = 0;
    const harness = fakeContext(directory, {}, NORMAL_HISTORY);
    const core = {
      capture: { runRetentionBacklog() {}, checkpoint() {}, markReconciled() {}, ingest() {} },
      retrieval: {
        async retrieve() {
          retrievalCalls++;
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
      await harness.sessionHooks.get("prompt")!({
        sessionID: "session-1",
        messageID: "prompt-1",
        prompt: { text: "[memory:off] keep this turn private" },
      });
      const input = { sessionID: "session-1", system: [], messages: NORMAL_HISTORY };
      await harness.sessionHooks.get("context")!(input);
      expect(retrievalCalls).toBe(0);
      expect(input.system).toEqual([]);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when the next context arrives before its opt-out prompt and history lags", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-context-first-"));
    let retrievalCalls = 0;
    const harness = fakeContext(directory, {}, NORMAL_HISTORY);
    const core = {
      capture: { runRetentionBacklog() {}, checkpoint() {}, markReconciled() {}, ingest() {} },
      retrieval: {
        async retrieve() {
          retrievalCalls++;
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
      const prompt = harness.sessionHooks.get("prompt")!;
      const context = harness.sessionHooks.get("context")!;
      await prompt({
        sessionID: "session-1",
        messageID: "prompt-0",
        prompt: { text: "normal prior turn" },
      });
      await context({ sessionID: "session-1", system: [], messages: NORMAL_HISTORY });
      expect(retrievalCalls).toBe(1);

      const lagging = { sessionID: "session-1", system: [], messages: NORMAL_HISTORY };
      await context(lagging);
      await prompt({
        sessionID: "session-1",
        messageID: "prompt-1",
        prompt: { text: "[memory:off] keep this turn private" },
      });
      expect(retrievalCalls).toBe(1);
      expect(lagging.system).toEqual([]);
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies a delayed event from its history when prompts change during the probe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-probe-transition-"));
    const historyEntered = deferred<void>();
    const releaseHistory = deferred<readonly unknown[]>();
    const ingested: unknown[] = [];
    const harness = fakeContext(directory, {}, async () => {
      historyEntered.resolve(undefined);
      return releaseHistory.promise;
    });
    const core = {
      capture: {
        runRetentionBacklog() {}, checkpoint() {}, markReconciled() {},
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
      testOptions("inject", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );
    try {
      await runtime.start();
      const prompt = harness.sessionHooks.get("prompt")!;
      await prompt({ sessionID: "session-1", messageID: "prompt-0", prompt: { text: "normal" } });
      const internal = runtime as unknown as { handleEvent(event: unknown): Promise<void> };
      const delayed = internal.handleEvent({
        type: "session.text.ended",
        location: { directory, workspaceID: "" },
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-private",
          text: "private assistant answer",
          ordinal: 0,
        },
      });
      await historyEntered.promise;
      await prompt({
        sessionID: "session-1",
        messageID: "prompt-private",
        prompt: { text: "[memory:off] private" },
      });
      await prompt({ sessionID: "session-1", messageID: "prompt-next", prompt: { text: "normal next" } });
      const baseline = ingested.length;
      releaseHistory.resolve([
        { type: "user", id: "prompt-private", text: "[memory:off] private" },
        { type: "assistant", id: "assistant-private", content: [] },
        { type: "user", id: "prompt-next", text: "normal next" },
      ]);
      await delayed;
      expect(ingested).toHaveLength(baseline);
    } finally {
      releaseHistory.resolve([]);
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not inject a retrieval result after the turn becomes opted out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-retrieval-race-"));
    const retrievalEntered = deferred<void>();
    const releaseRetrieval = deferred<void>();
    const harness = fakeContext(directory, {}, NORMAL_HISTORY);
    const core = {
      capture: { runRetentionBacklog() {}, checkpoint() {}, markReconciled() {}, ingest() {} },
      retrieval: {
        async retrieve() {
          retrievalEntered.resolve(undefined);
          await releaseRetrieval.promise;
          return {
            cards: [{ id: "note-1", kind: "fact", title: "private", summary: "must not inject" }],
            semanticFallback: false,
            rejectedBackendHits: 0,
          };
        },
      },
    } as unknown as ConstructorParameters<typeof PluginRuntime>[1];
    const runtime = new PluginRuntime(
      harness.context,
      core,
      testOptions("inject", PROJECT_ID, directory),
      { bindingKey: BINDING_KEY, projectID: PROJECT_ID, directory, workspaceID: "", opencodeProjectID: "oc-project" },
    );
    try {
      await runtime.start();
      const input = { sessionID: "session-1", system: [], messages: NORMAL_HISTORY };
      const context = harness.sessionHooks.get("context")!(input);
      await retrievalEntered.promise;
      await harness.sessionHooks.get("prompt")!({
        sessionID: "session-1",
        messageID: "prompt-private",
        prompt: { text: "[memory:off] private" },
      });
      releaseRetrieval.resolve(undefined);
      await context;
      expect(input.system).toEqual([]);
    } finally {
      releaseRetrieval.resolve(undefined);
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

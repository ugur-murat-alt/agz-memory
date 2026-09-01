import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Plugin } from "@opencode-ai/plugin";
import * as coreModule from "../../../src/core";
import { parseOptions, SAFE_DEFAULTS } from "../src/config";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const { PluginRuntime } = await import("../src/runtime");
const memoryPlugin = (await import("../src/index")).default;
const { openMemoryCore } = coreModule;

describe("OpenCode V2 memory plugin", () => {
  test("uses strict safe defaults and refuses unproven semantic backends", () => {
    expect(memoryPlugin.id).toBe("agz-memory");
    expect(parseOptions({})).toEqual(SAFE_DEFAULTS);
    expect(() => parseOptions({ unknown: true })).toThrow("unknown field");
    expect(() =>
      parseOptions({ retrieval: { semanticBackend: "agentmemory" } }),
    ).toThrow("not enabled");
    expect(() => parseOptions({ autoCreateProjects: true })).toThrow("must be false");
  });

  test("disables safely when configuration is invalid", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-invalid-"));
    try {
      const harness = fakeContext(directory, { retrieval: { semanticBackend: "agentmemory" } });
      expect(await memoryPlugin.setup(harness.context)).toBeUndefined();
      expect(harness.sessionHooks.size).toBe(0);
      expect(harness.toolHooks.size).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("disposes partial hook registration when setup fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-partial-"));
    const databasePath = join(directory, "memory.sqlite");
    const core = openMemoryCore(databasePath);
    const projectID = core.memory.createProject("Plugin Partial").project!.projectID;
    core.close();
    const harness = fakeContext(
      directory,
      {
        mode: "shadow-capture",
        autoCreateProjects: false,
        bindings: [{ memoryProjectID: projectID, opencodeProjectID: "oc-project" }],
        capture: { enabled: true, allowedKinds: ["preference"], minConfidence: 0.95 },
        retrieval: {
          semanticBackend: "none",
          timeoutMs: 300,
          maxCards: 8,
          maxCharacters: 4_800,
        },
      },
      "context",
    );
    const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    process.env.OPENCODE_MEMORY_DATABASE_PATH = databasePath;
    try {
      expect(await memoryPlugin.setup(harness.context)).toBeUndefined();
      expect(harness.sessionHooks.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("deduplicates prompt retries in shadow capture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-capture-"));
    const databasePath = join(directory, "memory.sqlite");
    const core = openMemoryCore(databasePath);
    const projectID = core.memory.createProject("Plugin Capture").project!.projectID;
    core.close();
    const harness = fakeContext(directory, {
      mode: "shadow-capture",
      autoCreateProjects: false,
      bindings: [{ memoryProjectID: projectID, opencodeProjectID: "oc-project" }],
      capture: {
        enabled: true,
        allowedKinds: ["preference", "decision"],
        minConfidence: 0.95,
      },
      retrieval: {
        semanticBackend: "none",
        timeoutMs: 300,
        maxCards: 8,
        maxCharacters: 4_800,
      },
    });
    const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    process.env.OPENCODE_MEMORY_DATABASE_PATH = databasePath;
    try {
      const cleanup = await memoryPlugin.setup(harness.context);
      const prompt = harness.sessionHooks.get("prompt")!;
      const input = {
        sessionID: "session-1",
        messageID: "message-1",
        prompt: { text: "Tercihim: kısa yanıt ver." },
      };
      await prompt(input);
      await prompt(input);
      await prompt({
        sessionID: "other-session",
        messageID: "message-other",
        prompt: { text: "Tercihim: bu başka projeye aittir." },
      });
      await cleanup?.();
      const check = openMemoryCore(databasePath);
      const checkpoint = check.capture.getCheckpoint("session-1");
      expect(checkpoint?.lastMessageID).toBe("message-1");
      check.close();
      const sqlite = new Database(databasePath, { readonly: true });
      expect(
        (sqlite.query("SELECT COUNT(*) AS count FROM capture_events").get() as { count: number }).count,
      ).toBe(1);
      sqlite.close();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reruns reconciliation when another terminal event arrives in flight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-reconcile-"));
    const databasePath = join(directory, "memory.sqlite");
    const core = openMemoryCore(databasePath);
    const projectID = core.memory.createProject("Plugin Reconcile").project!.projectID;
    const persisted = core.capture.bindProject({
      memoryProjectID: projectID,
      opencodeProjectID: "oc-project",
      canonicalDirectory: directory,
      workspaceID: "",
    });
    core.capture.checkpoint("session-1", persisted.bindingKey, projectID);
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    let enterSecond!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondEntered = new Promise<void>((resolve) => { enterSecond = resolve; });
    const harness = fakeContext(
      directory,
      {},
      undefined,
      async (call) => {
        if (call === 1) {
          enterFirst();
          await firstGate;
        }
        if (call === 2) enterSecond();
      },
    );
    const runtime = new PluginRuntime(
      harness.context,
      core as unknown as ConstructorParameters<typeof PluginRuntime>[1],
      parseOptions({
        mode: "shadow-capture",
        autoCreateProjects: false,
        bindings: [{ memoryProjectID: projectID, opencodeProjectID: "oc-project" }],
        capture: { enabled: true, allowedKinds: ["preference"], minConfidence: 0.95 },
        retrieval: {
          semanticBackend: "none",
          timeoutMs: 300,
          maxCards: 8,
          maxCharacters: 4_800,
        },
      }),
      {
        bindingKey: persisted.bindingKey,
        projectID,
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
        reconcileTasks: Set<Promise<void>>;
      };
      const queue = internal.queueReconcile.bind(runtime);
      queue("session-1");
      await firstEntered;
      queue("session-1");
      releaseFirst();
      await secondEntered;
      expect(harness.contextCallCount()).toBe(2);
      await Promise.allSettled([...internal.reconcileTasks]);

      let boundaryCalls = 0;
      let enterBoundaryRerun!: () => void;
      const boundaryRerun = new Promise<void>((resolve) => { enterBoundaryRerun = resolve; });
      internal.reconcile = (() => {
        boundaryCalls++;
        if (boundaryCalls === 2) {
          enterBoundaryRerun();
          return Promise.resolve();
        }
        return {
          then(resolve: () => void) {
            resolve();
            queueMicrotask(() => queue("boundary-session"));
          },
        } as unknown as Promise<void>;
      }) as typeof internal.reconcile;
      queue("boundary-session");
      await boundaryRerun;
      expect(boundaryCalls).toBe(2);
    } finally {
      await runtime.stop();
      core.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("injects one bounded untrusted block and never persists it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-inject-"));
    const databasePath = join(directory, "memory.sqlite");
    const core = openMemoryCore(databasePath);
    const projectID = core.memory.createProject("Plugin Inject").project!.projectID;
    core.memory.update(projectID, {
      kind: "decision",
      title: "Compiler",
      summary: "Use Bun for builds",
    });
    core.close();
    const harness = fakeContext(directory, {
      mode: "inject",
      autoCreateProjects: false,
      bindings: [{ memoryProjectID: projectID, opencodeProjectID: "oc-project" }],
      capture: { enabled: false, allowedKinds: ["decision"], minConfidence: 0.95 },
      retrieval: {
        semanticBackend: "none",
        timeoutMs: 300,
        maxCards: 8,
        maxCharacters: 4_800,
      },
    });
    const previous = process.env.OPENCODE_MEMORY_DATABASE_PATH;
    process.env.OPENCODE_MEMORY_DATABASE_PATH = databasePath;
    try {
      const cleanup = await memoryPlugin.setup(harness.context);
      const context = harness.sessionHooks.get("context")!;
      const input = {
        sessionID: "session-1",
        system: [] as Array<{ type: "text"; text: string }>,
        messages: [{ role: "user", content: [{ type: "text", text: "Bun compiler" }] }],
      };
      await context(input);
      await context(input);
      expect(input.system).toHaveLength(1);
      expect(input.system[0]!.text).toContain('trust="untrusted"');
      expect(input.system[0]!.text).toContain("Use Bun for builds");
      const prompt = harness.sessionHooks.get("prompt")!;
      for (let index = 0; index < 129; index++) {
        await prompt({
          sessionID: `session-${index}`,
          messageID: `message-${index}`,
          prompt: { text: "Bun compiler" },
        });
      }
      const evicted = { sessionID: "session-0", system: [], messages: [] };
      await context(evicted);
      expect(evicted.system).toHaveLength(0);
      const newest = { sessionID: "session-128", system: [], messages: [] };
      await context(newest);
      expect(newest.system).toHaveLength(1);
      await cleanup?.();
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_MEMORY_DATABASE_PATH;
      else process.env.OPENCODE_MEMORY_DATABASE_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("honors memory off for the full turn and resumes on the next prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-"));
    const databasePath = join(directory, "memory.sqlite");
    const core = openMemoryCore(databasePath);
    const projectID = core.memory.createProject("Plugin Opt Out").project!.projectID;
    core.memory.update(projectID, {
      kind: "decision",
      title: "Compiler",
      summary: "Use Bun for builds",
    });
    const persisted = core.capture.bindProject({
      memoryProjectID: projectID,
      opencodeProjectID: "oc-project",
      canonicalDirectory: directory,
      workspaceID: "",
    });
    const history = [
      {
        type: "user",
        id: "message-1",
        text: "[memory:off] Kararım: bu turda hafıza kullanma.",
      },
      {
        type: "assistant",
        id: "assistant-1",
        content: [{ type: "text", text: "Opted-out assistant answer" }],
      },
      { type: "user", id: "message-2", text: "Bun compiler" },
      {
        type: "assistant",
        id: "assistant-2",
        content: [{ type: "text", text: "Normal assistant answer" }],
      },
    ];
    const harness = fakeContext(directory, {}, undefined, undefined, history);
    const runtime = new PluginRuntime(
      harness.context,
      core as unknown as ConstructorParameters<typeof PluginRuntime>[1],
      parseOptions({
        mode: "inject",
        autoCreateProjects: false,
        bindings: [{ memoryProjectID: projectID, opencodeProjectID: "oc-project" }],
        capture: { enabled: true, allowedKinds: ["preference", "decision"], minConfidence: 0.95 },
        retrieval: {
          semanticBackend: "none",
          timeoutMs: 300,
          maxCards: 8,
          maxCharacters: 4_800,
        },
      }),
      {
        bindingKey: persisted.bindingKey,
        projectID,
        directory,
        workspaceID: "",
        opencodeProjectID: "oc-project",
      },
    );
    try {
      await runtime.start();
      const prompt = harness.sessionHooks.get("prompt")!;
      const context = harness.sessionHooks.get("context")!;
      const tool = harness.toolHooks.get("execute.after")!;
      await prompt({
        sessionID: "session-1",
        messageID: "message-1",
        prompt: { text: "[memory:off] Kararım: bu turda hafıza kullanma." },
      });
      const optedOutContext = {
        sessionID: "session-1",
        system: [] as Array<{ type: "text"; text: string }>,
        messages: [{ role: "user", content: [{ type: "text", text: "Bun compiler" }] }],
      };
      await context(optedOutContext);
      await tool({ sessionID: "session-1" });
      const internal = runtime as unknown as {
        handleEvent(event: unknown): Promise<void>;
        reconcile(sessionID: string): Promise<void>;
      };
      await internal.handleEvent({
        type: "session.text.ended",
        location: { directory, workspaceID: "" },
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          text: "Assistant memory candidate",
          ordinal: 0,
        },
      });
      await internal.handleEvent({
        type: "session.execution.succeeded",
        location: { directory, workspaceID: "" },
        data: { sessionID: "session-1" },
      });
      expect(optedOutContext.system).toHaveLength(0);
      expect(harness.contextCallCount()).toBe(0);
      const sqlite = new Database(databasePath, { readonly: true });
      expect((sqlite.query("SELECT COUNT(*) AS count FROM capture_events").get() as { count: number }).count).toBe(0);
      sqlite.close();

      await prompt({
        sessionID: "session-1",
        messageID: "message-2",
        prompt: { text: "Bun compiler" },
      });
      const resumed = {
        sessionID: "session-1",
        system: [] as Array<{ type: "text"; text: string }>,
        messages: [] as unknown[],
      };
      await context(resumed);
      expect(resumed.system).toHaveLength(1);
      expect(resumed.system[0]!.text).toContain("Use Bun for builds");
      await internal.reconcile("session-1");
      const reconciled = new Database(databasePath, { readonly: true });
      const payloads = JSON.stringify(reconciled.query("SELECT payload_json FROM capture_events").all());
      expect(payloads).not.toContain("Opted-out assistant answer");
      expect(payloads).toContain("Normal assistant answer");
      expect(
        (reconciled.query("SELECT COUNT(*) AS count FROM capture_events").get() as { count: number }).count,
      ).toBe(1);
      reconciled.close();
    } finally {
      await runtime.stop();
      core.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reconstructs memory off after a mid-turn runtime restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-plugin-optout-restart-"));
    const databasePath = join(directory, "memory.sqlite");
    const core = openMemoryCore(databasePath);
    const projectID = core.memory.createProject("Plugin Restart Opt Out").project!.projectID;
    const persisted = core.capture.bindProject({
      memoryProjectID: projectID,
      opencodeProjectID: "oc-project",
      canonicalDirectory: directory,
      workspaceID: "",
    });
    const history = [
      {
        type: "user",
        id: "message-1",
        text: "[memory:off] do not retain this turn",
      },
    ];
    const harness = fakeContext(directory, {}, undefined, undefined, history);
    const runtime = new PluginRuntime(
      harness.context,
      core as unknown as ConstructorParameters<typeof PluginRuntime>[1],
      parseOptions({
        mode: "shadow-capture",
        autoCreateProjects: false,
        bindings: [{ memoryProjectID: projectID, opencodeProjectID: "oc-project" }],
        capture: { enabled: true, allowedKinds: ["preference", "decision"], minConfidence: 0.95 },
        retrieval: {
          semanticBackend: "none",
          timeoutMs: 300,
          maxCards: 8,
          maxCharacters: 4_800,
        },
      }),
      {
        bindingKey: persisted.bindingKey,
        projectID,
        directory,
        workspaceID: "",
        opencodeProjectID: "oc-project",
      },
    );
    try {
      await runtime.start();
      const internal = runtime as unknown as { handleEvent(event: unknown): Promise<void> };
      await internal.handleEvent({
        type: "session.text.ended",
        location: { directory, workspaceID: "" },
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          text: "Restarted assistant answer",
          ordinal: 0,
        },
      });
      const sqlite = new Database(databasePath, { readonly: true });
      expect((sqlite.query("SELECT COUNT(*) AS count FROM capture_events").get() as { count: number }).count).toBe(0);
      sqlite.close();
      expect(harness.contextCallCount()).toBe(1);
    } finally {
      await runtime.stop();
      core.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fakeContext(
  directory: string,
  options: Record<string, unknown>,
  failHook?: string,
  onContext?: (call: number) => Promise<void> | void,
  contextMessages: unknown[] = [],
) {
  const sessionHooks = new Map<string, (input: unknown) => Promise<void> | void>();
  const toolHooks = new Map<string, (input: unknown) => Promise<void> | void>();
  let contextCalls = 0;
  const context = {
    app: { name: "opencode2", version: "0.0.0-beta-18743", channel: "beta" },
    location: {
      directory,
      project: { id: "oc-project", directory, canonical: directory },
    },
    options,
    session: {
      async hook(name: string, callback: (input: unknown) => Promise<void> | void) {
        if (name === failHook) throw new Error("hook registration failed");
        sessionHooks.set(name, callback);
        return { async dispose() { sessionHooks.delete(name); } };
      },
      async get(input: { sessionID: string }) {
        return {
          id: input.sessionID,
          projectID: input.sessionID === "other-session" ? "other-project" : "oc-project",
          cost: { amount: "0", currency: "USD" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), updated: Date.now() },
          location: { directory },
        };
      },
      async context() {
        contextCalls++;
        await onContext?.(contextCalls);
        return contextMessages;
      },
    },
    tool: {
      async hook(name: string, callback: (input: unknown) => Promise<void> | void) {
        if (name === failHook) throw new Error("hook registration failed");
        toolHooks.set(name, callback);
        return { async dispose() { toolHooks.delete(name); } };
      },
    },
    event: {
      async *subscribe(request?: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (request?.signal?.aborted) resolve();
          else request?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  } as unknown as Plugin.Context;
  return { context, sessionHooks, toolHooks, contextCallCount: () => contextCalls };
}

import type { Plugin } from "@opencode-ai/plugin";
import { parseOptions } from "../../packages/opencode-plugin/src/config";
import type { MemoryPluginOptions } from "../../packages/opencode-plugin/src/config";

export { parseOptions };

export type Hook = (input: unknown) => Promise<void> | void;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

export async function microtaskBarrier(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type ContextMessages =
  | readonly unknown[]
  | ((sessionID: string, input: unknown, call: number) => readonly unknown[] | Promise<readonly unknown[]>);

export function fakeContext(
  directory: string,
  options: unknown = {},
  contextMessages: ContextMessages = [],
  configuration: {
    failHook?: string;
    sessionProjectID?: (sessionID: string) => string;
    sessionDirectory?: (sessionID: string) => string;
    sessionWorkspaceID?: (sessionID: string) => string;
  } = {},
) {
  const sessionHooks = new Map<string, Hook>();
  const toolHooks = new Map<string, Hook>();
  const contextCalls: Array<{ sessionID: string; input: unknown }> = [];
  const sessionGetCalls: string[] = [];
  const sessionProjectID = configuration.sessionProjectID ?? (() => "oc-project");
  const sessionDirectory = configuration.sessionDirectory ?? (() => directory);
  const sessionWorkspaceID = configuration.sessionWorkspaceID ?? (() => "");
  const context = {
    app: { name: "opencode2", version: "0.0.0-beta-18743", channel: "beta" },
    location: {
      directory,
      workspaceID: "",
      project: { id: "oc-project", directory, canonical: directory },
    },
    options,
    session: {
      async hook(name: string, callback: Hook) {
        if (name === configuration.failHook) throw new Error("hook registration failed");
        sessionHooks.set(name, callback);
        return {
          async dispose() {
            if (sessionHooks.get(name) === callback) sessionHooks.delete(name);
          },
        };
      },
      async get(input: { sessionID: string }) {
        sessionGetCalls.push(String(input.sessionID));
        return {
          id: input.sessionID,
          projectID: sessionProjectID(String(input.sessionID)),
          cost: { amount: "0", currency: "USD" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), updated: Date.now() },
          location: {
            directory: sessionDirectory(String(input.sessionID)),
            workspaceID: sessionWorkspaceID(String(input.sessionID)),
          },
        };
      },
      async context(input: { sessionID: string }) {
        const sessionID = String(input.sessionID);
        contextCalls.push({ sessionID, input });
        if (typeof contextMessages === "function") {
          return await contextMessages(sessionID, input, contextCalls.length);
        }
        return contextMessages;
      },
    },
    tool: {
      async hook(name: string, callback: Hook) {
        if (name === configuration.failHook) throw new Error("hook registration failed");
        toolHooks.set(name, callback);
        return {
          async dispose() {
            if (toolHooks.get(name) === callback) toolHooks.delete(name);
          },
        };
      },
    },
    event: {
      async *subscribe(request?: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (request?.signal?.aborted) {
            resolve();
            return;
          }
          request?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  } as unknown as Plugin.Context;
  return {
    context,
    sessionHooks,
    toolHooks,
    contextCalls,
    sessionGetCalls,
    contextCallCount: () => contextCalls.length,
    sessionGetCallCount: () => sessionGetCalls.length,
  };
}

export function testOptions(
  mode: MemoryPluginOptions["mode"],
  projectID = "11111111-1111-4111-8111-111111111111",
  canonicalDirectory?: string,
): MemoryPluginOptions {
  return parseOptions({
    mode,
    autoCreateProjects: false,
    bindings: [
      {
        memoryProjectID: projectID,
        opencodeProjectID: "oc-project",
        ...(canonicalDirectory === undefined ? {} : { canonicalDirectory }),
      },
    ],
    capture: { enabled: true, allowedKinds: ["preference", "decision"], minConfidence: 0.95 },
    retrieval: { semanticBackend: "none", timeoutMs: 300, maxCards: 8, maxCharacters: 4_800 },
  });
}

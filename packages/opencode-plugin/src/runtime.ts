import type { Plugin } from "@opencode-ai/plugin";
import {
  CAPTURE_SCHEMA,
  REDACTION_POLICY_VERSION,
  SUPPORTED_OPENCODE_VERSION,
  captureIdempotencyKey,
  formatUntrustedContext,
  projectToolSignal,
  redactText,
  type CaptureEventV1,
  type MemoryCore,
  type MemoryCandidateV1,
} from "@vaur94/agz-memory/core";
import type { ActiveBinding } from "./binding";
import { eventMatchesLocation, sessionMatchesBinding } from "./binding";
import type { MemoryPluginOptions } from "./config";
import { safeAssistantCandidate, safeUserCandidate } from "./extract";
import { PLUGIN_VERSION } from "./version";

type OpenCodeEvent = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event>
  ? Event
  : never;

interface TurnState {
  messageID?: string;
  optedOut: boolean;
  source: "prompt" | "history";
}

const MAX_RECONCILE_CONCURRENCY = 4;

export class PluginRuntime {
  private abort = new AbortController();
  private registrations: Array<{ dispose(): Promise<void> }> = [];
  private promptCache = new Map<string, { text: string; expiresAt: number }>();
  private turnStates = new Map<string, TurnState>();
  private promptGenerations = new Map<string, number>();
  private nextPromptGeneration = 0;
  private optOutProbes = new Map<string, Promise<boolean>>();
  private reconcileQueue = new Set<string>();
  private reconcilePending = new Set<string>();
  private reconcileAgain = new Set<string>();
  private reconcileTasks = new Set<Promise<void>>();
  private reconcileActive = 0;
  private reconcileDispatchScheduled = false;
  private eventLoop?: Promise<void>;
  private retentionTimer?: ReturnType<typeof setInterval>;

  constructor(
    private ctx: Plugin.Context,
    private core: MemoryCore,
    private options: MemoryPluginOptions,
    private binding: ActiveBinding,
  ) {}

  async start(): Promise<void> {
    try {
      this.core.capture.runRetentionBacklog();
      this.retentionTimer = setInterval(() => {
        try {
          this.core.capture.runRetentionBacklog();
        } catch (error) {
          this.log("retention", error);
        }
      }, 60 * 60_000);
      this.retentionTimer.unref();
      this.registrations.push(
        await this.ctx.session.hook("prompt", async (input) => {
          if (this.abort.signal.aborted) return;
          try {
            const sessionID = String(input.sessionID);
            const generation = ++this.nextPromptGeneration;
            this.promptGenerations.set(sessionID, generation);
            const optedOut = /\[memory:off\]/i.test(input.prompt.text);
            if (optedOut) {
              this.turnStates.set(sessionID, {
                messageID: String(input.messageID),
                optedOut: true,
                source: "prompt",
              });
              this.promptCache.delete(sessionID);
            }
            let matches: boolean;
            try {
              matches = await this.matchesBinding(sessionID);
            } catch (error) {
              this.discardPromptGeneration(sessionID, generation, true);
              throw error;
            }
            if (!matches) {
              this.discardPromptGeneration(sessionID, generation, false);
              return;
            }
            if (
              this.abort.signal.aborted ||
              this.promptGenerations.get(sessionID) !== generation
            ) {
              return;
            }
            this.turnStates.set(sessionID, {
              messageID: String(input.messageID),
              optedOut,
              source: "prompt",
            });
            if (optedOut) {
              this.promptCache.delete(sessionID);
              return;
            }
            this.cachePrompt(sessionID, input.prompt.text);
            if (!this.captureEnabled) return;
            const safe = safeUserCandidate(input.prompt.text);
            if (safe.candidate) {
              this.ingestCandidate(
                "user-candidate",
                sessionID,
                String(input.messageID),
                safe.candidate,
                safe.redaction,
              );
            }
            this.core.capture.checkpoint(
              sessionID,
              this.binding.bindingKey,
              this.binding.projectID,
            );
          } catch (error) {
            this.log("prompt", error);
          }
        }),
      );
      this.registrations.push(
        await this.ctx.session.hook("context", async (input) => {
          if (this.abort.signal.aborted || !this.retrievalEnabled) return;
          const originalLength = input.system.length;
          try {
            const sessionID = String(input.sessionID);
            if (!(await this.matchesBinding(sessionID))) return;
            if (this.abort.signal.aborted) return;
            const promptQuery = this.takePrompt(sessionID);
            const previousTurn = this.turnStates.get(sessionID);
            if (this.updateTurnFromMessages(sessionID, input.messages)) return;
            if (
              promptQuery === undefined &&
              previousTurn !== undefined &&
              this.turnStates.get(sessionID) === previousTurn
            ) {
              return;
            }
            const query = promptQuery ?? latestUserText(input.messages);
            if (!query) return;
            const deadlineAt = Date.now() + this.options.retrieval.timeoutMs;
            const retrievalTurn = this.turnStates.get(sessionID);
            const result = await this.core.retrieval.retrieve({
              projectID: this.binding.projectID,
              query,
              limit: this.options.retrieval.maxCards,
              deadlineAt,
              semantic: "off",
            });
            if (this.abort.signal.aborted) return;
            if (
              this.turnStates.get(sessionID) !== retrievalTurn ||
              retrievalTurn?.optedOut
            ) {
              return;
            }
            if (this.options.mode === "shadow-retrieval") return;
            if (input.system.some((part) => part.text.includes("<agz-memory-context"))) return;
            const context = formatUntrustedContext(this.binding.projectID, result.cards, {
              maxCards: this.options.retrieval.maxCards,
              maxCharacters: this.options.retrieval.maxCharacters,
            });
            if (context && Date.now() <= deadlineAt) input.system.push({ type: "text", text: context });
          } catch (error) {
            if (input.system.length !== originalLength) input.system.splice(originalLength);
            this.log("context", error);
          }
        }),
      );
      this.registrations.push(
        await this.ctx.tool.hook("execute.after", async (input) => {
          if (this.abort.signal.aborted || !this.captureEnabled) return;
          try {
            const sessionID = String(input.sessionID);
            if (!(await this.matchesBinding(sessionID))) return;
            if (this.abort.signal.aborted) return;
            if (await this.turnOptedOut(sessionID, String(input.messageID))) return;
            if (this.abort.signal.aborted) return;
            const signal = projectToolSignal(
              input.tool,
              input.status,
              input.status === "error" ? input.error : undefined,
            );
            const key = captureIdempotencyKey({
              kind: "tool",
              bindingKey: this.binding.bindingKey,
              sessionID: String(input.sessionID),
              assistantMessageID: String(input.messageID),
              toolCallID: String(input.id),
              terminalStatus: input.status,
            });
            const event: CaptureEventV1 = {
              schema: CAPTURE_SCHEMA,
              idempotencyKey: key,
              projectID: this.binding.projectID,
              bindingKey: this.binding.bindingKey,
              kind: "tool-signal",
              source: {
                system: "opencode-v2",
                opencodeVersion: SUPPORTED_OPENCODE_VERSION,
                pluginVersion: PLUGIN_VERSION,
                sessionID: String(input.sessionID),
                messageID: String(input.messageID),
                toolCallID: String(input.id),
                observedAt: Date.now(),
              },
              signal,
              redaction: { policyVersion: REDACTION_POLICY_VERSION, replacements: 0, truncated: false },
            };
            this.core.capture.ingest(event, this.captureMode, this.capturePolicy);
          } catch (error) {
            this.log("tool", error);
          }
        }),
      );
      this.eventLoop = this.runEventLoop();
    } catch (error) {
      this.abort.abort();
      if (this.retentionTimer) clearInterval(this.retentionTimer);
      this.retentionTimer = undefined;
      await Promise.allSettled(this.registrations.splice(0).map((registration) => registration.dispose()));
      this.promptCache.clear();
      this.promptGenerations.clear();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = undefined;
    await Promise.allSettled(this.registrations.splice(0).map((registration) => registration.dispose()));
    this.promptCache.clear();
    this.turnStates.clear();
    this.promptGenerations.clear();
    this.optOutProbes.clear();
    this.reconcilePending.clear();
    this.reconcileAgain.clear();
    this.reconcileQueue.clear();
  }

  private async runEventLoop(): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const stream = this.ctx.event.subscribe({ signal: this.abort.signal });
        for await (const event of stream) {
          if (this.abort.signal.aborted) break;
          await this.handleEvent(event);
        }
        failures = 0;
      } catch (error) {
        if (this.abort.signal.aborted) return;
        failures++;
        this.log("event_stream", error);
      }
      await delay(Math.min(30_000, 250 * 2 ** Math.min(failures, 7)), this.abort.signal);
    }
  }

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    if (!isSessionEvent(event)) return;
    const locationMatch = eventMatchesLocation(event.location, this.binding);
    if (event.type === "session.deleted") {
      this.promptCache.delete(event.data.sessionID);
      this.turnStates.delete(event.data.sessionID);
      this.promptGenerations.delete(event.data.sessionID);
      if (locationMatch !== true) return;
      try {
        this.core.capture.markReconciled(
          event.data.sessionID,
          "closed",
          undefined,
          false,
          this.binding.bindingKey,
          this.binding.projectID,
        );
      } catch {}
      return;
    }
    if (locationMatch === false) return;
    if (!(await this.matchesBinding(event.data.sessionID))) return;
    if (this.abort.signal.aborted) return;
    if (await this.turnOptedOut(event.data.sessionID, eventAssistantMessageID(event))) return;
    if (this.abort.signal.aborted) return;
    if (event.type === "session.text.ended" && this.captureEnabled) {
      const safe = safeAssistantCandidate([{ type: "text", text: event.data.text }]);
      if (safe.candidate) {
        const key = captureIdempotencyKey({
          kind: "assistant",
          bindingKey: this.binding.bindingKey,
          sessionID: event.data.sessionID,
          assistantMessageID: event.data.assistantMessageID,
          ordinal: event.data.ordinal,
        });
        this.ingestCandidate(
          "assistant-candidate",
          event.data.sessionID,
          event.data.assistantMessageID,
          safe.candidate,
          safe.redaction,
          event.data.ordinal,
          key,
        );
      }
      return;
    }
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted" ||
      event.type === "session.idle" ||
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      this.queueReconcile(event.data.sessionID);
    }
  }

  private queueReconcile(sessionID: string): void {
    if (this.abort.signal.aborted) return;
    if (this.reconcileQueue.has(sessionID)) {
      this.reconcileAgain.add(sessionID);
      return;
    }
    this.reconcileQueue.add(sessionID);
    this.reconcilePending.add(sessionID);
    this.scheduleReconcileDispatch();
  }

  private scheduleReconcileDispatch(): void {
    if (this.reconcileDispatchScheduled) return;
    this.reconcileDispatchScheduled = true;
    queueMicrotask(() => {
      this.reconcileDispatchScheduled = false;
      this.dispatchReconciles();
    });
  }

  private dispatchReconciles(): void {
    while (
      !this.abort.signal.aborted &&
      this.reconcileActive < MAX_RECONCILE_CONCURRENCY
    ) {
      const sessionID = this.reconcilePending.values().next().value as string | undefined;
      if (sessionID === undefined) return;
      this.reconcilePending.delete(sessionID);
      this.reconcileActive++;
      const task = this.runReconcile(sessionID).finally(() => {
        this.reconcileActive--;
        this.reconcileQueue.delete(sessionID);
        this.reconcileTasks.delete(task);
        const rerun = this.reconcileAgain.delete(sessionID);
        if (rerun && !this.abort.signal.aborted) {
          this.reconcileQueue.add(sessionID);
          this.reconcilePending.add(sessionID);
        }
        this.scheduleReconcileDispatch();
      });
      this.reconcileTasks.add(task);
    }
  }

  private async runReconcile(sessionID: string): Promise<void> {
    do {
      this.reconcileAgain.delete(sessionID);
      await this.reconcile(sessionID);
    } while (!this.abort.signal.aborted && this.reconcileAgain.delete(sessionID));
  }

  private async reconcile(sessionID: string): Promise<void> {
    if (this.abort.signal.aborted || !this.captureEnabled) return;
    try {
      const checkpoint = this.core.capture.getCheckpoint?.(
        sessionID,
        this.binding.bindingKey,
        this.binding.projectID,
      );
      const messages = await withTimeout(
        async (signal) => {
          if (!(await sessionMatchesBinding(this.ctx, sessionID, this.binding, signal))) {
            return undefined;
          }
          return this.ctx.session.context({ sessionID }, { signal });
        },
        this.options.retrieval.timeoutMs,
        this.abort.signal,
      );
      if (!messages) return;
      if (this.abort.signal.aborted) return;
      const checkpointIndex =
        checkpoint?.lastMessageID === undefined
          ? -1
          : messages.findIndex(
              (message) =>
                Boolean(message && typeof message === "object" && "id" in message) &&
                String((message as { id: unknown }).id) === checkpoint.lastMessageID,
            );
      const firstMessageIndex = checkpointIndex < 0 ? 0 : checkpointIndex + 1;
      let lastMessageID: string | undefined;
      let skipAssistantTurn =
        checkpointIndex < 0
          ? false
          : /\[memory:off\]/i.test(latestUserText(messages.slice(0, firstMessageIndex)) ?? "");
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (!message || typeof message !== "object" || !("id" in message)) continue;
        lastMessageID = String(message.id);
        if (index < firstMessageIndex) continue;
        if (message.type === "user") {
          skipAssistantTurn = /\[memory:off\]/i.test(message.text);
          if (skipAssistantTurn) continue;
          const safe = safeUserCandidate(message.text);
          if (safe.candidate) {
            this.ingestCandidate(
              "user-candidate",
              sessionID,
              String(message.id),
              safe.candidate,
              safe.redaction,
            );
          }
        }
        if (message.type === "assistant") {
          if (skipAssistantTurn) continue;
          for (let ordinal = 0; ordinal < message.content.length; ordinal++) {
            const part = message.content[ordinal]!;
            if (part.type !== "text") continue;
            const safe = safeAssistantCandidate([part]);
            if (!safe.candidate) continue;
            const key = captureIdempotencyKey({
              kind: "assistant",
              bindingKey: this.binding.bindingKey,
              sessionID,
              assistantMessageID: String(message.id),
              ordinal,
            });
            this.ingestCandidate(
              "assistant-candidate",
              sessionID,
              String(message.id),
              safe.candidate,
              safe.redaction,
              ordinal,
              key,
            );
          }
        }
      }
      if (this.abort.signal.aborted) return;
      this.core.capture.markReconciled(
        sessionID,
        "active",
        lastMessageID,
        false,
        this.binding.bindingKey,
        this.binding.projectID,
      );
    } catch (error) {
      try {
        if (!this.abort.signal.aborted) {
          this.core.capture.markReconciled(
            sessionID,
            "unavailable",
            undefined,
            true,
            this.binding.bindingKey,
            this.binding.projectID,
          );
        }
      } catch {}
      this.log("reconcile", error);
    }
  }

  private ingestCandidate(
    kind: "user-candidate" | "assistant-candidate" | "session-summary",
    sessionID: string,
    messageID: string,
    candidate: MemoryCandidateV1,
    redaction: { replacements: number; truncated: boolean; quarantined?: boolean },
    ordinal?: number,
    explicitKey?: string,
  ): void {
    const key =
      explicitKey ??
      captureIdempotencyKey({
        kind: "user",
        bindingKey: this.binding.bindingKey,
        sessionID,
        messageID,
      });
    const event: CaptureEventV1 = {
      schema: CAPTURE_SCHEMA,
      idempotencyKey: key,
      projectID: this.binding.projectID,
      bindingKey: this.binding.bindingKey,
      kind,
      source: {
        system: "opencode-v2",
        opencodeVersion: SUPPORTED_OPENCODE_VERSION,
        pluginVersion: PLUGIN_VERSION,
        sessionID,
        messageID,
        ...(ordinal === undefined ? {} : { ordinal }),
        observedAt: Date.now(),
      },
      candidate,
      redaction: {
        policyVersion: redaction.quarantined
          ? `${REDACTION_POLICY_VERSION}/quarantined`
          : REDACTION_POLICY_VERSION,
        replacements: redaction.replacements,
        truncated: redaction.truncated,
      },
    };
    this.core.capture.ingest(event, this.captureMode, this.capturePolicy);
  }

  private get captureEnabled(): boolean {
    return this.options.capture.enabled && this.options.mode !== "off";
  }

  private cachePrompt(sessionID: string, text: string): void {
    const now = Date.now();
    for (const [key, entry] of this.promptCache) {
      if (entry.expiresAt <= now) this.promptCache.delete(key);
    }
    this.promptCache.delete(sessionID);
    this.promptCache.set(sessionID, { text: text.slice(0, 16_384), expiresAt: now + 5 * 60_000 });
    while (this.promptCache.size > 128) {
      const oldest = this.promptCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.promptCache.delete(oldest);
    }
  }

  private takePrompt(sessionID: string): string | undefined {
    const entry = this.promptCache.get(sessionID);
    this.promptCache.delete(sessionID);
    return entry && entry.expiresAt > Date.now() ? entry.text : undefined;
  }

  private get retrievalEnabled(): boolean {
    return ["shadow-retrieval", "inject", "auto-write"].includes(this.options.mode);
  }

  private async turnOptedOut(sessionID: string, assistantMessageID?: string): Promise<boolean> {
    if (this.turnStates.get(sessionID)?.optedOut) return true;
    const probeKey = `${sessionID}\0${assistantMessageID ?? ""}`;
    const existing = this.optOutProbes.get(probeKey);
    if (existing) {
      const optedOut = await existing;
      return optedOut || Boolean(this.turnStates.get(sessionID)?.optedOut);
    }
    const initialState = this.turnStates.get(sessionID);
    const probe = (async () => {
      const messages = await withTimeout(
        (signal) => this.ctx.session.context({ sessionID }, { signal }),
        this.options.retrieval.timeoutMs,
        this.abort.signal,
      );
      if (assistantMessageID !== undefined) {
        if (
          this.turnStates.get(sessionID) !== initialState &&
          this.turnStates.get(sessionID)?.optedOut
        ) {
          return true;
        }
        const turn = userTurnForMessage(messages, assistantMessageID);
        return turn ? /\[memory:off\]/i.test(turn.text) : true;
      }
      if (this.turnStates.get(sessionID) !== initialState) {
        return Boolean(this.turnStates.get(sessionID)?.optedOut);
      }
      return this.updateTurnFromMessages(sessionID, messages);
    })();
    this.optOutProbes.set(probeKey, probe);
    try {
      const optedOut = await probe;
      return optedOut || Boolean(this.turnStates.get(sessionID)?.optedOut);
    } finally {
      if (this.optOutProbes.get(probeKey) === probe) this.optOutProbes.delete(probeKey);
    }
  }

  private updateTurnFromMessages(sessionID: string, messages: readonly unknown[]): boolean {
    const latest = latestUserTurn(messages);
    const current = this.turnStates.get(sessionID);
    if (!latest) return Boolean(current?.optedOut);
    if (current && latest.messageID === current.messageID) return current.optedOut;
    if (current?.optedOut) {
      if (current.messageID === undefined) return true;
      const currentIndex = messageIndex(messages, current.messageID);
      const latestIndex = latest.messageID === undefined ? -1 : messageIndex(messages, latest.messageID);
      if (currentIndex < 0 || latestIndex <= currentIndex) return true;
    }
    const optedOut = /\[memory:off\]/i.test(latest.text);
    this.turnStates.set(sessionID, {
      ...(latest.messageID === undefined ? {} : { messageID: latest.messageID }),
      optedOut,
      source: "history",
    });
    if (optedOut) this.promptCache.delete(sessionID);
    return optedOut;
  }

  private matchesBinding(sessionID: string): Promise<boolean> {
    return withTimeout(
      (signal) => sessionMatchesBinding(this.ctx, sessionID, this.binding, signal),
      this.options.retrieval.timeoutMs,
      this.abort.signal,
    );
  }

  private discardPromptGeneration(
    sessionID: string,
    generation: number,
    preserveOptOut: boolean,
  ): void {
    if (this.promptGenerations.get(sessionID) !== generation) return;
    this.promptGenerations.delete(sessionID);
    this.promptCache.delete(sessionID);
    const state = this.turnStates.get(sessionID);
    if (state?.source === "prompt" && (!preserveOptOut || !state.optedOut)) {
      this.turnStates.delete(sessionID);
    }
  }

  private get captureMode(): "shadow" | "auto-write" {
    return this.options.mode === "auto-write" ? "auto-write" : "shadow";
  }

  private get capturePolicy() {
    return {
      allowedKinds: this.options.capture.allowedKinds,
      minConfidence: this.options.capture.minConfidence,
    };
  }

  private log(operation: string, error: unknown): void {
    const errorCode = error instanceof Error ? safeErrorCode(error.message) : "unknown";
    process.stderr.write(
      `${JSON.stringify({ component: "agz-memory-plugin", operation, outcome: "failed", error_code: errorCode })}\n`,
    );
  }
}

function isSessionEvent(
  event: OpenCodeEvent,
): event is Extract<OpenCodeEvent, { data: { sessionID: string } }> {
  return Boolean(event.data && typeof event.data === "object" && "sessionID" in event.data);
}

function eventAssistantMessageID(event: OpenCodeEvent): string | undefined {
  if (!event.data || typeof event.data !== "object") return undefined;
  if ("assistantMessageID" in event.data && event.data.assistantMessageID !== undefined) {
    return String(event.data.assistantMessageID);
  }
  if ("messageID" in event.data && event.data.messageID !== undefined) {
    return String(event.data.messageID);
  }
  return undefined;
}

function latestUserText(messages: readonly unknown[]): string | undefined {
  return latestUserTurn(messages)?.text;
}

function latestUserTurn(
  messages: readonly unknown[],
): { messageID?: string; text: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const messageID = "id" in message ? String((message as { id: unknown }).id) : undefined;
    if (
      (message as { type?: unknown }).type === "user" &&
      typeof (message as { text?: unknown }).text === "string"
    ) {
      return { ...(messageID === undefined ? {} : { messageID }), text: (message as { text: string }).text };
    }
    if ((message as { role?: unknown }).role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return { ...(messageID === undefined ? {} : { messageID }), text: content };
    }
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          ),
      )
      .map((part) => part.text)
      .join("\n");
    if (text) return { ...(messageID === undefined ? {} : { messageID }), text };
  }
  return undefined;
}

function userTurnForMessage(
  messages: readonly unknown[],
  messageID: string,
): { messageID?: string; text: string } | undefined {
  const index = messageIndex(messages, messageID);
  return index < 0 ? undefined : latestUserTurn(messages.slice(0, index + 1));
}

function messageIndex(messages: readonly unknown[], messageID: string): number {
  return messages.findIndex(
    (message) =>
      Boolean(message && typeof message === "object" && "id" in message) &&
      String((message as { id: unknown }).id) === messageID,
  );
}

function safeErrorCode(value: string): string {
  if (/binding/i.test(value)) return "binding_conflict";
  if (/timeout|abort/i.test(value)) return "timeout";
  if (/database|sqlite|lock/i.test(value)) return "database_unavailable";
  return "plugin_failure";
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  parentSignal: AbortSignal,
): Promise<T> {
  if (parentSignal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onAbort);
      action();
    };
    const abort = (code: "aborted" | "timeout") => {
      controller.abort();
      finish(() => reject(new Error(code)));
    };
    const onAbort = () => abort("aborted");
    const timer = setTimeout(
      () => abort("timeout"),
      milliseconds,
    );
    parentSignal.addEventListener("abort", onAbort, { once: true });
    operation(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

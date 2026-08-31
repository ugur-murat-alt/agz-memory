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
} from "@vaur94/opencode2-memory/core";
import type { ActiveBinding } from "./binding";
import { eventMatchesLocation, sessionMatchesBinding } from "./binding";
import type { MemoryPluginOptions } from "./config";
import { safeAssistantCandidate, safeUserCandidate } from "./extract";

type OpenCodeEvent = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event>
  ? Event
  : never;

export class PluginRuntime {
  private abort = new AbortController();
  private registrations: Array<{ dispose(): Promise<void> }> = [];
  private promptCache = new Map<string, { text: string; expiresAt: number }>();
  private reconcileQueue = new Set<string>();
  private reconcileAgain = new Set<string>();
  private reconcileTasks = new Set<Promise<void>>();
  private eventLoop?: Promise<void>;

  constructor(
    private ctx: Plugin.Context,
    private core: MemoryCore,
    private options: MemoryPluginOptions,
    private binding: ActiveBinding,
  ) {}

  async start(): Promise<void> {
    try {
      this.registrations.push(
        await this.ctx.session.hook("prompt", async (input) => {
          if (this.abort.signal.aborted) return;
          try {
            const sessionID = String(input.sessionID);
            if (!(await sessionMatchesBinding(this.ctx, sessionID, this.binding))) return;
            this.cachePrompt(sessionID, input.prompt.text);
            if (!this.captureEnabled || /\[memory:off\]/i.test(input.prompt.text)) return;
            this.core.capture.checkpoint(
              sessionID,
              this.binding.bindingKey,
              this.binding.projectID,
              String(input.messageID),
            );
            const safe = safeUserCandidate(input.prompt.text);
            if (!safe.candidate) return;
            this.ingestCandidate(
              "user-candidate",
              sessionID,
              String(input.messageID),
              safe.candidate,
              safe.redaction,
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
            if (!(await sessionMatchesBinding(this.ctx, String(input.sessionID), this.binding))) return;
            const query = this.takePrompt(String(input.sessionID)) ?? latestUserText(input.messages);
            if (!query) return;
            const deadlineAt = Date.now() + this.options.retrieval.timeoutMs;
            const result = await this.core.retrieval.retrieve({
              projectID: this.binding.projectID,
              query,
              limit: this.options.retrieval.maxCards,
              deadlineAt,
              semantic: "off",
            });
            if (this.options.mode === "shadow-retrieval") return;
            if (input.system.some((part) => part.text.includes("<opencode2-memory-context"))) return;
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
            if (!(await sessionMatchesBinding(this.ctx, String(input.sessionID), this.binding))) return;
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
                pluginVersion: "0.4.0-beta.1",
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
      await Promise.allSettled(this.registrations.splice(0).map((registration) => registration.dispose()));
      this.promptCache.clear();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.registrations.splice(0).map((registration) => registration.dispose()));
    this.promptCache.clear();
    if (this.eventLoop) await this.eventLoop;
    await Promise.allSettled([...this.reconcileTasks]);
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
    if (locationMatch === false) return;
    if (locationMatch === undefined && !(await sessionMatchesBinding(this.ctx, event.data.sessionID, this.binding))) {
      return;
    }
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
    if (event.type === "session.deleted") {
      this.promptCache.delete(event.data.sessionID);
      try {
        this.core.capture.markReconciled(event.data.sessionID, "closed");
      } catch {}
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
    queueMicrotask(() => {
      if (this.abort.signal.aborted) {
        this.reconcileQueue.delete(sessionID);
        this.reconcileAgain.delete(sessionID);
        return;
      }
      const task = (async () => {
        do {
          this.reconcileAgain.delete(sessionID);
          await this.reconcile(sessionID);
        } while (!this.abort.signal.aborted && this.reconcileAgain.delete(sessionID));
      })().finally(() => {
        this.reconcileQueue.delete(sessionID);
        this.reconcileTasks.delete(task);
        const rerun = this.reconcileAgain.delete(sessionID);
        if (rerun && !this.abort.signal.aborted) this.queueReconcile(sessionID);
      });
      this.reconcileTasks.add(task);
    });
  }

  private async reconcile(sessionID: string): Promise<void> {
    if (this.abort.signal.aborted || !this.captureEnabled) return;
    try {
      if (!(await sessionMatchesBinding(this.ctx, sessionID, this.binding))) return;
      const messages = await this.ctx.session.context({ sessionID });
      let lastMessageID: string | undefined;
      for (const message of messages) {
        if (!("id" in message)) continue;
        lastMessageID = String(message.id);
        if (message.type === "user") {
          if (/\[memory:off\]/i.test(message.text)) continue;
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
      this.core.capture.markReconciled(sessionID, "active", lastMessageID);
    } catch (error) {
      try {
        this.core.capture.markReconciled(sessionID, "unavailable", undefined, true);
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
        pluginVersion: "0.4.0-beta.1",
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
      `${JSON.stringify({ component: "opencode2-memory-plugin", operation, outcome: "failed", error_code: errorCode })}\n`,
    );
  }
}

function isSessionEvent(
  event: OpenCodeEvent,
): event is Extract<OpenCodeEvent, { data: { sessionID: string } }> {
  return Boolean(event.data && typeof event.data === "object" && "sessionID" in event.data);
}

function latestUserText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
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
    if (text) return text;
  }
  return undefined;
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

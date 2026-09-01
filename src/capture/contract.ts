import * as z from "zod/v4";
import { KINDS } from "../types";

export const CAPTURE_SCHEMA = "agz-memory.capture/1" as const;
export const SUPPORTED_OPENCODE_VERSION = "0.0.0-beta-18743" as const;
export const CAPTURE_EVENT_MAX_BYTES = 16 * 1024;
export const CAPTURE_CONTENT_MAX_CHARACTERS = 4_800;
export const CAPTURE_SUMMARY_MAX_CHARACTERS = 1_200;
export const CAPTURE_SUBJECT_MAX_CHARACTERS = 240;

const candidateSchema = z
  .object({
    kind: z.enum(KINDS),
    title: z.string().min(1).max(240),
    summary: z.string().min(1).max(CAPTURE_SUMMARY_MAX_CHARACTERS),
    content: z.string().min(1).max(CAPTURE_CONTENT_MAX_CHARACTERS),
    subjectKey: z.string().min(1).max(CAPTURE_SUBJECT_MAX_CHARACTERS).optional(),
    intent: z.enum(["create", "supersede", "ignore", "review"]),
    targetNoteID: z.string().min(1).max(240).optional(),
    confidence: z.number().finite().min(0).max(1),
    evidence: z.enum(["explicit-user", "verified-outcome", "session-summary"]),
  })
  .strict();

const signalSchema = z
  .object({
    tool: z.string().min(1).max(160),
    status: z.enum(["completed", "error"]),
    errorType: z.string().min(1).max(160).optional(),
  })
  .strict();

export const captureEventSchema = z
  .object({
    schema: z.literal(CAPTURE_SCHEMA),
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
    projectID: z.uuid(),
    bindingKey: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["user-candidate", "assistant-candidate", "session-summary", "tool-signal"]),
    source: z
      .object({
        system: z.literal("opencode-v2"),
        opencodeVersion: z.literal(SUPPORTED_OPENCODE_VERSION),
        pluginVersion: z.string().min(1).max(80),
        sessionID: z.string().min(1).max(240),
        messageID: z.string().min(1).max(240).optional(),
        ordinal: z.number().int().nonnegative().optional(),
        toolCallID: z.string().min(1).max(240).optional(),
        observedAt: z.number().int().nonnegative(),
      })
      .strict(),
    candidate: candidateSchema.optional(),
    signal: signalSchema.optional(),
    redaction: z
      .object({
        policyVersion: z.string().min(1).max(80),
        replacements: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.kind === "tool-signal" && !event.signal) {
      context.addIssue({ code: "custom", message: "tool-signal requires signal" });
    }
    if (event.kind !== "tool-signal" && !event.candidate) {
      context.addIssue({ code: "custom", message: `${event.kind} requires candidate` });
    }
    if (event.kind === "tool-signal" && event.candidate) {
      context.addIssue({ code: "custom", message: "tool-signal cannot carry candidate" });
    }
    if (event.kind !== "tool-signal" && event.signal) {
      context.addIssue({ code: "custom", message: `${event.kind} cannot carry signal` });
    }
  });

export type MemoryCandidateV1 = z.infer<typeof candidateSchema>;
export type CaptureEventV1 = z.infer<typeof captureEventSchema>;

export function parseCaptureEvent(value: unknown): CaptureEventV1 {
  const event = captureEventSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > CAPTURE_EVENT_MAX_BYTES) {
    throw new Error(`capture event exceeds ${CAPTURE_EVENT_MAX_BYTES} UTF-8 bytes`);
  }
  return event;
}

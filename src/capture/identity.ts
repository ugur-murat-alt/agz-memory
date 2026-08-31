import { createHash } from "crypto";

export type CaptureIdentityInput =
  | {
      kind: "user";
      bindingKey: string;
      sessionID: string;
      messageID: string;
    }
  | {
      kind: "assistant";
      bindingKey: string;
      sessionID: string;
      assistantMessageID: string;
      ordinal: number;
    }
  | {
      kind: "tool";
      bindingKey: string;
      sessionID: string;
      assistantMessageID: string;
      toolCallID: string;
      terminalStatus: "completed" | "error";
    }
  | {
      kind: "summary";
      bindingKey: string;
      sessionID: string;
      checkpointMessageID: string;
    };

export function captureIdempotencyKey(input: CaptureIdentityInput): string {
  const fields =
    input.kind === "user"
      ? ["capture/1", "user", input.bindingKey, input.sessionID, input.messageID]
      : input.kind === "assistant"
        ? [
            "capture/1",
            "assistant",
            input.bindingKey,
            input.sessionID,
            input.assistantMessageID,
            String(input.ordinal),
          ]
        : input.kind === "tool"
          ? [
              "capture/1",
              "tool",
              input.bindingKey,
              input.sessionID,
              input.assistantMessageID,
              input.toolCallID,
              input.terminalStatus,
            ]
          : [
              "capture/1",
              "summary",
              input.bindingKey,
              input.sessionID,
              input.checkpointMessageID,
            ];
  return createHash("sha256").update(fields.join("\0"), "utf8").digest("hex");
}

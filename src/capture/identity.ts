import { hashTuple, type HashTupleValue } from "../hash";

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
  let fields: HashTupleValue[];
  if (input.kind === "user") {
    fields = ["user", input.bindingKey, input.sessionID, input.messageID];
  } else if (input.kind === "assistant") {
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
      throw new RangeError("assistant capture ordinal must be a non-negative safe integer");
    }
    fields = [
      "assistant",
      input.bindingKey,
      input.sessionID,
      input.assistantMessageID,
      input.ordinal,
    ];
  } else if (input.kind === "tool") {
    fields = [
      "tool",
      input.bindingKey,
      input.sessionID,
      input.assistantMessageID,
      input.toolCallID,
      input.terminalStatus,
    ];
  } else {
    fields = ["summary", input.bindingKey, input.sessionID, input.checkpointMessageID];
  }
  return hashTuple("capture-identity", 2, fields);
}

import { describe, expect, mock, test } from "bun:test";
import * as coreModule from "../../src/core";
import {
  CAPTURE_CONTENT_MAX_CHARACTERS,
  projectAssistantParts,
  projectUserPrompt,
  redactText,
} from "../../src/core";

mock.module("@vaur94/agz-memory/core", () => coreModule);
const { safeAssistantCandidate, safeUserCandidate } = await import(
  "../../packages/opencode-plugin/src/extract"
);

const LIMIT = CAPTURE_CONTENT_MAX_CHARACTERS;

describe("deterministic redaction and truncation properties", () => {
  test("keeps projection and redaction limits exact at 4,800 characters", () => {
    for (const length of [4_799, 4_800, 4_801]) {
      const value = "x".repeat(length);
      const expectedText = length > LIMIT ? value.slice(-LIMIT) : value;
      expect(projectUserPrompt({ text: value }, LIMIT)).toEqual({
        text: expectedText,
        truncated: length > LIMIT,
      });
      expect(projectAssistantParts([{ type: "text", text: value }], LIMIT)).toEqual({
        text: expectedText,
        truncated: length > LIMIT,
      });
      expect(redactText(value, { maxCharacters: LIMIT })).toMatchObject({
        text: expectedText,
        truncated: length > LIMIT,
      });
    }
  });

  test("propagates long user and assistant truncation into the capture redaction boundary", () => {
    const userText = `USER_HEAD:${"u".repeat(LIMIT)}:USER_TAIL`;
    const userProjection = projectUserPrompt({ text: userText }, LIMIT);
    expect(userProjection.truncated).toBe(true);
    expect(userProjection.text).toContain("USER_TAIL");
    expect(safeUserCandidate(userText).redaction.truncated).toBe(true);

    const assistantText = `ASSISTANT_HEAD:${"a".repeat(LIMIT)}:ASSISTANT_TAIL`;
    const assistantProjection = projectAssistantParts(
      [{ type: "text", text: assistantText }],
      LIMIT,
    );
    expect(assistantProjection.truncated).toBe(true);
    expect(assistantProjection.text).toContain("ASSISTANT_TAIL");
    expect(safeAssistantCandidate([{ type: "text", text: assistantText }]).redaction.truncated).toBe(true);
  });

  test("quarantines a secret regardless of deterministic placement around the boundary", () => {
    const token = "a".repeat(32);
    const secret = `Bearer ${token}`;
    for (const prefixLength of [0, 1, 239, 1_199, 4_799]) {
      const result = redactText("p".repeat(prefixLength) + secret, { maxCharacters: LIMIT });
      expect(result.text).not.toContain(token);
      expect(result.replacements).toBeGreaterThan(0);
      expect(result.quarantined).toBe(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { KINDS } from "../../src/types";
import { LIMITS } from "../../src/contracts/limits";
import { parseOptions, SAFE_DEFAULTS } from "../../packages/opencode-plugin/src/config";

const MEMORY_PROJECT_A = "11111111-1111-4111-8111-111111111111";
const MEMORY_PROJECT_B = "22222222-2222-4222-8222-222222222222";

describe("OpenCode V2 plugin config bounds", () => {
  test("rejects extractionModel with a stable typed error code", () => {
    expect(() => parseOptions({ capture: { extractionModel: { providerID: "provider", id: "model" } } }))
      .toThrow("unsupported_extraction_model");
    expect(readCode(() => parseOptions({ capture: { extractionModel: {} } }))).toBe("unsupported_extraction_model");
  });

  test("accepts only unique KINDS values for allowedKinds", () => {
    expect(parseOptions({ capture: { allowedKinds: [...KINDS] } }).capture.allowedKinds).toEqual([...KINDS]);
    expect(() => parseOptions({ capture: { allowedKinds: ["not-a-kind"] } })).toThrow("invalid_allowed_kind");
    expect(() => parseOptions({ capture: { allowedKinds: ["decision", "decision"] } }))
      .toThrow("duplicate_allowed_kind");
  });

  test("bounds binding strings by UTF-8 bytes, not JavaScript characters", () => {
    const tooLong = "😀".repeat(Math.floor(LIMITS.noteID / 4) + 1);
    for (const field of ["opencodeProjectID", "workspaceID", "canonicalDirectory"] as const) {
      expect(() => parseOptions({ bindings: [{ memoryProjectID: MEMORY_PROJECT_A, opencodeProjectID: "project", [field]: tooLong }] }))
        .toThrow("string_too_long");
    }
  });

  test("rejects empty or whitespace-only binding identifiers", () => {
    for (const field of ["memoryProjectID", "opencodeProjectID", "workspaceID", "canonicalDirectory"] as const) {
      expect(() => parseOptions({ bindings: [{ memoryProjectID: MEMORY_PROJECT_A, opencodeProjectID: "project", [field]: "  " }] }))
        .toThrow("empty_string");
    }
  });

  test("caps the number of configured bindings", () => {
    const bindings = Array.from({ length: LIMITS.batch + 1 }, (_, index) => ({
      memoryProjectID: MEMORY_PROJECT_A,
      opencodeProjectID: `opencode-project-${index}`,
    }));
    expect(() => parseOptions({ bindings })).toThrow("bindings_limit_exceeded");
  });

  test("distinguishes exact duplicate bindings from a memory-project conflict", () => {
    const binding = { memoryProjectID: MEMORY_PROJECT_A, opencodeProjectID: "opencode-project", workspaceID: "workspace" };
    expect(() => parseOptions({ bindings: [binding, { ...binding }] })).toThrow("duplicate_binding");
    expect(() => parseOptions({ bindings: [binding, { ...binding, memoryProjectID: MEMORY_PROJECT_B }] }))
      .toThrow("binding_conflict");
  });

  test("rejects unknown nested fields without changing safe defaults", () => {
    expect(parseOptions({})).toEqual(SAFE_DEFAULTS);
    expect(() => parseOptions({ capture: { unknown: true } })).toThrow("unknown field");
    expect(() => parseOptions({ bindings: [{ memoryProjectID: MEMORY_PROJECT_A, opencodeProjectID: "project", unknown: true }] }))
      .toThrow("unknown field");
    expect(() => parseOptions({ retrieval: { unknown: true } })).toThrow("unknown field");
  });
});

function readCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

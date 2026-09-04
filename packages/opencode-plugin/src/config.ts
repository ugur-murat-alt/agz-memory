import { KINDS, LIMITS, utf8Bytes } from "@vaur94/agz-memory/core";

export type PluginMode = "off" | "shadow-capture" | "shadow-retrieval" | "inject" | "auto-write";

export type PluginConfigErrorCode =
  | "unknown_field"
  | "invalid_mode"
  | "auto_create_projects_disabled"
  | "bindings_not_array"
  | "bindings_limit_exceeded"
  | "binding_not_object"
  | "invalid_string"
  | "empty_string"
  | "string_too_long"
  | "invalid_memory_project_id"
  | "invalid_allowed_kinds"
  | "invalid_allowed_kind"
  | "duplicate_allowed_kind"
  | "duplicate_binding"
  | "binding_conflict"
  | "invalid_capture_enabled"
  | "invalid_min_confidence"
  | "unsupported_extraction_model"
  | "invalid_semantic_backend"
  | "semantic_backend_disabled"
  | "invalid_integer";

export class PluginConfigError extends Error {
  constructor(readonly code: PluginConfigErrorCode, message: string) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = "PluginConfigError";
  }
}

export interface ProjectBindingInput {
  memoryProjectID: string;
  opencodeProjectID: string;
  canonicalDirectory?: string;
  workspaceID?: string;
}

export interface MemoryPluginOptions {
  mode: PluginMode;
  autoCreateProjects: false;
  bindings: ProjectBindingInput[];
  capture: {
    enabled: boolean;
    extractionModel?: { providerID: string; id: string; variant?: string };
    allowedKinds: string[];
    minConfidence: number;
  };
  retrieval: {
    semanticBackend: "none" | "agentmemory" | "mcp-memory-service";
    timeoutMs: number;
    maxCards: number;
    maxCharacters: number;
  };
}

export const SAFE_DEFAULTS: MemoryPluginOptions = {
  mode: "off",
  autoCreateProjects: false,
  bindings: [],
  capture: {
    enabled: false,
    allowedKinds: ["preference", "decision"],
    minConfidence: 0.95,
  },
  retrieval: {
    semanticBackend: "none",
    timeoutMs: 300,
    maxCards: 8,
    maxCharacters: 4_800,
  },
};

export function parseOptions(value: Readonly<Record<string, unknown>>): MemoryPluginOptions {
  rejectUnknown(value, ["mode", "autoCreateProjects", "bindings", "capture", "retrieval"], "options");
  const mode = value.mode ?? SAFE_DEFAULTS.mode;
  if (!isOneOf(mode, ["off", "shadow-capture", "shadow-retrieval", "inject", "auto-write"])) {
    throw new PluginConfigError("invalid_mode", "invalid memory plugin mode");
  }
  const autoCreateProjects = value.autoCreateProjects ?? false;
  if (autoCreateProjects !== false) {
    throw new PluginConfigError("auto_create_projects_disabled", "autoCreateProjects must be false");
  }
  const bindings = value.bindings ?? [];
  if (!Array.isArray(bindings)) throw new PluginConfigError("bindings_not_array", "bindings must be an array");
  if (bindings.length > LIMITS.batch) {
    throw new PluginConfigError("bindings_limit_exceeded", `bindings must contain at most ${LIMITS.batch} entries`);
  }
  const parsedBindings = parseBindings(bindings);
  const capture = parseCapture(value.capture);
  const retrieval = parseRetrieval(value.retrieval);
  return { mode, autoCreateProjects, bindings: parsedBindings, capture, retrieval };
}

function parseBindings(values: unknown[]): ProjectBindingInput[] {
  const parsed: ProjectBindingInput[] = [];
  const byComposite = new Map<string, ProjectBindingInput>();
  for (const [index, value] of values.entries()) {
    const binding = parseBinding(value, index);
    const composite = JSON.stringify([binding.opencodeProjectID, binding.workspaceID ?? ""]);
    const previous = byComposite.get(composite);
    if (previous) {
      if (sameBinding(previous, binding)) {
        throw new PluginConfigError("duplicate_binding", `duplicate binding at bindings[${index}]`);
      }
      throw new PluginConfigError("binding_conflict", `conflicting binding at bindings[${index}]`);
    }
    byComposite.set(composite, binding);
    parsed.push(binding);
  }
  return parsed;
}

function parseBinding(value: unknown, index: number): ProjectBindingInput {
  const entry = object(value, `bindings[${index}]`);
  rejectUnknown(
    entry,
    ["memoryProjectID", "opencodeProjectID", "canonicalDirectory", "workspaceID"],
    `bindings[${index}]`,
  );
  const memoryProjectID = requiredString(entry.memoryProjectID, "memoryProjectID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memoryProjectID)) {
    throw new PluginConfigError("invalid_memory_project_id", "memoryProjectID must be a UUID");
  }
  return {
    memoryProjectID,
    opencodeProjectID: requiredString(entry.opencodeProjectID, "opencodeProjectID"),
    ...(entry.canonicalDirectory === undefined
      ? {}
      : { canonicalDirectory: requiredString(entry.canonicalDirectory, "canonicalDirectory") }),
    ...(entry.workspaceID === undefined
      ? {}
      : { workspaceID: requiredString(entry.workspaceID, "workspaceID") }),
  };
}

function parseCapture(value: unknown): MemoryPluginOptions["capture"] {
  if (value === undefined) return { ...SAFE_DEFAULTS.capture };
  const input = object(value, "capture");
  if (Object.prototype.hasOwnProperty.call(input, "extractionModel")) {
    throw new PluginConfigError("unsupported_extraction_model", "unsupported_extraction_model");
  }
  rejectUnknown(input, ["enabled", "allowedKinds", "minConfidence"], "capture");
  const enabled = input.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new PluginConfigError("invalid_capture_enabled", "capture.enabled must be boolean");
  }
  const allowedKinds = input.allowedKinds ?? SAFE_DEFAULTS.capture.allowedKinds;
  const parsedKinds = parseAllowedKinds(allowedKinds);
  const minConfidence = input.minConfidence ?? 0.95;
  if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new PluginConfigError("invalid_min_confidence", "capture.minConfidence must be between 0 and 1");
  }
  return { enabled, allowedKinds: parsedKinds, minConfidence };
}

function parseRetrieval(value: unknown): MemoryPluginOptions["retrieval"] {
  if (value === undefined) return { ...SAFE_DEFAULTS.retrieval };
  const input = object(value, "retrieval");
  rejectUnknown(input, ["semanticBackend", "timeoutMs", "maxCards", "maxCharacters"], "retrieval");
  const semanticBackend = input.semanticBackend ?? "none";
  if (!isOneOf(semanticBackend, ["none", "agentmemory", "mcp-memory-service"])) {
    throw new PluginConfigError("invalid_semantic_backend", "invalid semantic backend");
  }
  if (semanticBackend !== "none") {
    throw new PluginConfigError(
      "semantic_backend_disabled",
      "semantic backend is not enabled without a passing vendor contract benchmark",
    );
  }
  const timeoutMs = boundedInteger(input.timeoutMs ?? 300, 1, 300, "retrieval.timeoutMs");
  const maxCards = boundedInteger(input.maxCards ?? 8, 1, 8, "retrieval.maxCards");
  const maxCharacters = boundedInteger(
    input.maxCharacters ?? 4_800,
    256,
    4_800,
    "retrieval.maxCharacters",
  );
  return { semanticBackend, timeoutMs, maxCards, maxCharacters };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginConfigError("binding_not_object", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new PluginConfigError("unknown_field", `${label} contains unknown field: ${unknown[0]}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PluginConfigError("invalid_string", `${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (!normalized) throw new PluginConfigError("empty_string", `${label} must be a non-empty string`);
  if (utf8Bytes(normalized) > LIMITS.noteID) {
    throw new PluginConfigError("string_too_long", `${label} exceeds ${LIMITS.noteID} UTF-8 bytes`);
  }
  return normalized;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PluginConfigError("invalid_integer", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function parseAllowedKinds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PluginConfigError("invalid_allowed_kinds", "capture.allowedKinds must be an array");
  }
  const kinds = new Set<string>();
  for (const [index, kind] of value.entries()) {
    if (typeof kind !== "string") {
      throw new PluginConfigError("invalid_allowed_kind", `capture.allowedKinds[${index}] must be a string`);
    }
    if (utf8Bytes(kind) > LIMITS.noteID) {
      throw new PluginConfigError("string_too_long", `capture.allowedKinds[${index}] exceeds ${LIMITS.noteID} UTF-8 bytes`);
    }
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new PluginConfigError("invalid_allowed_kind", `capture.allowedKinds[${index}] is not a supported kind`);
    }
    if (kinds.has(kind)) {
      throw new PluginConfigError("duplicate_allowed_kind", `duplicate capture.allowedKinds[${index}]`);
    }
    kinds.add(kind);
  }
  return [...kinds];
}

function sameBinding(left: ProjectBindingInput, right: ProjectBindingInput): boolean {
  return (
    left.memoryProjectID === right.memoryProjectID &&
    left.opencodeProjectID === right.opencodeProjectID &&
    (left.workspaceID ?? "") === (right.workspaceID ?? "") &&
    (left.canonicalDirectory ?? "") === (right.canonicalDirectory ?? "")
  );
}

function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

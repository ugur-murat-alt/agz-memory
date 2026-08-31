export type PluginMode = "off" | "shadow-capture" | "shadow-retrieval" | "inject" | "auto-write";

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
    throw new Error("invalid memory plugin mode");
  }
  const autoCreateProjects = value.autoCreateProjects ?? false;
  if (autoCreateProjects !== false) throw new Error("autoCreateProjects must be false");
  const bindings = value.bindings ?? [];
  if (!Array.isArray(bindings)) throw new Error("bindings must be an array");
  const parsedBindings = bindings.map((entry, index) => parseBinding(entry, index));
  const capture = parseCapture(value.capture);
  const retrieval = parseRetrieval(value.retrieval);
  return { mode, autoCreateProjects, bindings: parsedBindings, capture, retrieval };
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
    throw new Error("memoryProjectID must be a UUID");
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
  rejectUnknown(input, ["enabled", "extractionModel", "allowedKinds", "minConfidence"], "capture");
  const enabled = input.enabled ?? false;
  if (typeof enabled !== "boolean") throw new Error("capture.enabled must be boolean");
  const allowedKinds = input.allowedKinds ?? SAFE_DEFAULTS.capture.allowedKinds;
  if (!Array.isArray(allowedKinds) || !allowedKinds.every((kind) => typeof kind === "string")) {
    throw new Error("capture.allowedKinds must be strings");
  }
  const minConfidence = input.minConfidence ?? 0.95;
  if (typeof minConfidence !== "number" || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error("capture.minConfidence must be between 0 and 1");
  }
  let extractionModel: MemoryPluginOptions["capture"]["extractionModel"];
  if (input.extractionModel !== undefined) {
    const model = object(input.extractionModel, "capture.extractionModel");
    rejectUnknown(model, ["providerID", "id", "variant"], "capture.extractionModel");
    extractionModel = {
      providerID: requiredString(model.providerID, "providerID"),
      id: requiredString(model.id, "id"),
      ...(model.variant === undefined ? {} : { variant: requiredString(model.variant, "variant") }),
    };
  }
  return { enabled, allowedKinds: [...allowedKinds], minConfidence, ...(extractionModel ? { extractionModel } : {}) };
}

function parseRetrieval(value: unknown): MemoryPluginOptions["retrieval"] {
  if (value === undefined) return { ...SAFE_DEFAULTS.retrieval };
  const input = object(value, "retrieval");
  rejectUnknown(input, ["semanticBackend", "timeoutMs", "maxCards", "maxCharacters"], "retrieval");
  const semanticBackend = input.semanticBackend ?? "none";
  if (!isOneOf(semanticBackend, ["none", "agentmemory", "mcp-memory-service"])) {
    throw new Error("invalid semantic backend");
  }
  if (semanticBackend !== "none") {
    throw new Error("semantic backend is not enabled without a passing vendor contract benchmark");
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field: ${unknown[0]}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

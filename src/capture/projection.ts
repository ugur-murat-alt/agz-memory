export interface ProjectedText {
  text: string;
  truncated: boolean;
}

export function projectUserPrompt(prompt: { text?: unknown }, maxCharacters = 4_800): ProjectedText {
  return bound(typeof prompt.text === "string" ? prompt.text : "", maxCharacters);
}

export function projectAssistantParts(
  parts: readonly unknown[],
  maxCharacters = 4_800,
): ProjectedText {
  const text = parts
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
    .join("\n\n");
  return bound(text, maxCharacters);
}

export function projectSessionSummary(
  messages: readonly { role: string; parts: readonly unknown[] }[],
  maxCharacters = 4_800,
): ProjectedText {
  const limit = normalizeLimit(maxCharacters);
  const selected: string[] = [];
  let size = 0;
  let truncated = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const projected = projectAssistantParts(message.parts, maxCharacters);
    truncated ||= projected.truncated;
    if (!projected.text) continue;
    const entry = `${message.role}: ${projected.text}`;
    if (size + entry.length + 2 > limit) {
      truncated = true;
      break;
    }
    selected.unshift(entry);
    size += entry.length + 2;
  }
  return { text: selected.join("\n\n"), truncated };
}

export function projectToolSignal(
  tool: string,
  status: "completed" | "error",
  error?: unknown,
): { tool: string; status: "completed" | "error"; errorType?: string } {
  const normalizedTool = truncateHead(tool.trim(), 160);
  const errorType = status === "error" ? normalizeErrorType(error) : undefined;
  return { tool: normalizedTool, status, ...(errorType ? { errorType } : {}) };
}

function normalizeErrorType(error: unknown): string {
  const name =
    error instanceof Error
      ? error.name
      : error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
        ? (error as { name: string }).name
        : "Error";
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160) || "Error";
}

function bound(value: string, maxCharacters: number): ProjectedText {
  const limit = normalizeLimit(maxCharacters);
  const truncated = value.length > limit;
  return {
    text: truncated ? truncateTail(value, limit) : value,
    truncated,
  };
}

function normalizeLimit(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function truncateHead(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  if (value.length <= maxCharacters) return value;
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset)!;
    const width = codePoint > 0xffff ? 2 : 1;
    if (offset + width > maxCharacters) break;
    offset += width;
  }
  return value.slice(0, offset);
}

function truncateTail(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  if (value.length <= maxCharacters) return value;
  let offset = value.length;
  let size = 0;
  while (offset > 0) {
    const last = value.charCodeAt(offset - 1);
    const paired =
      last >= 0xdc00 &&
      last <= 0xdfff &&
      offset > 1 &&
      value.charCodeAt(offset - 2) >= 0xd800 &&
      value.charCodeAt(offset - 2) <= 0xdbff;
    const width = paired ? 2 : 1;
    if (size + width > maxCharacters) break;
    offset -= width;
    size += width;
  }
  return value.slice(offset);
}

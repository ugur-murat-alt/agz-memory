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
  const selected: string[] = [];
  let size = 0;
  let truncated = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const projected = projectAssistantParts(message.parts, maxCharacters);
    if (!projected.text) continue;
    const entry = `${message.role}: ${projected.text}`;
    if (size + entry.length + 2 > maxCharacters) {
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
  const normalizedTool = tool.trim().slice(0, 160);
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
  return {
    text: value.length > maxCharacters ? value.slice(value.length - maxCharacters) : value,
    truncated: value.length > maxCharacters,
  };
}

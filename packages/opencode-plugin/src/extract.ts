import {
  extractExplicitUserCandidate,
  projectAssistantParts,
  redactText,
  type MemoryCandidateV1,
} from "@vaur94/agz-memory/core";

export function safeUserCandidate(text: string, denylist: readonly string[] = []) {
  const projection = projectAssistantParts([{ type: "text", text }], 4_800);
  const redaction = redactText(projection.text, {
    maxCharacters: 4_800,
    denylist,
    sourceTruncated: projection.truncated,
  });
  return { projection, redaction, candidate: extractExplicitUserCandidate(redaction.text) };
}

export function safeAssistantCandidate(parts: readonly unknown[], denylist: readonly string[] = []) {
  const projection = projectAssistantParts(parts, 4_800);
  const redaction = redactText(projection.text, {
    maxCharacters: 4_800,
    denylist,
    sourceTruncated: projection.truncated,
  });
  if (!redaction.text.trim()) return { projection, redaction };
  const summary = redaction.text.trim();
  const candidate: MemoryCandidateV1 = {
    kind: "fact",
    title: (summary.split(/[\n.!?]/, 1)[0] || "Verified session outcome").slice(0, 240),
    summary: summary.slice(0, 1_200),
    content: summary.slice(0, 4_800),
    intent: "review",
    confidence: 0.7,
    evidence: "verified-outcome",
  };
  return { projection, redaction, candidate };
}

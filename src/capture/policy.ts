import type { Kind } from "../types";
import type { MemoryCandidateV1 } from "./contract";

export const CAPTURE_POLICY_VERSION = "capture-policy/1";
export const EXTRACTOR_VERSION = "deterministic-extractor/1";

export function extractExplicitUserCandidate(text: string): MemoryCandidateV1 | undefined {
  const normalized = text.trim();
  if (!normalized || /\[memory:off\]/i.test(normalized) || /\?\s*$/.test(normalized)) return undefined;
  if (/\b(?:brainstorm|maybe|perhaps|guess|tahmin|beyin fırtınası|olabilir)\b/i.test(normalized)) {
    return undefined;
  }
  const preference = /\b(?:i prefer|my preference|tercihim|tercih ederim|bundan sonra)\b/i.test(normalized);
  const decision = /\b(?:i decided|we decided|decision:|kararım|karar verdim|kural:|constraint:|kısıt:)\b/i.test(normalized);
  const correction = /\b(?:correction:|instead of|düzeltme:|bunun yerine)\b/i.test(normalized);
  if (!preference && !decision && !correction) return undefined;
  const kind: Kind = preference ? "preference" : "decision";
  const title = takeHead(normalized.split(/[\n.!?]/, 1)[0]!.trim(), 240) || `${kind} memory`;
  const subjectKey = normalizeSubjectKey(title);
  return {
    kind,
    title,
    summary: takeHead(normalized, 1_200),
    content: takeHead(normalized, 4_800),
    subjectKey,
    intent: correction ? "supersede" : "create",
    confidence: correction ? 0.98 : 0.97,
    evidence: "explicit-user",
  };
}

export function canAutoWrite(
  candidate: MemoryCandidateV1,
  redaction: { truncated: boolean; quarantined: boolean },
  allowedKinds: readonly string[] = ["preference", "decision"],
  minConfidence = 0.95,
): boolean {
  return (
    candidate.evidence === "explicit-user" &&
    candidate.confidence >= minConfidence &&
    allowedKinds.includes(candidate.kind) &&
    !redaction.truncated &&
    !redaction.quarantined &&
    (candidate.intent === "create" || candidate.intent === "supersede")
  );
}

export function normalizeSubjectKey(value: string): string {
  return takeHead(
    value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"),
    240,
  );
}

function takeHead(value: string, maxCharacters: number): string {
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

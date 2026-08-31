import type { RankedHit } from "./contract";

const WEIGHTS = { lexical: 1, semantic: 0.8, graph: 0.35 } as const;

export interface FusedHit {
  noteID: string;
  score: number;
  matchedCandidate: boolean;
  channels: Set<RankedHit["channel"]>;
}

export function weightedReciprocalRankFusion(channels: readonly RankedHit[]): FusedHit[] {
  const fused = new Map<string, FusedHit>();
  for (const hit of channels) {
    if (!Number.isInteger(hit.rank) || hit.rank < 1) continue;
    const current = fused.get(hit.noteID) ?? {
      noteID: hit.noteID,
      score: 0,
      matchedCandidate: false,
      channels: new Set<RankedHit["channel"]>(),
    };
    if (!current.channels.has(hit.channel)) {
      current.score += WEIGHTS[hit.channel] / (60 + hit.rank);
      current.channels.add(hit.channel);
    }
    if (hit.channel !== "graph") current.matchedCandidate = true;
    fused.set(hit.noteID, current);
  }
  return [...fused.values()];
}

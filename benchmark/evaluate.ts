export interface RetrievalCase {
  goldNoteIDs: readonly string[];
  rankedNoteIDs: readonly string[];
}

export function evaluate(cases: readonly RetrievalCase[], cutoff = 10) {
  if (cases.length === 0) return { recall: 0, mrr: 0, ndcg: 0 };
  const effectiveCutoff = Number.isFinite(cutoff) ? Math.max(0, Math.floor(cutoff)) : 0;
  let recall = 0;
  let mrr = 0;
  let ndcg = 0;
  for (const entry of cases) {
    const gold = new Set(entry.goldNoteIDs);
    const ranked = [...new Set(entry.rankedNoteIDs)].slice(0, effectiveCutoff);
    const hits = ranked.filter((id) => gold.has(id));
    recall += gold.size === 0 ? Number(hits.length === 0) : Math.min(1, hits.length / gold.size);
    const first = ranked.findIndex((id) => gold.has(id));
    if (first >= 0) mrr += 1 / (first + 1);
    const dcg = ranked.reduce((score, id, index) => score + (gold.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
    const ideal = Array.from({ length: Math.min(gold.size, effectiveCutoff) }, (_, index) => 1 / Math.log2(index + 2)).reduce(
      (sum, value) => sum + value,
      0,
    );
    ndcg += ideal === 0 ? 1 : Math.min(1, dcg / ideal);
  }
  return {
    recall: clampMetric(recall / cases.length),
    mrr: clampMetric(mrr / cases.length),
    ndcg: clampMetric(ndcg / cases.length),
  };
}

function clampMetric(value: number): number {
  return Math.min(1, Math.max(0, value));
}

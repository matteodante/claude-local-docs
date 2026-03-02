/**
 * Reciprocal Rank Fusion — merge N ranked lists into a single fused ranking.
 * score = sum( weight_r / (k + rank_r) ) for each ranker r.
 * k=60 is the standard default (Azure, Weaviate, OpenSearch).
 */

export interface RankedDoc {
  id: number;
  text: string;
  [key: string]: any;  // pass-through fields
}

export interface FusedResult extends RankedDoc {
  rrfScore: number;
}

export function reciprocalRankFusion(
  rankedLists: { docs: RankedDoc[]; weight: number }[],
  k: number = 60
): FusedResult[] {
  const scoreMap = new Map<number, FusedResult>();

  for (const { docs, weight } of rankedLists) {
    for (let rank = 0; rank < docs.length; rank++) {
      const doc = docs[rank];
      const score = weight / (k + rank + 1);
      const existing = scoreMap.get(doc.id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        scoreMap.set(doc.id, { ...doc, rrfScore: score });
      }
    }
  }

  const results = Array.from(scoreMap.values());
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  return results;
}

/**
 * Cross-encoder reranker via TEI (Text Embeddings Inference).
 * Takes query + candidate passages, returns relevance scores.
 */

const TEI_RERANK_URL = process.env.TEI_RERANK_URL ?? "http://localhost:39282";

export interface RerankCandidate {
  id: number;
  text: string;
  library: string;
  headingPath: string;
  rrfScore: number;
}

export interface RerankResult extends RerankCandidate {
  rerankerScore: number;
}

/**
 * Rerank candidates using TEI cross-encoder endpoint.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];

  const res = await fetch(`${TEI_RERANK_URL}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, texts: candidates.map((c) => c.text) }),
  });
  if (!res.ok) {
    throw new Error(`TEI rerank error: ${res.status} ${await res.text()}`);
  }

  const results: { index: number; score: number }[] = await res.json();

  return results
    .map((r) => ({ ...candidates[r.index], rerankerScore: r.score }))
    .sort((a, b) => b.rerankerScore - a.rerankerScore);
}

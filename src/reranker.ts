/**
 * Cross-encoder reranker via TEI (Text Embeddings Inference).
 * Takes query + candidate passages, returns relevance scores.
 */

import { rerankClient } from "./tei-client.js";

export interface RerankCandidate {
  id: number;
  text: string;
  rrfScore: number;
  [key: string]: any;  // pass-through fields (library, filePath, etc.)
}

export interface RerankResult extends RerankCandidate {
  rerankerScore: number;
}

/**
 * Rerank candidates using TEI cross-encoder endpoint.
 * Batching is handled by the TeiClient.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];

  const texts = candidates.map((c) => c.text);
  const scored = await rerankClient.rerank(query, texts);

  const results: RerankResult[] = [];
  for (const r of scored) {
    if (r.index >= 0 && r.index < candidates.length) {
      results.push({ ...candidates[r.index], rerankerScore: r.score });
    }
  }

  return results.sort((a, b) => b.rerankerScore - a.rerankerScore);
}

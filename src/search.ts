/**
 * Advanced RAG search pipeline:
 *   1. Vector search (LanceDB) — semantic similarity
 *   2. BM25 search (LanceDB native FTS) — keyword/exact match
 *   3. Reciprocal Rank Fusion — merge both ranked lists
 *   4. Cross-encoder rerank — rescore top candidates
 */

import type { SearchResult, DocRow } from "./types.js";
import type { DocStore } from "./store.js";
import { embedTexts } from "./indexer.js";
import { rerank, type RerankCandidate } from "./reranker.js";

// --- Reciprocal Rank Fusion ---

interface RankedDoc {
  id: number;
  text: string;
  library: string;
  headingPath: string;
}

interface FusedResult extends RankedDoc {
  rrfScore: number;
}

/**
 * RRF: score = sum( weight_r / (k + rank_r) ) for each ranker r.
 * k=60 is the standard default (Azure, Weaviate, OpenSearch).
 */
function reciprocalRankFusion(
  vectorRanked: RankedDoc[],
  bm25Ranked: RankedDoc[],
  options: { k: number; vectorWeight: number; bm25Weight: number }
): FusedResult[] {
  const { k, vectorWeight, bm25Weight } = options;
  const scoreMap = new Map<number, FusedResult>();

  // Score from vector search (rank is 1-based)
  for (let rank = 0; rank < vectorRanked.length; rank++) {
    const doc = vectorRanked[rank];
    const score = vectorWeight / (k + rank + 1);
    const existing = scoreMap.get(doc.id);
    if (existing) {
      existing.rrfScore += score;
    } else {
      scoreMap.set(doc.id, { ...doc, rrfScore: score });
    }
  }

  // Score from BM25 search
  for (let rank = 0; rank < bm25Ranked.length; rank++) {
    const doc = bm25Ranked[rank];
    const score = bm25Weight / (k + rank + 1);
    const existing = scoreMap.get(doc.id);
    if (existing) {
      existing.rrfScore += score;
    } else {
      scoreMap.set(doc.id, { ...doc, rrfScore: score });
    }
  }

  // Sort by fused score
  const results = Array.from(scoreMap.values());
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  return results;
}

// --- Main search pipeline ---

export async function searchDocs(
  query: string,
  store: DocStore,
  options?: { library?: string; topK?: number }
): Promise<SearchResult[]> {
  const topK = options?.topK ?? 10;
  const candidateCount = 50; // retrieve enough for reranking without noise

  // Step 1: Vector search via LanceDB
  const [queryVector] = await embedTexts([query], "search_query");
  const vectorHits = await store.vectorSearch(
    queryVector,
    candidateCount,
    options?.library
  );
  const vectorRanked: RankedDoc[] = vectorHits.map((row) => ({
    id: row.id,
    text: row.text,
    library: row.library,
    headingPath: row.headingPath,
  }));

  // Step 2: BM25 search via LanceDB native FTS
  const ftsHits = await store.ftsSearch(query, candidateCount, options?.library);
  const bm25Ranked: RankedDoc[] = ftsHits.map((row: DocRow) => ({
    id: row.id,
    text: row.text,
    library: row.library,
    headingPath: row.headingPath,
  }));

  // Step 3: RRF fusion (k=60, BM25 weighted higher — trust exact keyword matches for
  // framework-specific queries like "Next.js middleware" vs "NestJS middleware")
  const fused = reciprocalRankFusion(vectorRanked, bm25Ranked, {
    k: 60,
    vectorWeight: 0.7,
    bm25Weight: 1.0,
  });

  // Step 4: Cross-encoder rerank top 50 candidates
  const rerankCandidates: RerankCandidate[] = fused
    .slice(0, 50)
    .map((f) => ({
      id: f.id,
      text: f.text,
      library: f.library,
      headingPath: f.headingPath,
      rrfScore: f.rrfScore,
    }));

  const reranked = await rerank(query, rerankCandidates);

  // Step 5: Format and return top-K
  return reranked.slice(0, topK).map((r) => ({
    score: Math.round(r.rerankerScore * 1000) / 1000,
    library: r.library,
    headingPath: JSON.parse(r.headingPath) as string[],
    content: r.text,
    chunkId: r.id,
  }));
}

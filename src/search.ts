/**
 * Advanced RAG search pipeline:
 *   1. Vector search (LanceDB) — semantic similarity
 *   2. BM25 search (LanceDB native FTS) — keyword/exact match
 *   3. Reciprocal Rank Fusion — merge both ranked lists
 *   4. Cross-encoder rerank — rescore top candidates
 *
 * TEI containers must be running — no fallback mode.
 */

import type { SearchResult, DocRow } from "./types.js";
import type { DocStore } from "./store.js";
import { embedTexts } from "./indexer.js";
import { rerank, type RerankCandidate } from "./reranker.js";
import { reciprocalRankFusion, type RankedDoc } from "./rrf.js";

// --- Main search pipeline ---

export async function searchDocs(
  query: string,
  store: DocStore,
  options?: { library?: string; topK?: number }
): Promise<SearchResult[]> {
  const topK = options?.topK ?? 10;
  const candidateCount = Math.max(50, topK * 3); // scale with topK

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
  const rrfInputs: { docs: RankedDoc[]; weight: number }[] = [];
  if (vectorRanked.length > 0) {
    rrfInputs.push({ docs: vectorRanked, weight: 0.7 });
  }
  if (bm25Ranked.length > 0) {
    rrfInputs.push({ docs: bm25Ranked, weight: 1.0 });
  }
  if (rrfInputs.length === 0) return [];

  const fused = reciprocalRankFusion(rrfInputs);

  // Step 4: Cross-encoder rerank top 50 candidates
  const rerankCandidates: RerankCandidate[] = fused
    .slice(0, 50)
    .map((f) => ({ ...f }));

  const reranked = await rerank(query, rerankCandidates);
  const finalResults = reranked.slice(0, topK).map((r) => ({
    id: r.id,
    score: Math.round(r.rerankerScore * 1000) / 1000,
    library: r.library,
    headingPath: r.headingPath,
    text: r.text,
  }));

  // Step 5: Format and return top-K
  return finalResults.map((r) => ({
    score: r.score,
    library: r.library,
    headingPath: (() => { try { return JSON.parse(r.headingPath) as string[]; } catch { return []; } })(),
    content: r.text,
    chunkId: r.id,
  }));
}

/**
 * Code search pipeline — mirrors the doc search pipeline architecture.
 * Vector search + BM25 → RRF fusion → cross-encoder rerank.
 *
 * TEI containers must be running — no fallback mode.
 */

import { sqlEscapeString } from "./types.js";
import type { CodeSearchResult, CodeEntityType, CodeRow } from "./types.js";
import type { CodeStore } from "./code-store.js";
import { embedCodeTexts } from "./code-indexer.js";
import { rerank, type RerankCandidate } from "./reranker.js";
import { reciprocalRankFusion, type RankedDoc } from "./rrf.js";

function buildFilter(options?: {
  filePath?: string;
  language?: string;
  entityType?: CodeEntityType;
}): string | undefined {
  if (!options) return undefined;
  const clauses: string[] = [];
  if (options.filePath) {
    clauses.push(`"filePath" = '${sqlEscapeString(options.filePath)}'`);
  }
  if (options.language) {
    clauses.push(`language = '${sqlEscapeString(options.language)}'`);
  }
  if (options.entityType) {
    clauses.push(`"entityType" = '${sqlEscapeString(options.entityType)}'`);
  }
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

/** Extract file-name-like tokens from a query for file-path boosting. */
function extractFilePathTokens(query: string): string[] {
  const matches = query.match(/[\w.-]+\.(ts|tsx|js|jsx|vue|svelte|astro)/gi);
  return matches ?? [];
}

function toRankedDoc(row: CodeRow): RankedDoc {
  return {
    id: row.id,
    text: row.text,
    filePath: row.filePath,
    language: row.language,
    entityType: row.entityType,
    entityName: row.entityName,
    signature: row.signature,
    scopeChain: row.scopeChain,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
  };
}

export async function searchCode(
  query: string,
  store: CodeStore,
  options?: {
    filePath?: string;
    language?: string;
    entityType?: CodeEntityType;
    topK?: number;
  }
): Promise<CodeSearchResult[]> {
  const topK = options?.topK ?? 10;
  const candidateCount = Math.max(50, topK * 3);
  const filter = buildFilter(options);

  // Step 1: Vector search via Qodo-Embed
  const [queryVector] = await embedCodeTexts([query], "query");
  const vectorHits = await store.vectorSearch(queryVector, candidateCount, filter);
  const vectorRanked: RankedDoc[] = vectorHits.map(toRankedDoc);

  // Step 2: BM25 search via LanceDB native FTS
  const ftsHits = await store.ftsSearch(query, candidateCount, filter);
  const bm25Ranked: RankedDoc[] = ftsHits.map(toRankedDoc);

  // Step 3: RRF fusion with optional file-path boost as third signal
  const rrfInputs: { docs: RankedDoc[]; weight: number }[] = [];
  if (vectorRanked.length > 0) {
    rrfInputs.push({ docs: vectorRanked, weight: 0.7 });
  }
  if (bm25Ranked.length > 0) {
    rrfInputs.push({ docs: bm25Ranked, weight: 1.0 });
  }

  // File-path boost: if query contains file references, rank matching results
  const fileTokens = extractFilePathTokens(query);
  if (fileTokens.length > 0) {
    // Collect all unique candidates from vector + BM25
    const allCandidates = new Map<number, RankedDoc>();
    for (const doc of [...vectorRanked, ...bm25Ranked]) {
      if (!allCandidates.has(doc.id)) allCandidates.set(doc.id, doc);
    }
    const filePathRanked: RankedDoc[] = [];
    for (const doc of allCandidates.values()) {
      const fp = (doc.filePath as string) ?? "";
      if (fileTokens.some(token => fp.endsWith(token) || fp.includes(token))) {
        filePathRanked.push(doc);
      }
    }
    if (filePathRanked.length > 0) {
      rrfInputs.push({ docs: filePathRanked, weight: 0.5 });
    }
  }

  if (rrfInputs.length === 0) return [];

  const fused = reciprocalRankFusion(rrfInputs);

  // Step 4: Cross-encoder rerank top 50 candidates
  const rerankCandidates: RerankCandidate[] = fused
    .slice(0, 50)
    .map((f) => ({ ...f }));

  const rerankResults = await rerank(query, rerankCandidates);
  const reranked = rerankResults.slice(0, topK);

  // Step 5: Map back to CodeSearchResult
  // Build lookup from fused results for extra fields
  const fusedMap = new Map(fused.map(f => [f.id, f]));

  const results = reranked.map((r) => {
    const orig = fusedMap.get(r.id);
    return {
      score: Math.round(r.rerankerScore * 1000) / 1000,
      filePath: (orig?.filePath ?? "") as string,
      language: (orig?.language ?? "unknown") as string,
      entityType: (orig?.entityType ?? "other") as CodeEntityType,
      entityName: (orig?.entityName ?? "") as string,
      signature: (orig?.signature ?? "") as string,
      scopeChain: (() => {
        try { return JSON.parse((orig?.scopeChain ?? "[]") as string) as string[]; }
        catch { return []; }
      })(),
      lineStart: (orig?.lineStart ?? 0) as number,
      lineEnd: (orig?.lineEnd ?? 0) as number,
      content: orig?.text ?? "",
      chunkId: r.id,
    };
  });

  // Step 5: Neighbor expansion — merge adjacent chunks from same file
  return expandCodeWithNeighbors(results, store);
}

/**
 * Expand code search results with adjacent chunks (id-1 and id+1) from the same file.
 * Recovers context split across chunk boundaries (similar to doc search neighbor expansion).
 */
async function expandCodeWithNeighbors(
  results: CodeSearchResult[],
  store: CodeStore
): Promise<CodeSearchResult[]> {
  const resultIds = new Set(results.map(r => r.chunkId));
  const expanded: CodeSearchResult[] = [];

  for (const result of results) {
    const parts: string[] = [];

    // Try previous chunk
    const prevId = result.chunkId - 1;
    if (!resultIds.has(prevId)) {
      const prev = await store.getChunkById(prevId);
      if (prev && prev.filePath === result.filePath) {
        parts.push(prev.text);
      }
    }

    parts.push(result.content);

    // Try next chunk
    const nextId = result.chunkId + 1;
    if (!resultIds.has(nextId)) {
      const next = await store.getChunkById(nextId);
      if (next && next.filePath === result.filePath) {
        parts.push(next.text);
      }
    }

    expanded.push({
      ...result,
      content: parts.length > 1 ? parts.join("\n\n") : result.content,
    });
  }

  return expanded;
}

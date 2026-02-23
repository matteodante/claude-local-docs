# CLAUDE.md — claude-local-docs

## What this project is

A local-first alternative to Context7 for Claude Code. Provides offline-capable documentation search for JS/TS projects. It reads `package.json` to detect dependencies, fetches their docs (preferring `llms.txt`), and indexes them locally with an advanced RAG search pipeline. All models run on your machine via ONNX — no cloud APIs at query time.

## Architecture

The plugin has two parts:

1. **MCP server** (`src/index.ts`) — Exposes 6 tools via stdio transport using `server.registerTool()`. Handles storage, indexing, search, and raw doc fetching.
2. **`/fetch-docs` command** (`commands/fetch-docs.md`) — Instructs Claude to act as a research agent: search the web for docs, fetch them, and call the MCP tools to store them.

### Search pipeline (4 stages)

The `search_docs` tool in `src/search.ts` runs:
1. **Vector search** — LanceDB with `nomic-ai/nomic-embed-text-v1.5` embeddings (384-dim Matryoshka)
2. **BM25 search** — LanceDB native full-text search index (stemming, lowercase, stop word removal)
3. **RRF fusion** — Reciprocal Rank Fusion (k=60) merges both ranked lists
4. **Cross-encoder rerank** — `Xenova/ms-marco-MiniLM-L-6-v2` rescores top 30 candidates

### Key files

- `src/index.ts` — MCP server entry. All 6 tool definitions with `server.registerTool()` and Zod schemas.
- `src/indexer.ts` — Markdown chunking (heading-based + overlap, 1500 char chunks) and embedding generation via Transformers.js.
- `src/search.ts` — Full search pipeline. LanceDB native FTS for BM25. RRF fusion and orchestration.
- `src/reranker.ts` — Cross-encoder model loading and batched scoring.
- `src/store.ts` — LanceDB connection management, FTS index creation, metadata persistence, raw doc storage.
- `src/fetcher.ts` — Raw HTTP fetch for documentation URLs. No AI processing, no truncation. Used by `fetch_and_store_doc`.
- `src/workspace.ts` — Monorepo detection (pnpm/npm/yarn workspaces), pnpm catalog resolution, cross-workspace dependency collection.
- `src/types.ts` — Shared interfaces: `DocRow`, `SearchResult`, `DocMetadata`, `Dependency`, `AnalyzeResult`, etc.

### Models (all ONNX, all lazy-loaded)

- **Embeddings**: `nomic-ai/nomic-embed-text-v1.5` — Requires `search_document:` / `search_query:` prefixes. Uses layer norm + Matryoshka truncation to 384 dims.
- **Reranker**: `Xenova/ms-marco-MiniLM-L-6-v2` — Cross-encoder, takes (query, passage) pairs, returns relevance logits.

## Build and run

```bash
npm install
npm run build      # tsc → dist/
node dist/index.js # Starts MCP server on stdio
```

## Storage location

Per-project at `{project}/.claude/docs/`:
- `lancedb/` — Vector database files (includes FTS index)
- `.metadata.json` — Library fetch timestamps and source URLs
- `raw/` — Original fetched markdown files

## Conventions

- All models are lazy-loaded on first use to keep startup fast.
- FTS index is rebuilt via `createFtsIndex()` after each `addLibrary()` call (uses `replace: true`).
- LanceDB table is called `"docs"` — created on first `store_and_index_doc` call.
- Library names in LanceDB use the exact npm package name (e.g. `@tanstack/query`).
- `headingPath` is stored as a JSON-stringified `string[]` in LanceDB rows.
- Chunk IDs are auto-incrementing integers, unique across all libraries.
- Tools are registered via `server.registerTool()` (not the deprecated `server.tool()`).
- Dependencies are tagged as `runtime` or `dev`. The `/fetch-docs` command skips dev deps by default.

## Monorepo support

- `analyze_dependencies` auto-detects monorepos via `pnpm-workspace.yaml` or `package.json` workspaces.
- pnpm `catalog:` versions are resolved from `pnpm-workspace.yaml`.
- `workspace:*` internal deps are skipped automatically.
- All workspace package.json files are scanned and deps deduplicated (runtime wins over dev).

## RRF parameters

- `k = 60` (standard default used by Azure, Weaviate, OpenSearch)
- BM25 weight = `1.0`, vector weight = `0.7` (trust exact keyword matches slightly more)
- Top 50 candidates retrieved from each search method
- Top 30 sent to cross-encoder reranker
- Final top-K returned to caller (default 10)

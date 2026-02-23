# CLAUDE.md — claude-local-docs

## What this project is

A local-first alternative to Context7 for Claude Code. Provides offline-capable documentation search for JS/TS projects. It reads `package.json` to detect dependencies, fetches their docs (preferring `llms.txt`), and indexes them locally with an advanced RAG search pipeline. All models run on your machine via ONNX — no cloud APIs at query time.

## Architecture

The plugin has two parts:

1. **MCP server** (`src/index.ts`) — Exposes 5 tools via stdio transport. Handles storage, indexing, and search.
2. **`/fetch-docs` command** (`commands/fetch-docs.md`) — Instructs Claude to act as a research agent: search the web for docs, fetch them, and call the MCP tools to store them.

### Search pipeline (4 stages)

The `search_docs` tool in `src/search.ts` runs:
1. **Vector search** — LanceDB with `nomic-ai/nomic-embed-text-v1.5` embeddings (384-dim Matryoshka)
2. **BM25 search** — MiniSearch with BM25+ algorithm, fuzzy matching, prefix search
3. **RRF fusion** — Reciprocal Rank Fusion (k=60) merges both ranked lists
4. **Cross-encoder rerank** — `Xenova/ms-marco-MiniLM-L-6-v2` rescores top 30 candidates

### Key files

- `src/index.ts` — MCP server entry. All 5 tool definitions with Zod schemas.
- `src/indexer.ts` — Markdown chunking (heading-based + overlap) and embedding generation via Transformers.js.
- `src/search.ts` — Full search pipeline. BM25 index is lazy-built and cached. RRF fusion and orchestration.
- `src/reranker.ts` — Cross-encoder model loading and batched scoring.
- `src/store.ts` — LanceDB connection management, metadata persistence, raw doc storage.
- `src/types.ts` — Shared interfaces: `DocRow`, `SearchResult`, `DocMetadata`, etc.

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
- `lancedb/` — Vector database files
- `.metadata.json` — Library fetch timestamps and source URLs
- `raw/` — Original fetched markdown files

## Conventions

- All models are lazy-loaded on first use to keep startup fast.
- BM25 index is rebuilt when chunk count changes (new docs added).
- LanceDB table is called `"docs"` — created on first `store_and_index_doc` call.
- Library names in LanceDB use the exact npm package name (e.g. `@tanstack/query`).
- `headingPath` is stored as a JSON-stringified `string[]` in LanceDB rows.
- Chunk IDs are auto-incrementing integers, unique across all libraries.

## RRF parameters

- `k = 60` (standard default used by Azure, Weaviate, OpenSearch)
- BM25 weight = `1.0`, vector weight = `0.7` (trust exact keyword matches slightly more)
- Top 50 candidates retrieved from each search method
- Top 30 sent to cross-encoder reranker
- Final top-K returned to caller (default 10)

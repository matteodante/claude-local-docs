# CLAUDE.md — claude-local-docs

## What this project is

A local-first alternative to Context7 for Claude Code. Provides offline-capable documentation search for JS/TS projects. It reads `package.json` to detect dependencies, fetches their docs (preferring `llms.txt`), and indexes them locally with an advanced RAG search pipeline. Embeddings and reranking run via TEI (HuggingFace Text Embeddings Inference) Docker containers — no cloud APIs at query time.

## Architecture

The plugin has two parts:

1. **MCP server** (`src/index.ts`) — Exposes 6 tools via stdio transport using `server.registerTool()`. Handles storage, indexing, search, and raw doc fetching.
2. **`/fetch-docs` command** (`commands/fetch-docs.md`) — Instructs Claude to act as a research agent: search the web for docs, fetch them, and call the MCP tools to store them.

### TEI backend

ML inference is handled by two TEI instances (embed on `:39281`, rerank on `:39282`):
- **Embeddings** — `nomic-ai/nomic-embed-text-v1.5`
- **Reranker** — `cross-encoder/ms-marco-MiniLM-L-6-v2`

The Node.js MCP server calls these via HTTP (`POST /embed`, `POST /rerank`). URLs are configurable via `TEI_EMBED_URL` and `TEI_RERANK_URL` env vars (default `http://localhost:39281` and `http://localhost:39282`).

**`./start-tei.sh`** auto-detects the platform and picks the best backend:
- **NVIDIA GPU** → Docker with architecture-optimized image (Blackwell `120`, Ada `89`, Ampere `86`, etc.)
- **Apple Silicon** → native Metal build via `cargo install` (no Docker, GPU-accelerated)
- **No GPU** → Docker with CPU image

Flags: `--metal` (force native Metal), `--cpu` (force CPU Docker), `--tag <tag>` (specific Docker image), `--stop` (stop all TEI).

Native Metal requires Rust (`rustup.rs`). First run clones TEI and builds with `--features metal`; subsequent runs reuse the installed binary. PIDs are tracked in `.tei-pids` for clean shutdown.

### Search pipeline (4 stages)

The `search_docs` tool in `src/search.ts` runs:
1. **Vector search** — LanceDB with `nomic-ai/nomic-embed-text-v1.5` embeddings (384-dim Matryoshka)
2. **BM25 search** — LanceDB native full-text search index (stemming, lowercase, stop word removal)
3. **RRF fusion** — Reciprocal Rank Fusion (k=60) merges both ranked lists
4. **Cross-encoder rerank** — `cross-encoder/ms-marco-MiniLM-L-6-v2` via TEI rescores top 30 candidates

### Key files

- `src/index.ts` — MCP server entry. All 6 tool definitions with `server.registerTool()` and Zod schemas.
- `src/indexer.ts` — Markdown chunking (heading-based + overlap, 1500 char chunks) and embedding generation via TEI HTTP.
- `src/search.ts` — Full search pipeline. LanceDB native FTS for BM25. RRF fusion and orchestration.
- `src/reranker.ts` — Cross-encoder reranking via TEI HTTP.
- `src/store.ts` — LanceDB connection management, FTS index creation, metadata persistence, raw doc storage.
- `src/fetcher.ts` — Raw HTTP fetch for documentation URLs. No AI processing, no truncation. Used by `fetch_and_store_doc`.
- `src/workspace.ts` — Monorepo detection (pnpm/npm/yarn workspaces), pnpm catalog resolution, cross-workspace dependency collection.
- `src/types.ts` — Shared interfaces: `DocRow`, `SearchResult`, `DocMetadata`, `Dependency`, `AnalyzeResult`, etc.
- `docker-compose.yml` — TEI containers (uses `${TEI_TAG:-cpu-1.9}`). `docker-compose.nvidia.yml` — NVIDIA GPU device passthrough.
- `start-tei.sh` — Auto-detects GPU, selects optimal TEI image tag, starts containers, waits for health.

### Models (via TEI Docker)

- **Embeddings**: `nomic-ai/nomic-embed-text-v1.5` — Requires `search_document:` / `search_query:` prefixes. Matryoshka truncation to 384 dims + L2 normalize done client-side.
- **Reranker**: `cross-encoder/ms-marco-MiniLM-L-6-v2` — Cross-encoder, takes (query, texts) via `/rerank` endpoint.

## Build and run

```bash
./start-tei.sh         # Auto-detect GPU, start TEI containers (first run downloads models)
npm install
npm run build          # tsc → dist/
node dist/index.js     # Starts MCP server on stdio
```

## Storage location

Per-project at `{project}/.claude/docs/`:
- `lancedb/` — Vector database files (includes FTS index)
- `.metadata.json` — Library fetch timestamps and source URLs
- `raw/` — Original fetched markdown files

## Conventions

- TEI containers must be running before indexing or searching.
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

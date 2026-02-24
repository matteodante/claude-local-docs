# CLAUDE.md — claude-local-docs

## What this project is

A local-first alternative to Context7 for Claude Code. Provides offline-capable documentation search for JS/TS projects. It reads `package.json` to detect dependencies, fetches their docs (preferring `llms.txt`), and indexes them locally with an advanced RAG search pipeline. Embeddings and reranking run via TEI (HuggingFace Text Embeddings Inference) Docker containers — no cloud APIs at query time.

## Architecture

The plugin has two parts:

1. **MCP server** (`src/index.ts`) — Exposes 7 tools via stdio transport using `server.registerTool()`. Handles storage, indexing, search, doc discovery, and raw doc fetching.
2. **`/fetch-docs` command** (`commands/fetch-docs.md`) — Instructs Claude to fetch docs for each runtime dependency. Uses a multi-step strategy: (1) known URL reference table, (2) WebSearch to find actual `llms.txt`/`llms-full.txt` URLs, (3) `discover_and_fetch_docs` for automatic probing (npm fields + URL patterns), (4) training data fallback. Includes a curated table of verified URLs for 40+ popular libraries.

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

### Search pipeline (4 stages + neighbor expansion)

The `search_docs` tool in `src/search.ts` runs:
1. **Vector search** — LanceDB with `nomic-ai/nomic-embed-text-v1.5` embeddings (384-dim Matryoshka)
2. **BM25 search** — LanceDB native full-text search index (stemming, lowercase, stop word removal). Heading path is prepended to chunk text so BM25 matches section structure (e.g., "Connect > Onboarding").
3. **RRF fusion** — Reciprocal Rank Fusion (k=60) merges both ranked lists. BM25 weighted 1.0, vector weighted 0.7 — trusts exact keyword matches more for framework-specific queries.
4. **Cross-encoder rerank** — `cross-encoder/ms-marco-MiniLM-L-6-v2` via TEI rescores top 50 candidates
5. **Neighbor expansion** — For each result, adjacent chunks (id-1, id+1) from the same library/section are merged to recover context split across chunk boundaries (code examples, etc.)

### Doc discovery pipeline

The `discover_and_fetch_docs` tool (Tool 7) in `src/discovery.ts` provides automatic doc discovery:

1. **npm registry lookup** — `registry.npmjs.org/{lib}/latest` → homepage, repository URL, version, and `llms`/`llmsFull` package.json fields
2. **package.json `llms`/`llmsFull` fields** — If the package includes these fields (Colin Hacks convention), their URLs are tried first as the most reliable source
3. **Candidate URL generation** — ordered probe list:
   - `{homepage}/llms-full.txt`, `{homepage}/llms.txt`
   - `docs.{domain}/llms-full.txt`, `docs.{domain}/llms.txt` (Mintlify/GitBook pattern)
   - `{origin}/docs/llms-full.txt`, `{origin}/docs/llms.txt`
   - `llms.{domain}/llms-full.txt`, `llms.{domain}/llms.txt` (Motion-style pattern)
   - GitHub raw (main + master branches)
   - README.md fallback, homepage HTML fallback
4. **Sequential probing** — fetches each candidate with 15s timeout, stops on first success
5. **Index detection** — if the content is a link-heavy file (>50% link lines, 5+ links), it's treated as an index
6. **Index expansion** — fetches each linked page (concurrency 5, 200ms inter-request delay, max 100 links), converts HTML → markdown via turndown, prepends heading context
7. **HTML → markdown** — turndown with GFM plugin; extracts `<main>`/`<article>` content, strips nav/footer/header/script/style/aside

Dependencies: `turndown` and `turndown-plugin-gfm` for HTML conversion.

### llms.txt ecosystem patterns

The `/fetch-docs` command leverages these discovery patterns, prioritized by reliability:

1. **Known URL reference table** — curated list of verified URLs for 40+ popular libraries (in command file)
2. **WebSearch** — finds llms.txt URLs that aren't at predictable locations
3. **package.json `llms`/`llmsFull` fields** — machine-readable convention proposed by Zod author (Colin Hacks). Libraries include doc URLs directly in npm metadata. `discover_and_fetch_docs` checks this automatically.
4. **Documentation platform auto-generation**:
   - **Mintlify** — auto-generates `/llms.txt` and `/llms-full.txt` for ALL hosted docs (Anthropic, Cursor, Stripe, CrewAI, Pinecone, etc.)
   - **GitBook** — auto-generates `/llms.txt` since Jan 2025
   - **Docusaurus** — via community plugin `docusaurus-plugin-llms-txt`
   - **Fern** — native support
5. **Special URL patterns**:
   - Stripe-style `.md` suffix: `docs.stripe.com/{page}.md` gives raw markdown
   - Motion-style subdomain: `llms.motion.dev/docs/{page}.md`
   - Nuxt Content: separate `content.nuxt.com/llms-full.txt`

### Key files

- `src/index.ts` — MCP server entry. All 7 tool definitions with `server.registerTool()` and Zod schemas.
- `src/discovery.ts` — Doc discovery: npm registry (including `llms`/`llmsFull` fields), URL probing, index detection/expansion, HTML→markdown conversion.
- `src/indexer.ts` — Code-aware markdown chunking (heading-based + overlap, 4000 char chunks, code fences never split) and embedding generation via TEI HTTP.
- `src/search.ts` — Full search pipeline. LanceDB native FTS for BM25. RRF fusion and orchestration.
- `src/reranker.ts` — Cross-encoder reranking via TEI HTTP.
- `src/store.ts` — LanceDB connection management, FTS index creation, metadata persistence, raw doc storage.
- `src/fetcher.ts` — Raw HTTP fetch for documentation URLs. Sends `Accept-Language: en` to prevent geo-localized content. Supports configurable timeout (`timeoutMs` option) and returns `finalUrl` after redirects.
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
- `discover_and_fetch_docs` checks npm package.json `llms`/`llmsFull` fields first, then probes standard URL patterns. The `/fetch-docs` command adds WebSearch and a known URL table on top of this.

## Monorepo support

- `analyze_dependencies` auto-detects monorepos via `pnpm-workspace.yaml` or `package.json` workspaces.
- pnpm `catalog:` versions are resolved from `pnpm-workspace.yaml`.
- `workspace:*` internal deps are skipped automatically.
- All workspace package.json files are scanned and deps deduplicated (runtime wins over dev).

## Search parameters

- Chunk size: 4000 chars (code-aware, never splits inside fenced code blocks)
- Chunk overlap: 400 chars at paragraph boundaries
- Heading path prepended to each chunk for BM25 discoverability
- RRF k = 60 (standard default used by Azure, Weaviate, OpenSearch)
- BM25 weight = `1.0`, vector weight = `0.7` (trust exact keyword matches slightly more)
- Top 50 candidates retrieved from each search method
- Top 50 sent to cross-encoder reranker
- Neighbor expansion: adjacent chunks (id-1, id+1) merged if same library + heading section
- Full chunk content returned to Claude (no truncation)
- Final top-K returned to caller (default 10)

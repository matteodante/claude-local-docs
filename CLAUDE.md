# CLAUDE.md — claude-local-docs

## What this project is

A local-first alternative to Context7 for Claude Code. Provides offline-capable documentation search for JS/TS projects. It reads `package.json` to detect dependencies, fetches their docs (preferring `llms.txt`), and indexes them locally with an advanced RAG search pipeline. Embeddings and reranking run via TEI (HuggingFace Text Embeddings Inference) Docker containers — no cloud APIs at query time.

## Architecture

The plugin has three parts:

1. **MCP server** (`src/index.ts`) — Exposes 10 tools via stdio transport using `server.registerTool()`. Handles storage, indexing, search, doc discovery, raw doc fetching, and codebase indexing/search.
2. **`/fetch-docs` command** (`commands/fetch-docs.md`) — Instructs Claude to fetch docs for each runtime dependency. Uses a multi-step strategy: (1) known URL reference table, (2) WebSearch to find actual `llms.txt`/`llms-full.txt` URLs, (3) `discover_and_fetch_docs` for automatic probing (npm fields + URL patterns), (4) training data fallback. Includes a curated table of verified URLs for 40+ popular libraries.
3. **`/index-codebase` command** (`commands/index-codebase.md`) — Instructs Claude to index the project's own source code for semantic search via `search_code`.

### TEI backend

ML inference is handled by three TEI instances:
- **Doc Embeddings** (`:39281`) — `nomic-ai/nomic-embed-text-v1.5` for library documentation
- **Reranker** (`:39282`) — `cross-encoder/ms-marco-MiniLM-L-6-v2` for both doc and code search
- **Code Embeddings** (`:39283`) — `Qodo/Qodo-Embed-1-1.5B` for source code (68.5 CoIR, 32K context, 1536-dim)

The Node.js MCP server calls these via a shared `TeiClient` (`src/tei-client.ts`) with built-in retry, timeout, and batching. URLs are configurable via `TEI_EMBED_URL`, `TEI_RERANK_URL`, and `TEI_CODE_EMBED_URL` env vars (default `http://localhost:39281`, `http://localhost:39282`, `http://localhost:39283`).

**`./start-tei.sh`** auto-detects the platform and picks the best backend:
- **NVIDIA GPU** → Docker with architecture-optimized image (Blackwell `120`, Ada `89`, Ampere `86`, etc.)
- **Apple Silicon** → native Metal build via `cargo install` (no Docker, GPU-accelerated)
- **No GPU** → Docker with CPU image

Flags: `--metal` (force native Metal), `--cpu` (force CPU Docker), `--tag <tag>` (specific Docker image), `--stop` (stop all TEI).

Native Metal requires Rust (`rustup.rs`). First run clones TEI and builds with `--features metal`; subsequent runs reuse the installed binary. PIDs are tracked in `.tei-pids` for clean shutdown.

### TEI Client (`src/tei-client.ts`)

Shared HTTP client for all TEI communication:
- **Retry**: 2 attempts with exponential backoff (500ms, 1s). Only retries 502/503/504/ECONNREFUSED.
- **Timeout**: `AbortSignal.timeout(30s)` on every request.
- **Batching**: Configurable `maxBatchSize` per endpoint (32 for embed/rerank, 8 for code-embed to match TEI server limit).
- **Health check**: `checkHealth()` on each client, `checkAllTeiHealth()` for all 3 endpoints.
- **Pre-configured singletons**: `docEmbedClient`, `rerankClient`, `codeEmbedClient`.
- **TEI required**: `search_docs` and `search_code` require all TEI containers to be running. Errors propagate to the caller — no silent fallback.

### Search pipeline (4 stages + neighbor expansion)

The `search_docs` tool in `src/search.ts` runs:
1. **Vector search** — LanceDB with `nomic-ai/nomic-embed-text-v1.5` embeddings (384-dim Matryoshka). Graceful: skipped if embed fails.
2. **BM25 search** — LanceDB native full-text search index (stemming, lowercase, stop word removal). Heading path is prepended to chunk text so BM25 matches section structure (e.g., "Connect > Onboarding").
3. **RRF fusion** — Reciprocal Rank Fusion (k=60) merges both ranked lists. BM25 weighted 1.0, vector weighted 0.7 — trusts exact keyword matches more for framework-specific queries.
4. **Cross-encoder rerank** — `cross-encoder/ms-marco-MiniLM-L-6-v2` via TEI rescores top 50 candidates.
5. **Neighbor expansion** — For each result, adjacent chunks (id-1, id+1) from the same library/section are merged to recover context split across chunk boundaries (code examples, etc.)

### Codebase indexing pipeline

The `index_codebase` tool indexes the project's own source code for semantic search:

1. **TEI health check** — Pre-flight check via `checkAllTeiHealth()`. Returns clear error if code-embed container is down. Aborts after 5 consecutive failures during indexing (TEI down detection).
2. **File walking** (`src/file-walker.ts`) — Discovers JS/TS/Vue/Svelte/Astro files respecting `.gitignore` and hardcoded skip list (`node_modules`, `dist`, etc.). Uses the `ignore` npm package.
3. **SFC extraction** (`src/sfc-extractor.ts`) — For `.vue`/`.svelte`/`.astro` files, extracts `<script>` blocks and frontmatter with line offset tracking, then parses each block with tree-sitter.
4. **AST chunking** (`src/code-indexer.ts`) — Parses each file with web-tree-sitter (WASM), extracts function/class/method/interface/namespace-level entities. Large classes (>1500 non-whitespace chars) are split into individual methods. Small entities (<100 chars) are merged with adjacent same-scope entities.
5. **JSDoc + decorator extraction** — JSDoc comments (`/** ... */`) are extracted and prepended to chunk text for embedding/BM25 visibility. Decorators (`@Controller`, `@Injectable`, etc.) are extracted by name.
6. **Metadata flags** — Each entity is tagged with `isExported`, `isAsync`, `isAbstract` flags, included in context headers.
7. **Contextual headers** — Each chunk is prepended with `// File: path`, `// Scope: Class > Method`, `// Flags: exported, async`, `// Decorators: @UseGuards`, and `// entityType: name (split words)` for BM25 discoverability.
8. **Qodo-Embed embedding** (`src/code-indexer.ts`) — 1536-dim vectors via TEI on `:39283`. No explicit prefix (TEI handles internally). L2 normalized.
9. **Incremental indexing** — Three strategies:
   - **git-diff** (fastest): Uses `git diff --name-status` + `git status` to find only changed files since `lastIndexedCommit`. ~50-100ms for 500-file projects.
   - **hash** (fallback): SHA-256 content hashes tracked in `.code-metadata.json`. Unchanged files are skipped.
   - **full**: When `forceReindex: true`, re-indexes all files.

### Code search pipeline

The `search_code` tool in `src/code-search.ts` runs a 5-stage pipeline:
1. **Vector search** — LanceDB with Qodo-Embed embeddings (1536-dim). Graceful: skipped if embed fails.
2. **BM25 search** — LanceDB native FTS on contextual headers + code text
3. **RRF fusion** — BM25=1.0, vector=0.7 via shared `src/rrf.ts`. Optional **file-path boost** as third signal (weight=0.5): if query mentions file names like "rrf.ts", matching results get boosted.
4. **Cross-encoder rerank** — Same ms-marco-MiniLM reranker as doc search.
5. **Neighbor expansion** — Adjacent chunks (id-1, id+1) from the same file are merged for fuller context.

Supports filtering by `filePath`, `language`, and `entityType`.

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

- `src/index.ts` — MCP server entry. All 10 tool definitions with `server.registerTool()` and Zod schemas.
- `src/tei-client.ts` — Shared TEI HTTP client with retry, timeout, batching, and health checks. Pre-configured singletons for all 3 endpoints.
- `src/discovery.ts` — Doc discovery: npm registry (including `llms`/`llmsFull` fields), URL probing, index detection/expansion, HTML→markdown conversion.
- `src/indexer.ts` — Code-aware markdown chunking (heading-based + overlap, 4000 char chunks, code fences never split) and embedding generation via TEI HTTP.
- `src/search.ts` — Doc search pipeline. LanceDB native FTS for BM25. RRF fusion and orchestration.
- `src/rrf.ts` — Shared Reciprocal Rank Fusion utility. Accepts N weighted ranked lists.
- `src/reranker.ts` — Cross-encoder reranking via TEI HTTP. Used by both doc and code search.
- `src/store.ts` — LanceDB "docs" table management, FTS index creation, metadata persistence, raw doc storage.
- `src/code-indexer.ts` — AST chunking via web-tree-sitter + Qodo-Embed embedding via TEI on `:39283`. Extracts JSDoc, decorators, and metadata flags.
- `src/code-store.ts` — LanceDB "code" table management, per-file code chunk storage, `.code-metadata.json`. Schema versioning with auto-migration.
- `src/code-search.ts` — Code search pipeline. 5-stage architecture with file-path boost and neighbor expansion.
- `src/sfc-extractor.ts` — Vue/Svelte/Astro SFC script block extraction with line offset tracking.
- `src/file-walker.ts` — Project file discovery with `.gitignore` support via `ignore` package. Git-diff change detection for incremental indexing.
- `src/fetcher.ts` — Raw HTTP fetch for documentation URLs. Sends `Accept-Language: en` to prevent geo-localized content. Supports configurable timeout (`timeoutMs` option) and returns `finalUrl` after redirects.
- `src/workspace.ts` — Monorepo detection (pnpm/npm/yarn workspaces), pnpm catalog resolution, cross-workspace dependency collection.
- `src/types.ts` — Shared interfaces: `DocRow`, `CodeRow`, `SearchResult`, `CodeSearchResult`, `DocMetadata`, `CodeMetadata`, `Dependency`, `AnalyzeResult`, etc.
- `docker-compose.yml` — TEI containers (uses `${TEI_TAG:-cpu-1.9}`). `docker-compose.nvidia.yml` — NVIDIA GPU device passthrough.
- `start-tei.sh` — Auto-detects GPU, selects optimal TEI image tag, starts 3 containers, waits for health.

### Models (via TEI Docker)

- **Doc Embeddings**: `nomic-ai/nomic-embed-text-v1.5` — Requires `search_document:` / `search_query:` prefixes. Matryoshka truncation to 384 dims + L2 normalize done client-side.
- **Code Embeddings**: `Qodo/Qodo-Embed-1-1.5B` — 1536-dim, 32K context, 68.5 CoIR. No explicit prefix (TEI handles internally). L2 normalized. ~3 GB VRAM (FP16).
- **Reranker**: `cross-encoder/ms-marco-MiniLM-L-6-v2` — Cross-encoder, takes (query, texts) via `/rerank` endpoint. Shared by doc and code search.

## Build and run

```bash
./start-tei.sh         # Auto-detect GPU, start TEI containers (first run downloads models)
npm install
npm run build          # tsc → dist/
node dist/index.js     # Starts MCP server on stdio
```

## Storage location

Per-project at `{project}/.claude/docs/`:
- `lancedb/` — Vector database files (includes FTS index). Contains both `"docs"` and `"code"` tables.
- `.metadata.json` — Library doc fetch timestamps and source URLs
- `.code-metadata.json` — Indexed file hashes, language, chunk counts, last index time, schema version, last indexed commit SHA
- `raw/` — Original fetched markdown files (doc search only — code uses project source files directly)

## Conventions

- TEI containers (all 3) must be running for both indexing and search. No fallback mode — errors propagate if TEI is down.
- All TEI communication goes through `TeiClient` singletons in `src/tei-client.ts` — never use raw `fetch()` for TEI endpoints.
- FTS index is rebuilt via `createFtsIndex()` after each `addLibrary()` call (uses `replace: true`). Code FTS is rebuilt once at end of `index_codebase`.
- LanceDB has two tables: `"docs"` for library documentation, `"code"` for project source code.
- Library names in LanceDB use the exact npm package name (e.g. `@tanstack/query`).
- `headingPath`, `scopeChain`, and `decorators` are stored as JSON-stringified `string[]` in LanceDB rows.
- Chunk IDs are auto-incrementing integers, unique within each table.
- Tools are registered via `server.registerTool()` (not the deprecated `server.tool()`).
- Dependencies are tagged as `runtime` or `dev`. The `/fetch-docs` command skips dev deps by default.
- `discover_and_fetch_docs` checks npm package.json `llms`/`llmsFull` fields first, then probes standard URL patterns. The `/fetch-docs` command adds WebSearch and a known URL table on top of this.
- Code indexing uses git-diff + content-hash hybrid for incremental updates. Only changed files are re-indexed.
- RRF fusion logic is shared between doc and code search via `src/rrf.ts`.
- CodeRow schema version (in `.code-metadata.json`) triggers automatic table drop + full reindex when incremented.
- `index_codebase` stores HEAD SHA as `lastIndexedCommit` for git-diff optimization on subsequent runs.

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
- File-path boost weight = `0.5` (code search only, activates when query contains file references)
- Top 50 candidates retrieved from each search method
- Top 50 sent to cross-encoder reranker
- Neighbor expansion: adjacent chunks (id-1, id+1) merged if same library/heading section (docs) or same file (code)
- Full chunk content returned to Claude (no truncation)
- Final top-K returned to caller (default 10)

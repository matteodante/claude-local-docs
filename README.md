# claude-local-docs

A local-first alternative to Context7 for Claude Code. Indexes your project's dependency documentation **and source code** locally with production-grade semantic search. Embeddings and reranking run via TEI (HuggingFace Text Embeddings Inference) Docker containers with auto GPU detection. Supports JS/TS, Vue, Svelte, and Astro with AST-aware chunking, JSDoc extraction, and git-diff incremental indexing.

## Why not Context7?

| | **claude-local-docs** | **Context7** |
|---|---|---|
| **Runs where** | Your machine (TEI Docker) | Upstash cloud servers |
| **Privacy** | Docs never leave your machine | Queries sent to cloud API |
| **Rate limits** | None | API-dependent |
| **Offline** | Full search works offline | Requires internet |
| **GPU accelerated** | NVIDIA CUDA / Apple Metal | N/A |
| **Search quality** | 4-stage RAG (vector + BM25 + RRF + cross-encoder reranking) | Single-stage retrieval |
| **Doc sources** | Prefers llms.txt, falls back to official docs | Pre-indexed source repos |
| **Code search** | Semantic AST-level search via Qodo-Embed-1-1.5B | N/A |
| **Framework support** | JS, TS, Vue, Svelte, Astro (SFC script extraction) | N/A |
| **Scope** | Your project's actual dependencies + source code | Any library |
| **Monorepo** | Detects pnpm/npm/yarn workspaces, resolves catalogs | N/A |
| **Resilience** | BM25-only fallback when TEI is down, retry + timeout | N/A |

## Prerequisites

- **Docker** — [Docker Desktop](https://www.docker.com/products/docker-desktop/) for TEI containers
- **Node.js 20+**
- **NVIDIA GPU** (optional) — auto-detected, uses architecture-optimized TEI images
- **Apple Silicon** (optional) — native Metal build via Rust/cargo (no Docker needed)

## Installation

### As a Claude Code plugin (recommended)

```bash
# Add the marketplace
/plugin marketplace add matteodante/claude-local-docs

# Install the plugin
/plugin install claude-local-docs
```

The plugin starts TEI containers automatically on session start via a SessionStart hook.

### Manual / development setup

```bash
git clone https://github.com/matteodante/claude-local-docs.git
cd claude-local-docs
npm install
npm run build

# Start TEI (auto-detects GPU)
./start-tei.sh
```

## How it works

### Documentation search

```
/fetch-docs                        search_docs("how to use useState")
     |                                       |
     v                                       v
 Detect monorepo              +--- Vector search (LanceDB) ---+
 Scan all workspace pkgs      |    nomic-embed-text-v1.5       |
 Resolve catalog: versions    |                                |
     |                        |                                +-> RRF Fusion
     v                        |                                |    (k=60)
 For each runtime dep:        +-- BM25 search (LanceDB FTS) --+
   - Search for llms.txt      |    keyword + stemming            |
   - Raw fetch (no truncation)|                                  v
   - Chunk + embed + store    |                        Cross-encoder rerank
                              |                        ms-marco-MiniLM-L-6-v2
                              |                          (via TEI :39282)
                              +----------------------------------+
                                                  |
                                                  v
                                          Top-K results
```

### Codebase search

```
/index-codebase                    search_code("RRF fusion logic")
     |                                       |
     v                                       v
 Walk project files            +--- Vector search (LanceDB) -------+
 Respect .gitignore            |    Qodo-Embed-1-1.5B (1536-dim)   |
 Git-diff incremental skip     |                                    |
     |                         |                                    +-> RRF Fusion
     v                         |                                    |    (k=60)
 For each JS/TS/Vue/           +-- BM25 search (LanceDB FTS) ------+
 Svelte/Astro file:            |    camelCase split + stemming      |
   - Extract <script> (SFC)    |                                    |
   - Parse AST (tree-sitter)   +-- File-path boost (optional) -----+
   - Extract functions/classes |                                      v
   - Extract JSDoc/decorators  |                            Cross-encoder rerank
   - Contextual headers        |                            ms-marco-MiniLM-L-6-v2
   - Embed with Qodo-Embed     |                              (via TEI :39282)
   - Store in LanceDB          +--------------------------------------+
                                                  |
                                                  v
                                      Function-level results
                                   (file, lines, scope, score)
                                   + neighbor chunk expansion
```

## Usage

### 1. Index your project's docs

```
/fetch-docs
```

Claude analyzes your project (including monorepo workspaces), finds all runtime dependencies, searches the web for the best documentation for each one (preferring `llms-full.txt` > `llms.txt` > official docs), and indexes everything locally.

### 2. Index your source code

```
/index-codebase
```

Parses all JS/TS/Vue/Svelte/Astro files with tree-sitter, extracts JSDoc comments and decorators, generates Qodo-Embed-1-1.5B embeddings for function/class/method-level chunks, and stores them in LanceDB. Incremental via git-diff (falls back to SHA-256 hashing for non-git projects). Only changed files are re-indexed.

### 3. Search

Ask Claude anything. It will automatically use the right search tool:

```
# Library documentation (search_docs)
How do I set up middleware in Express?
What are the options for useQuery in TanStack Query?
Show me the API for zod's .refine()

# Your codebase (search_code)
Where is the authentication middleware?
Find the database connection setup
How does the search pipeline work?
```

### 4. Other tools

- **`list_docs`** — See what's indexed, when it was fetched, chunk counts
- **`get_doc_section`** — Retrieve specific sections by heading or chunk ID
- **`get_codebase_status`** — Check index status, language breakdown, changed files
- **`analyze_dependencies`** — List all deps (monorepo-aware, catalog-resolved, runtime/dev tagged)
- **`fetch_and_store_doc`** — Fetch a URL and index it directly (no AI truncation)
- **`discover_and_fetch_docs`** — Auto-discover and index docs for any npm package

## TEI backend

ML inference runs in TEI (HuggingFace Text Embeddings Inference) containers:

| Container | Port | Model | Purpose |
|---|---|---|---|
| tei-embed | `:39281` | `nomic-ai/nomic-embed-text-v1.5` | Doc embeddings (384-dim Matryoshka) |
| tei-rerank | `:39282` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Cross-encoder reranking (docs + code) |
| tei-code-embed | `:39283` | `Qodo/Qodo-Embed-1-1.5B` | Code embeddings (1536-dim, 68.5 CoIR) |

All TEI communication goes through a shared `TeiClient` class (`src/tei-client.ts`) with automatic retry (2 attempts, exponential backoff), 30s timeout, and batch splitting. If TEI is unavailable, search pipelines gracefully degrade to BM25-only results.

### Starting TEI

```bash
./start-tei.sh           # Auto-detect GPU
./start-tei.sh --metal   # Force Apple Metal (native, no Docker)
./start-tei.sh --cpu     # Force CPU Docker
./start-tei.sh --stop    # Stop all TEI
```

Auto-detection selects the optimal backend:

| Platform | Backend | Image tag |
|---|---|---|
| NVIDIA RTX 50x0 (Blackwell) | Docker CUDA | `120-1.9` |
| NVIDIA RTX 40x0 (Ada) | Docker CUDA | `89-1.9` |
| NVIDIA RTX 30x0 (Ampere) | Docker CUDA | `86-1.9` |
| Apple Silicon | Native Metal | `cargo install --features metal` |
| No GPU | Docker CPU | `cpu-1.9` |

GPU override for NVIDIA:
```bash
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
```

## Search pipeline

Both doc search and code search use the same 4-stage RAG pipeline:

| Stage | Technology | Purpose |
|---|---|---|
| **Vector search** | LanceDB + nomic-embed / Qodo-Embed via TEI | Semantic similarity (understands meaning) |
| **BM25 search** | LanceDB native FTS (BM25, stemming, stop words) | Keyword matching (exact terms like `useEffect`) |
| **RRF fusion** | Reciprocal Rank Fusion (k=60) | Merges both ranked lists, handles different score scales |
| **Cross-encoder rerank** | ms-marco-MiniLM-L-6-v2 via TEI | Rescores top 50 candidates with deep relevance model |

### Code search specifics

- **AST chunking**: tree-sitter parses JS/TS/Vue/Svelte/Astro into function/class/method/interface/namespace entities
- **JSDoc + decorators**: Extracted from AST and prepended to chunk text for richer search context
- **Metadata flags**: `exported`, `async`, `abstract` tracked per entity
- **Qodo-Embed-1-1.5B**: 1.5B parameter model, 68.5 CoIR score, 32K context window, 1536-dim embeddings
- **Contextual headers**: file path + scope chain + flags + decorators + JSDoc prepended for BM25
- **File-path boost**: Queries containing file names (e.g., "rrf.ts") get a third RRF signal boosting matching files
- **Neighbor expansion**: Adjacent chunks from the same file are merged for fuller context
- **Incremental indexing**: Git-diff based (fast, ~50-100ms), falls back to SHA-256 hashing for non-git projects
- **Graceful degradation**: BM25-only results when vector embedding or reranker is unavailable
- **SFC support**: Vue `<script>`/`<script setup>`, Svelte `<script>`/`<script context="module">`, Astro `---` frontmatter + `<script>` tags

## Storage

All data stays in your project directory:

```
your-project/.claude/docs/
├── lancedb/                  # Vector database (docs + code tables)
├── .metadata.json            # Doc fetch timestamps, source URLs per library
├── .code-metadata.json       # File hashes, language, chunk counts, last index
└── raw/
    ├── react.md              # Raw fetched documentation
    ├── next.md
    └── tanstack__query.md
```

## MCP Tools

| Tool | Description |
|---|---|
| `analyze_dependencies` | Detect and list all npm dependencies (monorepo-aware, runtime/dev tagged) |
| `store_and_index_doc` | Index documentation content you already have as a string |
| `fetch_and_store_doc` | Fetch documentation from a URL and index it (raw HTTP, no truncation) |
| `discover_and_fetch_docs` | Auto-discover and index docs for an npm package |
| `search_docs` | Semantic search across indexed library documentation |
| `list_docs` | List indexed libraries with version and fetch date |
| `get_doc_section` | Retrieve specific doc sections by heading or chunk ID |
| `index_codebase` | Index project source code for semantic search (incremental, .gitignore-aware) |
| `search_code` | Semantic search across project source code (function/class-level) |
| `get_codebase_status` | Check codebase index status, language breakdown, changed files |

## Dependencies

| Package | License | Purpose |
|---|---|---|
| `@lancedb/lancedb` | Apache 2.0 | Embedded vector database + native FTS |
| `@modelcontextprotocol/sdk` | MIT | MCP server framework |
| `web-tree-sitter` | MIT | WASM-based AST parsing for code chunking |
| `tree-sitter-wasms` | MIT | Pre-built WASM grammars (JS/TS/Vue/Svelte) |
| `ignore` | MIT | .gitignore pattern matching |
| `zod` | MIT | Schema validation |

TEI containers (Docker):

| Image | Model | Purpose |
|---|---|---|
| `text-embeddings-inference:*` | `nomic-ai/nomic-embed-text-v1.5` | Doc embeddings |
| `text-embeddings-inference:*` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Cross-encoder reranking |
| `text-embeddings-inference:*` | `Qodo/Qodo-Embed-1-1.5B` | Code embeddings (1536-dim) |

## Development

```bash
npm run dev         # Watch mode — rebuilds on file changes
npm run build       # One-time build
npm run test:unit   # Unit tests (no TEI needed)
npm run test:docs   # Doc search integration tests (requires TEI on :39281, :39282)
npm run test:code   # Code search integration tests (requires TEI on :39281, :39282, :39283)
```

## Project structure

```
claude-local-docs/
├── .claude-plugin/
│   ├── plugin.json           # Plugin manifest
│   └── marketplace.json      # Marketplace listing
├── .mcp.json                 # MCP server config (stdio transport)
├── commands/
│   ├── fetch-docs.md         # /fetch-docs — Claude as research agent
│   └── index-codebase.md     # /index-codebase — index source code
├── hooks/
│   └── hooks.json            # SessionStart hook for TEI containers
├── scripts/
│   └── ensure-tei.sh         # Idempotent TEI health check + start
├── docker-compose.yml        # TEI containers (uses ${TEI_TAG})
├── docker-compose.nvidia.yml # NVIDIA GPU device passthrough
├── start-tei.sh              # Auto-detect GPU, start TEI
├── src/
│   ├── index.ts              # MCP server entry, 10 tool definitions
│   ├── tei-client.ts         # Shared TEI HTTP client (retry, timeout, batching)
│   ├── indexer.ts            # Doc chunking + nomic-embed-text embeddings
│   ├── search.ts             # Doc search pipeline (vector + BM25 + RRF + rerank)
│   ├── rrf.ts                # Shared Reciprocal Rank Fusion utility
│   ├── reranker.ts           # TEI cross-encoder reranking
│   ├── store.ts              # LanceDB "docs" table + metadata
│   ├── code-indexer.ts       # AST chunking (tree-sitter) + Qodo-Embed embeddings
│   ├── code-search.ts        # Code search pipeline (4-stage + file-path boost + neighbors)
│   ├── code-store.ts         # LanceDB "code" table + file hash tracking + schema migration
│   ├── file-walker.ts        # Project file discovery + .gitignore + git-diff
│   ├── sfc-extractor.ts      # Vue/Svelte/Astro <script> block extraction
│   ├── fetcher.ts            # Raw HTTP fetch (no AI truncation)
│   ├── workspace.ts          # Monorepo detection + pnpm catalog
│   ├── discovery.ts          # npm registry + URL probing for docs
│   ├── types.ts              # Shared TypeScript interfaces
│   ├── unit.test.ts          # Unit tests (no TEI needed)
│   ├── docs.test.ts          # Doc search integration tests
│   └── code.test.ts          # Code search integration tests
├── LICENSE
├── package.json
└── tsconfig.json
```

## Troubleshooting

### TEI containers not starting
```bash
# Check Docker is running
docker info

# Check container logs
docker compose logs tei-embed
docker compose logs tei-rerank
docker compose logs tei-code-embed

# Restart
./start-tei.sh --stop && ./start-tei.sh
```

### Port conflicts
If 39281/39282/39283 are in use, override via env vars:
```bash
TEI_EMBED_URL=http://localhost:49281 TEI_RERANK_URL=http://localhost:49282 TEI_CODE_EMBED_URL=http://localhost:49283 node dist/index.js
```

### Apple Silicon — slow performance
The default Docker CPU image runs via Rosetta 2. Use native Metal instead:
```bash
./start-tei.sh --metal
```
Requires Rust (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`). First build takes a few minutes.

## License

MIT

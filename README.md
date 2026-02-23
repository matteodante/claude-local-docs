# claude-local-docs

A local-first alternative to Context7 for Claude Code. Indexes your project's dependency documentation locally and provides production-grade semantic search. Embeddings and reranking run via TEI (HuggingFace Text Embeddings Inference) Docker containers with auto GPU detection.

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
| **Scope** | Your project's actual dependencies | Any library |
| **Monorepo** | Detects pnpm/npm/yarn workspaces, resolves catalogs | N/A |

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

## Usage

### 1. Index your project's docs

```
/fetch-docs
```

Claude analyzes your project (including monorepo workspaces), finds all runtime dependencies, searches the web for the best documentation for each one (preferring `llms-full.txt` > `llms.txt` > official docs), and indexes everything locally.

### 2. Search

Ask Claude anything about your dependencies. It will automatically use `search_docs` to find relevant documentation chunks:

```
How do I set up middleware in Express?
What are the options for useQuery in TanStack Query?
Show me the API for zod's .refine()
```

### 3. Other tools

- **`list_docs`** — See what's indexed, when it was fetched, chunk counts
- **`get_doc_section`** — Retrieve specific sections by heading or chunk ID
- **`analyze_dependencies`** — List all deps (monorepo-aware, catalog-resolved, runtime/dev tagged)
- **`fetch_and_store_doc`** — Fetch a URL and index it directly (no AI truncation)

## TEI backend

ML inference runs in TEI (HuggingFace Text Embeddings Inference) containers:

| Container | Port | Model | Purpose |
|---|---|---|---|
| tei-embed | `:39281` | `nomic-ai/nomic-embed-text-v1.5` | Text embeddings (384-dim Matryoshka) |
| tei-rerank | `:39282` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Cross-encoder reranking |

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

4-stage RAG pipeline:

| Stage | Technology | Purpose |
|---|---|---|
| **Vector search** | LanceDB + nomic-embed-text-v1.5 via TEI | Semantic similarity (understands meaning) |
| **BM25 search** | LanceDB native FTS (BM25, stemming, stop words) | Keyword matching (exact terms like `useEffect`) |
| **RRF fusion** | Reciprocal Rank Fusion (k=60) | Merges both ranked lists, handles different score scales |
| **Cross-encoder rerank** | ms-marco-MiniLM-L-6-v2 via TEI | Rescores top 30 candidates with deep relevance model |

## Storage

All data stays in your project directory:

```
your-project/.claude/docs/
├── lancedb/              # Vector database (LanceDB files)
├── .metadata.json        # Fetch timestamps, source URLs per library
└── raw/
    ├── react.md          # Raw fetched documentation
    ├── next.md
    └── tanstack__query.md
```

## MCP Tools

| Tool | Description |
|---|---|
| `analyze_dependencies` | Monorepo-aware dep analysis: detects workspaces, resolves catalog versions, tags runtime/dev |
| `store_and_index_doc` | Receive markdown, chunk, embed via TEI, store in LanceDB |
| `fetch_and_store_doc` | Fetch URL directly (raw HTTP, no truncation), then chunk + embed + store |
| `search_docs` | Full RAG pipeline: vector + BM25 + RRF + rerank via TEI |
| `list_docs` | List indexed libraries with metadata |
| `get_doc_section` | Get specific chunks by library + heading or chunk ID |

## Dependencies

| Package | License | Purpose |
|---|---|---|
| `@lancedb/lancedb` | Apache 2.0 | Embedded vector database + native FTS |
| `@modelcontextprotocol/sdk` | MIT | MCP server framework |
| `zod` | MIT | Schema validation |

TEI containers (Docker):

| Image | Model | Purpose |
|---|---|---|
| `text-embeddings-inference:*` | `nomic-ai/nomic-embed-text-v1.5` | Text embeddings |
| `text-embeddings-inference:*` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Cross-encoder reranking |

## Development

```bash
npm run dev    # Watch mode — rebuilds on file changes
npm run build  # One-time build
npm test       # Integration test (requires TEI running)
```

## Project structure

```
claude-local-docs/
├── .claude-plugin/
│   ├── plugin.json           # Plugin manifest
│   └── marketplace.json      # Marketplace listing
├── .mcp.json                 # MCP server config (stdio transport)
├── commands/
│   └── fetch-docs.md         # /fetch-docs — Claude as research agent
├── hooks/
│   └── hooks.json            # SessionStart hook for TEI containers
├── scripts/
│   └── ensure-tei.sh         # Idempotent TEI health check + start
├── docker-compose.yml        # TEI containers (uses ${TEI_TAG})
├── docker-compose.nvidia.yml # NVIDIA GPU device passthrough
├── start-tei.sh              # Auto-detect GPU, start TEI
├── src/
│   ├── index.ts              # MCP server entry, 6 tool definitions
│   ├── indexer.ts            # Chunking + TEI embeddings
│   ├── search.ts             # 4-stage pipeline: vector + BM25 + RRF + rerank
│   ├── reranker.ts           # TEI cross-encoder reranking
│   ├── store.ts              # LanceDB storage + metadata persistence
│   ├── fetcher.ts            # Raw HTTP fetch (no AI truncation)
│   ├── workspace.ts          # Monorepo detection + pnpm catalog
│   └── types.ts              # Shared TypeScript interfaces
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

# Restart
./start-tei.sh --stop && ./start-tei.sh
```

### Port conflicts
If 39281/39282 are in use, override via env vars:
```bash
TEI_EMBED_URL=http://localhost:49281 TEI_RERANK_URL=http://localhost:49282 node dist/index.js
```

### Apple Silicon — slow performance
The default Docker CPU image runs via Rosetta 2. Use native Metal instead:
```bash
./start-tei.sh --metal
```
Requires Rust (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`). First build takes a few minutes.

## License

MIT

# claude-local-docs

A local-first alternative to Context7 for Claude Code. Indexes your project's dependency documentation locally and provides production-grade semantic search — no cloud APIs at query time, no rate limits, full privacy.

## Why not Context7?

| | **claude-local-docs** | **Context7** |
|---|---|---|
| **Runs where** | Your machine (ONNX models) | Upstash cloud servers |
| **Privacy** | Docs never leave your machine | Queries sent to cloud API |
| **Rate limits** | None | API-dependent |
| **Offline** | Full search works offline | Requires internet |
| **Search quality** | 4-stage RAG (vector + BM25 + RRF + cross-encoder reranking) | Single-stage retrieval |
| **Doc sources** | Prefers llms.txt, falls back to official docs | Pre-indexed source repos |
| **Scope** | Your project's actual dependencies | Any library |
| **Setup** | `npm install` + `/fetch-docs` | Install plugin |
| **Monorepo** | Detects pnpm/npm/yarn workspaces, resolves catalogs | N/A |

## How it works

```
/fetch-docs                        search_docs("how to use useState")
     │                                       │
     ▼                                       ▼
 Detect monorepo              ┌─── Vector search (LanceDB) ───┐
 Scan all workspace pkgs      │    nomic-embed-text-v1.5       │
 Resolve catalog: versions    │                                │
     │                        │                                ├─→ RRF Fusion
     ▼                        │                                │    (k=60)
 For each runtime dep:        ├── BM25 search (LanceDB FTS) ──┘
   - Search for llms.txt      │    keyword + stemming            │
   - Raw fetch (no truncation)│                                  ▼
   - Chunk + embed + store    │                        Cross-encoder rerank
                              │                        ms-marco-MiniLM-L-6-v2
                              │                                  │
                              └──────────────────────────────────┘
                                                  │
                                                  ▼
                                          Top-K results
```

## Installation

```bash
# Clone into your Claude Code plugins directory
git clone <repo-url> ~/.claude/plugins/claude-local-docs

# Install dependencies and build
cd ~/.claude/plugins/claude-local-docs
npm install
npm run build
```

Or install as a project-local plugin by cloning into your project and referencing it in your Claude Code settings.

## Usage

### 1. Index your project's docs

```
/fetch-docs
```

Claude analyzes your project (including monorepo workspaces), finds all runtime dependencies, searches the web for the best documentation for each one (preferring `llms-full.txt` > `llms.txt` > official docs), and indexes everything locally. Progress is reported one library at a time.

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

## Search pipeline

This plugin implements a 4-stage advanced RAG pipeline, the current production standard:

| Stage | Technology | Purpose |
|---|---|---|
| **Vector search** | LanceDB + nomic-embed-text-v1.5 | Semantic similarity (understands meaning) |
| **BM25 search** | LanceDB native FTS (BM25, stemming, stop words) | Keyword matching (exact terms like `useEffect`) |
| **RRF fusion** | Reciprocal Rank Fusion (k=60) | Merges both ranked lists, handles different score scales |
| **Cross-encoder rerank** | ms-marco-MiniLM-L-6-v2 | Rescores top 30 candidates with deep relevance model |

### Why this matters

- **Vector-only** search misses exact API names and error codes
- **Keyword-only** search misses semantic meaning ("state management" won't find "useState")
- **Hybrid + reranking** catches both, then a cross-encoder picks the truly relevant results

## Models

All models run locally via ONNX. Downloaded once on first use, then cached.

| Model | Size | Purpose |
|---|---|---|
| `nomic-ai/nomic-embed-text-v1.5` | ~270MB | Text embeddings (86% top-5 accuracy, Matryoshka 384-dim) |
| `Xenova/ms-marco-MiniLM-L-6-v2` | ~23MB | Cross-encoder reranking |

## Chunking strategy

- Split markdown by headings (`##`, `###`, `####`) preserving the heading path
- Target ~1500 characters per chunk
- 10% overlap between chunks to prevent losing context at boundaries
- Large sections split at paragraph boundaries

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
| `store_and_index_doc` | Receive markdown, chunk, embed, store in LanceDB |
| `fetch_and_store_doc` | Fetch URL directly (raw HTTP, no truncation), then chunk + embed + store |
| `search_docs` | Full RAG pipeline: vector + BM25 + RRF + rerank |
| `list_docs` | List indexed libraries with metadata |
| `get_doc_section` | Get specific chunks by library + heading or chunk ID |

## Dependencies

All open source:

| Package | License | Purpose |
|---|---|---|
| `@lancedb/lancedb` | Apache 2.0 | Embedded vector database + native FTS |
| `@huggingface/transformers` | Apache 2.0 | Run ONNX models locally |
| `@modelcontextprotocol/sdk` | MIT | MCP server framework |
| `zod` | MIT | Schema validation |

No additional dependencies were added for monorepo support or HTTP fetching — everything uses Node built-ins.

## Development

```bash
npm run dev    # Watch mode — rebuilds on file changes
npm run build  # One-time build
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Project structure

```
claude-local-docs/
├── .claude-plugin/
│   ├── plugin.json         # Plugin manifest
│   └── marketplace.json    # Marketplace listing
├── .mcp.json               # MCP server config (stdio transport)
├── commands/
│   └── fetch-docs.md       # /fetch-docs command — Claude as research agent
├── src/
│   ├── index.ts            # MCP server entry, 6 tool definitions
│   ├── indexer.ts           # Chunking + nomic-embed-text-v1.5 embeddings
│   ├── search.ts            # 4-stage pipeline: vector + BM25 + RRF + rerank
│   ├── reranker.ts          # Cross-encoder (ms-marco-MiniLM-L-6-v2)
│   ├── store.ts             # LanceDB storage + metadata persistence
│   ├── fetcher.ts           # Raw HTTP fetch (no AI truncation)
│   ├── workspace.ts         # Monorepo detection + pnpm catalog + dep collection
│   └── types.ts             # Shared TypeScript interfaces
├── LICENSE
├── package.json
└── tsconfig.json
```

## License

MIT

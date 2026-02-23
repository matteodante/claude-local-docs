# claude-local-docs

A Claude Code plugin that indexes your project's dependency documentation locally and provides production-grade semantic search — no external APIs at query time.

## How it works

```
/fetch-docs                        search_docs("how to use useState")
     │                                       │
     ▼                                       ▼
 Read package.json              ┌─── Vector search (LanceDB) ───┐
     │                          │    nomic-embed-text-v1.5       │
     ▼                          │                                │
 For each dependency:           │                                ├─→ RRF Fusion
   - Search web for llms.txt    │                                │    (k=60)
   - Fetch best docs            ├─── BM25 search (MiniSearch) ──┘
   - Chunk + embed + store      │    keyword + fuzzy match         │
                                │                                  ▼
                                │                        Cross-encoder rerank
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

Claude reads your `package.json`, searches the web for the best documentation for each dependency (preferring `llms.txt` / `llms-full.txt`), and indexes everything locally.

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
- **`analyze_dependencies`** — List all deps from package.json

## Search pipeline

This plugin implements a 4-stage advanced RAG pipeline, the current production standard:

| Stage | Technology | Purpose |
|---|---|---|
| **Vector search** | LanceDB + nomic-embed-text-v1.5 | Semantic similarity (understands meaning) |
| **BM25 search** | MiniSearch (BM25+ algorithm) | Keyword matching (exact terms like `useEffect`) |
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
- Target ~2000 characters per chunk
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
| `analyze_dependencies` | Read package.json, return all deps with versions |
| `store_and_index_doc` | Receive markdown, chunk, embed, store in LanceDB |
| `search_docs` | Full RAG pipeline: vector + BM25 + RRF + rerank |
| `list_docs` | List indexed libraries with metadata |
| `get_doc_section` | Get specific chunks by library + heading or chunk ID |

## Dependencies

All open source:

| Package | License | Purpose |
|---|---|---|
| `@lancedb/lancedb` | Apache 2.0 | Embedded vector database |
| `@huggingface/transformers` | Apache 2.0 | Run ONNX models locally |
| `minisearch` | MIT | BM25+ full-text search |
| `@modelcontextprotocol/sdk` | MIT | MCP server framework |
| `zod` | MIT | Schema validation |

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
│   └── plugin.json         # Plugin manifest
├── .mcp.json               # MCP server config (stdio transport)
├── commands/
│   └── fetch-docs.md       # /fetch-docs command — Claude as research agent
├── src/
│   ├── index.ts            # MCP server entry, 5 tool definitions
│   ├── indexer.ts           # Chunking + nomic-embed-text-v1.5 embeddings
│   ├── search.ts            # 4-stage pipeline: vector + BM25 + RRF + rerank
│   ├── reranker.ts          # Cross-encoder (ms-marco-MiniLM-L-6-v2)
│   ├── store.ts             # LanceDB storage + metadata persistence
│   └── types.ts             # Shared TypeScript interfaces
├── package.json
└── tsconfig.json
```

## License

MIT

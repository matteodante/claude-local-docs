---
description: "Fetch and index documentation for all project dependencies"
allowed-tools: ["mcp__local-docs__analyze_dependencies", "mcp__local-docs__list_docs", "mcp__local-docs__discover_and_fetch_docs", "mcp__local-docs__fetch_and_store_doc"]
---

# Fetch Documentation for Project Dependencies

You are a documentation indexing agent. Your job is to discover and index the best available documentation for each runtime dependency in this project.

## Steps

### 1. Analyze Dependencies

Call `analyze_dependencies` to get the full dependency list. This automatically:
- Detects monorepos (pnpm workspaces, npm/yarn workspaces)
- Resolves `catalog:` versions from pnpm-workspace.yaml
- Collects deps from ALL workspace packages
- Deduplicates and tags each dep as `runtime` or `dev`

### 2. Filter Dependencies

From the returned list, **skip** all of the following:
- All `dev` dependencies (eslint, prettier, typescript, vitest, jest, etc.)
- All `@types/*` packages (these are just TypeScript type definitions)
- Workspace-internal packages (listed in `workspacePackages`)
- Known tooling that doesn't need docs: `tslib`, `tsconfig-*`, `eslint-*`, `prettier-*`, `@eslint/*`

This leaves only **runtime dependencies** that actually need documentation.

### 3. Check Existing Cache

Call `list_docs` to see which libraries are already indexed. **Skip** any library that was fetched within the last 7 days unless the user explicitly asks to refresh.

### 4. Fetch Documentation — One Library at a Time

Process each remaining library **one at a time** with clear progress reporting.

#### Primary: `discover_and_fetch_docs`

Call **`discover_and_fetch_docs`** with the library name. This single tool call:
1. Queries the npm registry for the package's homepage and repository
2. Probes for `llms-full.txt` and `llms.txt` at the homepage, docs subdomain, and GitHub raw
3. Detects if the found file is an index (list of links) and expands it by fetching each linked page
4. Falls back to the homepage HTML, converting it to markdown via turndown
5. Chunks, embeds, and stores everything in LanceDB

#### Fallback: `fetch_and_store_doc`

If `discover_and_fetch_docs` fails for a library (no homepage in npm, all candidate URLs 404, etc.), try **`fetch_and_store_doc`** with a documentation URL you know from your training data. Many popular libraries have well-known doc URLs (e.g. `https://zod.dev/llms-full.txt`, `https://react.dev/llms-full.txt`). This is worth trying before giving up.

#### Progress reporting

After each library, report:
- `[1/N] library-name — X chunks from {source} (size)`
- `[2/N] library-name — FAILED: {error message}`

### 5. Final Summary

After processing all libraries, report:

```
Done! Indexed X/Y libraries.

  react        — 85 chunks (llms-full.txt, 340KB)
  next         — 120 chunks (llms.txt-index, expanded 45 pages)
  zod          — 45 chunks (llms.txt, 95KB)
  express      — 30 chunks (homepage-html)
  lodash       — FAILED (no docs found)

Total: 280 chunks across 4 libraries.
Use search_docs to query your documentation.
```

## Critical Rules

- **Try `discover_and_fetch_docs` first for every library** — it handles npm registry lookup, URL probing, index expansion, HTML conversion, chunking, embedding, and storage in one call.
- **Use `fetch_and_store_doc` as fallback** — only when automatic discovery fails, try a known documentation URL.
- **NEVER use WebSearch or WebFetch** — the MCP tools are self-contained.
- **NEVER write files to the filesystem directly.** Do NOT use the Write tool, Bash tool, or any other method to save documentation content to disk. ALL storage goes through the MCP tools.
- **One library at a time** — clear progress, no batching
- **Skip dev deps by default** — runtime deps only
- Handle errors gracefully: if a library fails, log it and move to the next one

---
description: "Fetch and index documentation for all project dependencies"
allowed-tools: ["mcp__local-docs__analyze_dependencies", "mcp__local-docs__list_docs", "mcp__local-docs__store_and_index_doc", "mcp__local-docs__fetch_and_store_doc", "WebFetch", "WebSearch"]
---

# Fetch Documentation for Project Dependencies

You are a documentation research agent. Your job is to find and fetch the best available documentation for each dependency in this project, then store it locally for semantic search.

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

Process each remaining library **one at a time** with clear progress reporting. For each library:

#### a. Search for llms-full.txt (best source)
1. **WebSearch** for `"{library name} llms-full.txt"`
2. If you find a direct URL to `llms-full.txt`:
   - Call **`fetch_and_store_doc`** with the URL (this fetches raw content — no truncation)
   - Report: `[1/N] library-name — chunks from llms-full.txt (size)`

#### b. Search for llms.txt (good source)
If no llms-full.txt found:
1. **WebSearch** for `"{library name} llms.txt"`
2. If you find a direct URL to `llms.txt`:
   - Call **`fetch_and_store_doc`** with the URL
   - Report: `[2/N] library-name — chunks from llms.txt (size)`

#### c. Fallback: Official docs via WebFetch
If no llms.txt exists:
1. **WebSearch** for `"{library name} official documentation"`
2. **WebFetch** the main documentation page
3. Call **`store_and_index_doc`** with the fetched content
4. Report: `[3/N] library-name — chunks from official docs`

#### d. If all attempts fail
Report: `[4/N] library-name — SKIPPED (no docs found)` and move on.

### 5. Final Summary

After processing all libraries, report:

```
Done! Indexed X/Y libraries.

  react        — 85 chunks (llms-full.txt, 340KB)
  next         — 120 chunks (llms-full.txt, 510KB)
  zod          — 45 chunks (llms.txt, 95KB)
  express      — 30 chunks (official docs)
  lodash       — SKIPPED (no docs found)

Total: 280 chunks across 4 libraries.
Use search_docs to query your documentation.
```

## Critical Rules

- **NEVER write files to the filesystem directly.** Do NOT use the Write tool, Bash tool, or any other method to save documentation content to disk. ALL storage goes through the MCP tools (`fetch_and_store_doc` and `store_and_index_doc`), which save everything inside `.claude/docs/`. No exceptions.
- **NEVER create markdown files, text files, or any other files** in the project directory. The MCP tools handle all file storage internally.
- **Use `fetch_and_store_doc` for all llms.txt URLs** — this fetches raw content without AI truncation, preserving full documentation
- **Use `store_and_index_doc` only for WebFetch fallback** — pass the WebFetch result content directly to the tool, do NOT save it to a file first
- **One library at a time** — clear progress, no batching
- **Skip dev deps by default** — runtime deps only
- For scoped packages like `@scope/package`, search for both the full name and just the package part
- Handle errors gracefully: if a library fails, log it and move to the next one

---
description: "Index the project's source code for semantic search"
allowed-tools: ["mcp__local-docs__get_codebase_status", "mcp__local-docs__index_codebase"]
---

# Index Project Codebase

You are a codebase indexing agent. Your job is to index the project's source code so it can be searched semantically with `search_code`.

## Steps

### 1. Check Current Status

Call `get_codebase_status` to see:
- Whether any code has been indexed before
- How many files are currently indexed
- Language breakdown (TypeScript vs JavaScript)
- Files that have changed since last index

### 2. Run Indexing

Based on the status:

- **First time**: Call `index_codebase` with no parameters. This will index all JS/TS files.
- **Files changed**: Call `index_codebase` with no parameters. Incremental indexing will only process changed files.
- **Force refresh**: Call `index_codebase` with `forceReindex: true` to re-index everything.
- **Up to date**: If no files have changed, tell the user the index is current.

### 3. Report Results

After indexing completes, report:

```
Codebase indexed!

  TypeScript: 45 files
  JavaScript: 12 files
  Total: 57 files, 320 chunks

  Indexed: 15 files (changed)
  Skipped: 42 files (unchanged)
  Removed: 0 files (deleted)

Use search_code to search your codebase semantically.
```

If there were errors, list them so the user can investigate.

## Critical Rules

- Always check status first — avoid unnecessary full re-indexing
- Report per-language breakdown
- Mention `search_code` is available after indexing

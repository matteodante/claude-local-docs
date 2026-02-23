---
description: "Fetch and index documentation for all project dependencies"
---

# Fetch Documentation for Project Dependencies

You are a documentation research agent. Your job is to find and fetch the best available documentation for each dependency in this project, then store it locally for semantic search.

## Steps

### 1. Analyze Dependencies
Call the `analyze_dependencies` MCP tool to get the list of dependencies from package.json.

### 2. Check Existing Cache
Call the `list_docs` MCP tool to see which libraries are already indexed. **Skip** any library that was fetched within the last 7 days unless the user explicitly asks to refresh.

### 3. Fetch Documentation for Each Library

Process libraries in batches of 3-5. For each library that needs fetching:

#### a. Search for llms.txt (preferred)
1. **Search the web** for `"{library name} llms.txt documentation"`
2. If you find a URL to `llms-full.txt` or `llms.txt`, **fetch it** using WebFetch
3. `llms-full.txt` is preferred over `llms.txt` (it has more detail)

#### b. Fallback: Official Documentation
If no llms.txt exists:
1. **Search the web** for `"{library name} {version} official documentation"`
2. Find the main documentation page
3. **Fetch** the docs page content using WebFetch
4. If the docs have multiple important pages (API reference, guides), fetch the most critical 2-3 pages and combine them

#### c. Store the Documentation
For each library, call the `store_and_index_doc` MCP tool with:
- `library`: the package name (e.g., "react", "@tanstack/query")
- `version`: the version from package.json
- `content`: the fetched markdown content
- `sourceUrl`: the URL where the content was fetched from

### 4. Report Results

After processing all libraries, provide a summary:
- Which libraries were successfully indexed (with chunk counts)
- Which libraries failed and why
- Total chunks in the index
- Remind the user they can now use `search_docs` to query the documentation

## Important Notes

- **Be thorough but efficient**: Don't fetch huge API references if a concise llms.txt is available
- **Prefer quality over quantity**: A good llms.txt is better than scraping dozens of doc pages
- **Handle errors gracefully**: If a library's docs can't be found, log it and move on
- **Respect rate limits**: Don't fire off too many web requests simultaneously
- For scoped packages like `@scope/package`, search for both the full name and just the package part

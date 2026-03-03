#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DocStore, resolveProjectRoot } from "./store.js";
import { indexDocument } from "./indexer.js";
import { searchDocs } from "./search.js";
import { analyzeDependencies } from "./workspace.js";
import { fetchDocContent } from "./fetcher.js";
import { resolveDocsUrl } from "./discovery.js";
import { CodeStore } from "./code-store.js";
import { searchCode } from "./code-search.js";
import { walkProjectFiles, computeFileHash, computeContentHash, getGitChangedFiles } from "./file-walker.js";
import { indexCodeFile } from "./code-indexer.js";
import { checkAllTeiHealth } from "./tei-client.js";
import type { Dependency, SearchResult, CodeEntityType } from "./types.js";

const projectRoot = resolveProjectRoot();

/**
 * Expand search results with adjacent chunks (id-1 and id+1) from the same library/section.
 * This recovers context when code examples are split across chunk boundaries.
 */
async function expandWithNeighbors(
  results: SearchResult[],
  store: DocStore
): Promise<SearchResult[]> {
  const resultIds = new Set(results.map((r) => r.chunkId));
  const expanded: SearchResult[] = [];

  for (const result of results) {
    const headingJson = JSON.stringify(result.headingPath);
    const parts: string[] = [];

    // Try previous chunk
    const prevId = result.chunkId - 1;
    if (!resultIds.has(prevId)) {
      const prev = await store.getChunkById(prevId);
      if (prev && prev.library === result.library && prev.headingPath === headingJson) {
        parts.push(prev.text);
      }
    }

    parts.push(result.content);

    // Try next chunk
    const nextId = result.chunkId + 1;
    if (!resultIds.has(nextId)) {
      const next = await store.getChunkById(nextId);
      if (next && next.library === result.library && next.headingPath === headingJson) {
        parts.push(next.text);
      }
    }

    expanded.push({
      ...result,
      content: parts.length > 1 ? parts.join("\n\n") : result.content,
    });
  }

  return expanded;
}

const store = new DocStore(projectRoot);
const codeStore = new CodeStore(projectRoot);

const server = new McpServer({
  name: "local-docs",
  version: "1.0.0",
});

// --- Tool 1: analyze_dependencies ---
server.registerTool(
  "analyze_dependencies",
  {
    description:
      "Detect and list all npm dependencies in this project. Returns each dependency tagged as runtime or dev, with version info. Handles monorepos automatically (pnpm/npm/yarn workspaces). Use this before /fetch-docs.",
    inputSchema: {
      packageJsonPath: z
        .string()
        .optional()
        .describe("Path to package.json or project root. Defaults to the project root."),
    },
  },
  async ({ packageJsonPath }) => {
    try {
      const root = packageJsonPath
        ? packageJsonPath.endsWith("package.json")
          ? join(packageJsonPath, "..")
          : packageJsonPath
        : projectRoot;

      const result = await analyzeDependencies(root);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [
          { type: "text" as const, text: `Error analyzing dependencies: ${err.message}` },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 2: store_and_index_doc ---
server.registerTool(
  "store_and_index_doc",
  {
    description:
      "Store and index documentation content you already have as a string. Use this when you have raw markdown content in memory (e.g. from WebFetch or training data). For fetching from a URL, use fetch_and_store_doc instead.",
    inputSchema: {
      library: z.string().describe("Library name — use the npm package name (e.g. 'react', '@tanstack/query')"),
      version: z.string().describe("Library version (e.g. '18.2.0', 'latest')"),
      content: z.string().describe("Raw markdown documentation content to index"),
      sourceUrl: z.string().describe("URL where the docs were originally fetched from"),
    },
  },
  async ({ library, version, content, sourceUrl }) => {
    try {
      // Save raw doc
      await store.saveRawDoc(library, content);

      // Chunk and embed
      const chunks = await indexDocument(content, library);

      // Store in LanceDB
      const result = await store.addLibrary(library, version, sourceUrl, chunks);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              library,
              chunkCount: result.chunkCount,
              totalIndexSize: result.indexSize,
              storedAt: store.getDocsDir(),
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error indexing ${library}: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool 3: search_docs ---
server.registerTool(
  "search_docs",
  {
    description:
      "Search indexed library documentation using natural language queries. Use this to find API usage, configuration options, or conceptual explanations from dependency docs (e.g. 'how to set up middleware in Express', 'Zod schema validation'). For searching the project's own source code, use search_code instead.",
    inputSchema: {
      query: z.string().describe("Natural language search query — can be a concept ('authentication flow'), a question ('how to configure SSR'), or specific terms ('useQuery options')"),
      library: z.string().optional().describe("Filter to a specific library by npm package name (e.g. 'react', '@tanstack/query'). Omit to search all indexed libraries."),
      topK: z.number().optional().describe("Number of results (1-50, default: 10). Use 3-5 for focused lookups, 15-20 for broad exploration."),
      compact: z.boolean().optional().describe("Compact mode (default: true). Truncates content to ~15 lines, skips neighbor chunk expansion. Set false for full output with neighbor context."),
      scoreThreshold: z.number().optional().describe("Minimum relevance score to include (default: 0.01). Filters noise results scoring near zero."),
    },
  },
  async ({ query, library, topK, compact, scoreThreshold }) => {
    try {
      if (await store.isEmpty()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No documentation indexed yet. Run /fetch-docs first.",
            },
          ],
        };
      }

      const isCompact = compact !== false; // default true
      const minScore = scoreThreshold ?? 0.01;

      const results = await searchDocs(query, store, { library, topK });

      // Expand results with adjacent chunks only when not compact
      const final = isCompact ? results : await expandWithNeighbors(results, store);

      // Filter by score threshold
      const filtered = final.filter((r) => r.score >= minScore);

      if (filtered.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results above score threshold ${minScore} for query: "${query}"` }],
        };
      }

      // Format as LLM-friendly text blocks
      const textBlocks = filtered.map((r, i) => {
        const heading = r.headingPath.join(" > ");
        const parts: string[] = [];

        parts.push(`── [${i + 1}] ${r.library} — ${heading} (score: ${r.score}) ──`);

        const content = isCompact ? truncateDocContent(r.content) : r.content;
        parts.push(content);

        return parts.join("\n");
      });

      const header = `Found ${filtered.length} result(s) for "${query}"${isCompact ? " (compact — use get_doc_section with chunkId for full content)" : ""}:\n`;

      return {
        content: [{ type: "text" as const, text: header + textBlocks.join("\n\n") }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Search error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool 4: list_docs ---
server.registerTool(
  "list_docs",
  {
    description:
      "List which libraries have documentation indexed, with version and fetch date. Use this to check what's available before searching, or to see if docs need refreshing.",
  },
  async () => {
    try {
      const metadata = await store.loadMetadata();
      if (metadata.libraries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No documentation indexed yet. Run /fetch-docs first.",
            },
          ],
        };
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(metadata.libraries, null, 2) },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error listing docs: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool 5: get_doc_section ---
server.registerTool(
  "get_doc_section",
  {
    description:
      "Retrieve a specific documentation section by heading name or chunk ID. Use this to read a particular section of a library's docs, or to get more context around a search_docs result.",
    inputSchema: {
      library: z.string().describe("Library name (npm package name)"),
      heading: z.string().optional().describe("Heading text to search for in the heading path (case-insensitive partial match)"),
      chunkId: z.number().optional().describe("Specific chunk ID to retrieve (from a search_docs result)"),
    },
  },
  async ({ library, heading, chunkId }) => {
    try {
      if (chunkId !== undefined) {
        const chunk = await store.getChunkById(chunkId);
        if (!chunk) {
          return {
            content: [{ type: "text" as const, text: `Chunk ${chunkId} not found` }],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: chunk.id,
                  library: chunk.library,
                  headingPath: chunk.headingPath,
                  content: chunk.text,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (heading) {
        const chunks = await store.getChunksByHeading(library, heading);
        if (chunks.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No chunks found for library "${library}" with heading matching "${heading}"`,
              },
            ],
          };
        }
        const formatted = chunks.map((c: any) => ({
          id: c.id,
          headingPath: c.headingPath,
          content: c.text,
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }],
        };
      }

      // No heading or chunkId — return summaries for the library
      const chunks = await store.getChunks(library);
      if (chunks.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No documentation found for library "${library}"`,
            },
          ],
        };
      }
      const summary = chunks.map((c: any) => ({
        id: c.id,
        heading: typeof c.headingPath === "string"
          ? (() => { try { return JSON.parse(c.headingPath).join(" > "); } catch { return c.headingPath; } })()
          : c.headingPath,
        preview: c.text.slice(0, 120) + (c.text.length > 120 ? "..." : ""),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool 6: fetch_and_store_doc ---
server.registerTool(
  "fetch_and_store_doc",
  {
    description:
      "Fetch documentation from a specific URL and index it. Use this when you have a known documentation URL (e.g. llms-full.txt URL from WebSearch or the /fetch-docs reference table). Fetches raw content without truncation.",
    inputSchema: {
      library: z.string().describe("Library name — use the npm package name (e.g. 'react', '@tanstack/query')"),
      version: z.string().describe("Library version (e.g. '18.2.0', 'latest')"),
      url: z.string().describe("URL to fetch documentation from (e.g. 'https://react.dev/llms.txt')"),
    },
  },
  async ({ library, version, url }) => {
    try {
      // Fetch raw content
      const fetchResult = await fetchDocContent(url);
      if (!fetchResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: fetchResult.error }),
            },
          ],
          isError: true,
        };
      }

      // Save raw doc
      await store.saveRawDoc(library, fetchResult.content);

      // Chunk and embed
      const chunks = await indexDocument(fetchResult.content, library);

      // Store in LanceDB
      const result = await store.addLibrary(library, version, url, chunks);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              library,
              chunkCount: result.chunkCount,
              byteLength: fetchResult.byteLength,
              totalIndexSize: result.indexSize,
              storedAt: store.getDocsDir(),
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, error: err.message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 7: discover_and_fetch_docs ---
server.registerTool(
  "discover_and_fetch_docs",
  {
    description:
      "Automatically find and index documentation for an npm package. Use this when you don't have a specific URL — it probes npm metadata, homepage, GitHub, and common doc locations. Use fetch_and_store_doc instead if you already know the URL.",
    inputSchema: {
      library: z.string().describe("npm package name (e.g. 'react', '@tanstack/query')"),
      version: z.string().optional().describe("Library version (optional — auto-detected from npm registry)"),
    },
  },
  async ({ library, version }) => {
    try {
      const discovery = await resolveDocsUrl(library);
      await store.saveRawDoc(library, discovery.content);
      const chunks = await indexDocument(discovery.content, library);
      const result = await store.addLibrary(library, version ?? "latest", discovery.url, chunks);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              library,
              source: discovery.source,
              url: discovery.url,
              chunkCount: result.chunkCount,
              byteLength: discovery.byteLength,
              totalIndexSize: result.indexSize,
              expandedUrls: discovery.expandedUrls,
              failedUrls: discovery.failedUrls,
              warning: discovery.warning,
            }),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, library, error: err.message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 8: index_codebase ---
server.registerTool(
  "index_codebase",
  {
    description:
      "Index the project's source code for semantic search. Run this once when starting work on a project, or after significant file changes, to enable search_code. Parses JS/TS files with tree-sitter for function/class/method-level chunks and generates code-specialized embeddings. Supports incremental indexing — unchanged files are skipped automatically. Respects .gitignore.",
    inputSchema: {
      forceReindex: z.boolean().optional().describe("Re-index all files even if unchanged (default: false)"),
      excludePaths: z.array(z.string()).optional().describe("Additional glob patterns to exclude (e.g. ['test/**', '*.spec.ts'])"),
      includePaths: z.array(z.string()).optional().describe("Only index files matching these glob patterns (e.g. ['src/**'])"),
    },
  },
  async ({ forceReindex, excludePaths, includePaths }) => {
    try {
      // Pre-flight: check TEI health before starting the indexing loop
      const health = await checkAllTeiHealth();
      if (!health.codeEmbed.healthy) {
        const parts: string[] = [];
        parts.push(`code-embed (:39283): ${health.codeEmbed.error}`);
        if (!health.rerank.healthy) parts.push(`rerank (:39282): ${health.rerank.error}`);
        return {
          content: [{
            type: "text" as const,
            text: `TEI containers are not healthy. Start them with ./start-tei.sh\n\n${parts.join("\n")}`,
          }],
          isError: true,
        };
      }

      // Walk all project files (still needed for extension/gitignore filtering)
      const files = await walkProjectFiles({
        projectRoot,
        excludePaths,
        includePaths,
      });

      const currentPaths = new Set(files.map(f => f.relativePath));

      const metadata = await codeStore.loadMetadata();

      // Determine indexing strategy
      let strategy: "full" | "git-diff" | "hash" = "hash";
      let gitChangedPaths: Set<string> | null = null;
      let lastGitCommit: string | undefined;

      if (forceReindex) {
        strategy = "full";
        // Drop the table so it gets recreated with the correct vector dimension
        await codeStore.dropTable();
        // Still capture HEAD for storing lastIndexedCommit after full reindex
        const gitInfo = await getGitChangedFiles(projectRoot);
        lastGitCommit = gitInfo.isGitRepo ? gitInfo.lastCommit : undefined;
      } else if (metadata.lastIndexedCommit) {
        // Try git-diff optimization
        const gitChanges = await getGitChangedFiles(projectRoot, metadata.lastIndexedCommit);
        lastGitCommit = gitChanges.isGitRepo ? gitChanges.lastCommit : undefined;
        if (gitChanges.isGitRepo && (gitChanges.modified.length > 0 || gitChanges.added.length > 0 || gitChanges.deleted.length > 0)) {
          strategy = "git-diff";
          gitChangedPaths = new Set([...gitChanges.modified, ...gitChanges.added]);
          // Handle deletions
          for (const deleted of gitChanges.deleted) {
            if (metadata.files.some(f => f.filePath === deleted)) {
              await codeStore.removeFile(deleted);
            }
          }
        } else if (gitChanges.isGitRepo && gitChanges.lastCommit === metadata.lastIndexedCommit) {
          // Same commit, check working tree only
          strategy = "git-diff";
          gitChangedPaths = new Set([...gitChanges.modified, ...gitChanges.added]);
        }

        // Backfill: include any walkable file not yet in metadata (never indexed).
        // This handles partial first runs (e.g. with includePaths) and newly
        // created files that pre-date lastIndexedCommit.
        if (strategy === "git-diff" && gitChangedPaths) {
          const indexedPaths = new Set(metadata.files.map(f => f.filePath));
          for (const file of files) {
            if (!indexedPaths.has(file.relativePath)) {
              gitChangedPaths.add(file.relativePath);
            }
          }
        }
      } else {
        // No lastIndexedCommit — first run with hash strategy. Still capture HEAD.
        const gitInfo = await getGitChangedFiles(projectRoot);
        lastGitCommit = gitInfo.isGitRepo ? gitInfo.lastCommit : undefined;
      }

      let indexed = 0;
      let skipped = 0;
      let failed = 0;
      let consecutiveFailures = 0;
      const langBreakdown: Record<string, number> = {};
      const errors: string[] = [];

      for (const file of files) {
        try {
          // Git-diff strategy: skip files not in the changed set
          if (strategy === "git-diff" && gitChangedPaths && !gitChangedPaths.has(file.relativePath)) {
            skipped++;
            langBreakdown[file.language] = (langBreakdown[file.language] ?? 0) + 1;
            continue;
          }

          // Read file once, hash in memory (avoids triple disk read)
          const source = await readFile(file.absolutePath, "utf-8");
          const sha256 = computeContentHash(source);

          // Hash-based check (for "hash" strategy, or as secondary guard for git-diff)
          if (strategy !== "full") {
            const existingHash = await codeStore.getFileHash(file.relativePath);
            if (existingHash === sha256) {
              skipped++;
              langBreakdown[file.language] = (langBreakdown[file.language] ?? 0) + 1;
              continue;
            }
          }

          // Parse, embed, store
          const chunks = await indexCodeFile(source, file.relativePath, file.language);

          await codeStore.addFile(file.relativePath, file.language, sha256, chunks, { skipMetadataSave: true });
          indexed++;
          consecutiveFailures = 0; // reset on success
          langBreakdown[file.language] = (langBreakdown[file.language] ?? 0) + 1;
        } catch (err: any) {
          failed++;
          consecutiveFailures++;
          errors.push(`${file.relativePath}: ${err.message}`);

          // Abort after 5 consecutive failures — TEI is likely down
          if (consecutiveFailures >= 5) {
            errors.push("Aborting: 5 consecutive failures — TEI appears to be down");
            break;
          }
        }
      }

      // Remove stale files (files that were indexed but no longer exist in the project)
      const removed = await codeStore.removeStaleFiles(currentPaths);

      // Rebuild FTS index once at end
      if (indexed > 0 || removed.length > 0) {
        await codeStore.createFtsIndex();
      }

      // Update metadata: last full index time + HEAD commit
      const updatedMetadata = await codeStore.loadMetadata();
      updatedMetadata.lastFullIndexAt = new Date().toISOString();
      // Store current HEAD for git-diff on next run
      if (lastGitCommit) {
        updatedMetadata.lastIndexedCommit = lastGitCommit;
      }
      await codeStore.saveMetadata(updatedMetadata);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              strategy,
              totalFiles: files.length,
              indexed,
              skipped,
              failed,
              removed: removed.length,
              removedFiles: removed.length > 0 ? removed : undefined,
              languageBreakdown: langBreakdown,
              errors: errors.length > 0 ? errors : undefined,
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error indexing codebase: ${err.message}` }],
        isError: true,
      };
    }
  }
);

/**
 * Truncate doc content for compact mode.
 * Keeps first ~15 lines to preserve headings, code examples, and key sentences.
 */
function truncateDocContent(content: string, maxLines = 15): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;

  const kept = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  kept.push(`... ${remaining} more lines (use get_doc_section with chunkId for full content)`);
  return kept.join("\n");
}

/**
 * Strip redundant metadata header lines from code content.
 * These lines (// File:, // Scope:, // Flags:, // entityType:) duplicate
 * the structured metadata already in the response.
 */
function stripMetadataHeader(content: string): string {
  const lines = content.split("\n");
  let startIdx = 0;
  while (startIdx < lines.length) {
    const line = lines[startIdx]!.trimStart();
    if (
      line.startsWith("// File:") ||
      line.startsWith("// Scope:") ||
      line.startsWith("// Flags:") ||
      line.startsWith("// entityType:")
    ) {
      startIdx++;
    } else {
      break;
    }
  }
  return startIdx > 0 ? lines.slice(startIdx).join("\n") : content;
}

/**
 * Truncate code content for compact mode.
 * Strips metadata header, keeps JSDoc + first ~10 lines of code body.
 */
function truncateForCompact(content: string, maxBodyLines = 10): string {
  const cleaned = stripMetadataHeader(content);
  const lines = cleaned.split("\n");
  if (lines.length <= maxBodyLines) return cleaned;

  const kept = lines.slice(0, maxBodyLines);
  const remaining = lines.length - maxBodyLines;
  kept.push(`// ... ${remaining} more lines (use Read tool for full source)`);
  return kept.join("\n");
}

/**
 * Format a single search result as an LLM-friendly text block.
 *
 * Example output:
 * ── [1] src/auth/middleware.ts:45-89 (score: 0.95) ──
 * function authMiddleware | scope: AuthModule
 * ```typescript
 * export async function authMiddleware(req, res, next) {
 *   ...
 * ```
 */
function formatResultForLLM(
  r: { score: number; filePath: string; language: string; entityType: string; entityName: string; signature: string; scopeChain: string[]; lineStart: number; lineEnd: number; content: string; chunkId: number },
  index: number,
  isCompact: boolean,
): string {
  const parts: string[] = [];

  // Header line: location + score
  parts.push(`── [${index}] ${r.filePath}:${r.lineStart}-${r.lineEnd} (score: ${r.score}) ──`);

  // Entity info line
  const entityParts: string[] = [];
  if (r.entityName) entityParts.push(`${r.entityType} ${r.entityName}`);
  else entityParts.push(r.entityType);
  if (r.scopeChain.length > 0) entityParts.push(`scope: ${r.scopeChain.join(" > ")}`);
  if (r.signature) entityParts.push(`sig: ${r.signature}`);
  parts.push(entityParts.join(" | "));

  // Code block
  const code = isCompact ? truncateForCompact(r.content) : stripMetadataHeader(r.content);
  parts.push("```" + r.language);
  parts.push(code);
  parts.push("```");

  return parts.join("\n");
}

// --- Tool 9: search_code ---
server.registerTool(
  "search_code",
  {
    description:
      "Semantic search across the project's source code. Use this instead of Grep when searching for concepts rather than exact text — e.g. 'authentication middleware', 'database connection setup', 'error handling in API routes', 'function that validates email'. Returns function/class/method-level results with file paths, line numbers, and relevance scores. Requires index_codebase to have been run first.",
    inputSchema: {
      query: z.string().describe("Natural language search query — can be a concept ('authentication middleware'), a question ('function that handles payments'), or specific terms ('LanceDB vector search')"),
      language: z.string().optional().describe("Filter to a specific language: 'typescript' or 'javascript'"),
      filePath: z.string().optional().describe("Filter to a specific file path (relative to project root, e.g. 'src/search.ts')"),
      entityType: z.enum(["function", "class", "method", "interface", "type_alias", "enum", "import", "variable", "module", "namespace", "other"]).optional().describe("Filter to a specific entity type"),
      topK: z.number().optional().describe("Number of results (1-50, default: 10). Use 3-5 for focused lookups, 15-20 for broad exploration."),
      compact: z.boolean().optional().describe("Compact mode (default: true). Truncates content to ~10 lines, skips neighbor chunk expansion. Set false for full output with neighbor context."),
      scoreThreshold: z.number().optional().describe("Minimum relevance score to include (default: 0.01). Filters noise results scoring near zero."),
    },
  },
  async ({ query, language, filePath, entityType, topK, compact, scoreThreshold }) => {
    try {
      if (await codeStore.isEmpty()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No codebase indexed yet. Run index_codebase first.",
            },
          ],
        };
      }

      const isCompact = compact !== false; // default true
      const minScore = scoreThreshold ?? 0.01;

      const results = await searchCode(query, codeStore, {
        language,
        filePath,
        entityType: entityType as CodeEntityType | undefined,
        topK,
        expandNeighbors: !isCompact,
      });

      // Filter by score threshold
      const filtered = results.filter((r) => r.score >= minScore);

      if (filtered.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results above score threshold ${minScore} for query: "${query}"` }],
        };
      }

      // Format as LLM-friendly text blocks
      const textBlocks = filtered.map((r, i) =>
        formatResultForLLM(
          {
            score: r.score,
            filePath: r.filePath,
            language: r.language,
            entityType: r.entityType,
            entityName: r.entityName,
            signature: r.signature,
            scopeChain: r.scopeChain,
            lineStart: r.lineStart,
            lineEnd: r.lineEnd,
            content: r.content,
            chunkId: r.chunkId,
          },
          i + 1,
          isCompact,
        )
      );

      const header = `Found ${filtered.length} result(s) for "${query}"${isCompact ? " (compact — use Read tool for full source)" : ""}:\n`;

      return {
        content: [{ type: "text" as const, text: header + textBlocks.join("\n\n") }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Code search error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool 10: get_codebase_status ---
server.registerTool(
  "get_codebase_status",
  {
    description:
      "Check the status of the codebase index — how many files are indexed, language breakdown, last index time, and files changed since last index. Use this to decide whether to run index_codebase.",
  },
  async () => {
    try {
      const metadata = await codeStore.loadMetadata();

      if (metadata.files.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                indexed: false,
                message: "No codebase indexed yet. Run index_codebase to enable semantic code search.",
              }, null, 2),
            },
          ],
        };
      }

      // Walk current files to detect changes
      const currentFiles = await walkProjectFiles({ projectRoot });
      const currentPaths = new Set(currentFiles.map(f => f.relativePath));

      // Check for changed/new/removed files
      const indexedPaths = new Set(metadata.files.map(f => f.filePath));
      const newFiles: string[] = [];
      const changedFiles: string[] = [];
      const removedFiles: string[] = [];

      for (const file of currentFiles) {
        if (!indexedPaths.has(file.relativePath)) {
          newFiles.push(file.relativePath);
        } else {
          const existingHash = await codeStore.getFileHash(file.relativePath);
          if (existingHash) {
            const currentHash = await computeFileHash(file.absolutePath);
            if (existingHash !== currentHash) {
              changedFiles.push(file.relativePath);
            }
          }
        }
      }

      for (const file of metadata.files) {
        if (!currentPaths.has(file.filePath)) {
          removedFiles.push(file.filePath);
        }
      }

      // Language breakdown
      const langBreakdown: Record<string, number> = {};
      for (const file of metadata.files) {
        langBreakdown[file.language] = (langBreakdown[file.language] ?? 0) + 1;
      }

      const totalChunks = metadata.files.reduce((sum, f) => sum + f.chunkCount, 0);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              indexed: true,
              totalFiles: metadata.files.length,
              totalChunks,
              languageBreakdown: langBreakdown,
              lastFullIndexAt: metadata.lastFullIndexAt,
              changes: {
                newFiles: newFiles.length,
                changedFiles: changedFiles.length,
                removedFiles: removedFiles.length,
                needsReindex: newFiles.length > 0 || changedFiles.length > 0 || removedFiles.length > 0,
              },
              changedFilesList: changedFiles.length > 0 ? changedFiles : undefined,
              newFilesList: newFiles.length > 0 ? newFiles : undefined,
              removedFilesList: removedFiles.length > 0 ? removedFiles : undefined,
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error checking codebase status: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

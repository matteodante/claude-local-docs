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
import type { Dependency } from "./types.js";

const projectRoot = resolveProjectRoot();
const store = new DocStore(projectRoot);

const server = new McpServer({
  name: "local-docs",
  version: "1.0.0",
});

// --- Tool 1: analyze_dependencies ---
server.registerTool(
  "analyze_dependencies",
  {
    description:
      "Analyze project dependencies. Detects monorepos (pnpm workspaces, npm/yarn workspaces), resolves catalog: versions, collects deps from all workspace packages, and deduplicates. Returns deps tagged as runtime/dev plus monorepo info.",
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
    description: "Store and index documentation for a library. Chunks markdown, generates embeddings via nomic-embed-text-v1.5, and persists to LanceDB in .claude/docs/",
    inputSchema: {
      library: z.string().describe("Library name (e.g. 'react', '@tanstack/query')"),
      version: z.string().describe("Library version"),
      content: z.string().describe("Raw markdown documentation content"),
      sourceUrl: z.string().describe("URL where the docs were fetched from"),
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
    description: "Advanced RAG search: BM25 keyword search + vector similarity → RRF fusion → cross-encoder reranking. Uses nomic-embed-text-v1.5 for embeddings and ms-marco-MiniLM for reranking.",
    inputSchema: {
      query: z.string().describe("Search query"),
      library: z.string().optional().describe("Filter results to a specific library"),
      topK: z.number().optional().describe("Number of results to return (default: 10)"),
    },
  },
  async ({ query, library, topK }) => {
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

      const results = await searchDocs(query, store, { library, topK });

      const formatted = results.map((r) => ({
        score: r.score,
        library: r.library,
        heading: r.headingPath.join(" > "),
        chunkId: r.chunkId,
        content:
          r.content.length > 500
            ? r.content.slice(0, 500) + "..."
            : r.content,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }],
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
    description: "List all indexed documentation libraries with metadata",
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
    description: "Retrieve specific documentation chunks by library + heading or chunk ID",
    inputSchema: {
      library: z.string().describe("Library name"),
      heading: z.string().optional().describe("Heading text to search for in the heading path"),
      chunkId: z.number().optional().describe("Specific chunk ID to retrieve"),
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
          ? JSON.parse(c.headingPath).join(" > ")
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
      "Fetch documentation from a URL (raw HTTP, no AI processing or truncation) and index it. Use this for llms.txt and llms-full.txt URLs to preserve full content. Handles up to 200MB, 120s timeout.",
    inputSchema: {
      library: z.string().describe("Library name (e.g. 'react', '@tanstack/query')"),
      version: z.string().describe("Library version"),
      url: z.string().describe("URL to fetch documentation from (e.g. llms-full.txt URL)"),
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
      "Discover, fetch, and index documentation for a library automatically. Checks package.json llms/llmsFull fields first, then probes homepage, docs.{domain}, llms.{domain}, /docs/ subpath, and GitHub raw for llms-full.txt/llms.txt. Detects index files and expands them. Falls back to homepage HTML → markdown conversion. Self-contained — no WebSearch needed.",
    inputSchema: {
      library: z.string().describe("npm package name (e.g. 'react', '@tanstack/query')"),
      version: z.string().optional().describe("Library version (optional, auto-detected from npm)"),
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

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

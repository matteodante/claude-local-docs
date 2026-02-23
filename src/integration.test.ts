/**
 * Integration test: fetch Prisma llms-full.txt, index it, and run searches.
 *
 * Exercises the full fetch -> chunk -> embed -> store -> search -> rerank pipeline.
 *
 * Run: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { fetchDocContent } from "./fetcher.js";
import { chunkMarkdown, indexDocument } from "./indexer.js";
import { DocStore } from "./store.js";
import { searchDocs } from "./search.js";

const PRISMA_URL = "https://www.prisma.io/docs/llms-full.txt";
const CACHE_DIR = join(tmpdir(), "claude-local-docs-fixture");
const CACHE_FILE = join(CACHE_DIR, "prisma-llms-full.txt");

let tempDir: string;
let store: DocStore;
let fetchedContent: string;

/** Load from cache or fetch from network. */
async function loadPrismaDoc(): Promise<string> {
  if (existsSync(CACHE_FILE)) {
    console.log("  Using cached Prisma docs");
    return readFile(CACHE_FILE, "utf-8");
  }

  console.log("  Fetching Prisma docs (first run, will be cached)...");
  const result = await fetchDocContent(PRISMA_URL);
  assert.equal(result.ok, true, `Fetch failed: ${"error" in result ? result.error : ""}`);
  assert.ok(result.ok);

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, result.content, "utf-8");
  console.log(`  Fetched and cached ${result.byteLength} bytes (${(result.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  return result.content;
}

describe("Prisma llms-full.txt integration", { timeout: 600_000 }, () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-local-docs-test-"));
    fetchedContent = await loadPrismaDoc();
  });

  after(async () => {
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // -- Fetch --

  it("fetched content is substantial", () => {
    assert.ok(fetchedContent.length > 1_000_000, `Expected > 1M chars, got ${fetchedContent.length}`);
  });

  // -- Chunking --

  it("chunks the markdown into reasonable pieces", () => {
    const chunks = chunkMarkdown(fetchedContent, "prisma");
    console.log(`  Produced ${chunks.length} chunks`);

    assert.ok(chunks.length > 100, `Expected >100 chunks, got ${chunks.length}`);

    for (const c of chunks) {
      assert.equal(c.library, "prisma");
      assert.ok(c.text.trim().length > 0, "Found empty chunk");
      const parsed = JSON.parse(c.headingPath);
      assert.ok(Array.isArray(parsed), `headingPath not an array: ${c.headingPath}`);
    }
  });

  // -- Index + Store --

  it("indexes and stores all chunks in LanceDB", async () => {
    store = new DocStore(tempDir);

    const chunks = await indexDocument(fetchedContent, "prisma");
    console.log(`  Indexed ${chunks.length} chunks with embeddings`);

    assert.ok(chunks.length > 100);
    for (const c of chunks) {
      assert.equal(c.vector.length, 384, `Expected 384-dim vector, got ${c.vector.length}`);
    }

    const result = await store.addLibrary("prisma", "6.0.0", PRISMA_URL, chunks);
    console.log(`  Stored: ${result.chunkCount} chunks, index size: ${result.indexSize}`);

    assert.equal(result.chunkCount, chunks.length);
    assert.equal(result.indexSize, chunks.length);
  });

  // -- Search --

  const searchCases = [
    { query: "prisma client query", expectTerms: ["prisma", "client", "query"] },
    { query: "database migration", expectTerms: ["migrat", "schema", "database"] },
    { query: "prisma schema relations", expectTerms: ["relation", "schema", "model"] },
  ];

  for (const { query, expectTerms } of searchCases) {
    it(`returns relevant results for '${query}'`, async () => {
      const results = await searchDocs(query, store, { library: "prisma", topK: 5 });
      console.log(`  '${query}' → top score=${results[0]?.score}, heading=${results[0]?.headingPath.join(" > ")}`);

      assert.ok(results.length > 0, "Expected at least 1 result");
      assert.ok(results.length <= 5);

      const topContent = results[0].content.toLowerCase();
      assert.ok(
        expectTerms.some((t) => topContent.includes(t)),
        `Top result doesn't contain any of [${expectTerms}]`
      );
    });
  }

  it("returns scores in descending order", async () => {
    const results = await searchDocs("CRUD operations", store, { library: "prisma", topK: 10 });
    assert.ok(results.length > 1);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, `Not sorted: [${i - 1}]=${results[i - 1].score} < [${i}]=${results[i].score}`);
    }
  });

  it("returns results with valid structure", async () => {
    const results = await searchDocs("authentication", store, { topK: 3 });
    for (const r of results) {
      assert.equal(typeof r.score, "number");
      assert.equal(typeof r.library, "string");
      assert.ok(Array.isArray(r.headingPath));
      assert.equal(typeof r.content, "string");
      assert.equal(typeof r.chunkId, "number");
      assert.ok(r.content.length > 0);
    }
  });
});

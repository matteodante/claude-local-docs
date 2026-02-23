/**
 * Integration test: fetch Prisma llms-full.txt, index it, and run searches.
 *
 * This test hits the network, loads ONNX models, and exercises the full
 * fetch → chunk → embed → store → search → rerank pipeline.
 *
 * Run: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { fetchDocContent } from "./fetcher.js";
import { chunkMarkdown, indexDocument } from "./indexer.js";
import { DocStore } from "./store.js";
import { searchDocs } from "./search.js";

const PRISMA_URL = "https://www.prisma.io/docs/llms-full.txt";

let tempDir: string;
let store: DocStore;
let fetchedContent: string;

describe("Prisma llms-full.txt integration", { timeout: 600_000 }, () => {
  before(async () => {
    // Create a temp project dir with the structure DocStore expects
    tempDir = await mkdtemp(join(tmpdir(), "claude-local-docs-test-"));
  });

  after(async () => {
    if (tempDir && existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // -- Fetch --

  it("fetches Prisma llms-full.txt successfully", async () => {
    const result = await fetchDocContent(PRISMA_URL);
    assert.equal(result.ok, true, `Fetch failed: ${"error" in result ? result.error : ""}`);
    assert.ok(result.ok);

    fetchedContent = result.content;
    console.log(`  Fetched ${result.byteLength} bytes (${(result.byteLength / 1024 / 1024).toFixed(1)} MB)`);

    // Prisma full docs should be substantial
    assert.ok(result.byteLength > 1_000_000, `Expected > 1MB, got ${result.byteLength}`);
  });

  // -- Chunking --

  it("chunks the markdown into reasonable pieces", () => {
    const chunks = chunkMarkdown(fetchedContent, "prisma");
    console.log(`  Produced ${chunks.length} chunks`);

    assert.ok(chunks.length > 100, `Expected >100 chunks, got ${chunks.length}`);

    // Every chunk should have the library field set
    for (const c of chunks) {
      assert.equal(c.library, "prisma");
    }

    // Chunks should not be empty
    for (const c of chunks) {
      assert.ok(c.text.trim().length > 0, "Found empty chunk");
    }

    // headingPath should be valid JSON arrays
    for (const c of chunks) {
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

    // Every chunk should have a 384-dim vector
    for (const c of chunks) {
      assert.equal(c.vector.length, 384, `Expected 384-dim vector, got ${c.vector.length}`);
    }

    const result = await store.addLibrary("prisma", "6.0.0", PRISMA_URL, chunks);
    console.log(`  Stored: ${result.chunkCount} chunks, index size: ${result.indexSize}`);

    assert.equal(result.chunkCount, chunks.length);
    assert.equal(result.indexSize, chunks.length);
  });

  // -- Search --

  it("finds relevant results for 'prisma client query'", async () => {
    const results = await searchDocs("prisma client query", store, {
      library: "prisma",
      topK: 5,
    });

    console.log(`  Top result: score=${results[0]?.score}, heading=${results[0]?.headingPath.join(" > ")}`);

    assert.ok(results.length > 0, "Expected at least 1 result");
    assert.ok(results.length <= 5);

    // Top result should mention "Prisma Client" or "query" somewhere
    const topContent = results[0].content.toLowerCase();
    assert.ok(
      topContent.includes("prisma") || topContent.includes("client") || topContent.includes("query"),
      "Top result doesn't seem relevant to 'prisma client query'"
    );
  });

  it("finds relevant results for 'database migration'", async () => {
    const results = await searchDocs("database migration", store, {
      library: "prisma",
      topK: 5,
    });

    console.log(`  Top result: score=${results[0]?.score}, heading=${results[0]?.headingPath.join(" > ")}`);

    assert.ok(results.length > 0);

    const topContent = results[0].content.toLowerCase();
    assert.ok(
      topContent.includes("migrat") || topContent.includes("schema") || topContent.includes("database"),
      "Top result doesn't seem relevant to 'database migration'"
    );
  });

  it("finds relevant results for 'prisma schema relations'", async () => {
    const results = await searchDocs("prisma schema relations", store, {
      library: "prisma",
      topK: 5,
    });

    console.log(`  Top result: score=${results[0]?.score}, heading=${results[0]?.headingPath.join(" > ")}`);

    assert.ok(results.length > 0);

    const topContent = results[0].content.toLowerCase();
    assert.ok(
      topContent.includes("relation") || topContent.includes("schema") || topContent.includes("model"),
      "Top result doesn't seem relevant to 'prisma schema relations'"
    );
  });

  it("returns scores in descending order", async () => {
    const results = await searchDocs("CRUD operations", store, {
      library: "prisma",
      topK: 10,
    });

    assert.ok(results.length > 1);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `Results not sorted: score[${i - 1}]=${results[i - 1].score} < score[${i}]=${results[i].score}`
      );
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

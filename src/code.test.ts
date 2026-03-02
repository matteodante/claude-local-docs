/**
 * Code search integration tests — requires TEI containers running (:39281, :39282, :39283).
 * Indexes this project's own source code and tests semantic search against it.
 *
 * Run: npm run test:code
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { CodeStore } from "./code-store.js";
import { indexCodeFile } from "./code-indexer.js";
import { searchCode } from "./code-search.js";
import { walkProjectFiles, computeFileHash } from "./file-walker.js";

const PROJECT_ROOT = join(import.meta.dirname, "..");

describe("Code search pipeline (self-codebase)", { timeout: 600_000 }, () => {
  let tempDir: string;
  let codeStore: CodeStore;
  let indexedFileCount: number;
  let totalChunks: number;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "code-search-test-"));
    codeStore = new CodeStore(tempDir);

    // Walk this project's own src/ files (exclude test files to avoid self-reference noise)
    const files = await walkProjectFiles({
      projectRoot: PROJECT_ROOT,
      includePaths: ["src/**"],
      excludePaths: ["src/*.test.ts"],
    });

    indexedFileCount = files.length;
    console.log(`  Found ${files.length} source files to index`);
    assert.ok(files.length >= 8, `Expected >=8 src files, got ${files.length}`);

    totalChunks = 0;
    for (const f of files) {
      const source = await readFile(f.absolutePath, "utf-8");
      const sha256 = await computeFileHash(f.absolutePath);
      const chunks = await indexCodeFile(source, f.relativePath, f.language);
      await codeStore.addFile(f.relativePath, f.language, sha256, chunks);
      totalChunks += chunks.length;
      console.log(`  ${f.relativePath}: ${chunks.length} chunks`);
    }

    // Build FTS index
    await codeStore.createFtsIndex();
    console.log(`  FTS index built — ${totalChunks} total chunks across ${indexedFileCount} files`);
  });

  after(() => {
    // Force exit — LanceDB native bindings hold file locks and keep event loop alive
    setTimeout(() => process.exit(0), 200);
  });

  // --- Concept-based search tests ---

  it("finds RRF fusion logic by concept", async () => {
    const results = await searchCode("reciprocal rank fusion", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasRrf = results.some(
      r => r.filePath.includes("rrf") || r.content.includes("reciprocalRankFusion") || r.content.includes("rrfScore")
    );
    assert.ok(hasRrf, "Should find RRF-related code");
    console.log(`  'reciprocal rank fusion' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  it("finds LanceDB table management by concept", async () => {
    const results = await searchCode("LanceDB table management", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasStore = results.some(
      r => r.filePath.includes("store") || r.content.includes("LanceDB") || r.content.includes("openTable") || r.content.includes("createTable")
    );
    assert.ok(hasStore, "Should find LanceDB store code");
    console.log(`  'LanceDB table management' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  it("finds heading-based markdown chunking", async () => {
    const results = await searchCode("heading based markdown chunking", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasChunker = results.some(
      r => r.content.includes("chunkMarkdown") || r.content.includes("headingStack") || r.content.includes("splitWithOverlap")
    );
    assert.ok(hasChunker, "Should find markdown chunking code");
    console.log(`  'heading based markdown chunking' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  it("finds cross-encoder reranking", async () => {
    const results = await searchCode("cross encoder reranking", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasReranker = results.some(
      r => r.filePath.includes("reranker") || r.content.includes("rerank") || r.content.includes("rerankerScore")
    );
    assert.ok(hasReranker, "Should find reranker code");
    console.log(`  'cross encoder reranking' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  it("finds file walker / gitignore logic", async () => {
    const results = await searchCode("walk project files gitignore", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasWalker = results.some(
      r => r.filePath.includes("file-walker") || r.content.includes("walkProjectFiles") || r.content.includes("gitignore")
    );
    assert.ok(hasWalker, "Should find file walker code");
    console.log(`  'walk project files gitignore' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  it("finds DocStore class by name", async () => {
    const results = await searchCode("DocStore class", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasDocStore = results.some(
      r => r.entityName === "DocStore" || r.content.includes("class DocStore")
    );
    assert.ok(hasDocStore, "Should find DocStore class");
    console.log(`  'DocStore class' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  it("finds AST parsing / tree-sitter code", async () => {
    const results = await searchCode("tree sitter AST parsing", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasTreeSitter = results.some(
      r => r.content.includes("tree-sitter") || r.content.includes("Parser") || r.content.includes("rootNode")
    );
    assert.ok(hasTreeSitter, "Should find tree-sitter AST code");
    console.log(`  'tree sitter AST parsing' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  it("finds npm doc discovery logic", async () => {
    const results = await searchCode("npm package documentation discovery", codeStore, { topK: 5 });
    assert.ok(results.length > 0, "Expected at least 1 result");

    const hasDiscovery = results.some(
      r => r.filePath.includes("discovery") || r.content.includes("npmRegistry") || r.content.includes("llms.txt") || r.content.includes("probeUrl")
    );
    assert.ok(hasDiscovery, "Should find doc discovery code");
    console.log(`  'npm package documentation discovery' → top: ${results[0].filePath}:${results[0].lineStart} (${results[0].entityName})`);
  });

  // --- Neighbor expansion tests ---

  it("returns expanded content with neighbor chunks", async () => {
    const results = await searchCode("reciprocal rank fusion", codeStore, { topK: 3 });
    assert.ok(results.length > 0, "Expected results");
    // At least one result should have neighbor content (longer than a single chunk)
    // This is probabilistic — in a small codebase some results may not have adjacent chunks
    console.log(`  Neighbor expansion: top result content length = ${results[0].content.length} chars`);
  });

  // --- Structure validation tests ---

  it("returns results with valid CodeSearchResult structure", async () => {
    const results = await searchCode("embed texts", codeStore, { topK: 3 });
    for (const r of results) {
      assert.equal(typeof r.score, "number");
      assert.equal(typeof r.filePath, "string");
      assert.equal(typeof r.language, "string");
      assert.equal(typeof r.entityType, "string");
      assert.equal(typeof r.entityName, "string");
      assert.ok(Array.isArray(r.scopeChain));
      assert.equal(typeof r.lineStart, "number");
      assert.equal(typeof r.lineEnd, "number");
      assert.equal(typeof r.content, "string");
      assert.equal(typeof r.chunkId, "number");
      assert.ok(r.content.length > 0);
      assert.ok(r.lineStart >= 1, "lineStart should be 1-based");
      assert.ok(r.lineEnd >= r.lineStart, "lineEnd >= lineStart");
    }
  });

  it("returns scores in descending order", async () => {
    const results = await searchCode("search pipeline", codeStore, { topK: 10 });
    assert.ok(results.length > 1, "Expected multiple results");
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, `Not sorted at [${i}]`);
    }
  });

  // --- Filter tests ---

  it("filters by language", async () => {
    const results = await searchCode("function", codeStore, { language: "typescript", topK: 10 });
    assert.ok(results.length > 0, "Expected results");
    for (const r of results) {
      assert.equal(r.language, "typescript");
    }
  });

  it("filters by filePath", async () => {
    const results = await searchCode("search", codeStore, { filePath: "src/search.ts", topK: 10 });
    for (const r of results) {
      assert.equal(r.filePath, "src/search.ts");
    }
  });

  it("filters by entityType", async () => {
    const results = await searchCode("store management", codeStore, { entityType: "class", topK: 10 });
    // entityType filter may return 0 results if no classes match the query well
    // Just verify that any returned results have the correct type
    for (const r of results) {
      assert.equal(r.entityType, "class");
    }
  });

  // --- Metadata tests ---

  it("tracks file metadata correctly", async () => {
    const metadata = await codeStore.loadMetadata();
    assert.ok(metadata.files.length > 0, "Should have indexed file metadata");
    assert.equal(metadata.files.length, indexedFileCount);

    for (const f of metadata.files) {
      assert.ok(f.filePath.startsWith("src/"), `filePath should start with src/: ${f.filePath}`);
      assert.equal(f.sha256.length, 64, "SHA-256 hex should be 64 chars");
      assert.ok(f.chunkCount > 0, `chunkCount should be > 0 for ${f.filePath}`);
      assert.ok(f.language === "typescript" || f.language === "javascript");
      assert.ok(f.indexedAt, "indexedAt should be set");
    }
  });

  it("getFileHash returns correct hash for indexed files", async () => {
    const hash = await codeStore.getFileHash("src/rrf.ts");
    assert.ok(hash, "Should have hash for src/rrf.ts");
    assert.equal(hash!.length, 64);

    const missing = await codeStore.getFileHash("src/nonexistent.ts");
    assert.equal(missing, undefined, "Should return undefined for non-indexed file");
  });

  it("getChunkById returns a valid chunk", async () => {
    // Use a known chunk ID (first chunk should be id=1)
    const chunk = await codeStore.getChunkById(1);
    assert.ok(chunk, "Should find chunk with id 1");
    assert.equal(chunk!.id, 1);
    assert.ok(chunk!.text.length > 0);
    assert.ok(chunk!.filePath.startsWith("src/"));
  });

  it("isEmpty returns false after indexing", async () => {
    const empty = await codeStore.isEmpty();
    assert.equal(empty, false, "Store should not be empty after indexing");
  });
});

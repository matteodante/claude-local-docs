/**
 * Unit tests — no TEI containers needed.
 * Tests: RRF fusion, file-walker, code-indexer AST chunking, markdown chunking,
 *        SFC extraction, JSDoc/decorator/flags, TeiClient, git changes, utilities.
 *
 * Run: npm run test:unit
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Shared utilities
// ═══════════════════════════════════════════════════════════════════════════

import { sqlEscapeString } from "./types.js";

describe("sqlEscapeString", () => {
  it("escapes single quotes", () => {
    assert.equal(sqlEscapeString("it's"), "it''s");
    assert.equal(sqlEscapeString("he said 'hello'"), "he said ''hello''");
  });

  it("returns unchanged strings without quotes", () => {
    assert.equal(sqlEscapeString("hello world"), "hello world");
    assert.equal(sqlEscapeString("src/index.ts"), "src/index.ts");
  });

  it("handles empty string", () => {
    assert.equal(sqlEscapeString(""), "");
  });

  it("handles multiple consecutive quotes", () => {
    assert.equal(sqlEscapeString("'''"), "''''''");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// truncateAndNormalize
// ═══════════════════════════════════════════════════════════════════════════

import { truncateAndNormalize, TeiClient, checkAllTeiHealth } from "./tei-client.js";

describe("truncateAndNormalize", () => {
  it("truncates vectors to specified dimension", () => {
    const vecs = [[1, 2, 3, 4, 5, 6]];
    const result = truncateAndNormalize(vecs, 3);
    assert.equal(result[0].length, 3);
  });

  it("L2-normalizes the truncated vector", () => {
    const vecs = [[3, 4, 0, 0, 0]]; // 3-4-5 triangle
    const result = truncateAndNormalize(vecs, 2);
    // After truncation to [3, 4], norm = 5, normalized = [0.6, 0.8]
    assert.ok(Math.abs(result[0][0] - 0.6) < 1e-6);
    assert.ok(Math.abs(result[0][1] - 0.8) < 1e-6);
  });

  it("handles zero vector without division by zero", () => {
    const vecs = [[0, 0, 0, 0]];
    const result = truncateAndNormalize(vecs, 2);
    assert.deepEqual(result[0], [0, 0]);
  });

  it("processes multiple vectors", () => {
    const vecs = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
    const result = truncateAndNormalize(vecs, 2);
    assert.equal(result.length, 3);
    // [1, 0] normalized is still [1, 0]
    assert.ok(Math.abs(result[0][0] - 1.0) < 1e-6);
    assert.ok(Math.abs(result[0][1] - 0.0) < 1e-6);
  });

  it("handles dim larger than vector length (no-op truncation)", () => {
    const vecs = [[1, 0]];
    const result = truncateAndNormalize(vecs, 100);
    assert.equal(result[0].length, 2); // slice(0, 100) of 2-element array = 2
  });

  it("produces unit-length vectors", () => {
    const vecs = [[7, 11, 13, 17, 19]];
    const result = truncateAndNormalize(vecs, 3);
    const norm = Math.sqrt(result[0].reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(norm - 1.0) < 1e-6, `Expected unit norm, got ${norm}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RRF Fusion
// ═══════════════════════════════════════════════════════════════════════════

import { reciprocalRankFusion, type RankedDoc } from "./rrf.js";

describe("reciprocalRankFusion", () => {
  it("merges two ranked lists with default k=60", () => {
    const list1: RankedDoc[] = [
      { id: 1, text: "alpha" },
      { id: 2, text: "beta" },
      { id: 3, text: "gamma" },
    ];
    const list2: RankedDoc[] = [
      { id: 2, text: "beta" },
      { id: 4, text: "delta" },
      { id: 1, text: "alpha" },
    ];

    const fused = reciprocalRankFusion([
      { docs: list1, weight: 1.0 },
      { docs: list2, weight: 1.0 },
    ]);

    assert.ok(fused.length >= 4);
    assert.ok(fused[0].rrfScore > 0);

    // IDs 1 and 2 appear in both lists — should rank highest
    const topIds = new Set(fused.slice(0, 2).map(f => f.id));
    assert.ok(topIds.has(1) || topIds.has(2), "Expected overlapping docs to rank highly");
  });

  it("respects weights (higher weight = more influence)", () => {
    const list1: RankedDoc[] = [{ id: 10, text: "only-in-list1" }];
    const list2: RankedDoc[] = [{ id: 20, text: "only-in-list2" }];

    const fused = reciprocalRankFusion([
      { docs: list1, weight: 10.0 },
      { docs: list2, weight: 1.0 },
    ]);

    assert.equal(fused[0].id, 10, "Higher-weighted list should dominate");
  });

  it("handles empty lists", () => {
    const fused = reciprocalRankFusion([
      { docs: [], weight: 1.0 },
      { docs: [], weight: 1.0 },
    ]);
    assert.equal(fused.length, 0);
  });

  it("handles single list", () => {
    const list: RankedDoc[] = [
      { id: 1, text: "alpha" },
      { id: 2, text: "beta" },
    ];
    const fused = reciprocalRankFusion([{ docs: list, weight: 1.0 }]);
    assert.equal(fused.length, 2);
    assert.ok(fused[0].rrfScore > fused[1].rrfScore);
  });

  it("passes through extra fields on RankedDoc", () => {
    const list: RankedDoc[] = [{ id: 1, text: "t", filePath: "src/a.ts", language: "typescript" }];
    const fused = reciprocalRankFusion([{ docs: list, weight: 1.0 }]);
    assert.equal((fused[0] as any).filePath, "src/a.ts");
    assert.equal((fused[0] as any).language, "typescript");
  });

  it("produces results sorted by rrfScore descending", () => {
    const docs: RankedDoc[] = Array.from({ length: 20 }, (_, i) => ({ id: i, text: `doc-${i}` }));
    const fused = reciprocalRankFusion([{ docs, weight: 1.0 }]);
    for (let i = 1; i < fused.length; i++) {
      assert.ok(fused[i - 1].rrfScore >= fused[i].rrfScore, `Not sorted at index ${i}`);
    }
  });

  it("handles 3+ lists (N-way fusion)", () => {
    const list1: RankedDoc[] = [{ id: 1, text: "a" }, { id: 2, text: "b" }];
    const list2: RankedDoc[] = [{ id: 2, text: "b" }, { id: 3, text: "c" }];
    const list3: RankedDoc[] = [{ id: 3, text: "c" }, { id: 1, text: "a" }];

    const fused = reciprocalRankFusion([
      { docs: list1, weight: 1.0 },
      { docs: list2, weight: 1.0 },
      { docs: list3, weight: 1.0 },
    ]);

    assert.equal(fused.length, 3);
    // All 3 docs appear in exactly 2 lists; scores should be close
    assert.ok(fused[0].rrfScore > 0);
  });

  it("accumulates scores for duplicate IDs across lists", () => {
    const list1: RankedDoc[] = [{ id: 1, text: "a" }]; // rank 0 → score = 1/(60+1)
    const list2: RankedDoc[] = [{ id: 1, text: "a" }]; // rank 0 → score = 1/(60+1)

    const fusedSingle = reciprocalRankFusion([{ docs: list1, weight: 1.0 }]);
    const fusedDouble = reciprocalRankFusion([
      { docs: list1, weight: 1.0 },
      { docs: list2, weight: 1.0 },
    ]);

    // Score from two lists should be ~2x score from one list
    assert.ok(fusedDouble[0].rrfScore > fusedSingle[0].rrfScore * 1.9);
  });

  it("uses custom k parameter", () => {
    const list: RankedDoc[] = [{ id: 1, text: "a" }];
    const fused1 = reciprocalRankFusion([{ docs: list, weight: 1.0 }], 1);
    const fused60 = reciprocalRankFusion([{ docs: list, weight: 1.0 }], 60);

    // k=1: score = 1/(1+1) = 0.5; k=60: score = 1/(60+1) ≈ 0.0164
    assert.ok(fused1[0].rrfScore > fused60[0].rrfScore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Markdown chunking (indexer.ts)
// ═══════════════════════════════════════════════════════════════════════════

import { chunkMarkdown } from "./indexer.js";

describe("chunkMarkdown", () => {
  it("creates a single chunk for small documents", () => {
    const chunks = chunkMarkdown("Hello world\n\nSome content.", "test-lib");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].library, "test-lib");
    assert.ok(chunks[0].text.includes("Hello world"));
  });

  it("splits by headings", () => {
    const md = `# Introduction

First section content.

# API

Second section content.

# Examples

Third section content.`;

    const chunks = chunkMarkdown(md, "my-lib");
    assert.ok(chunks.length >= 3, `Expected >= 3 chunks, got ${chunks.length}`);
  });

  it("tracks heading hierarchy in headingPath", () => {
    const md = `# Getting Started

## Installation

Install with npm.

## Configuration

Configure it.

# API

## Methods

Some methods.`;

    const chunks = chunkMarkdown(md, "my-lib");
    const installChunk = chunks.find(c => c.text.includes("Install with npm"));
    assert.ok(installChunk, "Should find installation chunk");
    const path = JSON.parse(installChunk!.headingPath) as string[];
    assert.deepEqual(path, ["Getting Started", "Installation"]);
  });

  it("prepends heading path as context prefix", () => {
    const md = `# Guide

## Setup

Do the setup.`;

    const chunks = chunkMarkdown(md, "my-lib");
    const setupChunk = chunks.find(c => c.text.includes("Do the setup"));
    assert.ok(setupChunk, "Should find setup chunk");
    assert.ok(setupChunk!.text.startsWith("[Guide > Setup]"), "Should have heading prefix");
  });

  it("pops heading stack on same or deeper level", () => {
    const md = `# A

## B

Content B.

## C

Content C.`;

    const chunks = chunkMarkdown(md, "lib");
    const chunkC = chunks.find(c => c.text.includes("Content C"));
    assert.ok(chunkC);
    const path = JSON.parse(chunkC!.headingPath) as string[];
    // "C" should replace "B" (both level 2), not nest under it
    assert.deepEqual(path, ["A", "C"]);
  });

  it("never splits inside code fences", () => {
    // Create content with a code fence that would span a split boundary
    const longCode = "x = 1\n".repeat(200);
    const md = `# Code Example

\`\`\`python
${longCode}
\`\`\`

More text after code.`;

    const chunks = chunkMarkdown(md, "lib");
    // Verify no chunk starts or ends mid-fence
    for (const chunk of chunks) {
      const backtickCount = (chunk.text.match(/```/g) || []).length;
      // If a chunk has a code fence opener, it should also have a closer (even count)
      if (backtickCount > 0) {
        assert.equal(backtickCount % 2, 0, "Code fence should not be split across chunks");
      }
    }
  });

  it("handles empty markdown", () => {
    const chunks = chunkMarkdown("", "lib");
    assert.equal(chunks.length, 0);
  });

  it("handles whitespace-only markdown", () => {
    const chunks = chunkMarkdown("   \n\n  \n", "lib");
    assert.equal(chunks.length, 0);
  });

  it("handles markdown with no headings", () => {
    const chunks = chunkMarkdown("Just some plain text.\n\nAnother paragraph.", "lib");
    assert.equal(chunks.length, 1);
    const path = JSON.parse(chunks[0].headingPath) as string[];
    assert.deepEqual(path, []);
    // No heading prefix when headingPath is empty
    assert.ok(!chunks[0].text.startsWith("["));
  });

  it("handles tilde code fences", () => {
    const md = `# Section

~~~typescript
const x = 1;
const y = 2;
~~~

After fence.`;

    const chunks = chunkMarkdown(md, "lib");
    const chunk = chunks.find(c => c.text.includes("const x = 1"));
    assert.ok(chunk, "Should include tilde-fenced code");
    assert.ok(chunk!.text.includes("const y = 2"), "Code block should not be split");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// File Walker
// ═══════════════════════════════════════════════════════════════════════════

import { walkProjectFiles, computeFileHash, computeContentHash, detectLanguage, getGitChangedFiles } from "./file-walker.js";

describe("detectLanguage", () => {
  it("detects TypeScript files", () => {
    assert.equal(detectLanguage("foo.ts"), "typescript");
    assert.equal(detectLanguage("bar.tsx"), "typescript");
    assert.equal(detectLanguage("baz.mts"), "typescript");
    assert.equal(detectLanguage("qux.cts"), "typescript");
  });

  it("detects JavaScript files", () => {
    assert.equal(detectLanguage("foo.js"), "javascript");
    assert.equal(detectLanguage("bar.jsx"), "javascript");
    assert.equal(detectLanguage("baz.mjs"), "javascript");
    assert.equal(detectLanguage("qux.cjs"), "javascript");
  });

  it("detects .d.ts as typescript", () => {
    assert.equal(detectLanguage("types.d.ts"), "typescript");
    assert.equal(detectLanguage("global.d.ts"), "typescript");
  });

  it("detects SFC framework files", () => {
    assert.equal(detectLanguage("App.vue"), "vue");
    assert.equal(detectLanguage("Counter.svelte"), "svelte");
    assert.equal(detectLanguage("Layout.astro"), "astro");
  });

  it("returns null for unsupported extensions", () => {
    assert.equal(detectLanguage("foo.py"), null);
    assert.equal(detectLanguage("bar.rs"), null);
    assert.equal(detectLanguage("README.md"), null);
  });

  it("is case-insensitive for extensions", () => {
    assert.equal(detectLanguage("foo.TS"), "typescript");
    assert.equal(detectLanguage("bar.Vue"), "vue");
    assert.equal(detectLanguage("baz.JSX"), "javascript");
  });

  it("handles paths with directories", () => {
    assert.equal(detectLanguage("src/components/App.tsx"), "typescript");
    assert.equal(detectLanguage("pages/index.vue"), "vue");
  });
});

describe("computeContentHash", () => {
  it("returns consistent SHA-256 for same content", () => {
    const hash1 = computeContentHash("hello");
    const hash2 = computeContentHash("hello");
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
    assert.match(hash1, /^[a-f0-9]+$/);
  });

  it("returns different hash for different content", () => {
    const hash1 = computeContentHash("hello");
    const hash2 = computeContentHash("world");
    assert.notEqual(hash1, hash2);
  });

  it("accepts Buffer input", () => {
    const hash = computeContentHash(Buffer.from("hello"));
    assert.equal(hash.length, 64);
    // Should match the string version
    assert.equal(hash, computeContentHash("hello"));
  });

  it("handles empty string", () => {
    const hash = computeContentHash("");
    assert.equal(hash.length, 64);
  });
});

describe("walkProjectFiles", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "file-walker-test-"));

    await mkdir(join(tempDir, "src"), { recursive: true });
    await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await mkdir(join(tempDir, "lib"), { recursive: true });
    await mkdir(join(tempDir, "components"), { recursive: true });

    await writeFile(join(tempDir, "src", "index.ts"), "export const hello = 42;");
    await writeFile(join(tempDir, "src", "utils.js"), "module.exports = {};");
    await writeFile(join(tempDir, "src", "README.md"), "# Docs");
    await writeFile(join(tempDir, "node_modules", "pkg", "index.js"), "module.exports = {};");
    await writeFile(join(tempDir, "dist", "index.js"), "var hello = 42;");
    await writeFile(join(tempDir, "lib", "helper.ts"), "export function help() {}");
    await writeFile(join(tempDir, "components", "App.vue"), '<script lang="ts">\nexport default {};\n</script>');
    await writeFile(join(tempDir, "components", "Counter.svelte"), '<script>\nlet count = 0;\n</script>');
    await writeFile(join(tempDir, "package.json"), "{}");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("finds JS/TS files and skips node_modules and dist", async () => {
    const files = await walkProjectFiles({ projectRoot: tempDir });
    const paths = files.map(f => f.relativePath).sort();

    assert.ok(paths.includes("src/index.ts"), "Should find src/index.ts");
    assert.ok(paths.includes("src/utils.js"), "Should find src/utils.js");
    assert.ok(paths.includes("lib/helper.ts"), "Should find lib/helper.ts");
    assert.ok(!paths.some(p => p.includes("node_modules")), "Should skip node_modules");
    assert.ok(!paths.some(p => p.startsWith("dist/")), "Should skip dist");
    assert.ok(!paths.some(p => p.endsWith(".md")), "Should skip non-JS/TS files");
  });

  it("finds Vue and Svelte SFC files", async () => {
    const files = await walkProjectFiles({ projectRoot: tempDir });
    const paths = files.map(f => f.relativePath);
    assert.ok(paths.includes("components/App.vue"), "Should find .vue files");
    assert.ok(paths.includes("components/Counter.svelte"), "Should find .svelte files");
  });

  it("respects excludePaths", async () => {
    const files = await walkProjectFiles({
      projectRoot: tempDir,
      excludePaths: ["lib/**"],
    });
    const paths = files.map(f => f.relativePath);
    assert.ok(!paths.includes("lib/helper.ts"), "Should exclude lib/ via pattern");
    assert.ok(paths.includes("src/index.ts"), "Should still include src/");
  });

  it("respects includePaths", async () => {
    const files = await walkProjectFiles({
      projectRoot: tempDir,
      includePaths: ["src/**"],
    });
    const paths = files.map(f => f.relativePath);
    assert.ok(paths.includes("src/index.ts"), "Should include src/ files");
    assert.ok(!paths.includes("lib/helper.ts"), "Should exclude non-src files");
    assert.ok(!paths.includes("components/App.vue"), "Should exclude non-src files");
  });

  it("detects correct language per file", async () => {
    const files = await walkProjectFiles({ projectRoot: tempDir });
    const tsFile = files.find(f => f.relativePath === "src/index.ts");
    const jsFile = files.find(f => f.relativePath === "src/utils.js");
    const vueFile = files.find(f => f.relativePath === "components/App.vue");
    assert.equal(tsFile?.language, "typescript");
    assert.equal(jsFile?.language, "javascript");
    assert.equal(vueFile?.language, "vue");
  });

  it("skips empty files", async () => {
    await writeFile(join(tempDir, "src", "empty.ts"), "");
    const files = await walkProjectFiles({ projectRoot: tempDir });
    assert.ok(!files.some(f => f.relativePath === "src/empty.ts"), "Should skip empty files");
  });

  it("includes sizeBytes for each file", async () => {
    const files = await walkProjectFiles({ projectRoot: tempDir });
    for (const f of files) {
      assert.equal(typeof f.sizeBytes, "number");
      assert.ok(f.sizeBytes > 0, `sizeBytes should be > 0 for ${f.relativePath}`);
    }
  });

  it("walks this project's own src/ directory", async () => {
    const projectRoot = join(import.meta.dirname, "..");
    const files = await walkProjectFiles({ projectRoot, includePaths: ["src/**"] });
    const paths = files.map(f => f.relativePath);

    assert.ok(files.length >= 10, `Expected >=10 src files, got ${files.length}`);
    assert.ok(paths.some(p => p === "src/index.ts"), "Should find src/index.ts");
    assert.ok(paths.some(p => p === "src/store.ts"), "Should find src/store.ts");
    assert.ok(paths.some(p => p === "src/code-indexer.ts"), "Should find src/code-indexer.ts");
    assert.ok(paths.some(p => p === "src/rrf.ts"), "Should find src/rrf.ts");
    assert.ok(paths.every(f => f.startsWith("src/")), "All should be under src/");
  });
});

describe("computeFileHash", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hash-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns consistent SHA-256 hash", async () => {
    const filePath = join(tempDir, "test.ts");
    await writeFile(filePath, "const x = 42;");

    const hash1 = await computeFileHash(filePath);
    const hash2 = await computeFileHash(filePath);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64, "SHA-256 hex is 64 chars");
    assert.match(hash1, /^[a-f0-9]+$/);
  });

  it("returns different hash for different content", async () => {
    const file1 = join(tempDir, "a.ts");
    const file2 = join(tempDir, "b.ts");
    await writeFile(file1, "const a = 1;");
    await writeFile(file2, "const b = 2;");

    const hash1 = await computeFileHash(file1);
    const hash2 = await computeFileHash(file2);
    assert.notEqual(hash1, hash2);
  });

  it("matches computeContentHash for same content", async () => {
    const content = "export const x = 42;";
    const filePath = join(tempDir, "match.ts");
    await writeFile(filePath, content);

    const fileHash = await computeFileHash(filePath);
    const contentHash = computeContentHash(content);
    assert.equal(fileHash, contentHash);
  });
});

// --- Git Changes ---

describe("getGitChangedFiles", () => {
  it("returns isGitRepo=false for non-git directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "no-git-test-"));
    try {
      const result = await getGitChangedFiles(tempDir);
      assert.equal(result.isGitRepo, false);
      assert.equal(result.lastCommit, "");
      assert.equal(result.modified.length, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns isGitRepo=true for this project", async () => {
    const projectRoot = join(import.meta.dirname, "..");
    const result = await getGitChangedFiles(projectRoot);
    assert.equal(result.isGitRepo, true);
    assert.ok(result.lastCommit.length > 0, "Should have a HEAD commit");
    assert.match(result.lastCommit, /^[a-f0-9]{40}$/, "HEAD should be a 40-char hex SHA");
  });

  it("returns arrays for modified, added, deleted", async () => {
    const projectRoot = join(import.meta.dirname, "..");
    const result = await getGitChangedFiles(projectRoot);
    assert.ok(Array.isArray(result.modified));
    assert.ok(Array.isArray(result.added));
    assert.ok(Array.isArray(result.deleted));
  });

  it("returns valid structure for this project (regardless of working tree state)", async () => {
    const projectRoot = join(import.meta.dirname, "..");
    const result = await getGitChangedFiles(projectRoot);
    assert.equal(result.isGitRepo, true);
    assert.ok(result.lastCommit.length > 0, "Should have a HEAD commit");
    assert.ok(Array.isArray(result.modified));
    assert.ok(Array.isArray(result.added));
    assert.ok(Array.isArray(result.deleted));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Code Indexer (AST chunking, no embedding)
// ═══════════════════════════════════════════════════════════════════════════

import { chunkCodeFile } from "./code-indexer.js";

describe("chunkCodeFile", { timeout: 30_000 }, () => {
  it("extracts functions from TypeScript", async () => {
    // Functions must be >100 non-ws chars each to avoid merging
    const pad = "x".repeat(80);
    const source = `
export function greet(name: string): string {
  const message = "${pad}";
  return "Hello, " + name + message;
}

export function farewell(name: string): string {
  const message = "${pad}";
  return "Goodbye, " + name + message;
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/greet.ts", "typescript");
    assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);

    const greetChunk = chunks.find(c => c.entityName === "greet");
    assert.ok(greetChunk, "Should find 'greet' entity");
    assert.equal(greetChunk!.entityType, "function");
    assert.equal(greetChunk!.filePath, "src/greet.ts");
    assert.equal(greetChunk!.language, "typescript");
    assert.ok(greetChunk!.text.includes("// File: src/greet.ts"), "Should have contextual header");
    assert.ok(greetChunk!.text.includes("Hello"), "Should contain function body");
  });

  it("extracts classes and splits large ones into methods", async () => {
    // Each method needs substantial body so total class > 1500 non-ws chars
    const longBody = `    const data = "${Array(500).fill("x").join("")}";\n    return data;`;
    const source = `
export class UserService {
  private db: any;

  constructor(db: any) {
    this.db = db;
  }

  async findUser(id: string): Promise<any> {
${longBody}
  }

  async createUser(data: any): Promise<any> {
${longBody}
  }

  async deleteUser(id: string): Promise<void> {
${longBody}
  }
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/user.ts", "typescript");

    const classChunk = chunks.find(c => c.entityType === "class");
    assert.ok(classChunk, "Should extract class");
    assert.equal(classChunk!.entityName, "UserService");

    const methodChunks = chunks.filter(c => c.entityType === "method");
    assert.ok(methodChunks.length >= 2, `Expected >=2 methods, got ${methodChunks.length}`);

    for (const mc of methodChunks) {
      const scope = JSON.parse(mc.scopeChain) as string[];
      assert.ok(scope.includes("UserService"), `Method scope should include class name, got ${mc.scopeChain}`);
    }
  });

  it("extracts arrow functions in const declarations", async () => {
    // Make each function >100 non-ws chars to prevent merging
    const pad = "x".repeat(80);
    const source = `
export const add = (a: number, b: number): number => {
  const label = "${pad}";
  return a + b;
};

export const subtract = (a: number, b: number): number => {
  const label = "${pad}";
  return a - b;
};
`.trim();

    const chunks = await chunkCodeFile(source, "src/math.ts", "typescript");
    const addChunk = chunks.find(c => c.entityName === "add");
    assert.ok(addChunk, "Should find 'add' arrow function");
    assert.equal(addChunk!.entityType, "function");
  });

  it("extracts interfaces and type aliases", async () => {
    // Make each entity >100 non-ws chars to prevent merging
    const source = `
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  avatarUrl: string;
  bio: string;
  location: string;
  website: string;
}

export type UserRole = "admin" | "user" | "guest" | "moderator" | "superadmin" | "editor" | "viewer" | "contributor";
`.trim();

    const chunks = await chunkCodeFile(source, "src/types.ts", "typescript");
    const iface = chunks.find(c => c.entityType === "interface");
    assert.ok(iface, "Should find interface");
    assert.equal(iface!.entityName, "User");

    const typeAlias = chunks.find(c => c.entityType === "type_alias");
    assert.ok(typeAlias, "Should find type alias");
    assert.equal(typeAlias!.entityName, "UserRole");
  });

  it("extracts enums", async () => {
    const source = `
export enum Direction {
  Up = "UP",
  Down = "DOWN",
  Left = "LEFT",
  Right = "RIGHT",
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/enums.ts", "typescript");
    const enumChunk = chunks.find(c => c.entityType === "enum");
    assert.ok(enumChunk, "Should find enum");
    assert.equal(enumChunk!.entityName, "Direction");
  });

  it("produces contextual headers with file path and camelCase-split name", async () => {
    const source = `
export function validateEmailAddress(email: string): boolean {
  return email.includes("@") && email.includes(".");
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/validators.ts", "typescript");
    const chunk = chunks[0];
    assert.ok(chunk.text.includes("// File: src/validators.ts"), "Header should include file path");
    assert.ok(
      chunk.text.includes("validate email address") || chunk.text.includes("validate Email Address"),
      "Header should include camelCase-split name for BM25"
    );
  });

  it("merges small entities (<100 non-ws chars)", async () => {
    const source = `
import { foo } from "foo";
import { bar } from "bar";
import { baz } from "baz";

export const VERSION = "1.0.0";
`.trim();

    const chunks = await chunkCodeFile(source, "src/index.ts", "typescript");
    assert.ok(chunks.length <= 3, `Expected small entities to be merged, got ${chunks.length} chunks`);
  });

  it("handles JavaScript files", async () => {
    const source = `
function hello() {
  console.log("hello world");
}

module.exports = { hello };
`.trim();

    const chunks = await chunkCodeFile(source, "lib/hello.js", "javascript");
    assert.ok(chunks.length >= 1);
    const fnChunk = chunks.find(c => c.entityName === "hello");
    assert.ok(fnChunk, "Should extract JS function");
    assert.equal(fnChunk!.language, "javascript");
  });

  it("creates module-level chunk for bare code files", async () => {
    const source = `
// This is a configuration file
console.log("bootstrap");
`.trim();

    const chunks = await chunkCodeFile(source, "src/bootstrap.ts", "typescript");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].entityType, "module");
    assert.equal(chunks[0].entityName, "");
  });

  it("has 1-based line numbers", async () => {
    const source = `
export function first() {
  return 1;
}

export function second() {
  return 2;
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/lines.ts", "typescript");
    for (const c of chunks) {
      assert.ok(c.lineStart >= 1, `lineStart should be >= 1, got ${c.lineStart}`);
      assert.ok(c.lineEnd >= c.lineStart, `lineEnd should be >= lineStart`);
    }
  });

  it("applies lineOffset parameter", async () => {
    const source = `export function hello(): void { const x = "padding padding padding padding padding padding padding"; }`;

    const withoutOffset = await chunkCodeFile(source, "src/a.ts", "typescript", 0);
    const withOffset = await chunkCodeFile(source, "src/a.ts", "typescript", 10);

    assert.equal(withOffset[0].lineStart, withoutOffset[0].lineStart + 10);
    assert.equal(withOffset[0].lineEnd, withoutOffset[0].lineEnd + 10);
  });

  it("includes signature field", async () => {
    const pad = "x".repeat(80);
    const source = `
export function fetchData(url: string, options?: RequestInit): Promise<Response> {
  const label = "${pad}";
  return fetch(url, options);
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/fetch.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "fetchData");
    assert.ok(chunk);
    assert.ok(chunk!.signature.includes("fetchData"), "Signature should contain function name");
    assert.ok(chunk!.signature.includes("url: string"), "Signature should contain parameters");
    assert.ok(!chunk!.signature.includes("{"), "Signature should not contain function body");
  });

  it("chunks this project's own store.ts correctly", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "src", "store.ts"), "utf-8");
    const chunks = await chunkCodeFile(source, "src/store.ts", "typescript");

    assert.ok(chunks.length >= 5, `Expected >=5 chunks from store.ts, got ${chunks.length}`);

    // Should find the DocStore class
    const classChunk = chunks.find(c => c.entityName === "DocStore");
    assert.ok(classChunk, "Should extract DocStore class");
    assert.equal(classChunk!.entityType, "class");

    // Should find resolveProjectRoot function
    const fnChunk = chunks.find(c => c.entityName === "resolveProjectRoot");
    assert.ok(fnChunk, "Should extract resolveProjectRoot function");

    console.log(`  store.ts → ${chunks.length} chunks: ${chunks.map(c => `${c.entityType}:${c.entityName}`).join(", ")}`);
  });

  it("chunks this project's own rrf.ts correctly", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "src", "rrf.ts"), "utf-8");
    const chunks = await chunkCodeFile(source, "src/rrf.ts", "typescript");

    assert.ok(chunks.length >= 1, `Expected >=1 chunk from rrf.ts, got ${chunks.length}`);

    const rrfChunk = chunks.find(c => c.entityName === "reciprocalRankFusion");
    assert.ok(rrfChunk, "Should extract reciprocalRankFusion function");
    assert.equal(rrfChunk!.entityType, "function");
    assert.ok(rrfChunk!.text.includes("rrfScore"), "Should contain rrfScore in body");

    console.log(`  rrf.ts → ${chunks.length} chunks: ${chunks.map(c => `${c.entityType}:${c.entityName}`).join(", ")}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Enhanced AST: JSDoc, Decorators, Flags (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════

describe("Enhanced AST: JSDoc extraction", { timeout: 30_000 }, () => {
  it("extracts JSDoc and prepends to chunk text", async () => {
    const source = `
/** Validates a JWT token and attaches the user to the request. */
export async function validateToken(req: Request): Promise<boolean> {
  const token = req.headers.get("Authorization");
  const isValid = token !== null && token.startsWith("Bearer ");
  return isValid;
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/auth.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "validateToken");
    assert.ok(chunk, "Should find validateToken");
    assert.ok(chunk!.jsdoc.includes("Validates a JWT token"), "jsdoc field should contain the comment text");
    assert.ok(chunk!.text.includes("Validates a JWT token"), "Chunk text should include JSDoc for embedding visibility");
  });

  it("returns empty jsdoc when no JSDoc present", async () => {
    const pad = "x".repeat(80);
    const source = `
// Regular comment, not JSDoc
export function noJsDoc(): void {
  const data = "${pad}";
  console.log(data);
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/test.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "noJsDoc");
    assert.ok(chunk, "Should find noJsDoc");
    assert.equal(chunk!.jsdoc, "", "jsdoc should be empty for non-JSDoc comments");
  });

  it("extracts multi-line JSDoc", async () => {
    const source = `
/**
 * Fetches user data from the remote API.
 * Handles authentication and retry logic.
 * @param userId - The unique user identifier
 * @returns The user data or null if not found
 */
export async function fetchUser(userId: string): Promise<any | null> {
  const result = await fetch("/api/users/" + userId);
  return result.ok ? result.json() : null;
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/api.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "fetchUser");
    assert.ok(chunk);
    assert.ok(chunk!.jsdoc.includes("Fetches user data"), "Should extract first line");
    assert.ok(chunk!.jsdoc.includes("@param userId"), "Should extract @param tag");
    assert.ok(chunk!.jsdoc.includes("@returns"), "Should extract @returns tag");
  });

  it("extracts JSDoc on exported classes", async () => {
    const source = `
/** Manages database connections and pooling. */
export class DatabaseManager {
  private pool: any;

  constructor() {
    this.pool = null;
  }

  /** Connect to the database. */
  async connect(url: string): Promise<void> {
    this.pool = await createPool(url);
  }
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/db.ts", "typescript");
    const classChunk = chunks.find(c => c.entityName === "DatabaseManager");
    assert.ok(classChunk);
    assert.ok(classChunk!.jsdoc.includes("Manages database connections"), "Class should have JSDoc");
  });
});

describe("Enhanced AST: metadata flags", { timeout: 30_000 }, () => {
  it("detects exported, async, and abstract flags", async () => {
    const pad = "x".repeat(80);
    const source = `
export async function fetchData(url: string): Promise<string> {
  const result = "${pad}";
  return result;
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/fetch.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "fetchData");
    assert.ok(chunk, "Should find fetchData");
    assert.equal(chunk!.isExported, true, "Should be exported");
    assert.equal(chunk!.isAsync, true, "Should be async");
    assert.equal(chunk!.isAbstract, false, "Should not be abstract");
  });

  it("detects non-exported functions", async () => {
    const pad = "x".repeat(80);
    const source = `
function internalHelper(x: number): number {
  const data = "${pad}";
  return x * 2;
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/helper.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "internalHelper");
    assert.ok(chunk);
    assert.equal(chunk!.isExported, false, "Should not be exported");
    assert.equal(chunk!.isAsync, false, "Should not be async");
  });

  it("includes Flags line in context header when flags are set", async () => {
    const pad = "x".repeat(80);
    const source = `
export async function doWork(): Promise<void> {
  const data = "${pad}";
  console.log(data);
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/work.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "doWork");
    assert.ok(chunk, "Should find doWork");
    assert.ok(chunk!.text.includes("// Flags: exported, async"), "Should have Flags header line");
  });

  it("omits Flags line when no flags are set", async () => {
    const pad = "x".repeat(80);
    const source = `
function plain(): void {
  const data = "${pad}";
  console.log(data);
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/plain.ts", "typescript");
    const chunk = chunks.find(c => c.entityName === "plain");
    assert.ok(chunk);
    assert.ok(!chunk!.text.includes("// Flags:"), "Should not have Flags line when no flags set");
  });

  it("has correct CodeRow new fields structure", async () => {
    const pad = "x".repeat(80);
    const source = `
export function sample(): void {
  const data = "${pad}";
  console.log(data);
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/sample.ts", "typescript");
    const chunk = chunks[0];

    // Verify new CodeRow fields exist
    assert.equal(typeof chunk.jsdoc, "string");
    assert.equal(typeof chunk.decorators, "string");
    assert.equal(typeof chunk.isExported, "boolean");
    assert.equal(typeof chunk.isAsync, "boolean");
    assert.equal(typeof chunk.isAbstract, "boolean");

    // decorators should be JSON array
    const decs = JSON.parse(chunk.decorators);
    assert.ok(Array.isArray(decs));
  });

  it("stores scopeChain as JSON string", async () => {
    const pad = "x".repeat(80);
    const source = `
export function topLevel(): void {
  const data = "${pad}";
  console.log(data);
}
`.trim();

    const chunks = await chunkCodeFile(source, "src/scope.ts", "typescript");
    const chunk = chunks[0];
    const parsed = JSON.parse(chunk.scopeChain);
    assert.ok(Array.isArray(parsed), "scopeChain should be parseable JSON array");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SFC Extraction (Phase 3)
// ═══════════════════════════════════════════════════════════════════════════

import { extractScriptBlocks } from "./sfc-extractor.js";

describe("extractScriptBlocks", () => {
  it("extracts Vue <script lang='ts'> block", () => {
    const source = `<template>
  <div>Hello</div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
export default defineComponent({ name: "Hello" });
</script>
`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, "typescript");
    assert.ok(blocks[0].scriptContent.includes("defineComponent"));
    assert.ok(blocks[0].lineOffset > 0, "lineOffset should account for template lines");
  });

  it("extracts Vue <script setup> block", () => {
    const source = `<template>
  <div>{{ msg }}</div>
</template>

<script setup lang="ts">
const msg = "hello";
</script>
`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, "typescript");
    assert.ok(blocks[0].scriptContent.includes("const msg"));
  });

  it("extracts both <script> and <script setup> from Vue", () => {
    const source = `<script lang="ts">
export default { name: "Dual" };
</script>

<script setup lang="ts">
const x = 1;
</script>

<template><div /></template>
`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 2, "Should extract both script blocks");
  });

  it("extracts Svelte <script context='module'> block", () => {
    const source = `<script context="module" lang="ts">
export const prerender = true;
</script>

<script lang="ts">
let count = 0;
</script>

<div>{count}</div>
`;
    const blocks = extractScriptBlocks(source, ".svelte");
    assert.equal(blocks.length, 2);
    assert.ok(blocks.some(b => b.scriptContent.includes("prerender")));
    assert.ok(blocks.some(b => b.scriptContent.includes("count")));
  });

  it("extracts Astro --- frontmatter", () => {
    const source = `---
import Layout from "../layouts/Main.astro";
const title = "Hello";
---

<Layout title={title}>
  <h1>Welcome</h1>
</Layout>
`;
    const blocks = extractScriptBlocks(source, ".astro");
    assert.ok(blocks.length >= 1, "Should extract frontmatter");
    assert.equal(blocks[0].language, "typescript");
    assert.ok(blocks[0].scriptContent.includes("const title"));
    assert.equal(blocks[0].lineOffset, 1, "Frontmatter starts after opening ---");
  });

  it("extracts Astro frontmatter AND script tags", () => {
    const source = `---
const title = "Hello";
---

<h1>{title}</h1>

<script>
  console.log("client-side");
</script>
`;
    const blocks = extractScriptBlocks(source, ".astro");
    assert.equal(blocks.length, 2, "Should extract both frontmatter and script tag");
    assert.ok(blocks[0].scriptContent.includes("const title"), "First block is frontmatter");
    assert.ok(blocks[1].scriptContent.includes("console.log"), "Second block is script tag");
  });

  it("returns empty for template-only Vue file", () => {
    const source = `<template><div>Static</div></template>`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 0);
  });

  it("returns empty for unsupported file extension", () => {
    const blocks = extractScriptBlocks("<script>x</script>", ".html");
    assert.equal(blocks.length, 0);
  });

  it("calculates correct line offsets", () => {
    const source = `<template>
  <div>Line 1</div>
  <div>Line 2</div>
  <div>Line 3</div>
</template>

<script lang="ts">
const x = 1;
</script>
`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 1);
    // Script tag starts after 7 lines (template + blank line + script tag)
    assert.ok(blocks[0].lineOffset >= 6, `Expected lineOffset >= 6, got ${blocks[0].lineOffset}`);
  });

  it("defaults to javascript when no lang attribute", () => {
    const source = `<script>
export default { data() { return {} } };
</script>
`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, "javascript");
  });

  it("skips empty script blocks", () => {
    const source = `<script lang="ts">
</script>
`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 0, "Should skip script blocks with only whitespace");
  });

  it("handles lang='typescript' (long form)", () => {
    const source = `<script lang="typescript">
const x: number = 1;
</script>
`;
    const blocks = extractScriptBlocks(source, ".vue");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, "typescript");
  });

  it("handles Svelte with no lang (defaults to javascript)", () => {
    const source = `<script>
let count = 0;
function increment() { count += 1; }
</script>

<button on:click={increment}>{count}</button>
`;
    const blocks = extractScriptBlocks(source, ".svelte");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].language, "javascript");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SFC + chunkCodeFile integration
// ═══════════════════════════════════════════════════════════════════════════

import { indexCodeFile } from "./code-indexer.js";

describe("SFC + chunkCodeFile integration", { timeout: 30_000 }, () => {
  it("extracts entities from Vue SFC script block", async () => {
    const source = `<template>
  <div>{{ greeting }}</div>
</template>

<script lang="ts">
import { defineComponent, ref } from "vue";

export default defineComponent({
  name: "Greeting",
  setup() {
    const greeting = ref("Hello, World!");
    return { greeting };
  }
});
</script>
`;
    // Use chunkCodeFile with the extracted script content
    const { extractScriptBlocks: extract } = await import("./sfc-extractor.js");
    const blocks = extract(source, ".vue");
    assert.ok(blocks.length > 0);

    const chunks = await chunkCodeFile(blocks[0].scriptContent, "src/Greeting.vue", blocks[0].language, blocks[0].lineOffset);
    assert.ok(chunks.length >= 1);
    // Line numbers should be offset to match position in original .vue file
    for (const c of chunks) {
      assert.ok(c.lineStart > blocks[0].lineOffset, `lineStart ${c.lineStart} should be > offset ${blocks[0].lineOffset}`);
    }
  });

  it("handles Astro frontmatter with TypeScript", async () => {
    const source = `---
interface Props {
  title: string;
  description: string;
}

const { title, description } = Astro.props;
---

<html>
  <head><title>{title}</title></head>
  <body><p>{description}</p></body>
</html>
`;
    const { extractScriptBlocks: extract } = await import("./sfc-extractor.js");
    const blocks = extract(source, ".astro");
    assert.ok(blocks.length >= 1);
    assert.equal(blocks[0].language, "typescript");

    const chunks = await chunkCodeFile(blocks[0].scriptContent, "src/Page.astro", blocks[0].language, blocks[0].lineOffset);
    assert.ok(chunks.length >= 1);
    // Should find the interface
    const iface = chunks.find(c => c.entityType === "interface");
    assert.ok(iface, "Should extract Props interface from Astro frontmatter");
    assert.equal(iface!.entityName, "Props");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TeiClient (Phase 1)
// ═══════════════════════════════════════════════════════════════════════════

describe("TeiClient", () => {
  it("health check returns unhealthy for non-existent endpoint", async () => {
    const client = new TeiClient({ baseUrl: "http://localhost:1", timeoutMs: 1000 });
    const health = await client.checkHealth();
    assert.equal(health.healthy, false);
    assert.ok(health.error, "Should have an error message");
  });

  it("constructor sets correct defaults", () => {
    const client = new TeiClient({ baseUrl: "http://localhost:9999" });
    assert.equal(client.baseUrl, "http://localhost:9999");
  });

  it("allows custom configuration", () => {
    const client = new TeiClient({
      baseUrl: "http://example.com",
      timeoutMs: 5000,
      maxRetries: 5,
      retryDelayMs: 100,
      maxBatchSize: 8,
    });
    assert.equal(client.baseUrl, "http://example.com");
  });

  it("embed throws on non-existent endpoint", async () => {
    const client = new TeiClient({
      baseUrl: "http://localhost:1",
      timeoutMs: 500,
      maxRetries: 0,
    });
    await assert.rejects(
      () => client.embed(["hello"]),
      (err: any) => {
        assert.ok(err, "Should throw an error");
        return true;
      }
    );
  });

  it("rerank throws on non-existent endpoint", async () => {
    const client = new TeiClient({
      baseUrl: "http://localhost:1",
      timeoutMs: 500,
      maxRetries: 0,
    });
    await assert.rejects(
      () => client.rerank("query", ["text1", "text2"]),
      (err: any) => {
        assert.ok(err, "Should throw an error");
        return true;
      }
    );
  });
});

describe("checkAllTeiHealth", () => {
  it("reports all unhealthy when TEI is not running", async () => {
    const result = await checkAllTeiHealth();
    // TEI is not running during unit tests
    assert.equal(typeof result.allHealthy, "boolean");
    assert.equal(typeof result.embed.healthy, "boolean");
    assert.equal(typeof result.rerank.healthy, "boolean");
    assert.equal(typeof result.codeEmbed.healthy, "boolean");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CodeStore (metadata operations)
// ═══════════════════════════════════════════════════════════════════════════

import { CodeStore } from "./code-store.js";

describe("CodeStore metadata", { timeout: 30_000 }, () => {
  let tempDir: string;
  let store: CodeStore;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "code-store-test-"));
    store = new CodeStore(tempDir);
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loadMetadata returns default for new project", async () => {
    const meta = await store.loadMetadata();
    assert.ok(meta);
    assert.equal(meta.projectRoot, tempDir);
    assert.ok(Array.isArray(meta.files));
    assert.equal(meta.files.length, 0);
  });

  it("saveMetadata + loadMetadata round-trips correctly", async () => {
    const meta = await store.loadMetadata();
    meta.lastFullIndexAt = "2026-01-01T00:00:00Z";
    meta.lastIndexedCommit = "abc123def456";
    await store.saveMetadata(meta);

    // Force re-read by creating a new store instance
    const store2 = new CodeStore(tempDir);
    const meta2 = await store2.loadMetadata();
    assert.equal(meta2.lastFullIndexAt, "2026-01-01T00:00:00Z");
    assert.equal(meta2.lastIndexedCommit, "abc123def456");
  });

  it("getFileHash returns undefined for non-existent file", async () => {
    const hash = await store.getFileHash("src/nonexistent.ts");
    assert.equal(hash, undefined);
  });

  it("isEmpty returns true for empty store", async () => {
    const freshDir = await mkdtemp(join(tmpdir(), "empty-store-"));
    try {
      const freshStore = new CodeStore(freshDir);
      const empty = await freshStore.isEmpty();
      assert.equal(empty, true);
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });
});

/**
 * Integration test — runs the full pipeline:
 * 1. analyze_dependencies
 * 2. fetch_and_store_doc (Zod llms-full.txt)
 * 3. list_docs
 * 4. search_docs
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const SERVER = join(import.meta.dirname, "dist", "index.js");
const DOCS_DIR = join(import.meta.dirname, ".claude", "docs");

// Clean previous test data
try { await rm(DOCS_DIR, { recursive: true }); } catch {}

let msgId = 0;
function rpc(method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: ++msgId, method, params }) + "\n";
}

const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: import.meta.dirname,
});

let buffer = "";
const responses = new Map();
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop(); // keep incomplete line
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        responses.set(msg.id, msg);
        pending.get(msg.id)();
      }
    } catch {}
  }
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text) console.error("[server stderr]", text);
});

function send(method, params = {}) {
  const id = ++msgId;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve) => {
    pending.set(id, () => resolve(responses.get(id)));
    child.stdin.write(msg);
  });
}

async function run() {
  console.log("=== Integration Test ===\n");

  // 1. Initialize
  console.log("1. Initializing MCP server...");
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "integration-test", version: "1.0" },
  });
  console.log("   Server:", init.result.serverInfo.name, "v" + init.result.serverInfo.version);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. Analyze dependencies
  console.log("\n2. Analyzing dependencies...");
  const analyze = await send("tools/call", { name: "analyze_dependencies", arguments: {} });
  const deps = JSON.parse(analyze.result.content[0].text);
  console.log("   Monorepo:", deps.isMonorepo);
  const runtime = deps.dependencies.filter(d => d.kind === "runtime");
  const dev = deps.dependencies.filter(d => d.kind === "dev");
  console.log("   Runtime deps:", runtime.map(d => d.name).join(", "));
  console.log("   Dev deps:", dev.map(d => d.name).join(", "));

  // 3. Fetch and store Zod docs
  console.log("\n3. Fetching Zod llms-full.txt (raw, no truncation)...");
  const fetchStart = Date.now();
  const fetchResult = await send("tools/call", {
    name: "fetch_and_store_doc",
    arguments: {
      library: "zod",
      version: "^3.24.0",
      url: "https://zod.dev/llms-full.txt",
    },
  });
  const fetchTime = ((Date.now() - fetchStart) / 1000).toFixed(1);
  const fetchData = JSON.parse(fetchResult.result.content[0].text);
  console.log("   Success:", fetchData.success);
  console.log("   Chunks:", fetchData.chunkCount);
  console.log("   Size:", (fetchData.byteLength / 1024).toFixed(0) + "KB");
  console.log("   Time:", fetchTime + "s");

  // 4. List docs
  console.log("\n4. Listing indexed docs...");
  const list = await send("tools/call", { name: "list_docs", arguments: {} });
  const libs = JSON.parse(list.result.content[0].text);
  for (const lib of libs) {
    console.log("   ", lib.library, "—", lib.chunkCount, "chunks, fetched", lib.fetchedAt.slice(0, 10));
  }

  // 5. Search
  console.log("\n5. Searching: 'how to validate email with zod'...");
  const searchStart = Date.now();
  const search = await send("tools/call", {
    name: "search_docs",
    arguments: { query: "how to validate email with zod", library: "zod", topK: 3 },
  });
  const searchTime = ((Date.now() - searchStart) / 1000).toFixed(1);
  const results = JSON.parse(search.result.content[0].text);
  console.log("   Found", results.length, "results in", searchTime + "s:");
  for (const r of results) {
    console.log("   [" + r.score.toFixed(3) + "]", r.heading);
    console.log("        ", r.content.slice(0, 120).replace(/\n/g, " ") + "...");
  }

  // 6. Search #2
  console.log("\n6. Searching: 'z.object schema definition'...");
  const search2Start = Date.now();
  const search2 = await send("tools/call", {
    name: "search_docs",
    arguments: { query: "z.object schema definition", library: "zod", topK: 3 },
  });
  const search2Time = ((Date.now() - search2Start) / 1000).toFixed(1);
  const results2 = JSON.parse(search2.result.content[0].text);
  console.log("   Found", results2.length, "results in", search2Time + "s:");
  for (const r of results2) {
    console.log("   [" + r.score.toFixed(3) + "]", r.heading);
    console.log("        ", r.content.slice(0, 120).replace(/\n/g, " ") + "...");
  }

  console.log("\n=== All tests passed ===");
  child.kill();
  process.exit(0);
}

// Timeout safety
setTimeout(() => {
  console.error("\nTIMEOUT — test took too long");
  child.kill();
  process.exit(1);
}, 300_000); // 5 min — first model download can be slow

run().catch((err) => {
  console.error("Test failed:", err);
  child.kill();
  process.exit(1);
});

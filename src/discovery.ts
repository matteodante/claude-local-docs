/**
 * Self-contained doc discovery: npm registry lookup, llms.txt probing,
 * index detection & expansion, HTML-to-markdown conversion.
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { fetchDocContent } from "./fetcher.js";

// ── Types ──────────────────────────────────────────────────────────────

interface NpmInfo {
  name: string;
  version: string;
  homepage?: string;
  repoUrl?: string; // normalized HTTPS URL without .git
  repoOrg?: string;
  repoName?: string;
}

interface IndexDetection {
  isIndex: boolean;
  links: { text: string; url: string }[];
}

export interface DiscoveryResult {
  url: string;
  content: string;
  byteLength: number;
  source: "llms-full.txt" | "llms.txt" | "llms.txt-index" | "homepage-html" | "github-raw" | "readme";
  expandedUrls?: string[];
  failedUrls?: string[];
  warning?: string;
}

// ── npm registry ───────────────────────────────────────────────────────

export async function queryNpmRegistry(library: string): Promise<NpmInfo> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(library)}/latest`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "claude-local-docs/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${library}`);
  }
  const pkg = (await res.json()) as Record<string, any>;

  let repoUrl: string | undefined;
  let repoOrg: string | undefined;
  let repoName: string | undefined;

  const rawRepo =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (rawRepo) {
    repoUrl = normalizeRepoUrl(rawRepo);
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (m) {
      repoOrg = m[1];
      repoName = m[2];
    }
  }

  return {
    name: pkg.name,
    version: pkg.version,
    homepage: pkg.homepage || undefined,
    repoUrl,
    repoOrg,
    repoName,
  };
}

function normalizeRepoUrl(raw: string): string {
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com/, "https://github.com")
    .replace(/\.git$/, "");
}

// ── Candidate URL generation ───────────────────────────────────────────

export function generateCandidateUrls(info: NpmInfo): string[] {
  const urls: string[] = [];

  if (info.homepage) {
    const hp = info.homepage.replace(/\/$/, "");
    urls.push(`${hp}/llms-full.txt`);
    urls.push(`${hp}/llms.txt`);

    // docs.{domain} variant
    try {
      const u = new URL(hp);
      if (!u.hostname.startsWith("docs.")) {
        const docsHost = `docs.${u.hostname}`;
        urls.push(`${u.protocol}//${docsHost}/llms-full.txt`);
        urls.push(`${u.protocol}//${docsHost}/llms.txt`);
      }
    } catch {
      // invalid URL — skip
    }

    // /docs/ subpath variant
    try {
      const u = new URL(hp);
      urls.push(`${u.origin}/docs/llms-full.txt`);
      urls.push(`${u.origin}/docs/llms.txt`);
    } catch {
      // invalid URL — skip
    }
  }

  // GitHub raw
  if (info.repoOrg && info.repoName) {
    for (const branch of ["main", "master"]) {
      urls.push(
        `https://raw.githubusercontent.com/${info.repoOrg}/${info.repoName}/${branch}/llms-full.txt`
      );
      urls.push(
        `https://raw.githubusercontent.com/${info.repoOrg}/${info.repoName}/${branch}/llms.txt`
      );
    }

    // README.md fallback (before homepage HTML)
    for (const branch of ["main", "master"]) {
      urls.push(
        `https://raw.githubusercontent.com/${info.repoOrg}/${info.repoName}/${branch}/README.md`
      );
    }
  }

  // Homepage HTML fallback (last)
  if (info.homepage) {
    urls.push(info.homepage);
  }

  return urls;
}

// ── Index detection ────────────────────────────────────────────────────

const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export function detectIndex(content: string, url: string): IndexDetection {
  // Large files are content, not an index
  if (content.length > 100_000) {
    return { isIndex: false, links: [] };
  }

  const links: { text: string; url: string }[] = [];
  for (const m of content.matchAll(MD_LINK_RE)) {
    const href = m[2].trim();
    // Only keep http(s) links and relative paths that look like docs
    if (href.startsWith("http") || href.startsWith("/") || href.endsWith(".md") || href.endsWith(".txt")) {
      links.push({ text: m[1], url: href });
    }
  }

  if (links.length < 5) {
    return { isIndex: false, links: [] };
  }

  // Count lines that are mostly links vs prose
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const linkTestRe = /\[[^\]]*\]\([^)]+\)/;
  let linkLines = 0;
  for (const line of lines) {
    if (linkTestRe.test(line)) linkLines++;
  }

  const linkRatio = linkLines / (lines.length || 1);

  const isIndex = linkRatio > 0.5 && links.length > 5;

  return { isIndex, links };
}

// ── Index expansion ────────────────────────────────────────────────────

const MAX_EXPAND_LINKS = 100;
const CONCURRENCY = 5;
const INTER_REQUEST_DELAY_MS = 200;

export async function expandIndex(
  links: { text: string; url: string }[],
  baseUrl: string
): Promise<{ content: string; expandedUrls: string[]; failedUrls: string[] }> {
  const expandedUrls: string[] = [];
  const failedUrls: string[] = [];
  const parts: string[] = [];

  // Resolve and dedupe URLs
  const resolved: { text: string; absolute: string }[] = [];
  const seen = new Set<string>();
  for (const link of links.slice(0, MAX_EXPAND_LINKS)) {
    const absolute = resolveUrl(link.url, baseUrl);
    if (!absolute || seen.has(absolute)) continue;
    // Skip binary / non-doc URLs
    if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|zip|tar|gz|mp4|mp3|pdf)$/i.test(absolute)) {
      continue;
    }
    seen.add(absolute);
    resolved.push({ text: link.text, absolute });
  }

  // Fetch with concurrency limit
  let i = 0;
  while (i < resolved.length) {
    const batch = resolved.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        const result = await fetchDocContent(item.absolute, { timeoutMs: 30_000 });
        return { item, result };
      })
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled" && r.value.result.ok) {
        const { item, result } = r.value;
        const ct = result.contentType.toLowerCase();
        const md = ct.includes("html") ? htmlToMarkdown(result.content) : result.content;
        parts.push(`## ${item.text}\n\n${md}`);
        expandedUrls.push(item.absolute);
      } else if (r.status === "fulfilled") {
        failedUrls.push(r.value.item.absolute);
      } else {
        failedUrls.push(batch[j].absolute);
      }
    }

    i += CONCURRENCY;

    if (i < resolved.length) {
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  }

  return {
    content: parts.join("\n\n---\n\n"),
    expandedUrls,
    failedUrls,
  };
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── HTML → Markdown ────────────────────────────────────────────────────

// Simple tag stripper for specific elements (works on raw HTML before turndown)
function stripTags(html: string, tags: string[]): string {
  let result = html;
  for (const tag of tags) {
    // Remove opening and closing tags and everything between them
    const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    result = result.replace(re, "");
    // Also remove self-closing variants
    const selfRe = new RegExp(`<${tag}[^/>]*/?>`, "gi");
    result = result.replace(selfRe, "");
  }
  return result;
}

function extractMainContent(html: string): string {
  // Try <main>, then <article>, then <body>, else full HTML
  for (const tag of ["main", "article"]) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const m = html.match(re);
    if (m) return m[1];
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  return html;
}

let turndownInstance: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;
  turndownInstance = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndownInstance.use(gfm);
  turndownInstance.addRule("removeImages", {
    filter: "img",
    replacement: () => "",
  });
  return turndownInstance;
}

export function htmlToMarkdown(html: string): string {
  let content = extractMainContent(html);
  content = stripTags(content, ["nav", "footer", "header", "script", "style", "aside", "noscript"]);
  return getTurndown().turndown(content);
}

function classifySource(url: string): DiscoveryResult["source"] {
  if (url.endsWith("/llms-full.txt")) return "llms-full.txt";
  if (url.endsWith("/llms.txt")) return "llms.txt";
  if (url.includes("raw.githubusercontent.com") && url.endsWith("/README.md")) return "readme";
  if (url.includes("raw.githubusercontent.com")) return "github-raw";
  return "homepage-html";
}

// ── Orchestrator ───────────────────────────────────────────────────────

export async function resolveDocsUrl(
  library: string
): Promise<DiscoveryResult> {
  // 1. Query npm registry
  const npmInfo = await queryNpmRegistry(library);

  // 2. Generate candidate URLs
  const candidates = generateCandidateUrls(npmInfo);

  if (candidates.length === 0) {
    throw new Error(`No candidate documentation URLs found for ${library}`);
  }

  // 3. Probe each candidate
  for (const candidateUrl of candidates) {
    const result = await fetchDocContent(candidateUrl, { timeoutMs: 15_000 });
    if (!result.ok) continue;

    const ct = result.contentType.toLowerCase();
    const isBinary =
      ct.includes("image") ||
      ct.includes("font") ||
      ct.includes("octet-stream") ||
      ct.includes("pdf") ||
      ct.includes("zip");
    if (isBinary) continue;

    // Determine source label
    const source = classifySource(candidateUrl);
    const isHtml = ct.includes("html");

    // 4. HTML → convert to markdown
    if (isHtml) {
      const md = htmlToMarkdown(result.content);
      if (md.trim().length > 100) {
        const discoveryResult: DiscoveryResult = {
          url: candidateUrl,
          content: md,
          byteLength: Buffer.byteLength(md),
          source: "homepage-html",
        };
        if (md.length < 5_000) {
          discoveryResult.warning = "Content is very small, index may be thin";
        }
        return discoveryResult;
      }
      continue;
    }

    // 5. Text docs — check if it's an index that needs expansion
    const detection = detectIndex(result.content, candidateUrl);
    if (detection.isIndex) {
      const expanded = await expandIndex(detection.links, candidateUrl);
      if (expanded.content.length > 0) {
        const discoveryResult: DiscoveryResult = {
          url: candidateUrl,
          content: expanded.content,
          byteLength: Buffer.byteLength(expanded.content),
          source: "llms.txt-index",
          expandedUrls: expanded.expandedUrls,
          failedUrls: expanded.failedUrls.length > 0 ? expanded.failedUrls : undefined,
        };
        if (expanded.content.length < 5_000) {
          discoveryResult.warning = "Content is very small, index may be thin";
        }
        return discoveryResult;
      }
    }

    // Full content doc (llms-full.txt, non-index llms.txt, github-raw, or readme)
    const discoveryResult: DiscoveryResult = {
      url: candidateUrl,
      content: result.content,
      byteLength: result.byteLength,
      source,
    };
    if (result.content.length < 5_000) {
      discoveryResult.warning = "Content is very small, index may be thin";
    }
    return discoveryResult;
  }

  throw new Error(
    `No documentation found for ${library}. Tried ${candidates.length} candidate URLs.`
  );
}

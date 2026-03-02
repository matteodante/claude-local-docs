/**
 * SFC (Single File Component) script extractor for Vue, Svelte, and Astro.
 * Extracts <script> blocks and frontmatter so they can be parsed by tree-sitter.
 */

export interface SfcExtractResult {
  scriptContent: string;
  language: string;      // "typescript" | "javascript"
  lineOffset: number;    // 0-based: number of lines before this script block in the original file
}

/**
 * Extract script blocks from a single-file component.
 * Returns an array of script blocks with their language and line offset.
 */
export function extractScriptBlocks(source: string, fileExtension: string): SfcExtractResult[] {
  const ext = fileExtension.toLowerCase().replace(/^\./, "");

  switch (ext) {
    case "vue":
    case "svelte":
      return extractScriptTags(source);
    case "astro":
      return extractAstroScripts(source);
    default:
      return [];
  }
}

/**
 * Shared helper: extract all <script> tags from source, detecting lang attribute.
 * Used by Vue and Svelte (identical extraction logic).
 */
function extractScriptTags(source: string, defaultLang?: string): SfcExtractResult[] {
  const results: SfcExtractResult[] = [];
  const scriptRe = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(source)) !== null) {
    const attrs = match[1] ?? "";
    const content = match[2];

    // Determine language from lang attribute, or use default
    let language: string;
    if (defaultLang) {
      language = defaultLang;
    } else {
      const langMatch = attrs.match(/lang\s*=\s*["'](\w+)["']/i);
      const lang = langMatch?.[1];
      language = (lang === "ts" || lang === "typescript") ? "typescript" : "javascript";
    }

    // Calculate line offset: count newlines before the match content starts
    const tagEnd = match.index + match[0].indexOf(">") + 1;
    const lineOffset = source.slice(0, tagEnd).split("\n").length - 1;

    if (content.trim().length > 0) {
      results.push({ scriptContent: content, language, lineOffset });
    }
  }

  return results;
}

// --- Astro ---
// Frontmatter is between --- delimiters (always TypeScript), plus optional <script> tags
function extractAstroScripts(source: string): SfcExtractResult[] {
  const results: SfcExtractResult[] = [];

  // Frontmatter: content between --- ... ---
  const frontmatterRe = /^---\r?\n([\s\S]*?)\r?\n---/m;
  const fmMatch = source.match(frontmatterRe);
  if (fmMatch && fmMatch[1].trim().length > 0) {
    // Frontmatter starts at line 1 (after the opening ---)
    results.push({
      scriptContent: fmMatch[1],
      language: "typescript", // Astro frontmatter is always TypeScript
      lineOffset: 1,
    });
  }

  // Also extract <script> tags (for client-side scripts) — Astro scripts are always TypeScript
  results.push(...extractScriptTags(source, "typescript"));

  return results;
}

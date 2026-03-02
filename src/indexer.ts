import type { DocRow } from "./types.js";
import { docEmbedClient, truncateAndNormalize } from "./tei-client.js";

const MATRYOSHKA_DIM = 384;

// ── Code fence detection ────────────────────────────────────────────────

const CODE_FENCE_OPEN = /^(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = (fence: string) => new RegExp(`^${fence.replace(/~/g, "\\~")}\\s*$`);

/**
 * Pre-process markdown: merge each fenced code block into a single "line"
 * so that paragraph-based splitting never breaks inside code.
 * The merged line uses \n internally but won't be split by \n\n.
 */
function mergeCodeFences(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const fenceMatch = lines[i].match(CODE_FENCE_OPEN);
    if (fenceMatch) {
      // Collect everything inside the fence
      const fence = fenceMatch[1];
      const closePat = CODE_FENCE_CLOSE(fence);
      const block: string[] = [lines[i]];
      i++;
      while (i < lines.length && !closePat.test(lines[i].trim())) {
        block.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        block.push(lines[i]); // closing fence
        i++;
      }
      // Join with a sentinel that won't match \n\n splitting
      result.push(block.join("\n"));
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result;
}

/**
 * Semantic chunking: split markdown by headings, then split large sections
 * at paragraph boundaries. Code fences are never split.
 */
export function chunkMarkdown(
  markdown: string,
  library: string
): Omit<DocRow, "id" | "vector">[] {
  const rawLines = markdown.split("\n");
  const lines = mergeCodeFences(rawLines);
  const chunks: Omit<DocRow, "id" | "vector">[] = [];

  const headingStack: { level: number; text: string }[] = [];
  let currentText = "";

  function flush() {
    const trimmed = currentText.trim();
    if (trimmed.length > 0) {
      const headingPath = headingStack.map((h) => h.text);
      // Prepend heading context so BM25 can match on section structure
      // (e.g., "Connect > Onboarding" makes "connect onboarding" query match)
      const headingPrefix =
        headingPath.length > 0 ? `[${headingPath.join(" > ")}]\n\n` : "";
      const subChunks = splitWithOverlap(trimmed, 4000, 400);
      for (const sub of subChunks) {
        chunks.push({
          library,
          headingPath: JSON.stringify(headingPath),
          text: headingPrefix + sub,
        });
      }
    }
    currentText = "";
  }

  for (const line of lines) {
    // Only match headings on non-code lines (code fences contain \n)
    const isCodeBlock = line.includes("\n");
    const headingMatch = !isCodeBlock ? line.match(/^(#{1,6})\s+(.+)/) : null;
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();

      // Pop headings at same or deeper level
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      currentText += line + "\n";
    } else {
      currentText += line + "\n";
    }
  }
  flush();

  return chunks;
}

/**
 * Split text at paragraph boundaries with ~10% overlap.
 * Code blocks (containing \n) are treated as atomic units.
 */
function splitWithOverlap(
  text: string,
  maxChars: number,
  overlapChars: number
): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const result: string[] = [];
  let current = "";
  let overlapBuffer = "";

  for (const para of paragraphs) {
    const nextLen = current.length + para.length + 2;

    // If adding this paragraph would exceed limit AND we have content already
    if (nextLen > maxChars && current.length > 0) {
      // But if the paragraph is a code block, try to keep it with the heading before it
      // by allowing a larger chunk rather than splitting before the code
      if (para.includes("\n") && current.length < maxChars * 0.6) {
        // Current chunk is less than 60% full — keep the code block with it
        current += (current ? "\n\n" : "") + para;
        continue;
      }

      result.push(current.trim());
      overlapBuffer = snapOverlapToParagraph(current, overlapChars);
      current = overlapBuffer + "\n\n" + para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * Walk backward through paragraph breaks to find the last complete
 * paragraph(s) fitting within maxChars. Falls back to raw char slice
 * if no paragraph breaks exist in the tail.
 */
function snapOverlapToParagraph(text: string, maxChars: number): string {
  const tail = text.slice(-maxChars);
  const breakIdx = tail.indexOf("\n\n");
  if (breakIdx === -1) {
    return tail;
  }
  return tail.slice(breakIdx + 2);
}

/**
 * Generate embeddings via TEI (Text Embeddings Inference).
 * Uses Matryoshka dimensionality reduction to 384 dims + L2 normalize.
 * Prefixes text with task type for better accuracy (required by nomic).
 */
export async function embedTexts(
  texts: string[],
  taskType: "search_document" | "search_query" = "search_document"
): Promise<number[][]> {
  const prefixed = texts.map((t) => `${taskType}: ${t}`);

  const fullVecs = await docEmbedClient.embed(prefixed, { truncate: true });

  // Matryoshka truncation to 384 dims + L2 normalize
  return truncateAndNormalize(fullVecs, MATRYOSHKA_DIM);
}

/**
 * Chunk markdown and generate embeddings, returning rows ready for LanceDB.
 */
export async function indexDocument(
  markdown: string,
  library: string
): Promise<Omit<DocRow, "id">[]> {
  const rawChunks = chunkMarkdown(markdown, library);
  if (rawChunks.length === 0) return [];

  const texts = rawChunks.map((c) => c.text);
  const embeddings = await embedTexts(texts, "search_document");

  return rawChunks.map((chunk, i) => ({
    ...chunk,
    vector: embeddings[i],
  }));
}

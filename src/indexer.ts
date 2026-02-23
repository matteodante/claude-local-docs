import type { DocRow } from "./types.js";

const TEI_EMBED_URL = process.env.TEI_EMBED_URL ?? "http://localhost:39281";
const MATRYOSHKA_DIM = 384;

/**
 * Semantic chunking: split markdown by headings, then split large sections
 * at paragraph boundaries with overlap.
 */
export function chunkMarkdown(
  markdown: string,
  library: string
): Omit<DocRow, "id" | "vector">[] {
  const lines = markdown.split("\n");
  const chunks: Omit<DocRow, "id" | "vector">[] = [];

  const headingStack: { level: number; text: string }[] = [];
  let currentText = "";

  function flush() {
    const trimmed = currentText.trim();
    if (trimmed.length > 0) {
      const headingPath = headingStack.map((h) => h.text);
      const subChunks = splitWithOverlap(trimmed, 1500, 200);
      for (const sub of subChunks) {
        chunks.push({
          library,
          headingPath: JSON.stringify(headingPath),
          text: sub,
        });
      }
    }
    currentText = "";
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
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
 * Overlap ensures context isn't lost at chunk edges.
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
  let overlapBuffer = ""; // trailing text from previous chunk

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      result.push(current.trim());
      // Start next chunk with overlap from end of current
      overlapBuffer = current.slice(-overlapChars);
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
 * Generate embeddings via TEI (Text Embeddings Inference).
 * Uses Matryoshka dimensionality reduction to 384 dims + L2 normalize.
 * Prefixes text with task type for better accuracy (required by nomic).
 */
export async function embedTexts(
  texts: string[],
  taskType: "search_document" | "search_query" = "search_document"
): Promise<number[][]> {
  const prefixed = texts.map((t) => `${taskType}: ${t}`);
  const embeddings: number[][] = [];

  // Process in batches to stay within TEI request size limits
  const batchSize = 32;
  for (let i = 0; i < prefixed.length; i += batchSize) {
    const batch = prefixed.slice(i, i + batchSize);

    const res = await fetch(`${TEI_EMBED_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: batch, truncate: true }),
    });
    if (!res.ok) {
      throw new Error(`TEI embed error: ${res.status} ${await res.text()}`);
    }

    const fullVecs: number[][] = await res.json();

    // Matryoshka truncation to 384 dims + L2 normalize
    for (const vec of fullVecs) {
      const truncated = vec.slice(0, MATRYOSHKA_DIM);
      const norm = Math.sqrt(truncated.reduce((s, v) => s + v * v, 0));
      embeddings.push(truncated.map((v) => v / (norm || 1)));
    }
  }

  return embeddings;
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

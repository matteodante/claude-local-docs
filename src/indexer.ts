import type { DocRow } from "./types.js";

// Lazy-loaded pipeline
let embedPipeline: any = null;
let layerNormFn: any = null;

const MODEL_NAME = "nomic-ai/nomic-embed-text-v1.5";
const MATRYOSHKA_DIM = 384; // Use 384-dim slice for speed; can bump to 768 for max accuracy

async function getEmbedPipeline() {
  if (embedPipeline) return { pipe: embedPipeline, layerNorm: layerNormFn };
  const transformers = await import("@huggingface/transformers");
  embedPipeline = await transformers.pipeline("feature-extraction", MODEL_NAME, {
    dtype: "q8",
  });
  layerNormFn = transformers.layer_norm;
  return { pipe: embedPipeline, layerNorm: layerNormFn };
}

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
 * Generate embeddings using nomic-embed-text-v1.5.
 * Uses Matryoshka dimensionality reduction to MATRYOSHKA_DIM.
 * Prefixes text with task type for better accuracy.
 */
export async function embedTexts(
  texts: string[],
  taskType: "search_document" | "search_query" = "search_document"
): Promise<number[][]> {
  const { pipe, layerNorm } = await getEmbedPipeline();
  const embeddings: number[][] = [];

  // Prefix each text with the task type as required by nomic
  const prefixed = texts.map((t) => `${taskType}: ${t}`);

  // Process in batches
  const batchSize = 64;
  for (let i = 0; i < prefixed.length; i += batchSize) {
    const batch = prefixed.slice(i, i + batchSize);
    const raw = await pipe(batch, { pooling: "mean" });

    // Apply layer norm + Matryoshka truncation + L2 normalize
    const normed = layerNorm(raw, [raw.dims[1]]);
    const truncated = normed.slice(null, [0, MATRYOSHKA_DIM]);
    const normalized = truncated.normalize(2, -1);

    for (let j = 0; j < batch.length; j++) {
      embeddings.push(Array.from(normalized[j].data as Float32Array));
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

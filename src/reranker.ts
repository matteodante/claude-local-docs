/**
 * Cross-encoder reranker using Xenova/ms-marco-MiniLM-L-6-v2.
 * Takes query + candidate passages, returns relevance scores.
 * ~23MB model, runs locally via Transformers.js ONNX runtime.
 */

let rerankerModel: any = null;
let rerankerTokenizer: any = null;

const RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

async function loadReranker() {
  if (rerankerModel && rerankerTokenizer) {
    return { model: rerankerModel, tokenizer: rerankerTokenizer };
  }
  const { AutoModelForSequenceClassification, AutoTokenizer } = await import(
    "@huggingface/transformers"
  );
  rerankerModel = await AutoModelForSequenceClassification.from_pretrained(
    RERANKER_MODEL,
    { dtype: "q8" }
  );
  rerankerTokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL);
  return { model: rerankerModel, tokenizer: rerankerTokenizer };
}

export interface RerankCandidate {
  id: number;
  text: string;
  library: string;
  headingPath: string;
  rrfScore: number;
}

export interface RerankResult extends RerankCandidate {
  rerankerScore: number;
}

/**
 * Rerank candidates using cross-encoder.
 * Processes in batches to manage memory.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];

  const { model, tokenizer } = await loadReranker();
  const results: RerankResult[] = [];

  // Process in batches of 32
  const batchSize = 32;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);

    const queries = batch.map(() => query);
    const passages = batch.map((c) => c.text);

    const features = tokenizer(queries, {
      text_pair: passages,
      padding: true,
      truncation: true,
    });

    const output = await model(features);

    // output.logits is a Tensor of shape [batch_size, 1]
    // Higher score = more relevant
    for (let j = 0; j < batch.length; j++) {
      const score = output.logits.data[j];
      results.push({
        ...batch[j],
        rerankerScore: score,
      });
    }
  }

  // Sort by reranker score descending
  results.sort((a, b) => b.rerankerScore - a.rerankerScore);
  return results;
}

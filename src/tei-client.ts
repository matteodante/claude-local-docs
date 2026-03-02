/**
 * Shared TEI (Text Embeddings Inference) HTTP client with retry, timeout, and batching.
 * Centralizes all TEI communication so embed, rerank, and code-embed share
 * consistent error handling and diagnostics.
 */

export interface TeiClientOptions {
  baseUrl: string;
  timeoutMs?: number;       // default 30_000
  maxRetries?: number;       // default 2
  retryDelayMs?: number;     // default 500
  maxBatchSize?: number;     // default 32
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export class TeiClient {
  readonly baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private maxBatchSize: number;

  constructor(options: TeiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxBatchSize = options.maxBatchSize ?? 32;
  }

  /**
   * Embed texts, automatically splitting into batches.
   * Returns one embedding vector per input text.
   */
  async embed(inputs: string[], options?: { truncate?: boolean }): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (let i = 0; i < inputs.length; i += this.maxBatchSize) {
      const batch = inputs.slice(i, i + this.maxBatchSize);
      const body: any = { inputs: batch };
      if (options?.truncate !== undefined) body.truncate = options.truncate;

      const data = await this.fetchWithRetry(`${this.baseUrl}/embed`, body);
      embeddings.push(...(data as number[][]));
    }

    return embeddings;
  }

  /**
   * Rerank texts against a query, automatically splitting into batches.
   * Returns scored results sorted by score descending.
   */
  async rerank(query: string, texts: string[]): Promise<{ index: number; score: number }[]> {
    const allResults: { index: number; score: number }[] = [];

    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const data = await this.fetchWithRetry(`${this.baseUrl}/rerank`, {
        query,
        texts: batch,
      });
      const results = data as { index: number; score: number }[];
      // Offset indices back to original positions
      for (const r of results) {
        allResults.push({ index: r.index + i, score: r.score });
      }
    }

    return allResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Check if the TEI endpoint is healthy.
   */
  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return { healthy: true };
      return { healthy: false, error: `HTTP ${res.status}` };
    } catch (err: any) {
      return { healthy: false, error: err.message ?? String(err) };
    }
  }

  private async fetchWithRetry(url: string, body: any): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.ok) {
          return await res.json();
        }

        // Non-retryable HTTP error — fail immediately
        if (!RETRYABLE_STATUSES.has(res.status)) {
          const text = await res.text();
          throw new Error(`TEI error: ${res.status} ${text}`);
        }

        // Retryable status — store error and retry
        lastError = new Error(`TEI error: ${res.status}`);
      } catch (err: any) {
        // Retryable network errors (ECONNREFUSED, timeout, etc.)
        const isRetryable =
          err.name === "TimeoutError" ||
          err.cause?.code === "ECONNREFUSED" ||
          err.cause?.code === "ECONNRESET" ||
          RETRYABLE_STATUSES.has(err.status);

        if (!isRetryable || attempt === this.maxRetries) {
          throw err;
        }
        lastError = err;
      }

      // Exponential backoff: 500ms, 1000ms
      if (attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
      }
    }

    throw lastError ?? new Error("TEI request failed after retries");
  }
}

// --- Pre-configured singletons ---

export const docEmbedClient = new TeiClient({
  baseUrl: process.env.TEI_EMBED_URL ?? "http://localhost:39281",
  maxBatchSize: 32,
});

export const rerankClient = new TeiClient({
  baseUrl: process.env.TEI_RERANK_URL ?? "http://localhost:39282",
  maxBatchSize: 32,
});

export const codeEmbedClient = new TeiClient({
  baseUrl: process.env.TEI_CODE_EMBED_URL ?? "http://localhost:39283",
  maxBatchSize: 8, // must match --max-client-batch-size 8 in docker-compose.yml / start-tei.sh
});

/**
 * Truncate vectors to `dim` dimensions and L2-normalize.
 * Shared by doc embeddings (Matryoshka 384-dim) and code embeddings (1536-dim).
 */
export function truncateAndNormalize(vectors: number[][], dim: number): number[][] {
  return vectors.map(vec => {
    const truncated = vec.slice(0, dim);
    const norm = Math.sqrt(truncated.reduce((s, v) => s + v * v, 0));
    return truncated.map(v => v / (norm || 1));
  });
}

/**
 * Check health of all 3 TEI endpoints.
 * Returns per-endpoint status and an overall allHealthy flag.
 */
export async function checkAllTeiHealth(): Promise<{
  allHealthy: boolean;
  embed: { healthy: boolean; error?: string };
  rerank: { healthy: boolean; error?: string };
  codeEmbed: { healthy: boolean; error?: string };
}> {
  const [embed, rerank, codeEmbed] = await Promise.all([
    docEmbedClient.checkHealth(),
    rerankClient.checkHealth(),
    codeEmbedClient.checkHealth(),
  ]);
  return {
    allHealthy: embed.healthy && rerank.healthy && codeEmbed.healthy,
    embed,
    rerank,
    codeEmbed,
  };
}

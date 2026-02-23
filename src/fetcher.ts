/**
 * Raw HTTP fetch for documentation content.
 * No AI processing, no truncation — returns full text as-is.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SIZE = 200 * 1024 * 1024; // 200MB

export type FetchResult =
  | { ok: true; content: string; byteLength: number; contentType: string; finalUrl: string }
  | { ok: false; error: string };

export interface FetchOptions {
  /** Timeout in milliseconds (default 120s). Use 15s for URL probing. */
  timeoutMs?: number;
}

export async function fetchDocContent(
  url: string,
  options?: FetchOptions
): Promise<FetchResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "claude-local-docs/1.0",
        "Accept": "text/plain, text/markdown, text/html, */*",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }

    const contentType = res.headers.get("content-type") ?? "text/plain";

    // Check content-length header if available
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_SIZE) {
      return { ok: false, error: `Content too large: ${contentLength} bytes (limit: ${MAX_SIZE})` };
    }

    // Read body with size guard
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_SIZE) {
      return { ok: false, error: `Content too large: ${buffer.byteLength} bytes (limit: ${MAX_SIZE})` };
    }

    const content = new TextDecoder().decode(buffer);

    return {
      ok: true,
      content,
      byteLength: buffer.byteLength,
      contentType,
      finalUrl: res.url,
    };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { ok: false, error: `Request timed out after ${timeoutMs / 1000}s` };
    }
    return { ok: false, error: err.message ?? String(err) };
  }
}

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type FetchCappedOptions = {
  init?: RequestInit;
  /** Hard ceiling on the response body. Enforced while streaming too. */
  maxBytes: number;
  timeoutMs?: number;
  /**
   * Throw before reading the body when the response is not ok, with a
   * download-style message. Leave off when the caller needs the error body
   * (the CLI APIs answer with a JSON `error` code) or handles status itself.
   */
  throwOnNotOk?: boolean;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

export type FetchCappedResult = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
};

/**
 * `fetch` with a timeout and a bounded body read.
 *
 * A plain `await res.arrayBuffer()` has no size limit at all, and a plain
 * `fetch` has no timeout, so a hung or hostile endpoint could pin the CLI and
 * grow memory without bound. Both ceilings are applied here: the Content-Length
 * header is checked up front when present, and the stream is cut off the moment
 * the real body crosses the limit (Content-Length is only a claim).
 */
export async function fetchCapped(
  url: string,
  options: FetchCappedOptions,
): Promise<FetchCappedResult> {
  const {
    init,
    maxBytes,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    throwOnNotOk = false,
    fetchImpl = fetch,
  } = options;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // AbortSignal.timeout rejects with a DOMException named "TimeoutError"
    // whose message varies by runtime, so name the condition ourselves.
    if ((error as { name?: string } | null)?.name === "TimeoutError") {
      throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }

  if (throwOnNotOk && !res.ok) {
    throw new Error(`download ${url} -> ${res.status} ${res.statusText}`);
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `response from ${url} is ${declared} bytes; the limit is ${maxBytes}`,
    );
  }

  const body = await readBodyCapped(res, maxBytes, url);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body,
  };
}

async function readBodyCapped(
  res: Response,
  maxBytes: number,
  url: string,
): Promise<Buffer> {
  const stream = res.body;
  if (!stream) return Buffer.alloc(0);

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(
        `response from ${url} exceeds the ${maxBytes} byte limit`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Read a request body with a hard byte ceiling.
 *
 * `req.json()` / `req.text()` buffer whatever the client sends, so a route
 * that reads before it authenticates — a webhook whose signature has to be
 * verified against the raw body, most of all — lets an unauthenticated caller
 * decide how much memory the server allocates. Routes that already cap their
 * input (telemetry, internal/route-cost) each grew their own copy of this;
 * new callers share this one.
 */

export class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
  }
}

/** Cheap pre-check: refuse an oversized body from its declared length alone. */
export function contentLengthExceeds(req: Request, maxBytes: number): boolean {
  const declared = Number(req.headers.get("content-length") ?? "0");
  return Number.isFinite(declared) && declared > maxBytes;
}

/** Read the stream, aborting the moment it crosses `maxBytes`. */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

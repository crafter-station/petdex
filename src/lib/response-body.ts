/**
 * Read a response body incrementally without allowing an untrusted stream to
 * exceed the caller's byte limit or remain pending indefinitely.
 */
export async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
  timeoutMs = 15_000,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("invalid response body limit");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid response body timeout");
  }
  if (!response.body) throw new Error("response body is empty");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        throw new Error("response body read timed out");
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("response body read timed out"));
            }, remaining);
          }),
        ]);
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel("response body exceeds limit").catch(() => {});
          throw new Error("response body exceeds limit");
        }
        chunks.push(Buffer.from(value));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } catch (error) {
    if (timedOut)
      void reader.cancel("response body read timed out").catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out pending read can still hold the stream lock briefly.
    }
  }

  return Buffer.concat(chunks, total);
}

import { describe, expect, it } from "bun:test";

import { apiRequest } from "./api-fetch.js";

// Every API call in the CLI used to be a bare `fetch`, so a server that
// accepted the connection and then stalled froze the command forever. These
// pin the two properties that close that: a timeout, and a size cap — plus
// that HTTP errors still come back as `ok: false` rather than throwing, so
// the callers' existing `if (!res.ok)` handling keeps working.

function respond(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): typeof fetch {
  const impl = async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  // `typeof fetch` also declares `preconnect`, which a two-line stub does not
  // have; the call contract under test is only the call itself.
  return impl as unknown as typeof fetch;
}

describe("apiRequest", () => {
  it("parses json and reports ok", async () => {
    const res = await apiRequest("https://example.test/x", undefined, {
      fetchImpl: respond('{"id":"pet_1"}'),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json<{ id: string }>()).toEqual({ id: "pet_1" });
  });

  it("does not throw on an HTTP error — the caller handles it", async () => {
    const res = await apiRequest("https://example.test/x", undefined, {
      fetchImpl: respond('{"error":"nope"}', 403),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('{"error":"nope"}');
  });

  it("refuses a response larger than the cap", async () => {
    await expect(
      apiRequest("https://example.test/big", undefined, {
        fetchImpl: respond("x".repeat(1024), 200, {
          "content-length": String(2 * 1024 * 1024),
        }),
      }),
    ).rejects.toThrow(/limit/);
  });

  it("surfaces a stalled request as a timeout instead of hanging", async () => {
    // A body that never resolves. `fetch` rejects a fired signal with a
    // DOMException named TimeoutError; mirror that so the message
    // `fetchCapped` builds is what the assertion pins.
    const stalled = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(
            Object.assign(new Error("This operation was aborted"), {
              name: "TimeoutError",
            }),
          ),
        );
      });
    await expect(
      apiRequest("https://example.test/slow", undefined, {
        fetchImpl: stalled as typeof fetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});

import { describe, expect, it } from "bun:test";

import { fetchCapped } from "./fetch-capped";

function jsonFetch(body: string, init?: ResponseInit): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

describe("fetchCapped", () => {
  it("returns the body when it is under the ceiling", async () => {
    const result = await fetchCapped("https://petdex.test/x", {
      maxBytes: 1024,
      fetchImpl: jsonFetch("hello"),
    });
    expect(result.ok).toBe(true);
    expect(result.body.toString("utf8")).toBe("hello");
  });

  it("rejects a body larger than the declared content-length", async () => {
    const result = fetchCapped("https://petdex.test/x", {
      maxBytes: 4,
      fetchImpl: jsonFetch("too long", {
        headers: { "content-length": "8" },
      }),
    });
    await expect(result).rejects.toThrow("the limit is 4");
  });

  it("caps a streamed body that lies about its content-length", async () => {
    // No content-length header at all, so the ceiling has to be enforced
    // while reading rather than up front.
    await expect(
      fetchCapped("https://petdex.test/x", {
        maxBytes: 4,
        fetchImpl: jsonFetch("way more than four bytes"),
      }),
    ).rejects.toThrow("exceeds the 4 byte limit");
  });

  it("throws on a non-ok response only when asked", async () => {
    const init: ResponseInit = { status: 404, statusText: "Not Found" };
    const withThrow = fetchCapped("https://petdex.test/x", {
      maxBytes: 1024,
      throwOnNotOk: true,
      fetchImpl: jsonFetch("nope", init),
    });
    await expect(withThrow).rejects.toThrow("download");

    const result = await fetchCapped("https://petdex.test/x", {
      maxBytes: 1024,
      fetchImpl: jsonFetch(JSON.stringify({ error: "not_found" }), init),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.body.toString("utf8")).toBe('{"error":"not_found"}');
  });

  it("names a timeout instead of leaking the runtime's abort message", async () => {
    const timeoutFetch = (async () => {
      const error = new Error("The operation was aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;
    await expect(
      fetchCapped("https://petdex.test/x", {
        maxBytes: 1024,
        timeoutMs: 1234,
        fetchImpl: timeoutFetch,
      }),
    ).rejects.toThrow("timed out after 1234ms");
  });
});

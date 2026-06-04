import { describe, expect, it } from "bun:test";

import {
  buildVersionBrowserCacheKey,
  fetchBuildVersion,
  fetchBuildVersionWithBrowserCache,
  getBuildVersionTokenFromPayload,
  isChunkLoadFailure,
  readCachedBuildVersion,
  writeCachedBuildVersion,
} from "./build-version-check";

class MemoryStorage implements Storage {
  [name: string]: unknown;
  #items = new Map<string, string>();

  get length() {
    return this.#items.size;
  }

  clear() {
    this.#items.clear();
  }

  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }

  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#items.delete(key);
  }

  setItem(key: string, value: string) {
    this.#items.set(key, value);
  }
}

describe("build version check helpers", () => {
  it("reads a non-empty version from version payloads", () => {
    expect(
      getBuildVersionTokenFromPayload({
        version: "abc123",
        builtAt: "2026-05-17T00:00:00.000Z",
      }),
    ).toBe("abc123|2026-05-17T00:00:00.000Z");
  });

  it("ignores missing or blank version payloads", () => {
    expect(getBuildVersionTokenFromPayload({ version: "" })).toBeNull();
    expect(
      getBuildVersionTokenFromPayload({ builtAt: "2026-05-17" }),
    ).toBeNull();
    expect(getBuildVersionTokenFromPayload(null)).toBeNull();
  });

  it("uses build metadata so same-commit redeploys can be detected", () => {
    expect(
      getBuildVersionTokenFromPayload({
        version: "abc123",
        builtAt: "2026-05-17T00:00:00.000Z",
      }),
    ).not.toBe(
      getBuildVersionTokenFromPayload({
        version: "abc123",
        builtAt: "2026-05-17T00:01:00.000Z",
      }),
    );
  });

  it("recognizes stale chunk loading failures", () => {
    expect(isChunkLoadFailure(new Error("ChunkLoadError"))).toBe(true);
    expect(isChunkLoadFailure("Loading chunk app-gallery failed")).toBe(true);
    expect(
      isChunkLoadFailure({
        reason: new Error("failed to fetch dynamically imported module"),
      }),
    ).toBe(true);
    expect(isChunkLoadFailure(new Error("network timeout"))).toBe(false);
  });

  it("aborts version fetches that do not settle", async () => {
    let signal: AbortSignal | undefined;

    const hangingFetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;

      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const version = await fetchBuildVersion(hangingFetch, { timeoutMs: 1 });

    expect(version).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it("fetches the stable version path without a cache-busting query", async () => {
    let requestedUrl: RequestInfo | URL | undefined;
    let requestedInit: RequestInit | undefined;
    const fetcher = ((url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url;
      requestedInit = init;
      return Promise.resolve(
        Response.json({
          version: "abc123",
          builtAt: "2026-05-17T00:00:00.000Z",
        }),
      );
    }) as typeof fetch;

    const version = await fetchBuildVersion(fetcher);

    expect(version).toBe("abc123|2026-05-17T00:00:00.000Z");
    expect(requestedUrl).toBe("/version.json");
    expect(requestedInit?.cache).toBe("no-store");
  });

  it("coalesces build version checks through local storage", async () => {
    const storage = new MemoryStorage();
    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        Response.json({
          version: "abc123",
          builtAt: "2026-05-17T00:00:00.000Z",
        }),
      );
    }) as typeof fetch;

    const first = await fetchBuildVersionWithBrowserCache(fetcher, {
      nowMs: 1_000,
      storage,
    });
    const second = await fetchBuildVersionWithBrowserCache(fetcher, {
      nowMs: 1_500,
      storage,
    });

    expect(first).toBe("abc123|2026-05-17T00:00:00.000Z");
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("expires cached build versions after the configured TTL", async () => {
    const storage = new MemoryStorage();
    writeCachedBuildVersion(storage, "old", 1_000);

    expect(readCachedBuildVersion(storage, 1_500, 1_000)).toBe("old");
    expect(readCachedBuildVersion(storage, 2_500, 1_000)).toBeNull();
  });

  it("scopes cached build versions by the running build", async () => {
    const storage = new MemoryStorage();
    writeCachedBuildVersion(
      storage,
      "old-build",
      1_000,
      buildVersionBrowserCacheKey("old-build"),
    );

    expect(
      readCachedBuildVersion(
        storage,
        1_500,
        10_000,
        buildVersionBrowserCacheKey("new-build"),
      ),
    ).toBeNull();
  });

  it("falls back to network when browser storage is blocked", async () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: Object.defineProperty({}, "localStorage", {
        get() {
          throw new DOMException("Blocked", "SecurityError");
        },
      }),
    });

    let calls = 0;
    const fetcher = (() => {
      calls += 1;
      return Promise.resolve(
        Response.json({
          version: "abc123",
          builtAt: "2026-05-17T00:00:00.000Z",
        }),
      );
    }) as typeof fetch;

    try {
      const version = await fetchBuildVersionWithBrowserCache(fetcher);

      expect(version).toBe("abc123|2026-05-17T00:00:00.000Z");
      expect(calls).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});

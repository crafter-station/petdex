import { describe, expect, it } from "bun:test";

import {
  PET_METRICS_CACHE_CONTROL,
  PET_METRICS_CACHE_TTL_SECONDS,
} from "@/lib/pet-metrics-cache";
import {
  loadPetMetrics,
  type PetMetricsResponse,
  parseCachedPetMetrics,
  petMetricsCacheKey,
  petMetricsResponseSavedAt,
  readCachedPetMetricsFromBrowser,
  serializePetMetrics,
  writeCachedPetMetricsToBrowser,
} from "@/lib/pet-metrics-client";

const METRICS: PetMetricsResponse = {
  installCount: 10,
  zipDownloadCount: 2,
  likeCount: 4,
  summary: { maxInstallCount: 20, maxLikeCount: 8 },
};

describe("pet metrics client cache", () => {
  it("keeps the API cache header aligned with the browser freshness window", () => {
    expect(PET_METRICS_CACHE_CONTROL).toBe(
      `public, max-age=${PET_METRICS_CACHE_TTL_SECONDS}, s-maxage=${PET_METRICS_CACHE_TTL_SECONDS}`,
    );
  });

  it("parses only fresh cached metrics", () => {
    const raw = serializePetMetrics(METRICS, 1_000);

    expect(parseCachedPetMetrics(raw, 30_000)?.data).toEqual(METRICS);
    expect(parseCachedPetMetrics(raw, 301_001)).toBeNull();
    expect(parseCachedPetMetrics(raw, 500)).toBeNull();
    expect(parseCachedPetMetrics("{}", 30_000)).toBeNull();
    expect(
      parseCachedPetMetrics(
        JSON.stringify({
          savedAt: 1_000,
          data: { ...METRICS, likeCount: "4" },
        }),
        30_000,
      ),
    ).toBeNull();
  });

  it("scopes cache keys by valid slug", () => {
    expect(petMetricsCacheKey("boba")).toBe("petdex:pet-metrics:boba");
    expect(petMetricsCacheKey("../boba")).toBeNull();
    expect(petMetricsCacheKey("A")).toBeNull();
  });

  it("uses the freshest browser cache across shared and tab-local storage", () => {
    const restore = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );

    try {
      window.localStorage.setItem(
        "petdex:pet-metrics:boba",
        serializePetMetrics({ ...METRICS, likeCount: 1 }, 1_000),
      );
      window.sessionStorage.setItem(
        "petdex:pet-metrics:boba",
        serializePetMetrics({ ...METRICS, likeCount: 7 }, 2_000),
      );

      expect(readCachedPetMetricsFromBrowser("boba", 3_000)?.data).toEqual({
        ...METRICS,
        likeCount: 7,
      });
    } finally {
      restore();
    }
  });

  it("falls back to tab-local cache when shared browser cache is blocked", () => {
    const sessionStorage = new MemoryStorage();
    const restore = installWindowStorage(blockedStorage(), sessionStorage);

    try {
      writeCachedPetMetricsToBrowser("boba", METRICS, 1_000);

      expect(sessionStorage.getItem("petdex:pet-metrics:boba")).not.toBeNull();
      expect(readCachedPetMetricsFromBrowser("boba", 2_000)?.data).toEqual(
        METRICS,
      );
    } finally {
      restore();
    }
  });

  it("serves browser-cached metrics without fetching", async () => {
    const restoreStorage = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const restoreFetch = installFetch(async () => {
      throw new Error("unexpected fetch");
    });

    try {
      writeCachedPetMetricsToBrowser("cached-pet", METRICS, Date.now());

      await expect(loadPetMetrics("cached-pet")).resolves.toEqual(METRICS);
    } finally {
      restoreFetch();
      restoreStorage();
    }
  });

  it("preserves CDN response age for browser cache freshness", () => {
    const now = Date.parse("2026-06-04T16:10:00.000Z");
    const date = new Headers({
      date: "Thu, 04 Jun 2026 16:05:00 GMT",
    });
    const age = new Headers({ age: "120" });
    const futureDate = new Headers({
      date: "Thu, 04 Jun 2026 16:11:00 GMT",
      age: "30",
    });
    const dateAndAge = new Headers({
      date: "Thu, 04 Jun 2026 16:09:30 GMT",
      age: "120",
    });

    expect(petMetricsResponseSavedAt(date, now)).toBe(
      Date.parse("2026-06-04T16:05:00.000Z"),
    );
    expect(petMetricsResponseSavedAt(age, now)).toBe(now - 120_000);
    expect(petMetricsResponseSavedAt(futureDate, now)).toBe(now - 30_000);
    expect(petMetricsResponseSavedAt(dateAndAge, now)).toBe(now - 120_000);
    expect(petMetricsResponseSavedAt(new Headers(), now)).toBe(now);
  });

  it("expires in-memory metrics from the original CDN freshness window", async () => {
    const restoreStorage = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const firstNow = Date.parse("2026-06-04T16:20:00.000Z");
    const restoreDateNow = installDateNow(() => firstNow);
    let fetchCount = 0;
    const restoreFetch = installFetch(async () => {
      fetchCount += 1;
      return Response.json(
        { ...METRICS, likeCount: fetchCount },
        { headers: { age: "299" } },
      );
    });

    try {
      await expect(loadPetMetrics("aged-pet")).resolves.toMatchObject({
        likeCount: 1,
      });
      await Promise.resolve();
      restoreDateNow();
      const restoreLaterDateNow = installDateNow(() => firstNow + 2_000);

      try {
        await expect(loadPetMetrics("aged-pet")).resolves.toMatchObject({
          likeCount: 2,
        });
      } finally {
        restoreLaterDateNow();
      }

      expect(fetchCount).toBe(2);
    } finally {
      restoreFetch();
      restoreDateNow();
      restoreStorage();
    }
  });

  it("expires browser-cached metrics from the same in-memory freshness window", async () => {
    const restoreStorage = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const firstNow = Date.parse("2026-06-04T16:30:00.000Z");
    const restoreDateNow = installDateNow(() => firstNow);
    let fetchCount = 0;
    const restoreFetch = installFetch(async () => {
      fetchCount += 1;
      return Response.json({ ...METRICS, likeCount: 9 });
    });

    try {
      writeCachedPetMetricsToBrowser(
        "browser-aged-pet",
        { ...METRICS, likeCount: 3 },
        firstNow - 299_000,
      );

      await expect(loadPetMetrics("browser-aged-pet")).resolves.toMatchObject({
        likeCount: 3,
      });
      await Promise.resolve();
      restoreDateNow();
      const restoreLaterDateNow = installDateNow(() => firstNow + 2_000);

      try {
        await expect(loadPetMetrics("browser-aged-pet")).resolves.toMatchObject(
          { likeCount: 9 },
        );
      } finally {
        restoreLaterDateNow();
      }

      expect(fetchCount).toBe(1);
    } finally {
      restoreFetch();
      restoreDateNow();
      restoreStorage();
    }
  });
});

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function blockedStorage(): Storage {
  return {
    get length() {
      throw new DOMException("Blocked", "SecurityError");
    },
    clear() {
      throw new DOMException("Blocked", "SecurityError");
    },
    getItem() {
      throw new DOMException("Blocked", "SecurityError");
    },
    key() {
      throw new DOMException("Blocked", "SecurityError");
    },
    removeItem() {
      throw new DOMException("Blocked", "SecurityError");
    },
    setItem() {
      throw new DOMException("Blocked", "SecurityError");
    },
  };
}

function installWindowStorage(
  localStorage: Storage,
  sessionStorage: Storage,
): () => void {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
    },
  });
  return () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  };
}

function installFetch(fetch: typeof globalThis.fetch): () => void {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetch,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  };
}

function installDateNow(now: () => number): () => void {
  const originalNow = Date.now;
  Object.defineProperty(Date, "now", {
    configurable: true,
    value: now,
  });
  return () => {
    Object.defineProperty(Date, "now", {
      configurable: true,
      value: originalNow,
    });
  };
}

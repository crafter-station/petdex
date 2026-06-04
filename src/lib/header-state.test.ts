import { describe, expect, it } from "bun:test";

import {
  claimHeaderStateRefresh,
  clearCachedHeaderStateFromBrowser,
  headerStateCacheKey,
  headerStateFetchCacheMode,
  headerStateResponseSavedAt,
  INITIAL_HEADER_STATE,
  nextHeaderStatePollDelay,
  parseCachedHeaderState,
  readCachedHeaderStateFromBrowser,
  releaseHeaderStateRefreshClaim,
  serializeHeaderState,
  shouldRequestHeaderState,
  withHeaderUnreadCount,
  writeCachedHeaderStateToBrowser,
} from "@/lib/header-state";

describe("header state helpers", () => {
  it("does not request header state before auth resolves or for signed-out users", () => {
    expect(
      shouldRequestHeaderState({
        isLoaded: false,
        isSignedIn: undefined,
        lastRefreshAt: 0,
        now: 1_000,
      }),
    ).toBe(false);
    expect(
      shouldRequestHeaderState({
        isLoaded: true,
        isSignedIn: false,
        lastRefreshAt: 0,
        now: 1_000,
      }),
    ).toBe(false);
  });

  it("throttles signed-in refreshes unless forced", () => {
    expect(
      shouldRequestHeaderState({
        isLoaded: true,
        isSignedIn: true,
        lastRefreshAt: 0,
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldRequestHeaderState({
        isLoaded: true,
        isSignedIn: true,
        lastRefreshAt: 1_000,
        now: 120_000,
      }),
    ).toBe(false);
    expect(
      shouldRequestHeaderState({
        isLoaded: true,
        isSignedIn: true,
        lastRefreshAt: 1_000,
        now: 902_000,
      }),
    ).toBe(false);
    expect(
      shouldRequestHeaderState({
        isLoaded: true,
        isSignedIn: true,
        lastRefreshAt: 1_000,
        now: 1_802_000,
      }),
    ).toBe(true);
    expect(
      shouldRequestHeaderState({
        force: true,
        isLoaded: true,
        isSignedIn: true,
        lastRefreshAt: 1_000,
        now: 30_000,
      }),
    ).toBe(true);
  });

  it("parses only fresh cached header state", () => {
    const state = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      notifications: { unreadCount: 2 },
      feedback: { count: 1, adminCount: 0 },
      caught: ["byte"],
    };
    const raw = serializeHeaderState(state, 1_000);

    expect(parseCachedHeaderState(raw, 30_000)?.state).toEqual(state);
    expect(parseCachedHeaderState(raw, 1_801_001)).toBeNull();
    expect(parseCachedHeaderState(raw, 500)).toBeNull();
  });

  it("reads shared browser cache before tab-local fallback cache", () => {
    const restore = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const cacheKey = signedInCacheKey();
    const localState = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      notifications: { unreadCount: 2 },
    };
    const sessionState = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      notifications: { unreadCount: 1 },
    };

    try {
      window.localStorage.setItem(
        cacheKey,
        serializeHeaderState(localState, 2_000),
      );
      window.sessionStorage.setItem(
        cacheKey,
        serializeHeaderState(sessionState, 1_000),
      );

      expect(readCachedHeaderStateFromBrowser(cacheKey, 3_000)?.state).toEqual(
        localState,
      );
    } finally {
      restore();
    }
  });

  it("falls back to tab-local cache when shared browser cache is blocked", () => {
    const sessionStorage = new MemoryStorage();
    const restore = installWindowStorage(blockedStorage(), sessionStorage);
    const cacheKey = signedInCacheKey();
    const state = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      caught: ["byte-bunny"],
    };

    try {
      writeCachedHeaderStateToBrowser(cacheKey, state, 1_000);

      expect(sessionStorage.getItem(cacheKey)).not.toBeNull();
      expect(readCachedHeaderStateFromBrowser(cacheKey, 2_000)?.state).toEqual(
        state,
      );
    } finally {
      restore();
    }
  });

  it("falls back to fresh tab-local cache when shared cache is stale", () => {
    const restore = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const cacheKey = signedInCacheKey();
    const localState = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      notifications: { unreadCount: 9 },
    };
    const sessionState = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      notifications: { unreadCount: 3 },
    };

    try {
      window.localStorage.setItem(
        cacheKey,
        serializeHeaderState(localState, 1_000),
      );
      window.sessionStorage.setItem(
        cacheKey,
        serializeHeaderState(sessionState, 1_800_000),
      );

      expect(
        readCachedHeaderStateFromBrowser(cacheKey, 1_801_001)?.state,
      ).toEqual(sessionState);
    } finally {
      restore();
    }
  });

  it("uses the freshest browser cache across shared and tab-local storage", () => {
    const restore = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const cacheKey = signedInCacheKey();
    const localState = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      notifications: { unreadCount: 2 },
    };
    const sessionState = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      notifications: { unreadCount: 7 },
    };

    try {
      window.localStorage.setItem(
        cacheKey,
        serializeHeaderState(localState, 1_000),
      );
      window.sessionStorage.setItem(
        cacheKey,
        serializeHeaderState(sessionState, 2_000),
      );

      expect(readCachedHeaderStateFromBrowser(cacheKey, 3_000)?.state).toEqual(
        sessionState,
      );
    } finally {
      restore();
    }
  });

  it("clears shared and tab-local browser cache for the signed-in user", () => {
    const restore = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const cacheKey = signedInCacheKey();
    const state = {
      ...INITIAL_HEADER_STATE,
      signedIn: true,
      caught: ["byte-bunny"],
    };

    try {
      window.localStorage.setItem(cacheKey, serializeHeaderState(state, 1_000));
      window.sessionStorage.setItem(
        cacheKey,
        serializeHeaderState(state, 1_000),
      );
      expect(claimHeaderStateRefresh(cacheKey, 1_000, 15_000, "tab-a")).toEqual(
        {
          shouldRefresh: true,
          token: "tab-a",
        },
      );

      clearCachedHeaderStateFromBrowser(cacheKey);

      expect(window.localStorage.getItem(cacheKey)).toBeNull();
      expect(window.sessionStorage.getItem(cacheKey)).toBeNull();
      expect(claimHeaderStateRefresh(cacheKey, 2_000, 15_000, "tab-b")).toEqual(
        {
          shouldRefresh: true,
          token: "tab-b",
        },
      );
    } finally {
      restore();
    }
  });

  it("claims automatic refreshes with a short shared browser lock", () => {
    const restore = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const cacheKey = signedInCacheKey();

    try {
      expect(claimHeaderStateRefresh(cacheKey, 1_000, 15_000, "tab-a")).toEqual(
        {
          shouldRefresh: true,
          token: "tab-a",
        },
      );
      expect(claimHeaderStateRefresh(cacheKey, 2_000, 15_000, "tab-b")).toEqual(
        {
          shouldRefresh: false,
          token: null,
        },
      );
      expect(
        claimHeaderStateRefresh(cacheKey, 16_001, 15_000, "tab-b"),
      ).toEqual({
        shouldRefresh: true,
        token: "tab-b",
      });
    } finally {
      restore();
    }
  });

  it("releases only the matching automatic refresh claim", () => {
    const restore = installWindowStorage(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const cacheKey = signedInCacheKey();

    try {
      expect(claimHeaderStateRefresh(cacheKey, 1_000, 15_000, "tab-a")).toEqual(
        {
          shouldRefresh: true,
          token: "tab-a",
        },
      );
      releaseHeaderStateRefreshClaim(cacheKey, "tab-b");
      expect(claimHeaderStateRefresh(cacheKey, 2_000, 15_000, "tab-c")).toEqual(
        {
          shouldRefresh: false,
          token: null,
        },
      );
      releaseHeaderStateRefreshClaim(cacheKey, "tab-a");
      expect(claimHeaderStateRefresh(cacheKey, 3_000, 15_000, "tab-c")).toEqual(
        {
          shouldRefresh: true,
          token: "tab-c",
        },
      );
    } finally {
      restore();
    }
  });

  it("schedules cached polls by remaining freshness window", () => {
    expect(nextHeaderStatePollDelay(0, 1_000)).toBe(1_800_000);
    expect(nextHeaderStatePollDelay(1_000, 61_000)).toBe(1_740_000);
    expect(nextHeaderStatePollDelay(1_000, 1_801_000)).toBe(0);
    expect(nextHeaderStatePollDelay(10_000, 1_000)).toBe(1_800_000);
  });

  it("scopes cache keys by signed-in user", () => {
    expect(headerStateCacheKey(null)).toBeNull();
    expect(headerStateCacheKey("user_123")).toBe(
      "petdex:header-state:user_123",
    );
  });

  it("uses network reload only for forced header refreshes", () => {
    expect(headerStateFetchCacheMode()).toBe("default");
    expect(headerStateFetchCacheMode(false)).toBe("default");
    expect(headerStateFetchCacheMode(true)).toBe("reload");
  });

  it("preserves browser-cached response age for session storage freshness", () => {
    const now = Date.parse("2026-06-04T12:45:00.000Z");
    const date = new Headers({
      date: "Thu, 04 Jun 2026 12:40:00 GMT",
    });
    const age = new Headers({ age: "120" });
    const futureDate = new Headers({
      date: "Thu, 04 Jun 2026 12:46:00 GMT",
    });
    const dateAndAge = new Headers({
      date: "Thu, 04 Jun 2026 12:44:30 GMT",
      age: "120",
    });

    expect(headerStateResponseSavedAt(date, now)).toBe(
      Date.parse("2026-06-04T12:40:00.000Z"),
    );
    expect(headerStateResponseSavedAt(age, now)).toBe(now - 120_000);
    expect(headerStateResponseSavedAt(futureDate, now)).toBe(now);
    expect(headerStateResponseSavedAt(dateAndAge, now)).toBe(now - 120_000);
    expect(headerStateResponseSavedAt(new Headers(), now)).toBe(now);
  });

  it("updates unread count without mutating the current header state", () => {
    const current = {
      ...INITIAL_HEADER_STATE,
      notifications: { unreadCount: 3 },
    };

    expect(withHeaderUnreadCount(current, (n) => n - 1)).toEqual({
      ...current,
      notifications: { unreadCount: 2 },
    });
    expect(withHeaderUnreadCount(current, -10).notifications.unreadCount).toBe(
      0,
    );
    expect(current.notifications.unreadCount).toBe(3);
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

function signedInCacheKey() {
  const cacheKey = headerStateCacheKey("user_123");
  if (!cacheKey) throw new Error("missing signed-in cache key");
  return cacheKey;
}

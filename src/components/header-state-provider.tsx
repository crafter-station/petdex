"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useAuth } from "@clerk/nextjs";

import {
  HEADER_STATE_POLL_MS,
  type HeaderState,
  headerStateCacheKey,
  INITIAL_HEADER_STATE,
  parseCachedHeaderState,
  serializeHeaderState,
  shouldRequestHeaderState,
  withHeaderUnreadCount,
} from "@/lib/header-state";

type Ctx = {
  state: HeaderState;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  setUnreadCount: (next: number | ((current: number) => number)) => void;
};

const HeaderStateContext = createContext<Ctx | null>(null);

// Single source of truth for SiteHeader badges + caught-slug set.
// Replaces 3 separate fetches per page-view (auth-badge feedback unread,
// notifications-bell unread, pet-gallery caught slugs) with 1 polled
// aggregate from /api/me/header-state. Cuts Edge Requests ~3x on busy
// pages, which is what was driving the May 5-6 Vercel spike.
export function HeaderStateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const [state, setState] = useState<HeaderState>(INITIAL_HEADER_STATE);
  const cacheKey = headerStateCacheKey(userId);
  const lastRefreshAt = useRef(0);
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const userScope = useRef<string | null>(null);
  const inFlightUser = useRef<string | null>(null);

  const setUnreadCount = useCallback(
    (next: number | ((current: number) => number)) => {
      setState((current) => withHeaderUnreadCount(current, next));
    },
    [],
  );

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      const now = Date.now();
      const requestUserId = userId ?? null;
      if (
        !shouldRequestHeaderState({
          force: options?.force,
          isLoaded,
          isSignedIn,
          lastRefreshAt: lastRefreshAt.current,
          now,
        })
      ) {
        return;
      }
      if (!options?.force && inFlightUser.current === requestUserId) return;
      const generation = ++requestGeneration.current;
      inFlightUser.current = requestUserId;
      try {
        const res = await fetch("/api/me/header-state", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as HeaderState;
        if (
          !mounted.current ||
          generation !== requestGeneration.current ||
          userScope.current !== requestUserId
        ) {
          return;
        }
        setState(json);
        lastRefreshAt.current = now;
        if (cacheKey) {
          writeCachedHeaderState(cacheKey, json, now);
        }
      } catch {
        return;
      } finally {
        if (inFlightUser.current === requestUserId) {
          inFlightUser.current = null;
        }
      }
    },
    [cacheKey, isLoaded, isSignedIn, userId],
  );

  useEffect(() => {
    mounted.current = true;
    userScope.current = userId ?? null;
    requestGeneration.current += 1;
    if (!isLoaded) {
      return () => {
        mounted.current = false;
        requestGeneration.current += 1;
      };
    }
    if (!isSignedIn) {
      setState(INITIAL_HEADER_STATE);
      lastRefreshAt.current = 0;
      return () => {
        mounted.current = false;
        requestGeneration.current += 1;
      };
    }
    let hasCachedState = false;
    if (cacheKey) {
      const cached = parseCachedHeaderState(
        readCachedHeaderState(cacheKey),
        Date.now(),
      );
      if (cached) {
        setState(cached.state);
        lastRefreshAt.current = cached.savedAt;
        hasCachedState = true;
      }
    }
    if (!hasCachedState) {
      setState(INITIAL_HEADER_STATE);
      lastRefreshAt.current = 0;
    }
    void refresh({ force: !hasCachedState });
    const refreshIfVisible = (options?: { force?: boolean }) => {
      if (document.visibilityState !== "visible") return;
      void refresh(options);
    };
    const id = window.setInterval(
      () => refreshIfVisible({ force: true }),
      HEADER_STATE_POLL_MS,
    );
    const onFocus = () => refreshIfVisible();
    const onVisibilityChange = () => refreshIfVisible();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cacheKey, isLoaded, isSignedIn, refresh, userId]);

  return (
    <HeaderStateContext.Provider value={{ refresh, setUnreadCount, state }}>
      {children}
    </HeaderStateContext.Provider>
  );
}

export function useHeaderState(): Ctx {
  const ctx = useContext(HeaderStateContext);
  if (ctx) return ctx;
  return {
    refresh: async () => {},
    setUnreadCount: () => {},
    state: INITIAL_HEADER_STATE,
  };
}

function readCachedHeaderState(cacheKey: string) {
  try {
    return window.sessionStorage.getItem(cacheKey);
  } catch {
    return null;
  }
}

function writeCachedHeaderState(
  cacheKey: string,
  state: HeaderState,
  savedAt: number,
) {
  try {
    window.sessionStorage.setItem(
      cacheKey,
      serializeHeaderState(state, savedAt),
    );
  } catch {
    return;
  }
}

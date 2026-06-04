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
  claimHeaderStateRefresh,
  clearCachedHeaderStateFromBrowser,
  HEADER_STATE_POLL_MS,
  type HeaderState,
  headerStateCacheKey,
  headerStateFetchCacheMode,
  headerStateResponseSavedAt,
  INITIAL_HEADER_STATE,
  nextHeaderStatePollDelay,
  parseCachedHeaderState,
  readCachedHeaderStateFromBrowser,
  releaseHeaderStateRefreshClaim,
  shouldRequestHeaderState,
  withHeaderUnreadCount,
  writeCachedHeaderStateToBrowser,
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
  const previousCacheKey = useRef<string | null>(null);

  const applyCachedState = useCallback(
    (now = Date.now()) => {
      if (!cacheKey) return false;
      const cached = readCachedHeaderStateFromBrowser(cacheKey, now);
      if (!cached) return false;
      setState(cached.state);
      lastRefreshAt.current = cached.savedAt;
      return true;
    },
    [cacheKey],
  );

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
      if (!options?.force) {
        applyCachedState(now);
      }
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
        const res = await fetch("/api/me/header-state", {
          cache: headerStateFetchCacheMode(options?.force),
        });
        if (!res.ok) return;
        const json = (await res.json()) as HeaderState;
        if (
          !mounted.current ||
          generation !== requestGeneration.current ||
          userScope.current !== requestUserId
        ) {
          return;
        }
        const savedAt = headerStateResponseSavedAt(res.headers, now);
        setState(json);
        lastRefreshAt.current = savedAt;
        if (cacheKey) {
          writeCachedHeaderStateToBrowser(cacheKey, json, savedAt);
        }
      } catch {
        return;
      } finally {
        if (inFlightUser.current === requestUserId) {
          inFlightUser.current = null;
        }
      }
    },
    [applyCachedState, cacheKey, isLoaded, isSignedIn, userId],
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
      if (previousCacheKey.current) {
        clearCachedHeaderStateFromBrowser(previousCacheKey.current);
        previousCacheKey.current = null;
      }
      setState(INITIAL_HEADER_STATE);
      lastRefreshAt.current = 0;
      return () => {
        mounted.current = false;
        requestGeneration.current += 1;
      };
    }
    if (cacheKey && previousCacheKey.current !== cacheKey) {
      if (previousCacheKey.current) {
        clearCachedHeaderStateFromBrowser(previousCacheKey.current);
      }
      previousCacheKey.current = cacheKey;
    }
    const hasCachedState = applyCachedState();
    if (!hasCachedState) {
      setState(INITIAL_HEADER_STATE);
      lastRefreshAt.current = 0;
    }
    const refreshIfVisible = (options?: { force?: boolean }) => {
      if (document.visibilityState !== "visible") return;
      void refresh(options);
    };
    let cancelled = false;
    let intervalId: number | null = null;
    let timeoutId: number | null = null;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      applyCachedState(now);
      if (
        !shouldRequestHeaderState({
          isLoaded,
          isSignedIn,
          lastRefreshAt: lastRefreshAt.current,
          now,
        })
      ) {
        return;
      }
      const claim = cacheKey
        ? claimHeaderStateRefresh(cacheKey, now)
        : { shouldRefresh: true, token: null };
      if (!claim.shouldRefresh) return;
      void refresh({ force: true }).finally(() => {
        if (cacheKey && claim.token) {
          releaseHeaderStateRefreshClaim(cacheKey, claim.token);
        }
      });
    };
    const schedulePoll = () => {
      if (cancelled) return;
      timeoutId = window.setTimeout(
        () => {
          if (cancelled) return;
          poll();
          intervalId = window.setInterval(poll, HEADER_STATE_POLL_MS);
        },
        nextHeaderStatePollDelay(lastRefreshAt.current, Date.now()),
      );
    };
    void refresh().finally(schedulePoll);
    const onFocus = () => refreshIfVisible();
    const onVisibilityChange = () => refreshIfVisible();
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== cacheKey || !ev.newValue) return;
      const cached = parseCachedHeaderState(ev.newValue, Date.now());
      if (!cached || userScope.current !== (userId ?? null)) return;
      setState(cached.state);
      lastRefreshAt.current = cached.savedAt;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      mounted.current = false;
      requestGeneration.current += 1;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (intervalId !== null) window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [applyCachedState, cacheKey, isLoaded, isSignedIn, refresh, userId]);

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

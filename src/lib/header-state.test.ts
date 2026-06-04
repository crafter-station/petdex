import { describe, expect, it } from "bun:test";

import {
  headerStateCacheKey,
  INITIAL_HEADER_STATE,
  nextHeaderStatePollDelay,
  parseCachedHeaderState,
  serializeHeaderState,
  shouldRequestHeaderState,
  withHeaderUnreadCount,
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
        now: 302_000,
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
    expect(parseCachedHeaderState(raw, 301_001)).toBeNull();
    expect(parseCachedHeaderState(raw, 500)).toBeNull();
  });

  it("schedules cached polls by remaining freshness window", () => {
    expect(nextHeaderStatePollDelay(0, 1_000)).toBe(900_000);
    expect(nextHeaderStatePollDelay(1_000, 61_000)).toBe(840_000);
    expect(nextHeaderStatePollDelay(1_000, 901_000)).toBe(0);
    expect(nextHeaderStatePollDelay(10_000, 1_000)).toBe(900_000);
  });

  it("scopes cache keys by signed-in user", () => {
    expect(headerStateCacheKey(null)).toBeNull();
    expect(headerStateCacheKey("user_123")).toBe(
      "petdex:header-state:user_123",
    );
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

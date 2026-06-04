export type HeaderState = {
  signedIn: boolean;
  notifications: { unreadCount: number };
  feedback: { count: number; adminCount: number };
  caught: string[];
};

export const INITIAL_HEADER_STATE: HeaderState = {
  signedIn: false,
  notifications: { unreadCount: 0 },
  feedback: { count: 0, adminCount: 0 },
  caught: [],
};

export const HEADER_STATE_POLL_MS = 900_000;
export const HEADER_STATE_MIN_REFRESH_MS = 300_000;
export const HEADER_STATE_CACHE_TTL_MS = HEADER_STATE_MIN_REFRESH_MS;

type CachedHeaderState = {
  savedAt: number;
  state: HeaderState;
};

export function headerStateCacheKey(userId: string | null | undefined) {
  return userId ? `petdex:header-state:${userId}` : null;
}

export function shouldRequestHeaderState(input: {
  force?: boolean;
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  lastRefreshAt: number;
  minRefreshMs?: number;
  now: number;
}) {
  if (!input.isLoaded || !input.isSignedIn) return false;
  if (input.force) return true;
  return (
    input.lastRefreshAt === 0 ||
    input.now - input.lastRefreshAt >=
      (input.minRefreshMs ?? HEADER_STATE_MIN_REFRESH_MS)
  );
}

export function nextHeaderStatePollDelay(
  lastRefreshAt: number,
  now: number,
  pollMs = HEADER_STATE_POLL_MS,
) {
  if (lastRefreshAt <= 0 || lastRefreshAt > now) return pollMs;
  return Math.max(0, pollMs - (now - lastRefreshAt));
}

export function parseCachedHeaderState(
  raw: string | null,
  now: number,
  ttlMs = HEADER_STATE_CACHE_TTL_MS,
): CachedHeaderState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedHeaderState>;
    if (
      typeof parsed.savedAt !== "number" ||
      !parsed.state ||
      parsed.savedAt > now ||
      now - parsed.savedAt > ttlMs
    ) {
      return null;
    }
    return {
      savedAt: parsed.savedAt,
      state: normalizeHeaderState(parsed.state),
    };
  } catch {
    return null;
  }
}

export function serializeHeaderState(state: HeaderState, savedAt: number) {
  return JSON.stringify({ savedAt, state });
}

export function withHeaderUnreadCount(
  state: HeaderState,
  next: number | ((current: number) => number),
): HeaderState {
  const unreadCount =
    typeof next === "function" ? next(state.notifications.unreadCount) : next;
  return {
    ...state,
    notifications: {
      ...state.notifications,
      unreadCount: Math.max(0, toNumber(unreadCount)),
    },
  };
}

function normalizeHeaderState(value: unknown): HeaderState {
  const input = isRecord(value) ? value : {};
  const notifications = isRecord(input.notifications)
    ? input.notifications
    : {};
  const feedback = isRecord(input.feedback) ? input.feedback : {};
  return {
    signedIn: input.signedIn === true,
    notifications: {
      unreadCount: toNumber(notifications.unreadCount),
    },
    feedback: {
      count: toNumber(feedback.count),
      adminCount: toNumber(feedback.adminCount),
    },
    caught: Array.isArray(input.caught) ? input.caught.filter(isString) : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

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

export const HEADER_STATE_POLL_MS = 1_800_000;
export const HEADER_STATE_MIN_REFRESH_MS = HEADER_STATE_POLL_MS;
export const HEADER_STATE_CACHE_TTL_MS = HEADER_STATE_MIN_REFRESH_MS;
export const HEADER_STATE_BROWSER_CACHE_SECONDS = 300;
export const HEADER_STATE_REFRESH_LOCK_MS = 15_000;

export type CachedHeaderState = {
  savedAt: number;
  state: HeaderState;
};

export type HeaderStateRefreshClaim = {
  shouldRefresh: boolean;
  token: string | null;
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

export function readCachedHeaderStateFromBrowser(
  cacheKey: string,
  now = Date.now(),
): CachedHeaderState | null {
  const local = parseCachedHeaderState(
    readStorageValue(browserStorage("localStorage"), cacheKey),
    now,
  );
  const session = parseCachedHeaderState(
    readStorageValue(browserStorage("sessionStorage"), cacheKey),
    now,
  );
  if (!local) return session;
  if (!session) return local;
  return local.savedAt >= session.savedAt ? local : session;
}

export function writeCachedHeaderStateToBrowser(
  cacheKey: string,
  state: HeaderState,
  savedAt: number,
) {
  const raw = serializeHeaderState(state, savedAt);
  if (writeStorageValue(browserStorage("localStorage"), cacheKey, raw)) return;
  writeStorageValue(browserStorage("sessionStorage"), cacheKey, raw);
}

export function clearCachedHeaderStateFromBrowser(cacheKey: string) {
  removeStorageValue(browserStorage("localStorage"), cacheKey);
  removeStorageValue(browserStorage("sessionStorage"), cacheKey);
  removeStorageValue(
    browserStorage("localStorage"),
    headerStateRefreshLockKey(cacheKey),
  );
}

export function claimHeaderStateRefresh(
  cacheKey: string,
  now = Date.now(),
  lockMs = HEADER_STATE_REFRESH_LOCK_MS,
  token = `${now}:${Math.random()}`,
): HeaderStateRefreshClaim {
  const storage = browserStorage("localStorage");
  if (!storage) return { shouldRefresh: true, token: null };
  const lockKey = headerStateRefreshLockKey(cacheKey);
  const current = parseRefreshLock(readStorageValue(storage, lockKey));
  if (current && current.expiresAt > now) {
    return { shouldRefresh: false, token: null };
  }
  const next = JSON.stringify({ expiresAt: now + lockMs, token });
  if (!writeStorageValue(storage, lockKey, next)) {
    return { shouldRefresh: true, token: null };
  }
  const saved = parseRefreshLock(readStorageValue(storage, lockKey));
  return saved?.token === token
    ? { shouldRefresh: true, token }
    : { shouldRefresh: false, token: null };
}

export function releaseHeaderStateRefreshClaim(
  cacheKey: string,
  token: string,
) {
  const storage = browserStorage("localStorage");
  if (!storage) return;
  const lockKey = headerStateRefreshLockKey(cacheKey);
  const current = parseRefreshLock(readStorageValue(storage, lockKey));
  if (current?.token !== token) return;
  try {
    storage.removeItem(lockKey);
  } catch {
    return;
  }
}

export function headerStateFetchCacheMode(force?: boolean): RequestCache {
  return force ? "reload" : "default";
}

export function headerStateResponseSavedAt(
  headers: Pick<Headers, "get">,
  now: number,
) {
  const dateMs = Date.parse(headers.get("date") ?? "");
  const validDateMs = Number.isFinite(dateMs) && dateMs <= now ? dateMs : null;
  const ageSeconds = Number(headers.get("age") ?? NaN);
  if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
    const agedSavedAt = Math.max(0, now - ageSeconds * 1000);
    return validDateMs === null
      ? agedSavedAt
      : Math.min(validDateMs, agedSavedAt);
  }
  return validDateMs ?? now;
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

function headerStateRefreshLockKey(cacheKey: string) {
  return `${cacheKey}:refresh-lock`;
}

function parseRefreshLock(raw: string | null): {
  expiresAt: number;
  token: string;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { expiresAt?: unknown; token?: unknown };
    if (
      typeof parsed.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt) &&
      typeof parsed.token === "string"
    ) {
      return { expiresAt: parsed.expiresAt, token: parsed.token };
    }
  } catch {}
  return null;
}

function browserStorage(
  name: "localStorage" | "sessionStorage",
): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window[name];
  } catch {
    return null;
  }
}

function readStorageValue(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(
  storage: Storage | null,
  key: string,
  value: string,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorageValue(storage: Storage | null, key: string) {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    return;
  }
}

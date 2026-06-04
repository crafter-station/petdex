import { createBuildVersionToken } from "@/lib/build-version-token";

export const BUILD_VERSION_PATH = "/version.json";
export const BUILD_VERSION_FETCH_TIMEOUT_MS = 5_000;
export const BUILD_VERSION_BROWSER_CACHE_TTL_MS = 10 * 60_000;
export const BUILD_VERSION_BROWSER_CACHE_KEY = "petdex:build-version";

const CHUNK_LOAD_FAILURE_PATTERNS = [
  "chunkloaderror",
  "loading chunk",
  "failed to fetch dynamically imported module",
  "importing a module script failed",
];

export function getBuildVersionTokenFromPayload(
  payload: unknown,
): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const version = (payload as { version?: unknown }).version;

  if (typeof version !== "string") {
    return null;
  }

  const builtAt = (payload as { builtAt?: unknown }).builtAt;

  return createBuildVersionToken({
    builtAt: typeof builtAt === "string" ? builtAt : null,
    version,
  });
}

export async function fetchBuildVersion(
  fetcher: typeof fetch = fetch,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? BUILD_VERSION_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetcher(BUILD_VERSION_PATH, {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return getBuildVersionTokenFromPayload(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchBuildVersionWithBrowserCache(
  fetcher: typeof fetch = fetch,
  options: {
    maxAgeMs?: number;
    nowMs?: number;
    storage?: Storage | null;
    timeoutMs?: number;
    cacheKey?: string;
  } = {},
): Promise<string | null> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? BUILD_VERSION_BROWSER_CACHE_TTL_MS;
  const storage = options.storage ?? browserStorage();
  const cacheKey = options.cacheKey ?? BUILD_VERSION_BROWSER_CACHE_KEY;
  const cached = readCachedBuildVersion(storage, nowMs, maxAgeMs, cacheKey);

  if (cached) {
    return cached;
  }

  const version = await fetchBuildVersion(fetcher, {
    timeoutMs: options.timeoutMs,
  });

  if (version) {
    writeCachedBuildVersion(storage, version, nowMs, cacheKey);
  }

  return version;
}

export function readCachedBuildVersion(
  storage: Storage | null,
  nowMs: number,
  maxAgeMs = BUILD_VERSION_BROWSER_CACHE_TTL_MS,
  cacheKey = BUILD_VERSION_BROWSER_CACHE_KEY,
): string | null {
  if (!storage) return null;

  try {
    const raw = storage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; version?: unknown };

    if (typeof parsed.version !== "string") return null;
    if (typeof parsed.savedAt !== "number") return null;
    if (!Number.isFinite(parsed.savedAt)) return null;
    if (nowMs - parsed.savedAt < 0) return null;
    if (nowMs - parsed.savedAt > maxAgeMs) return null;

    return parsed.version;
  } catch {
    return null;
  }
}

export function writeCachedBuildVersion(
  storage: Storage | null,
  version: string,
  savedAt: number,
  cacheKey = BUILD_VERSION_BROWSER_CACHE_KEY,
): void {
  if (!storage) return;

  try {
    storage.setItem(cacheKey, JSON.stringify({ savedAt, version }));
  } catch {
    return;
  }
}

export function buildVersionBrowserCacheKey(currentVersion: string | null) {
  return currentVersion
    ? `${BUILD_VERSION_BROWSER_CACHE_KEY}:${currentVersion}`
    : BUILD_VERSION_BROWSER_CACHE_KEY;
}

export function isChunkLoadFailure(errorLike: unknown): boolean {
  const message = getErrorLikeMessage(errorLike).toLowerCase();

  return CHUNK_LOAD_FAILURE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

function getErrorLikeMessage(errorLike: unknown): string {
  if (typeof errorLike === "string") {
    return errorLike;
  }

  if (errorLike instanceof Error) {
    return errorLike.message;
  }

  if (!errorLike || typeof errorLike !== "object") {
    return "";
  }

  const maybeMessage = (errorLike as { message?: unknown }).message;
  if (typeof maybeMessage === "string") {
    return maybeMessage;
  }

  const maybeReason = (errorLike as { reason?: unknown }).reason;
  if (maybeReason !== undefined) {
    return getErrorLikeMessage(maybeReason);
  }

  const maybeError = (errorLike as { error?: unknown }).error;
  if (maybeError !== undefined) {
    return getErrorLikeMessage(maybeError);
  }

  return "";
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

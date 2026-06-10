import { PET_METRICS_CACHE_TTL_MS } from "@/lib/pet-metrics-cache";

export { PET_METRICS_CACHE_TTL_MS } from "@/lib/pet-metrics-cache";

export type PetMetricsResponse = {
  installCount: number;
  zipDownloadCount: number;
  likeCount: number;
  summary: { maxInstallCount: number; maxLikeCount: number };
};

export type CachedPetMetrics = {
  savedAt: number;
  data: PetMetricsResponse;
};

const petMetricsCache = new Map<
  string,
  { promise: Promise<PetMetricsResponse | null>; savedAt: number }
>();

export function loadPetMetrics(slug: string) {
  const now = Date.now();
  const cached = petMetricsCache.get(slug);
  if (cached && now - cached.savedAt < PET_METRICS_CACHE_TTL_MS) {
    return cached.promise;
  }

  const cachedBrowserMetrics = readCachedPetMetricsFromBrowser(slug, now);
  if (cachedBrowserMetrics) {
    const promise = Promise.resolve(cachedBrowserMetrics.data);
    rememberPetMetricsPromise(slug, promise, cachedBrowserMetrics.savedAt);
    return promise;
  }

  let responseSavedAt = now;
  const promise = fetch(`/api/pets/${slug}/metrics`, {
    headers: { accept: "application/json" },
  })
    .then(async (res) => {
      if (!res.ok) return null;
      responseSavedAt = petMetricsResponseSavedAt(res.headers, Date.now());
      return normalizePetMetricsResponse(await res.json());
    })
    .catch(() => null);

  rememberPetMetricsPromise(slug, promise, now);
  void promise.then((data) => {
    if (!data) petMetricsCache.delete(slug);
    if (data) {
      rememberPetMetricsPromise(slug, promise, responseSavedAt);
      writeCachedPetMetricsToBrowser(slug, data, responseSavedAt);
    }
  });
  return promise;
}

export function petMetricsCacheKey(slug: string) {
  return /^[a-z0-9-]{1,60}$/.test(slug) ? `petdex:pet-metrics:${slug}` : null;
}

export function parseCachedPetMetrics(
  raw: string | null,
  now: number,
  ttlMs = PET_METRICS_CACHE_TTL_MS,
): CachedPetMetrics | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedPetMetrics>;
    const data = normalizePetMetricsResponse(parsed.data);
    if (
      typeof parsed.savedAt !== "number" ||
      !data ||
      parsed.savedAt > now ||
      now - parsed.savedAt > ttlMs
    ) {
      return null;
    }
    return { savedAt: parsed.savedAt, data };
  } catch {
    return null;
  }
}

export function serializePetMetrics(data: PetMetricsResponse, savedAt: number) {
  return JSON.stringify({ savedAt, data });
}

export function readCachedPetMetricsFromBrowser(
  slug: string,
  now = Date.now(),
): CachedPetMetrics | null {
  const cacheKey = petMetricsCacheKey(slug);
  if (!cacheKey) return null;
  const local = parseCachedPetMetrics(
    readStorageValue(browserStorage("localStorage"), cacheKey),
    now,
  );
  const session = parseCachedPetMetrics(
    readStorageValue(browserStorage("sessionStorage"), cacheKey),
    now,
  );
  if (!local) return session;
  if (!session) return local;
  return local.savedAt >= session.savedAt ? local : session;
}

export function writeCachedPetMetricsToBrowser(
  slug: string,
  data: PetMetricsResponse,
  savedAt: number,
) {
  const cacheKey = petMetricsCacheKey(slug);
  if (!cacheKey) return;
  const raw = serializePetMetrics(data, savedAt);
  if (writeStorageValue(browserStorage("localStorage"), cacheKey, raw)) return;
  writeStorageValue(browserStorage("sessionStorage"), cacheKey, raw);
}

export function petMetricsResponseSavedAt(
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

function normalizePetMetricsResponse(
  value: unknown,
): PetMetricsResponse | null {
  if (!isRecord(value) || !isRecord(value.summary)) return null;
  const installCount = toFiniteNumber(value.installCount);
  const zipDownloadCount = toFiniteNumber(value.zipDownloadCount);
  const likeCount = toFiniteNumber(value.likeCount);
  const maxInstallCount = toFiniteNumber(value.summary.maxInstallCount);
  const maxLikeCount = toFiniteNumber(value.summary.maxLikeCount);
  if (
    installCount === null ||
    zipDownloadCount === null ||
    likeCount === null ||
    maxInstallCount === null ||
    maxLikeCount === null
  ) {
    return null;
  }
  return {
    installCount,
    zipDownloadCount,
    likeCount,
    summary: { maxInstallCount, maxLikeCount },
  };
}

function rememberPetMetricsPromise(
  slug: string,
  promise: Promise<PetMetricsResponse | null>,
  savedAt: number,
) {
  petMetricsCache.set(slug, { promise, savedAt });
  setTimeout(
    () => {
      const cached = petMetricsCache.get(slug);
      if (cached?.promise === promise) petMetricsCache.delete(slug);
    },
    Math.max(0, PET_METRICS_CACHE_TTL_MS - Math.max(0, Date.now() - savedAt)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

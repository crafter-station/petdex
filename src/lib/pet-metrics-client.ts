export type PetMetricsResponse = {
  installCount: number;
  zipDownloadCount: number;
  likeCount: number;
  summary: { maxInstallCount: number; maxLikeCount: number };
};

const PET_METRICS_CACHE_TTL_MS = 60_000;
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

  const promise = fetch(`/api/pets/${slug}/metrics`, {
    headers: { accept: "application/json" },
  })
    .then((res) =>
      res.ok ? (res.json() as Promise<PetMetricsResponse>) : null,
    )
    .catch(() => null);

  petMetricsCache.set(slug, { promise, savedAt: now });
  setTimeout(() => {
    const cached = petMetricsCache.get(slug);
    if (cached?.promise === promise) petMetricsCache.delete(slug);
  }, PET_METRICS_CACHE_TTL_MS);
  void promise.then((data) => {
    if (!data) petMetricsCache.delete(slug);
  });
  return promise;
}

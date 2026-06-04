export type RandomPetCandidate = {
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
};

export function pickRandomPet(
  pool: readonly RandomPetCandidate[],
  random = Math.random,
) {
  if (pool.length === 0) return null;
  const index = Math.min(
    pool.length - 1,
    Math.max(0, Math.floor(random() * pool.length)),
  );
  return pool[index] ?? null;
}

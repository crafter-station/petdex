export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Slug that never hard-fails on non-Latin input: petId → displayName →
 *  deterministic `pet-<hash>` so a CJK-only id (common in the Chinese
 *  community) still derives a stable slug. Returns "" only when both
 *  inputs are empty. Uniqueness is still resolveUniqueSlug's job. */
export function deriveSlug(petId: string, displayName = ""): string {
  const direct = slugify(petId);
  if (direct) return direct;
  const fromName = slugify(displayName);
  if (fromName) return fromName;
  const seed = petId.trim() || displayName.trim();
  if (!seed) return "";
  return `pet-${fnv1a36(seed)}`;
}

function fnv1a36(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

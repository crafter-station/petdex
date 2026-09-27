/** Cap on personal (unfeatured) collections per creator. Featured ones are
 *  admin-curated promotions and do not count toward it. Lives here rather
 *  than in collection-access.ts because that module is server-only and the
 *  owner manager UI needs to render the same limit. */
export const MAX_OWNER_COLLECTIONS = 10;

export const MAX_COLLECTION_PETS = 24;

/**
 * Whether a proposed member list may be written.
 *
 * The cap is a growth limit, not an invariant on the stored row. Collections
 * created before the cap existed can hold more than MAX_COLLECTION_PETS, and
 * those rows must stay editable: rejecting them outright would make a stored
 * collection uneditable (not even a title fix) until its owner deleted
 * members. So a list is allowed when it is within the cap, or when it is a
 * subset of what is already stored — it may shrink, never grow past the cap.
 *
 * @param proposedSlugs The member list the request wants to store.
 * @param existingSlugs The members currently stored, or `null` when there is
 *   no existing row (a create), where any list over the cap is a rejection.
 */
export function collectionPetLimitExceeded(
  proposedSlugs: readonly string[],
  existingSlugs: readonly string[] | null,
): boolean {
  const proposed = new Set(proposedSlugs);
  if (proposed.size <= MAX_COLLECTION_PETS) return false;
  if (existingSlugs === null) return true;
  // Over the cap is only acceptable while it adds nothing: every proposed
  // slug is already stored. A pure shrink, or an unchanged over-cap list
  // sent alongside a title edit, both pass.
  const existing = new Set(existingSlugs);
  for (const slug of proposed) {
    if (!existing.has(slug)) return true;
  }
  return false;
}

/** Keep a client-side selection within the server collection limit. */
export function limitCollectionPetSlugs(
  slugs: readonly string[],
  coverPetSlug: string | null = null,
): string[] {
  const unique = [...new Set(slugs)];
  if (unique.length <= MAX_COLLECTION_PETS) return unique;

  const limited = unique.slice(0, MAX_COLLECTION_PETS);
  if (
    coverPetSlug !== null &&
    unique.includes(coverPetSlug) &&
    !limited.includes(coverPetSlug)
  ) {
    limited[limited.length - 1] = coverPetSlug;
  }
  return limited;
}

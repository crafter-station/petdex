import { validateProfileHandle } from "@/lib/profiles";

// Cap on the slugified base, not on the final slug: a uniqueness suffix is
// appended after this, so a stored slug can run a few characters longer. The
// budget is longer than the pet one (src/lib/slug.ts caps at 40) because the
// base is seeded from a profile handle and should still read as a name once
// the suffix lands. Truncating the suffixed candidates instead would collapse
// them all onto the base and defeat the probe, so the suffix is deliberately
// allowed past this.
const MAX_COLLECTION_SLUG_LENGTH = 48;

/** How many `base`, `base-2`, `base-3`, ... candidates a caller probes
 *  before giving up and allocating a random slug. */
export const COLLECTION_SLUG_ATTEMPTS = 20;

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Trim again after cutting to the budget: the slice can land on a separator,
  // and the trim above ran before it, so the result would otherwise end in a
  // dash. That reads as a typo in the URL and turns the numbered candidates
  // into `name--2` rather than `name-2`. Only the tail needs the second pass —
  // a leading dash cannot appear, since the first character of a trimmed slug
  // is always alphanumeric.
  return slug.slice(0, MAX_COLLECTION_SLUG_LENGTH).replace(/-+$/, "");
}

/**
 * Base slug for a new collection. Reserved handles (which would collide with
 * app routes such as /collections or /admin) and seeds that do not slugify at
 * all fall back to a random slug rather than producing an empty or reserved
 * base.
 */
export function collectionSlugBase(seed: string): string {
  const base = slugify(seed);
  if (!base || validateProfileHandle(base) === "reserved") {
    return `collection-${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return base;
}

/** Candidate slugs to probe for availability, in preference order. */
export function collectionSlugCandidates(
  base: string,
  attempts = COLLECTION_SLUG_ATTEMPTS,
): string[] {
  return Array.from({ length: attempts }, (_, index) =>
    index === 0 ? base : `${base}-${index + 1}`,
  );
}

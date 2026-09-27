import { MAX_COLLECTION_PETS } from "@/lib/collection-constants";
import { isSafeExternalUrl } from "@/lib/url-allowlist";

export { MAX_COLLECTION_PETS };

export const MAX_COLLECTION_TITLE = 80;
export const MAX_COLLECTION_DESCRIPTION = 280;

/**
 * Ceilings on the raw petSlugs array before any element is examined. These are
 * payload-size bounds, not the collection limit: MAX_COLLECTION_PETS is enforced
 * on the deduplicated result, and the two must not be confused.
 *
 * A duplicate-heavy caller is legal — the list is deduplicated below, and a
 * client that resends its selection alongside a new one repeats entries. So
 * both bounds sit far above any legitimate payload: 24 members would have to
 * repeat 500x to reach them. Rejecting on either reports a shape error
 * (`pet_slugs`) rather than the cap, which would misdescribe the request.
 *
 * The character ceiling is the one that normally binds: real slugs run well
 * over 8 characters, so 96k chars is reached before 12k entries. The entry
 * ceiling is the cheaper guard that catches a flood of tiny or non-string
 * elements without summing them first, and it is checked first because its
 * length test is O(1). Every entry then goes through a trim, a regex and a Set,
 * so together the two hold a worst-case admissible request to tens of ms.
 */
const MAX_COLLECTION_PET_SLUG_CHARS = 96_000;
/** Checked first: O(1), so a flood of elements is rejected without summing. */
const MAX_COLLECTION_PET_SLUG_ENTRIES = 12_000;

export type CollectionInput = {
  title: unknown;
  description?: unknown;
  petSlugs?: unknown;
};

export type CollectionRequestBody = {
  title?: unknown;
  description?: unknown;
  petSlugs?: unknown;
  allApproved?: unknown;
  externalUrl?: unknown;
  coverPetSlug?: unknown;
};

export function isCollectionRequestBody(
  value: unknown,
): value is CollectionRequestBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  return (
    body.allApproved === undefined || typeof body.allApproved === "boolean"
  );
}

export function normalizeCollectionExternalUrl(
  value: unknown,
): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.length > 300) return false;
  if (!isSafeExternalUrl(raw)) return false;
  return new URL(raw).toString();
}

export function normalizeCollectionCover(
  value: unknown,
): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) ? raw : false;
}

export type NormalizedCollectionInput = {
  title: string;
  description: string;
  petSlugs: string[];
};

/**
 * Resolve the cover for a write that also replaces the member list.
 *
 * `requestedCover` carries three states and they must stay distinct:
 * `undefined` when the request did not name the field, `null` when it named it
 * blank (an explicit clear), and a slug otherwise. Carrying only the normalized
 * value merged the first two — normalizeCollectionCover maps both to null — so
 * a request that asked to clear the cover fell through to the default below and
 * silently set it to the first member instead.
 *
 * An omitted cover keeps the stored one while it is still a member and falls
 * back to the first member; a cleared cover stays null.
 */
export function resolveCollectionCover(
  requestedCover: string | null | undefined,
  petSlugs: string[],
  existingCover: string | null = null,
): string | null {
  if (requestedCover !== undefined) return requestedCover;
  if (existingCover !== null && petSlugs.includes(existingCover)) {
    return existingCover;
  }
  return petSlugs[0] ?? null;
}

export function normalizeCollectionInput(
  input: CollectionInput,
): NormalizedCollectionInput {
  const title = normalizeCollectionTitle(input.title);
  const description = normalizeCollectionDescription(input.description);
  const petSlugs = normalizeCollectionPetSlugs(input.petSlugs);
  return { title, description, petSlugs };
}

/**
 * Validate a partial edit, touching only the fields the request actually sent.
 *
 * The edit routes used to substitute the stored value for every omitted field
 * and then run the full validator over the merge. That widened the checks past
 * the request: a row whose stored description exceeded the limit — which the
 * database permits, and the ops scripts write directly — failed
 * `description_length` on a rename or a cover-only edit, naming a field the
 * request never contained, and resending the value did not help because the
 * stored one was already over the limit. The row became uneditable through the
 * API. Only the fields in the body are validated here; the routes keep writing
 * just those, so nothing depends on the merged value.
 *
 * A field that is absent stays absent in the result, which is how the callers
 * distinguish "not sent" from "sent blank".
 */
export function normalizeCollectionPatch(
  input: CollectionInput,
): Partial<NormalizedCollectionInput> {
  const patch: Partial<NormalizedCollectionInput> = {};
  if (input.title !== undefined) {
    patch.title = normalizeCollectionTitle(input.title);
  }
  if (input.description !== undefined) {
    patch.description = normalizeCollectionDescription(input.description);
  }
  if (input.petSlugs !== undefined) {
    patch.petSlugs = normalizeCollectionPetSlugs(input.petSlugs);
  }
  return patch;
}

function normalizeCollectionTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title.length < 2 || title.length > MAX_COLLECTION_TITLE) {
    throw new Error("title_length");
  }
  return title;
}

function normalizeCollectionDescription(value: unknown): string {
  if (value !== undefined && typeof value !== "string") {
    throw new Error("description_type");
  }
  const description = typeof value === "string" ? value.trim() : "";
  if (description.length > MAX_COLLECTION_DESCRIPTION) {
    throw new Error("description_length");
  }
  return description;
}

function normalizeCollectionPetSlugs(value: unknown): string[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw new Error("pet_slugs");
  }
  // Bound the walk. Every element goes through a trim, a regex and a Set, so
  // an unbounded array is a cheap CPU amplification vector: 500k entries took
  // ~300ms before this guard. This is only a size bound — the collection cap
  // is a growth limit that depends on what the row already stores, so it
  // cannot be decided here. Callers apply collectionPetLimitExceeded().
  if (Array.isArray(value)) {
    // Length first: it is O(1), so a huge array is rejected without walking
    // it. Only then is the O(n) character sum worth paying.
    if (value.length > MAX_COLLECTION_PET_SLUG_ENTRIES) {
      throw new Error("pet_slugs");
    }
    let totalChars = 0;
    for (const raw of value) {
      if (typeof raw === "string") totalChars += raw.length;
    }
    if (totalChars > MAX_COLLECTION_PET_SLUG_CHARS) {
      throw new Error("pet_slugs");
    }
  }
  const petSlugs: string[] = [];
  const seen = new Set<string>();
  for (const raw of value ?? []) {
    if (typeof raw !== "string") throw new Error("pet_slug");
    const slug = raw.trim().toLowerCase();
    if (!slug) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error("pet_slug");
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      petSlugs.push(slug);
    }
  }
  return petSlugs;
}

/**
 * Error codes normalizeCollectionInput is allowed to report to a client.
 * collection_pet_limit is not here: the cap is a growth limit decided against
 * the stored members, so the validator cannot raise it.
 */
const COLLECTION_INPUT_ERROR_CODES = new Set([
  "description_length",
  "description_type",
  "pet_slug",
  "pet_slugs",
  "title_length",
]);

/**
 * Map a normalizeCollectionInput failure to a client-safe code. The routes
 * used to return `(error as Error).message` directly, which would leak any
 * future unexpected throw (and misreport it as a 400).
 */
export function collectionInputErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return COLLECTION_INPUT_ERROR_CODES.has(message) ? message : "invalid_body";
}

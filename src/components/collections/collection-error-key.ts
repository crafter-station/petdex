// Maps the internal error codes `/api/profile/collection` puts on the wire to
// the keys under the `ownerCollections` message namespace.
//
// The route answers with a code (`invalid_url`, `collection_pet_limit`), never a
// sentence, so a panel that renders the code directly — or through
// `error.replace(/_/g, " ")`, which yields "INVALID URL" — shows a non-sentence
// in every language. Both collection surfaces hit the same route with the same
// body: the create/edit manager and the featured-collection editor. The map
// lives here rather than once per panel, so a code added to the route is
// translated in one place.
//
// An unrecognised code returns null; the caller renders the route's raw code in
// a fallback sentence rather than dropping the message, so a new server code is
// visible.
export const COLLECTION_ERROR_KEYS: Record<string, string> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  not_found: "notFound",
  featured_not_editable: "featuredNotEditable",
  invalid_url: "invalidUrl",
  collection_pet_limit: "collectionPetLimit",
  pet_not_owned_or_approved: "petNotOwnedOrApproved",
  collection_cap_reached: "collectionCapReached",
  collection_slug_conflict: "collectionSlugConflict",
  empty_pet_slugs: "emptyPetSlugs",
};

export function collectionErrorKey(code: string | undefined): string | null {
  return code ? (COLLECTION_ERROR_KEYS[code] ?? null) : null;
}

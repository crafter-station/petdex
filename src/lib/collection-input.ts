export type CollectionPatch = {
  title?: string;
  description?: string;
  externalUrl?: string | null;
  coverPetSlug?: string | null;
  petSlugs?: string[];
};

export function normalizeCollectionPatch(
  input: unknown,
): { value: CollectionPatch } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "invalid_body" };
  }
  const body = input as Record<string, unknown>;
  const value: CollectionPatch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string") return { error: "title_length" };
    const title = body.title.trim();
    if (title.length < 2 || title.length > 80) return { error: "title_length" };
    value.title = title;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string")
      return { error: "description_length" };
    const description = body.description.trim();
    if (description.length > 280) return { error: "description_length" };
    value.description = description;
  }
  if (body.externalUrl !== undefined) {
    if (body.externalUrl !== null && typeof body.externalUrl !== "string")
      return { error: "invalid_url" };
    const raw = (body.externalUrl ?? "").trim();
    if (!raw) value.externalUrl = null;
    else {
      try {
        const url = new URL(raw);
        if (
          raw.length > 300 ||
          (url.protocol !== "https:" && url.protocol !== "http:")
        )
          return { error: "invalid_url" };
        value.externalUrl = url.toString();
      } catch {
        return { error: "invalid_url" };
      }
    }
  }
  if (body.coverPetSlug !== undefined) {
    if (body.coverPetSlug !== null && typeof body.coverPetSlug !== "string")
      return { error: "cover_not_in_collection" };
    value.coverPetSlug = body.coverPetSlug?.trim().toLowerCase() || null;
  }
  if (body.petSlugs !== undefined) {
    if (
      !Array.isArray(body.petSlugs) ||
      body.petSlugs.some((slug) => typeof slug !== "string" || !slug.trim())
    )
      return { error: "invalid_pet_slugs" };
    value.petSlugs = [
      ...new Set(
        body.petSlugs.map((slug: string) => slug.trim().toLowerCase()),
      ),
    ];
    if (value.petSlugs.length === 0) return { error: "empty_pet_list" };
  }
  return { value };
}

export function resolveCollectionCover(
  petSlugs: string[],
  requested: string | null | undefined,
  current: string | null = null,
): string | null {
  if (requested !== undefined) return requested;
  return current && petSlugs.includes(current)
    ? current
    : (petSlugs[0] ?? null);
}

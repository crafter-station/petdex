export type CollectionListingSortKey = "size" | "title";

const PRIORITY_COLLECTION_SLUGS = [
  "franchise-pokemon",
  "franchise-league-of-legends",
  "franchise-jojos-bizarre-adventure",
];

const priorityIndex = new Map(
  PRIORITY_COLLECTION_SLUGS.map((slug, index) => [slug, index]),
);

export function sortCollectionListingItems<
  T extends { slug: string; title: string; petCount: number },
>(items: T[], sort: CollectionListingSortKey): T[] {
  return [...items].sort((a, b) => {
    const ai = priorityIndex.get(a.slug);
    const bi = priorityIndex.get(b.slug);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    if (sort === "size") return b.petCount - a.petCount;
    return a.title.localeCompare(b.title);
  });
}

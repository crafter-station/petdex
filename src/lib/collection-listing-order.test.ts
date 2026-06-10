import { describe, expect, it } from "bun:test";

import { sortCollectionListingItems } from "@/lib/collection-listing-order";

describe("collection listing order", () => {
  it("keeps priority collections first before size order", () => {
    const sorted = sortCollectionListingItems(
      [
        item("category-small", "Small", 2),
        item("franchise-league-of-legends", "League", 1),
        item("category-large", "Large", 100),
        item("franchise-pokemon", "Pokemon", 5),
      ],
      "size",
    );

    expect(sorted.map((collection) => collection.slug)).toEqual([
      "franchise-pokemon",
      "franchise-league-of-legends",
      "category-large",
      "category-small",
    ]);
  });

  it("keeps priority collections first before title order", () => {
    const sorted = sortCollectionListingItems(
      [
        item("zeta", "Zeta", 50),
        item("franchise-jojos-bizarre-adventure", "Jojo", 1),
        item("alpha", "Alpha", 1),
      ],
      "title",
    );

    expect(sorted.map((collection) => collection.slug)).toEqual([
      "franchise-jojos-bizarre-adventure",
      "alpha",
      "zeta",
    ]);
  });
});

function item(slug: string, title: string, petCount: number) {
  return { slug, title, petCount };
}

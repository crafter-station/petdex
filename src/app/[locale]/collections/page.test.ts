import { expect, test } from "bun:test";
import { join } from "node:path";

test("every listed collection has a preview beyond the first 24 cards", () => {
  // Isolate module mocks so they cannot replace database or layout modules
  // in other tests running in the same Bun process.
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
import { mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const collections = Array.from({ length: 30 }, (_, index) => ({
  slug: "collection-" + index,
  title: "Collection " + index,
  description: "Collection preview regression fixture",
  ownerId: null,
  externalUrl: null,
  coverPetSlug: null,
  petCount: 30 - index,
}));
const withPets = (collection) => ({
  ...collection,
  pets: [{
    slug: "pet-" + collection.slug,
    displayName: "Pet " + collection.title,
    spritesheetPath: "/fixtures/" + collection.slug + ".webp",
  }],
});

mock.module("next-intl/server", () => ({
  getTranslations: async () => (key) => key,
}));
mock.module("@/lib/collections", () => ({
  getCollectionListingMetadata: async () => collections,
  getCollectionListingPreviewsBySlugs: async (slugs) =>
    collections.filter((collection) => slugs.includes(collection.slug)).map(withPets),
}));
mock.module("@/lib/owner-credit", () => ({
  resolveOwnerCredits: async () => new Map(),
}));
mock.module("@/components/site-header", () => ({ SiteHeader: () => null }));
mock.module("@/components/site-footer", () => ({ SiteFooter: () => null }));

const { default: CollectionsPage } = await import("./src/app/[locale]/collections/page");
const page = await CollectionsPage({ params: Promise.resolve({ locale: "en" }) });
console.log(renderToStaticMarkup(page));
`,
    ],
    { cwd: join(import.meta.dir, "../../../..") },
  );

  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const html = result.stdout.toString();
  expect(html.match(/<article\b/g)).toHaveLength(30);
  expect(html.match(/class="pet-sprite-static"/g)).toHaveLength(30);
  expect(html).toContain("/fixtures/collection-24.webp");
  expect(html).toContain("/fixtures/collection-29.webp");
});

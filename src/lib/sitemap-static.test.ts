import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `/sitemap.xml` is a prerendered route — the build reports `○`. The build
// only keeps it static while everything it reaches is static too, and the
// sitemap filters its facet entries on the approved-pet counts.
//
// Reaching those counts through `loadFacets` — which reads Upstash before
// falling back to the `unstable_cache`d computation — made Next render the
// whole route dynamically. The build then reported `/sitemap.xml` as `ƒ`, and
// every request recomputed `lastModified: new Date()`, so `<lastmod>` in the
// XML changed on each fetch. That is the opposite of what the element means:
// it is supposed to be the page's last content change, and a value that moves
// on every request is one crawlers learn to ignore.
//
// `loadFacetsForSitemap` is the same computation without the Redis hop. This
// asserts the sitemap uses it, because the regression is invisible in every
// unit test — it only shows up in the build's route table.
//
// One thing this file does NOT claim: that the route revalidates on the
// `86400` it declares. Next takes the *lowest* revalidate across a route's
// fetches, and `computeFacets` is cached at 300 for the search routes, so the
// effective period is 300s and `lastmod` moves each regeneration. That is
// better than `main`, where the same route recomputed it per request, but it
// is not frozen at build time. The build's route table prints it as `5m`.

const SITEMAP = join(import.meta.dir, "..", "app", "sitemap.ts");
const PET_SEARCH = join(import.meta.dir, "pet-search.ts");
const STICKER_EXPORT = join(import.meta.dir, "sticker-export.ts");

describe("the sitemap stays statically renderable", () => {
  const sitemap = readFileSync(SITEMAP, "utf8");

  test("it does not call the Redis-backed loadFacets", () => {
    expect(
      sitemap,
      "loadFacets reads Upstash, which makes /sitemap.xml render dynamically " +
        "and moves <lastmod> to request time. Use loadFacetsForSitemap.",
    ).not.toMatch(/\bloadFacets\s*\(/);
  });

  test("it uses the Redis-free facet accessor", () => {
    expect(sitemap).toContain("loadFacetsForSitemap");
  });

  test("the two accessors are genuinely different", () => {
    const source = readFileSync(PET_SEARCH, "utf8");
    const forSitemap = source.match(
      /export const loadFacetsForSitemap = \(\): Promise<SearchFacets> =>\s*([^\n]+)/,
    );
    const regular = source.match(
      /const loadFacets = \(\): Promise<SearchFacets> =>\s*([^\n]+)/,
    );
    expect(forSitemap?.[1]).toContain("computeFacets()");
    expect(regular?.[1]).toContain("cachedAggregate(");
  });

  test("facet entries are filtered on the approved-pet counts", () => {
    // A vibe or kind with no approved pets calls `notFound()`. Eight of the
    // twelve vibes are in that state today, so listing them would advertise
    // eight 404s to crawlers. The filter is what keeps a facet entry and a
    // reachable page the same set, and it is invisible to every other test —
    // the sitemap route is only driven against a populated database.
    //
    // Asserted structurally: the map is applied through `.filter(...)` with
    // the `populated` predicate, so a change back to a bare `.map` (which is
    // what shipped the 404s) fails here.
    for (const facet of ["vibes", "kinds"]) {
      expect(
        sitemap,
        `PET_${facet.toUpperCase()} entries must be filtered on ` +
          `\`facets.${facet}\` having approved pets, or the sitemap lists ` +
          "facets whose pages call notFound().",
      ).toMatch(
        new RegExp(
          `PET_${facet.toUpperCase()}\\.filter\\(\\s*\\([^)]*\\)\\s*=>\\s*` +
            `populated\\(facets\\.${facet}`,
        ),
      );
    }
    // The predicate has to test > 0, not merely presence — a zero count is a
    // key that exists and is still not indexable.
    expect(sitemap).toMatch(/counts\[slug\] \?\? 0\) > 0/);
  });

  test("sticker collections are listed, on the same gate the page uses", () => {
    // `/stickers/[collection]` is reachable from the header nav whenever the
    // explorer is on, and it declares `index, follow` by inheriting the layout
    // — but nothing listed it, so a crawler that did not start from the
    // homepage had no way in. The header link is the only thing carrying it.
    //
    // Two conditions have to hold together, or the entry is worse than the
    // omission: the sitemap must list the collections the page can serve, and
    // only those. An explorer-off deployment 404s every slug, and a collection
    // with no published pets calls `notFound()` — so the same two-way pairing
    // the facet entries above rely on.
    expect(
      sitemap,
      "Sticker collections are linked from the header when the explorer is " +
        "enabled but appear in no sitemap entry, so the header link is the " +
        "only path a crawler has to them.",
    ).toContain("getStickerSitemapEntries");

    // Enumerating from the accessor, not from a hardcoded slug: `demoCollection`
    // accepts only "claude", so a bare list would advertise that one slug in
    // every deployment, including the ones where it 404s.
    expect(
      sitemap,
      "Sticker entries must come from getStickerSitemapEntries(), which " +
        "applies the same per-pet eligibility the page applies. A hardcoded " +
        "slug list would list a collection whose pets are not published.",
    ).toMatch(/\.\.\.stickerEntries\b/);

    // The gate lives in the accessor rather than the sitemap, so it is checked
    // where it is written: with the explorer off the page calls `notFound()`
    // for every slug, and the accessor has to return nothing to match.
    const accessor = readFileSync(STICKER_EXPORT, "utf8");
    const body = accessor.slice(
      accessor.indexOf("export async function getStickerSitemapEntries"),
    );
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(
      fn,
      "The sticker accessor must return nothing when the explorer is off, " +
        "or the deployment serving 404s is the one advertising them.",
    ).toContain("isStickerExplorerEnabled");
    // And it has to apply the *per-pet* eligibility the page applies, not just
    // enumerate slugs: a collection whose every pet fails the export or
    // publication check calls `notFound()` on the page, so listing it would
    // advertise a 404. Both predicates are required — one guards the export
    // approval, the other the published artifact set.
    expect(
      fn,
      "Sticker entries must be filtered through the same per-pet predicates " +
        "the page uses (isCurrentStickerExportAllowed and " +
        "isCurrentStickerPublication), or a collection whose pets are not " +
        "published is listed while its page 404s.",
    ).toContain("isCurrentStickerExportAllowed");
    expect(fn).toContain("isCurrentStickerPublication");
  });

  test("the sticker accessor is Redis-free", () => {
    // The same constraint as the facet entries, asserted at the accessor: a
    // Redis hop anywhere in this chain makes `/sitemap.xml` dynamic again.
    const accessor = readFileSync(STICKER_EXPORT, "utf8");
    const body = accessor.slice(
      accessor.indexOf("export async function getStickerSitemapEntries"),
    );
    expect(
      body.slice(0, body.indexOf("\n}")),
      "The sitemap accessor must not read Upstash — see the loadFacets note " +
        "above for what that costs.",
    ).not.toMatch(/\bcachedAggregate\b|loadFacets|Upstash/i);
  });
});

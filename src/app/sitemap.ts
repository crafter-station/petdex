import type { MetadataRoute } from "next";

import { getCollectionSitemapEntries } from "@/lib/collections";
import {
  buildAbsoluteLocaleAlternates,
  buildAbsoluteUrl,
} from "@/lib/locale-routing";
import { loadFacetsForSitemap } from "@/lib/pet-search";
import { getPetSitemapEntries } from "@/lib/pets";
import { getStickerSitemapEntries } from "@/lib/sticker-export";
import { PET_KINDS, PET_VIBES } from "@/lib/types";

export const revalidate = 86400;

type EntryInput = {
  pathname: string;
  // Optional on purpose: a static page's lastModified used to be `now`,
  // so every revalidate rewrote the whole line and "changed recently"
  // stopped meaning anything. Static entries omit it; dynamic entries
  // (pets/collections) pass their real timestamps.
  lastModified?: Date;
  changeFrequency: NonNullable<
    MetadataRoute.Sitemap[number]["changeFrequency"]
  >;
  priority: number;
};

function expandLocalizedEntry(entry: EntryInput): MetadataRoute.Sitemap {
  return [
    {
      url: buildAbsoluteUrl(entry.pathname, "en"),
      lastModified: entry.lastModified,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: buildAbsoluteLocaleAlternates(entry.pathname),
    },
    {
      url: buildAbsoluteUrl(entry.pathname, "es"),
      lastModified: entry.lastModified,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: buildAbsoluteLocaleAlternates(entry.pathname),
    },
    {
      url: buildAbsoluteUrl(entry.pathname, "zh"),
      lastModified: entry.lastModified,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: buildAbsoluteLocaleAlternates(entry.pathname),
    },
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [pets, collections, stickerCollections] = await Promise.all([
    getPetSitemapEntries(),
    getCollectionSitemapEntries(),
    getStickerSitemapEntries(),
  ]);
  const now = new Date();

  const staticEntries: EntryInput[] = [
    {
      pathname: "/",
      changeFrequency: "daily",
      priority: 1,
    },
    {
      pathname: "/about",
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      pathname: "/docs",
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      pathname: "/brand",
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      pathname: "/leaderboard",
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      pathname: "/collections",
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      pathname: "/requests",
      changeFrequency: "daily",
      priority: 0.6,
    },
    // `/create` is deliberately absent: robots.txt disallows it, and a sitemap
    // entry for a disallowed URL is a Search Console error, not a hint.
    {
      pathname: "/legal/takedown",
      changeFrequency: "yearly",
      priority: 0.2,
    },
    // These three are indexable and prerendered but were missing here, so the
    // only way a crawler found them was by following a link. `/download` and
    // `/built-with` are linked from the header nav; `/legal/telemetry` is
    // reached from the CLI's telemetry notice rather than any page, which is
    // exactly the case a sitemap exists to cover.
    {
      pathname: "/download",
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      pathname: "/built-with",
      changeFrequency: "weekly",
      priority: 0.5,
    },
    {
      pathname: "/legal/telemetry",
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ];

  // `/community` is indexable exactly when the page is live: with no Discord
  // invite it calls `notFound()` and its metadata says `noindex`, and in
  // production the invite is set, so it answers 200 with `index, follow` while
  // being absent here — the one state a sitemap exists to prevent.
  //
  // Keyed on the Discord invite alone, not on either signal the page accepts.
  // The zh WeChat card makes only `/zh/community` live, and every entry below
  // expands to all three locales, so admitting that case would advertise two
  // 404s to cover one page; it is left unlisted rather than half-listed.
  if (process.env.NEXT_PUBLIC_DISCORD_INVITE_URL) {
    staticEntries.push({
      pathname: "/community",
      changeFrequency: "monthly",
      priority: 0.5,
    });
  }

  // A facet with no approved pets calls `notFound()`, so listing it advertises
  // a 404 — which is why the filter below is not cosmetic: every one of the
  // twelve vibes is populated in production today, but the set is data-driven
  // and a vibe can empty out (and on a fresh local seed most of them are). The
  // counts come from the same `unstable_cache`d aggregate the facet pages read.
  //
  // `loadFacetsForSitemap`, not `loadFacets`: the latter also reads Upstash,
  // and any Redis call from this route makes Next render it dynamically —
  // `/sitemap.xml` went from a static `○` to a dynamic `ƒ`, and its `lastmod`
  // from regeneration time to request time. (The effective period is 300s, not
  // the 86400 below: Next takes the lowest revalidate in the route's fetches,
  // and this aggregate is cached at 300 for the search pages.)
  const facets = await loadFacetsForSitemap();
  const populated = (counts: Record<string, number>, slug: string) =>
    (counts[slug] ?? 0) > 0;

  const vibeEntries: EntryInput[] = PET_VIBES.filter((vibe) =>
    populated(facets.vibes, vibe),
  ).map((vibe) => ({
    pathname: `/vibe/${vibe}`,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const kindEntries: EntryInput[] = PET_KINDS.filter((kind) =>
    populated(facets.kinds, kind),
  ).map((kind) => ({
    pathname: `/kind/${kind}`,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const petEntries: EntryInput[] = pets.map((pet) => ({
    pathname: `/pets/${pet.slug}`,
    lastModified: pet.importedAt ? new Date(pet.importedAt) : now,
    changeFrequency: "weekly",
    priority: pet.featured ? 0.9 : 0.6,
  }));

  const collectionEntries: EntryInput[] = collections.map((collection) => ({
    pathname: `/collections/${collection.slug}`,
    lastModified: collection.updatedAt ?? now,
    changeFrequency: "weekly",
    priority: collection.featured ? 0.8 : 0.5,
  }));

  // `/stickers/<slug>` answers 200 with `index, follow` whenever the explorer is
  // on and the collection has a pet the current sticker policy publishes, and
  // 404s otherwise. The accessor applies both conditions — with the explorer
  // off it returns nothing at all — so this lists exactly the pages that exist
  // and never advertises the 404s a bare slug list would.
  //
  // The header links `/stickers/claude` in every explorer deployment, so before
  // this the only way a crawler reached these was by starting from the homepage.
  const stickerEntries: EntryInput[] = stickerCollections.map((collection) => ({
    pathname: `/stickers/${collection.slug}`,
    lastModified: collection.updatedAt ?? now,
    changeFrequency: "weekly",
    priority: 0.5,
  }));

  return [
    ...staticEntries,
    ...vibeEntries,
    ...kindEntries,
    ...petEntries,
    ...collectionEntries,
    ...stickerEntries,
  ].flatMap(expandLocalizedEntry);
}

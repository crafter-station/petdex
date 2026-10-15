import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildAbsoluteLocaleAlternates,
  buildAbsoluteUrl,
  buildLocaleAlternates,
  SITE_URL,
} from "@/lib/locale-routing";

// Guard against the legacy domain leaking back into any crawler-facing
// SEO output during/after the petdex.crafter.run -> petdex.dev migration.
// The legacy host should survive ONLY in redirect/proxy compatibility
// config (next.config.ts redirects, proxy.ts), never in canonical URLs,
// sitemap, robots, hreflang, Open Graph, Twitter cards, or JSON-LD.

const CANONICAL_ORIGIN = "https://petdex.dev";
const LEGACY_HOST = "petdex.crafter.run";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Every file that emits a public SEO artifact. If a new SEO surface is
// added, list it here so the guard keeps covering it.
const SEO_SOURCE_FILES = [
  "src/lib/locale-routing.ts",
  "src/app/sitemap.ts",
  "src/app/robots.ts",
  "src/app/layout.tsx",
  "src/app/[locale]/layout.tsx",
  "src/components/layout/json-ld.tsx",
  "src/app/[locale]/page.tsx",
  "src/app/[locale]/about/page.tsx",
  "src/app/[locale]/brand/page.tsx",
  "src/app/[locale]/built-with/page.tsx",
  "src/app/[locale]/collections/page.tsx",
  "src/app/[locale]/collections/[slug]/page.tsx",
  "src/app/[locale]/community/page.tsx",
  "src/app/[locale]/create/page.tsx",
  "src/app/[locale]/docs/page.tsx",
  "src/app/[locale]/download/page.tsx",
  "src/app/[locale]/kind/[kind]/page.tsx",
  "src/app/[locale]/leaderboard/page.tsx",
  "src/app/[locale]/legal/takedown/page.tsx",
  "src/app/[locale]/legal/telemetry/page.tsx",
  "src/app/[locale]/pets/[slug]/page.tsx",
  "src/app/[locale]/requests/page.tsx",
  "src/app/[locale]/stickers/[collection]/page.tsx",
  "src/app/[locale]/submit/page.tsx",
  "src/app/[locale]/u/[handle]/page.tsx",
  "src/app/[locale]/vibe/[vibe]/page.tsx",
  "src/app/[locale]/collections/[slug]/opengraph-image.tsx",
  "src/app/[locale]/download/opengraph-image.tsx",
  "src/app/[locale]/pets/[slug]/opengraph-image.tsx",
  "src/app/[locale]/u/[handle]/opengraph-image.tsx",
  "src/components/collections/collection-action-menu.tsx",
  "src/components/pets/pet-action-menu.tsx",
  "src/components/profile/profile-share-button.tsx",
];

describe("SEO canonical domain", () => {
  it("locale-routing SITE_URL is the canonical origin", () => {
    expect(SITE_URL).toBe(CANONICAL_ORIGIN);
  });

  it("absolute sitemap URLs resolve to the canonical origin", () => {
    expect(buildAbsoluteUrl("/", "en")).toBe(`${CANONICAL_ORIGIN}/`);
    expect(buildAbsoluteUrl("/pets/cai-chao", "zh")).toBe(
      `${CANONICAL_ORIGIN}/zh/pets/cai-chao`,
    );
  });

  it("hreflang alternates are all on the canonical origin", () => {
    const { languages } = buildAbsoluteLocaleAlternates("/pets/cai-chao");
    for (const url of Object.values(languages)) {
      expect(url.startsWith(`${CANONICAL_ORIGIN}/`)).toBe(true);
      expect(url).not.toContain(LEGACY_HOST);
    }
  });

  it("no SEO source file references the legacy domain", () => {
    const offenders: string[] = [];
    for (const rel of SEO_SOURCE_FILES) {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      if (source.includes(LEGACY_HOST)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
  // hreflang has to be spelled one way. Two of the three placements Google
  // accepts are built here — the `<link rel="alternate">` elements Next renders
  // from `buildLocaleAlternates`, and the sitemap via
  // `buildAbsoluteLocaleAlternates` — so both are pinned together.
  it("spells the Chinese hreflang the script-qualified way", () => {
    for (const languages of [
      buildLocaleAlternates("/pets/cai-chao", "zh").languages,
      buildAbsoluteLocaleAlternates("/pets/cai-chao").languages,
    ]) {
      expect(Object.keys(languages)).toEqual([
        "en",
        "es",
        "zh-Hans",
        "x-default",
      ]);
      // A bare `zh` is a different tag, and it is what next-intl derives from
      // the locale key, so a regression to it is the failure this catches.
      expect(Object.keys(languages)).not.toContain("zh");
    }
  });

  // The third placement is next-intl's `Link` response header, which takes the
  // hreflang straight from the locale key and so can only ever say `zh` —
  // `alternateLinks` is a boolean with no mapping hook in next-intl 4.11. It
  // is therefore switched off, leaving the two consistent placements above as
  // the only ones that speak. Anchored on the `createMiddleware({…})` literal
  // rather than the bare setting, so a comment naming it cannot satisfy this.
  it("leaves next-intl's alternate-links header off in the proxy", () => {
    const proxy = readFileSync(join(REPO_ROOT, "src/proxy.ts"), "utf8");
    expect(proxy).toMatch(
      /createMiddleware\(\{[^}]*alternateLinks:\s*false[^}]*\}\)/,
    );
  });
});

// The OG image routes that render a sprite pass the URL to a loader that
// checks `isAllowedAssetUrl` first and only rewrites inside `fetchR2Asset`.
// A row still stored on a retired host was therefore rejected before it could
// be rewritten, and the sprite silently vanished from the collage.
// `u/[handle]` read the raw `spritesheetUrl` column while every sibling read
// the already-rewritten `spritesheetPath`, so it was the one route that hit
// this. These pin the rewrite at the call site.
describe("OG image routes rewrite sprite URLs before validating", () => {
  const OG_ROUTES = [
    "src/app/[locale]/pets/[slug]/opengraph-image.tsx",
    "src/app/[locale]/collections/[slug]/opengraph-image.tsx",
    "src/app/[locale]/u/[handle]/opengraph-image.tsx",
  ];

  for (const rel of OG_ROUTES) {
    it(`${rel} does not hand a raw spritesheetUrl to the loader`, () => {
      const source = readFileSync(join(REPO_ROOT, rel), "utf8");
      // Reading the raw DB column is the shape that broke: the loader's
      // guard rejects a legacy host before `fetchR2Asset` can rewrite it.
      expect(source, "reads the raw column").not.toMatch(
        /loadFirstFrameAsDataUrl\(\s*r\.spritesheetUrl\s*\)/,
      );
      expect(source).not.toMatch(
        /loadFirstFrameAsDataUrl\(\s*r\.spritesheetUrl\s*,/,
      );
    });
  }

  it("the handle route rewrites the column it reads", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/app/[locale]/u/[handle]/opengraph-image.tsx"),
      "utf8",
    );
    expect(source).toContain("toCurrentR2PublicUrl(r.spritesheetUrl)");
  });
});

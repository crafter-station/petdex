import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildAbsoluteLocaleAlternates,
  buildAbsoluteUrl,
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
  "src/components/json-ld.tsx",
  "src/app/[locale]/page.tsx",
  "src/app/[locale]/about/page.tsx",
  "src/app/[locale]/advertise/page.tsx",
  "src/app/[locale]/brand/page.tsx",
  "src/app/[locale]/built-with/page.tsx",
  "src/app/[locale]/collections/page.tsx",
  "src/app/[locale]/collections/[slug]/page.tsx",
  "src/app/[locale]/community/page.tsx",
  "src/app/[locale]/download/page.tsx",
  "src/app/[locale]/kind/[kind]/page.tsx",
  "src/app/[locale]/pets/[slug]/page.tsx",
  "src/app/[locale]/u/[handle]/page.tsx",
  "src/app/[locale]/vibe/[vibe]/page.tsx",
  "src/app/[locale]/collections/[slug]/opengraph-image.tsx",
  "src/app/[locale]/download/opengraph-image.tsx",
  "src/app/[locale]/pets/[slug]/opengraph-image.tsx",
  "src/app/[locale]/u/[handle]/opengraph-image.tsx",
  "src/components/collection-action-menu.tsx",
  "src/components/pet-action-menu.tsx",
  "src/components/profile-share-button.tsx",
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
});

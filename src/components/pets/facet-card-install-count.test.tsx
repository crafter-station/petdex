import { describe, expect, mock, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "use-intl";

import { formatLocalizedNumber } from "@/lib/format-number";
import type { SearchPet } from "@/lib/pet-search";

import en from "@/i18n/messages/en.json";
import es from "@/i18n/messages/es.json";
import zh from "@/i18n/messages/zh.json";

// The facet card's install label is the one place an abbreviated number meets
// an ICU `plural`. An earlier version handed the message only the display
// string ("1.5K"), so the plural selector coerced it and every pet past 1000
// installs rendered `NaN installs` on /kind/<kind> and /vibe/<vibe> — English
// and Spanish; Chinese has no plural arm so it read fine.
//
// Nothing caught it: the card's own guard reads source text, `i18n:check`
// parses messages without formatting them, and every fixture in the repo has a
// count in the hundreds at most, where `formatLocalizedNumber` returns a plain
// integer and the coercion happens to work. This renders the real card, with
// labels built the way `facet-page.tsx` builds them, at counts either side of
// the abbreviation threshold.

mock.module("server-only", () => ({}));

const { StaticFacetPetCard } = await import("./static-facet-pet-card");

const MESSAGES = { en, es, zh } as const;

function pet(installCount: number): SearchPet {
  return {
    slug: "byte-bunny",
    displayName: "Byte Bunny",
    description: "A bunny.",
    spritesheetPath: "https://assets.petdex.dev/pets/x/sprite.webp",
    zipUrl: null,
    soundUrl: null,
    featured: false,
    kind: "creature",
    vibes: [],
    tags: [],
    dominantColor: null,
    submittedBy: { name: "Someone" },
    source: "submit",
    approvedAt: null,
    spriteVersionNumber: 2,
    dexNumber: 1,
    metrics: { installCount, likeCount: 0, zipDownloadCount: 0 },
  } as unknown as SearchPet;
}

/** The card's markup, with labels wired exactly as `facet-page.tsx` wires them. */
function render(locale: "en" | "es" | "zh", installCount: number): string {
  const t = createTranslator({ locale, messages: MESSAGES[locale] as never });
  return renderToStaticMarkup(
    <StaticFacetPetCard
      pet={pet(installCount)}
      index={0}
      locale={locale}
      labels={{
        installs: (count, formatted) =>
          t("facetPages.cardInstalls" as never, { count, formatted } as never),
        discovered: t("facetPages.cardDiscovered" as never),
        discoveredTitle: t("facetPages.cardDiscoveredTitle" as never),
        byAuthor: (name) =>
          t("facetPages.cardByAuthor" as never, { name } as never),
        featured: t("facetPages.cardFeatured" as never),
        dexNumber: (number) =>
          t("facetPages.cardDexNumber" as never, { number } as never),
        openPet: (name) =>
          t("facetPages.cardOpenPet" as never, { name } as never),
        spriteStill: (name) =>
          t("facetPages.cardSpriteStill" as never, { name } as never),
        batchLabel: (month) =>
          t("facetPages.cardBatchLabel" as never, { month } as never),
        kinds: (
          MESSAGES[locale] as { taxonomy: { kinds: Record<string, string> } }
        ).taxonomy.kinds,
        vibes: (
          MESSAGES[locale] as { taxonomy: { vibes: Record<string, string> } }
        ).taxonomy.vibes,
      }}
    />,
  );
}

describe("facet card install label", () => {
  // 1 and 999 keep the plain integer; 1000+ switches to the K/M/千/万 form,
  // which is the value that used to reach the plural selector as text.
  const COUNTS = [1, 2, 999, 1000, 1500, 23_000, 2_300_000];

  for (const locale of ["en", "es", "zh"] as const) {
    for (const count of COUNTS) {
      test(`${locale} renders a count at ${count} without NaN`, () => {
        const html = render(locale, count);
        expect(html).not.toContain("NaN");
      });
    }
  }

  test("the plural distinguishes one from many", () => {
    expect(render("en", 1)).toContain("1 install");
    expect(render("en", 22)).toContain("22 installs");
    expect(render("es", 1)).toContain("1 instalación");
    expect(render("es", 22)).toContain("22 instalaciones");
  });

  test("a large count keeps its abbreviation", () => {
    expect(render("en", 1500)).toContain("1.5K installs");
    expect(render("en", 2_300_000)).toContain("2.3M installs");
    expect(render("es", 1500)).toContain("1.5K instalaciones");
    expect(render("zh", 1500)).toContain("1.5千 次安装");
    expect(render("zh", 2_300_000)).toContain("230万 次安装");
  });

  test("formatLocalizedNumber is what produces the abbreviated form", () => {
    // Pins the helper the card calls to the strings asserted above, so a
    // change to the abbreviation shows up here rather than silently moving
    // the test's targets.
    expect(formatLocalizedNumber(1500, "en")).toBe("1.5K");
    expect(formatLocalizedNumber(1500, "zh")).toBe("1.5千");
  });
});

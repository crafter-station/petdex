import { describe, expect, it } from "bun:test";

import en from "./messages/en.json";
import es from "./messages/es.json";
import zh from "./messages/zh.json";

const messagesByLocale = { en, es, zh };

describe("root metadata messages", () => {
  it("uses Next title template placeholders for every locale", () => {
    for (const [locale, messages] of Object.entries(messagesByLocale)) {
      const titleTemplate = messages.metadata.root.titleTemplate;

      expect(titleTemplate, locale).toContain("%s");
      expect(titleTemplate, locale).not.toContain("{title}");
    }
  });
});

// `[locale]/layout.tsx` sets Next's `title.template` to `%s | Petdex`, so every
// page title it does not override gets the brand appended for free. A page
// title that names the brand at either end therefore renders it twice:
// `Takedown | Petdex` became `Takedown | Petdex | Petdex`, and `Petdex
// leaderboard` became `Petdex leaderboard | Petdex`. The template owns the
// brand; a metadata title must not repeat it.
//
// Scoped to `*.metadata.title` keys, which is what `generateMetadata` reads.
// The visible `title` keys beside them — `leaderboard.title`, `home.title` —
// are page headings, not browser titles, and are meant to name the brand.
// Matching a brand anywhere would also flag a legitimate mid-title mention
// (`About Petdex: …`), so the rule is an *edge*: the template already puts
// one there, and two in a row is the defect.
describe("page titles leave the brand suffix to the template", () => {
  const BRAND_AT_EDGE = /^\s*Petdex\b|\bPetdex\s*$/;

  /** `*.metadata.title` values, with their dotted path. */
  function metadataTitles(value: unknown, path = ""): Array<[string, string]> {
    if (typeof value === "string") {
      const isMetadataTitle =
        /(^|\.)metadata\.title$/.test(path) && path !== "metadata.title";
      return isMetadataTitle ? [[path, value]] : [];
    }
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) =>
      metadataTitles(child, path ? `${path}.${key}` : key),
    );
  }

  for (const [locale, messages] of Object.entries(messagesByLocale)) {
    it(`${locale} does not repeat the brand in a page title`, () => {
      const offenders = metadataTitles(messages)
        .filter(([, value]) => BRAND_AT_EDGE.test(value))
        .map(([path, value]) => `${path} = ${JSON.stringify(value)}`);
      expect(
        offenders,
        "The title template appends `| Petdex`, so a metadata title that " +
          "starts or ends with the brand renders it twice. Drop the brand " +
          "from the title and let the template add it: " +
          offenders.join("; "),
      ).toEqual([]);
    });
  }

  it("the scan sees the metadata titles", () => {
    // A scan that matched nothing would pass for the wrong reason.
    expect(metadataTitles(messagesByLocale.en).length).toBeGreaterThan(10);
  });
});

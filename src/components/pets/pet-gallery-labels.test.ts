import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gallery card on the home page is a client component and *can* call
// `useTranslations`, which is what makes its hardcoded strings easy to miss:
// `StaticFacetPetCard` was fixed to take a `labels` prop, and the same
// "Discovered" badge here kept its English text and English tooltip, so the
// badge read "Discovered" on /es and /zh under a Chinese page.
//
// The `gallery` namespace is where this card already keeps its badge strings
// (`featuredTitle` sits in the same header), so these belong beside them
// rather than in `facetPages`, which the server-rendered facet card owns.

const GALLERY = join(import.meta.dir, "pet-gallery.tsx");
const MESSAGES = join(import.meta.dir, "../../i18n/messages");

describe("the gallery card takes its labels from messages", () => {
  const source = readFileSync(GALLERY, "utf8");

  test("the Discovered badge is translated", () => {
    expect(source).not.toContain(
      'title="Added on behalf of the original author',
    );
    expect(source).toContain('title={t("discoveredTitle")}');
    expect(source).toContain('{t("discovered")}');
  });

  test("no hardcoded English remains in a user-visible attribute", () => {
    // A `title`/`aria-label`/`placeholder`/`alt` holding a literal English
    // word is the shape the tooltip took. `aria-hidden` and `aria-label`
    // values that are not English copy are excluded by requiring a letter
    // after the quote and skipping known non-copy attributes.
    const offenders: string[] = [];
    source.split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const match = line.match(/\b(title|placeholder|alt)="([A-Za-z][^"]*)"/);
      if (match) offenders.push(`pet-gallery.tsx:${index + 1} ${match[0]}`);
    });
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  test("no bare English text node remains in the JSX", () => {
    // The strings this card shipped as bare text nodes — `Filters`, `Load
    // more`, `End of gallery · {total} shown`, `No. {dexLabel}` — sat alone
    // on their own line, so a scan for attribute literals never saw them and
    // they rendered in English on /es and /zh. A line whose entire content is
    // a capitalised English phrase (optionally with an interpolation) and
    // which contains no tag or attribute is a text node the JSX will print.
    const TEXT_NODE = /^\s*([A-Z][A-Za-z'’:·]*)(\s*·?\s*\{[^}]*\})?\s*$/;
    const offenders: string[] = [];
    source.split("\n").forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // Anything with JSX syntax on it is not a bare text node.
      if (/[<>=;()[\]]/.test(line)) return;
      if (TEXT_NODE.test(line)) {
        offenders.push(`pet-gallery.tsx:${index + 1} ${line.trim()}`);
      }
    });
    expect(
      offenders,
      "These render on /es and /zh too, so they must come from the `gallery` " +
        "messages via `t()`. Offenders: " +
        offenders.join("; "),
    ).toEqual([]);
  });

  test("no multi-line English sentence sits in a JSX text node", () => {
    // A JSX text run: prose between a `>` that closes a tag and the next `<`,
    // with no brace in between (a `{` means a JS expression, so it is not a
    // plain text node). `[^<>{}]` keeps the match from spanning tags or
    // expressions, which is what let a first attempt swallow unrelated code.
    //
    // TypeScript puts `>` in generics (`Set<string>`) and `=>` in arrows, so a
    // run is only prose when it carries none of the punctuation code has and
    // sentences do not: `;`, `=`, `(`, `)`, quotes, `:`, or `?`.
    const JSX_TEXT = />([^<>{}]+)</g;
    const CODE_PUNCT = /[;=()"'?:]/;
    const offenders: string[] = [];
    for (const match of source.matchAll(JSX_TEXT)) {
      const text = match[1].replace(/\s+/g, " ").trim();
      if (CODE_PUNCT.test(text)) continue;
      // Three or more English words is prose; fewer is a stray token like `·`
      // or a unit, which is not a translation defect.
      if ((text.match(/[A-Za-z]{2,}/g) ?? []).length < 3) continue;
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`pet-gallery.tsx:${line} ${text}`);
    }
    expect(
      offenders,
      "Prose directly inside JSX renders as-is on every locale. Route it " +
        "through `t()` instead. Offenders: " +
        offenders.join(" | "),
    ).toEqual([]);
  });

  test("the sort labels are translated, not a module-level English map", () => {
    // `SORT_LABELS` was a `Record<SortKey, string>` of English words, so every
    // sort option showed in English regardless of locale. The map now holds
    // message keys and the text comes from `t()`.
    expect(source).not.toMatch(/SORT_LABELS/);
    expect(source).toMatch(/SORT_MESSAGE/);
    for (const key of [
      "sortCurated",
      "sortRecent",
      "sortPopular",
      "sortInstalled",
      "sortAlpha",
    ]) {
      expect(source, key).toContain(`"${key}"`);
    }
  });

  test("the accessible names are translated too", () => {
    // The visible copy moved into messages, but the names a screen reader
    // reads did not: the card link announced "Open <name>" and the sprite
    // `role="img"` announced "<name> animated" under a translated page, so a
    // /es or /zh screen-reader user heard English. An `aria-label` is as
    // user-visible as body text — the literal scan above cannot catch it
    // because the string is interpolated, not quoted.
    expect(source).not.toMatch(/aria-label=\{`Open \$\{/);
    expect(source).not.toMatch(/label=\{`\$\{[^}]+\} animated`\}/);
    expect(source).toContain('t("openPet", { name: pet.displayName })');
    expect(source).toContain('t("spriteAnimated", { name: pet.displayName })');
  });

  test("the filter group headings are translated", () => {
    // The desktop rows and the mobile sheet both label their groups with bare
    // English strings ("Type", "Version", "Vibe", "Color", "Era"), which is
    // what a /zh or /es visitor read above every chip row. The attribute scan
    // above cannot see them: the literal is a prop value on a wrapper
    // component, not a `title`/`alt`/`placeholder`.
    expect(source).not.toMatch(/<(FilterGroup|FilterRow) label="/);
    for (const key of [
      "filterType",
      "filterVersion",
      "filterVibe",
      "filterColor",
      "filterEra",
    ]) {
      expect(source, key).toContain(`t("${key}")`);
    }
  });

  test("the kind, vibe, and color chips render translated labels", () => {
    // The group headings were translated but the chips under them were not:
    // every kind/vibe/color chip fell through to the raw slug (`creature`,
    // `cozy`, `red`) on /es and /zh, because only the batch and version
    // groups passed a `labels` map. Every `tone="kind"|"vibe"|"color"` site
    // must now carry its map, which the counts pin: a new unlabeled group
    // fails the pairing.
    expect(source).toContain('useTranslations("taxonomy")');
    for (const [tone, map] of [
      ["kind", "kindLabels"],
      ["vibe", "vibeLabels"],
      ["color", "colorLabels"],
    ] as const) {
      const tones = source.match(new RegExp(`tone="${tone}"`, "g")) ?? [];
      const wired = source.match(new RegExp(`labels=\\{${map}\\}`, "g")) ?? [];
      expect(tones.length, tone).toBeGreaterThan(0);
      expect(wired.length, `${tone} chips without labels`).toBe(tones.length);
    }
  });

  test("the two long strings are translated rather than left as prose", () => {
    // `endOfGallery` was added to all three message files but never wired, and
    // the vibe-match banner was never extracted at all. Both rendered English
    // on /es and /zh; these pin the `t()` calls that replaced them.
    expect(source).toContain('t("endOfGallery", { total })');
    expect(source).toContain('t("vibeMatch", { query: trimmedQuery })');
    expect(source).not.toContain("End of gallery ·");
    expect(source).not.toContain("Closer to the");
  });

  test("the request errors are chosen by code, not the server's English", () => {
    // The route answers `{ error: "query_length", message: "Use 4-200
    // characters." }` and the client preferred `message`, so the server's
    // English overrode the translated fallback on every locale. The client now
    // maps `error` codes to `gallery` messages.
    expect(source).not.toMatch(/data\.message\s*\?\?/);
    for (const code of [
      "query_length",
      "query_invalid_characters",
      "query_not_searchable",
      "url_in_field",
      "blocked_content",
    ]) {
      expect(source, code).toContain(`${code}:`);
    }
  });

  test("every locale carries both keys", () => {
    for (const locale of ["en", "es", "zh"]) {
      const messages = JSON.parse(
        readFileSync(join(MESSAGES, `${locale}.json`), "utf8"),
      );
      expect(messages.gallery.discovered, locale).toBeTruthy();
      expect(messages.gallery.discoveredTitle, locale).toBeTruthy();
    }
  });
});

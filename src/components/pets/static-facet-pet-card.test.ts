import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The facet cards (`/kind/<kind>` and `/vibe/<vibe>`) are server components
// rendered at build time, so they cannot call `useTranslations` and were
// written with English literals baked into the JSX: the install count read
// "3 installs", the badge read "Discovered", and the author line read
// "by <name>". Every one of them rendered unchanged on /es and /zh — five
// "Discovered" badges and six "by" lines per Chinese facet page.
//
// `StaticCollectionCard`, the sibling component for collections, already
// takes its strings as a `labels` prop. That is the shape these follow now,
// with the values living in the `facetPages` messages.
//
// A literal-word scan can only see the obvious cases, so this asserts on the
// specific strings that shipped rather than trying to prove the absence of
// every possible English word.

const CARD = join(import.meta.dir, "static-facet-pet-card.tsx");

describe("the facet pet card takes its labels from messages", () => {
  const source = readFileSync(CARD, "utf8");

  test("no English UI literals remain in the JSX", () => {
    // The words this card shipped in English. They must reach the page
    // through `labels`, so a literal occurrence is a string or a JSX text
    // node — in either case, a place that renders the same on /es and /zh.
    //
    // The pattern must match a bare JSX text node, not only a word preceded
    // by a quote, brace, or `>`. The literals this card actually shipped —
    // an indented `Discovered`, `by {pet.submittedBy.name}`, and
    // `No. {dexLabel}` — sit alone on their own lines, and an earlier version
    // of this check required a delimiter on the same line, so it flagged only
    // the two `title="Featured"` attributes and reported the other three as
    // absent. A negative lookbehind for a word character keeps it from
    // matching inside identifiers (`.submittedBy`, `standby`) while still
    // catching the bare text node.
    const WORDS = /(?<![\w.$])(Discovered|Featured|FEATURED|by |No\.)/;
    const offenders: string[] = [];
    source.split("\n").forEach((line, index) => {
      // Comments may quote the old strings; only live code counts.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (WORDS.test(line)) {
        offenders.push(`static-facet-pet-card.tsx:${index + 1}`);
      }
    });
    expect(
      offenders,
      "These render on /es and /zh too, so they must come from the " +
        "`facetPages` messages via the `labels` prop. Offenders: " +
        offenders.join(", "),
    ).toEqual([]);
  });

  test("the 'Featured' tooltip is not a literal either", () => {
    // Guards the specific regression the scan above was blind to: the badge
    // text went through `labels.featured` while the tooltip beside it stayed
    // `title="Featured"`.
    expect(source).not.toMatch(/title\s*=\s*"Featured"/);
    expect(source.match(/title=\{labels\.featured\}/g)?.length).toBe(2);
  });

  test("the install count is pluralized from the raw number", () => {
    // The label takes the raw count as well as the abbreviated display value.
    // An earlier version of this card passed only the display string, which
    // made the ICU `plural` coerce "1.5K" and render `NaN installs` for every
    // pet past 1000 installs. It read correctly everywhere it was checked,
    // because a local database only holds small counts — the defect lived
    // outside the range the tests happened to sample.
    expect(source).toMatch(
      /labels\.installs\(\s*installCount\s*,\s*formattedInstallCount\s*\)/,
    );
  });

  test("the labels prop takes both the count and the display value", () => {
    expect(source).toMatch(
      /installs:\s*\(count:\s*number,\s*formatted:\s*string\)\s*=>\s*string/,
    );
  });

  test("every label the card renders comes from the prop", () => {
    for (const key of [
      "installs",
      "discovered",
      "discoveredTitle",
      "byAuthor",
      "featured",
      "dexNumber",
      "openPet",
      "spriteStill",
      "kinds",
      "vibes",
    ]) {
      expect(source, key).toContain(`labels.${key}`);
    }
  });

  test("the kind badge and vibe chips are not raw slugs", () => {
    // `{pet.kind}` and `#{vibe}` rendered the English slug on every locale
    // ("object", "#focused") while the eyebrow above the grid showed the
    // translated label. Both now resolve through the `taxonomy` maps, with
    // the slug kept only as the fallback for an unknown value.
    expect(source).not.toMatch(/\{pet\.kind\}/);
    expect(source).not.toMatch(/#\{vibe\}/);
    expect(source).toContain("labels.kinds[pet.kind] ?? pet.kind");
    expect(source).toContain("labels.vibes[vibe] ?? vibe");
  });

  test("the accessible names are not interpolated English either", () => {
    // The card's visible strings moved into `labels`, but two names a screen
    // reader reads did not: the link announced "Open <name>" and the sprite
    // `role="img"` announced "<name> sprite". The word scan above cannot see
    // them — the text is interpolated, not written as a literal — so they are
    // asserted directly.
    expect(source).not.toMatch(/aria-label=\{`Open \$\{/);
    expect(source).not.toMatch(/label=\{`\$\{[^}]+\} sprite`\}/);
    expect(source).toContain("labels.openPet(pet.displayName)");
    expect(source).toContain("labels.spriteStill(pet.displayName)");
  });
});

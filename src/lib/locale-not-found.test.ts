import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A URL that matches no route never reaches a page, so Next answers with its
// own bare "This page could not be found." in English on every locale.
// `[locale]/not-found.tsx` does not cover that case — it renders only when
// something calls `notFound()`, which is why `/es/pets/nope` was localized
// while `/es/nope` was not.
//
// The branded 404 that used to handle unmatched URLs was `src/app/not-found.tsx`,
// deleted in the next-intl scaffold (3966b368) when routes moved under
// `[locale]`. A root not-found cannot come back either: `app/layout.tsx`
// returns its children without `<html>`/`<body>`, so it would render outside a
// document. The catch-all route is what puts unmatched paths back inside the
// locale segment.
//
// These assertions are structural because the behavior they protect is only
// visible in a production build — no unit test renders the 404 for a URL that
// matches nothing.

const LOCALE_DIR = join(import.meta.dir, "..", "app", "[locale]");
const CATCH_ALL = join(LOCALE_DIR, "[...rest]", "page.tsx");

describe("unmatched URLs reach the localized 404", () => {
  test("a catch-all route exists under [locale]", () => {
    expect(
      existsSync(CATCH_ALL),
      "Without src/app/[locale]/[...rest]/page.tsx, an unmatched URL is " +
        "answered by Next's default English 404 on every locale.",
    ).toBe(true);
  });

  test("the catch-all delegates to notFound()", () => {
    // Comments are stripped first: the file's own doc comment names
    // `notFound()` while explaining the hand-off, so a bare `toContain`
    // passed even with the call deleted. What has to survive is the call.
    const code = readFileSync(CATCH_ALL, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // It must hand off rather than render: the branded UI belongs to
    // not-found.tsx, and rendering it here would duplicate it.
    expect(code).toContain("notFound()");
    expect(code).toMatch(/from "next\/navigation"/);
  });

  test("the branded 404 page it hands off to still exists", () => {
    expect(existsSync(join(LOCALE_DIR, "not-found.tsx"))).toBe(true);
  });

  test("there is no root not-found that would render without a document", () => {
    // `app/layout.tsx` returns children, so a root not-found has no
    // <html>/<body>. Its presence would mean the 404 broke again.
    expect(
      existsSync(join(import.meta.dir, "..", "app", "not-found.tsx")),
    ).toBe(false);
  });
});

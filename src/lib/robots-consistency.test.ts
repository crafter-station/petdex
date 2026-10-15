import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `robots.txt` and a page's `<meta name="robots">` are two ways to say the
// same thing, and they only work together if they agree. A `Disallow`ed URL
// is never crawled, so a crawler never reads the page's meta tag at all — a
// page that is disallowed but declares `index, follow` has no effect from
// either signal, and the contradiction only shows up when a person reads the
// two side by side.
//
// `/submit` and `/create` were in exactly that state: both are linked from
// the site header, both are listed in `robots.ts`'s `disallow`, and both
// inherited `index, follow` from the root layout. Every other private page in
// the app — my-pets, my-feedback, unsubscribe, the 404 — sets `index: false`
// explicitly; these two were the ones that were missed.

const APP = join(import.meta.dir, "..", "app");
const ROBOTS = join(APP, "robots.ts");

/** Paths named in `robots.ts`'s `disallow` array, as bare segments. */
function disallowedSegments(): string[] {
  const source = readFileSync(ROBOTS, "utf8");
  const match = source.match(/disallow:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"\/([a-z-]+)\/?"/g)].map((m) => m[1]);
}

describe("disallowed paths say noindex in their own metadata", () => {
  const segments = disallowedSegments();

  test("the disallow list was found", () => {
    expect(segments.length).toBeGreaterThan(2);
  });

  for (const segment of segments) {
    // Only pages can carry a robots meta; /api and /admin have no page file.
    const page = join(APP, "[locale]", segment, "page.tsx");
    if (!existsSync(page)) continue;

    test(`/${segment} sets index: false`, () => {
      const source = readFileSync(page, "utf8");
      // A boolean assertion rather than `toContain`: the latter prints the
      // whole file into the failure output.
      const setsNoindex = /robots:\s*\{[^}]*index:\s*false/.test(source);
      expect(
        setsNoindex,
        `robots.txt disallows /${segment}, so a crawler never reads this ` +
          "page's meta tag — but leaving it as the root layout's " +
          "`index, follow` contradicts the disallow. Set " +
          "`robots: { index: false, follow: false }` in its metadata.",
      ).toBe(true);
    });
  }
});

// A segment's `not-found.tsx` is the boundary Next renders when a page in
// that segment calls `notFound()`. Re-exporting only `default` from the
// shared file drops its `generateMetadata`, and the 404 then inherits the
// root layout's metadata: `index, follow` (contradicting the `noindex` Next
// injects for the 404 status), the site title instead of the 404 title, and a
// canonical pointing at the home page. `u/` and `my-feedback/` did exactly
// that; segments without their own boundary fall through to
// `[locale]/not-found.tsx` and were fine.
describe("segment not-found boundaries keep the shared metadata", () => {
  test("every re-exporting not-found also re-exports generateMetadata", async () => {
    const { readdir } = await import("node:fs/promises");
    const localeDir = join(APP, "[locale]");
    const offenders: string[] = [];

    for (const entry of await readdir(localeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const boundary = join(localeDir, entry.name, "not-found.tsx");
      if (!existsSync(boundary)) continue;
      const source = readFileSync(boundary, "utf8");
      // Only the thin re-export files are in scope; a boundary that defines
      // its own component and metadata is complete by construction.
      if (!/export\s*\{[^}]*\}\s*from\s*"\.\.\/not-found"/.test(source))
        continue;
      if (!/generateMetadata/.test(source)) {
        offenders.push(`[locale]/${entry.name}/not-found.tsx`);
      }
    }

    expect(
      offenders,
      "These re-export the shared 404 component but not its " +
        "`generateMetadata`, so the 404 falls back to the root layout's " +
        "`index, follow` and site title. Re-export both: " +
        '`export { default, generateMetadata } from "../not-found"`. ' +
        "Offenders: " +
        offenders.join(", "),
    ).toEqual([]);
  });
});

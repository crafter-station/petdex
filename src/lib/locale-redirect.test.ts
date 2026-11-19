import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `localePrefix: "as-needed"` (src/proxy.ts) serves the default locale at the
// bare path, so a server `redirect("/")` from inside `[locale]/...` sends a
// zh or es visitor to the *English* home page — the URL changes language
// mid-session, and the prefix they arrived under is thrown away.
//
// `my-feedback` and `my-feedback/[id]` did exactly that on the signed-out
// branch (both `redirect("/")`), and `u/[handle]` redirected a profile whose
// stored handle differed from the requested one to a bare `/u/<handle>`, so
// the canonical URL a non-default-locale visitor landed on rendered English.
// The sibling `my-pets` page already used `withLocale` for its redirect.
//
// The guard keys on the literal `redirect("/…")` / `redirect(`/…`)` form: a
// path that already begins with a locale, or one built by `withLocale` /
// `localizePath`, is a call expression rather than a string literal and is
// left alone. `redirect` to an absolute URL or a dynamic segment is fine too.

const LOCALE_DIR = join(import.meta.dir, "..", "app", "[locale]");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

describe("server redirects keep the visitor's locale", () => {
  const pages = pageFiles(LOCALE_DIR);

  test("the scan finds the locale pages", () => {
    // A guard that silently scans nothing passes for the wrong reason.
    expect(pages.length).toBeGreaterThan(15);
  });

  for (const path of pages) {
    const relative = path.slice(LOCALE_DIR.length + 1);
    const source = readFileSync(path, "utf8");
    const offenders: number[] = [];
    source.split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      // A bare-root or bare-path literal: `redirect("/")`, `redirect("/x")`,
      // or the same in a backtick template with no interpolation.
      if (/(^|[^.\w])redirect\(\s*["'`]\/[^"'`]*["'`]\s*\)/.test(code)) {
        offenders.push(index + 1);
      }
    });

    test(`${relative} prefixes its redirects`, () => {
      expect(
        offenders,
        `${relative} redirects to a locale-less literal on line(s) ` +
          `${offenders.join(", ")}. Wrap the path in withLocale(path, locale) ` +
          "so a zh/es visitor is not bounced to the default-locale URL.",
      ).toEqual([]);
    });
  }
});

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A `force-static` page under `[locale]` must read its `params`. Three of them
// — download, leaderboard, requests — declared a default export that took no
// arguments, and every locale prefix was served the same English render:
// `/es/download` and `/zh/download` shipped the English header nav and body
// under `<html lang="es">` / `lang="zh"`. Their sibling pages all read
// `params` and were correct.
//
// The condition was isolated by building with `setRequestLocale` removed and
// `params` still read: all three rendered in the right locale, so reading
// `params` is what produces the per-locale render. `setRequestLocale` is kept
// beside it as next-intl's documented API for statically rendered pages, but
// it is not what this guard can see from source, and not what the fix turned
// on.
//
// Nothing else in the suite catches this: the pages are prerendered, so no
// test renders them, and the HTML they emit is asserted nowhere. This guard
// reads the source instead, because the defect is a missing parameter in a
// signature rather than a value a unit test could check.

const LOCALE_DIR = join(import.meta.dir, "..", "app", "[locale]");

/** Every `page.tsx` under `[locale]`, at any depth. */
function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

function defaultExportSignature(source: string): string | null {
  const match = source.match(
    /export default async function \w+\s*\(([\s\S]*?)\)\s*[:{]/,
  );
  return match ? match[1] : null;
}

describe("prerendered locale pages consume their route params", () => {
  const pages = pageFiles(LOCALE_DIR);

  test("the scan finds the locale pages", () => {
    // A guard that silently scans nothing passes for the wrong reason.
    expect(pages.length).toBeGreaterThan(15);
  });

  for (const path of pages) {
    const relative = path.slice(LOCALE_DIR.length + 1);
    const source = readFileSync(path, "utf8");
    if (!source.includes('export const dynamic = "force-static"')) continue;

    const signature = defaultExportSignature(source);
    if (signature === null) continue;

    test(`${relative} reads params in its default export`, () => {
      expect(
        signature.includes("params"),
        `${relative} is force-static but its default export takes no params, ` +
          "so it is rendered once in the default locale and served that way " +
          "under every locale prefix. Destructure `params` and await it " +
          "before reading any translation.",
      ).toBe(true);
    });
  }
});

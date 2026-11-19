import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `localePrefix: "as-needed"` (src/proxy.ts) serves the default locale at the
// bare path and the others under a prefix. A link written as
// `` `/${locale}/download` `` therefore points at `/en/download` for English
// readers, which the proxy answers with a 307 back to `/download` — one extra
// round trip per click, on the pages that carry the most outbound links.
//
// Six call sites had drifted into the literal form: the home page, two in
// `/docs`, the desktop-release dialog, the compact install command, the
// "open in Petdex" button, and the collection action menu. `withLocale` and
// `localizePath` already existed and were used everywhere else, so this is a
// rule about which helper to reach for rather than a missing capability.
//
// Only the interpolated form is flagged. `` `/${locale}` `` is correct inside
// the helpers themselves (locale-routing.ts, i18n/config.ts) and in
// `revalidatePath` calls that intentionally purge the prefixed shape, so a
// blanket ban on the substring would be wrong; the guard keys on the
// `/`+`${locale}`+`/` sequence that only a hand-built prefixed path produces.

const SRC = join(import.meta.dir, "..");

/** Source files, skipping tests and the helper modules that own the prefix. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.(test|integration|spec)\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

// The two modules whose whole job is building a prefixed path, plus the
// revalidate helper that deliberately enumerates every shape and the rewrite
// guard, which matches an incoming pathname rather than building a link.
const ALLOWED = new Set([
  join(SRC, "lib", "locale-routing.ts"),
  join(SRC, "i18n", "config.ts"),
  join(SRC, "app", "api", "revalidate", "route.ts"),
  join(SRC, "lib", "locale-rewrite-guard.ts"),
]);

describe("locale-prefixed paths go through a helper", () => {
  const files = sourceFiles(SRC).filter((path) => !ALLOWED.has(path));

  test("the scan finds source files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("no source hand-builds a locale-prefixed path", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      source.split("\n").forEach((line, index) => {
        // Comments explaining the rule are fine; only live code counts.
        const code = line.replace(/\/\/.*$/, "");
        if (/`\/\$\{locale\}\//.test(code) || /"\/\$\{locale\}\//.test(code)) {
          offenders.push(`${path.slice(SRC.length + 1)}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      "Use withLocale(path, locale) or localizePath(locale, path) instead of " +
        "hand-building a locale-prefixed path: the default locale is " +
        "unprefixed, so the literal form 307-redirects. Offenders: " +
        offenders.join(", "),
    ).toEqual([]);
  });
});

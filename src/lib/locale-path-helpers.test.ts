import { describe, expect, test } from "bun:test";

import { withLocale } from "@/lib/locale-routing";

import { localizePath } from "@/i18n/config";

// Two helpers build a locale-prefixed path and they take their arguments in
// opposite orders:
//
//   withLocale(path, locale)      // src/lib/locale-routing.ts
//   localizePath(locale, path)    // src/i18n/config.ts
//
// Both are `(string, string) => string`, so swapping the arguments at a call
// site compiles, type-checks, and is invisible in review — it just produces a
// path built from the wrong pair, or a bare locale name. `buildLocaleAlternates`
// and the email templates each use a different one, so the two live side by
// side in the same codebase.
//
// The duplication itself is worth pinning for a second reason: the two agree
// on every path that starts with `/`, which is every path any call site passes
// today, and disagree on a path that does not. `withLocale("download", "zh")`
// normalizes to `/zh/download`; `localizePath("zh", "download")` concatenates
// to `/zhdownload`. Nothing hits that today, which is exactly why it would
// ship unnoticed if a future call site read a path from data.

describe("locale path helpers agree", () => {
  const LOCALES = ["en", "es", "zh"] as const;

  // The shapes call sites actually pass, plus the root.
  const PATHS = [
    "/",
    "/download",
    "/docs#install",
    "/legal/takedown",
    "/pets/cai-chao",
    "/collections/cozy-crew",
  ];

  test("both produce the same path for slash-prefixed input", () => {
    for (const locale of LOCALES) {
      for (const path of PATHS) {
        expect(
          localizePath(locale, path),
          `localizePath("${locale}", "${path}") disagrees with ` +
            `withLocale("${path}", "${locale}")`,
        ).toBe(withLocale(path, locale));
      }
    }
  });

  test("the default locale stays unprefixed in both", () => {
    // `localePrefix: "as-needed"` serves `en` at the bare path, so a prefixed
    // `/en/...` only costs a 307 — the defect the call sites were fixed for.
    for (const path of PATHS) {
      expect(localizePath("en", path)).toBe(path);
      expect(withLocale(path, "en")).toBe(path);
    }
  });

  test("a non-default locale is prefixed in both", () => {
    for (const path of PATHS) {
      expect(localizePath("zh", path)).toBe(withLocale(path, "zh"));
      expect(localizePath("zh", path).startsWith("/zh")).toBe(true);
    }
  });

  // Documents the known divergence rather than asserting the helpers match it,
  // so the day someone makes them agree this test fails loudly and the guard
  // above starts covering the case instead of the comment being stale.
  test("a slash-less path is the one input they disagree on", () => {
    expect(withLocale("download", "zh")).toBe("/zh/download");
    expect(localizePath("zh", "download")).toBe("/zhdownload");
  });
});

describe("call sites pass arguments in each helper's own order", () => {
  // The order cannot be checked by types — both helpers are `(string, string)`
  // — so it is checked by shape. `withLocale` is always called with the path
  // first, and `localizePath` with the locale first; a swapped call is one
  // that hands each helper the other's argument type.
  //
  // Both sides are recognized rather than just the locale, because a swap at a
  // call site passes a *variable* locale, not a literal: an earlier version of
  // this check only matched `"en"`/`"es"`/`"zh"` and stayed green when
  // `withLocale("/docs", locale)` was mutated to `withLocale(locale, "/docs")`.
  const LOCALE_LITERAL = /^(["'`])(en|es|zh)\1$/;
  const LOCALE_IDENT =
    /^(locale|localeValue|currentLocale|nextLocale|targetLocale|current)$/;

  function isLocaleish(arg: string): boolean {
    return (
      LOCALE_LITERAL.test(arg) ||
      LOCALE_IDENT.test(arg) ||
      /Locale\b/.test(arg) ||
      /^normalizeLocale\(/.test(arg)
    );
  }

  function isPathish(arg: string): boolean {
    return (
      // A quoted path, or a template literal that opens with `/`.
      /^(["'`])\//.test(arg) ||
      /^(pathname|path|basePath)$/.test(arg) ||
      /\.(href|installHref)$/.test(arg)
    );
  }

  async function callSites(): Promise<
    Array<{ file: string; callee: string; first: string; second: string }>
  > {
    const glob = new Bun.Glob("src/**/*.{ts,tsx}");
    const out: Array<{
      file: string;
      callee: string;
      first: string;
      second: string;
    }> = [];
    for await (const file of glob.scan({ cwd: process.cwd() })) {
      if (/\.(test|integration)\.tsx?$/.test(file)) continue;
      const source = await Bun.file(file).text();
      // Single-line, single-level calls only: that is how every site is
      // written, and a nested call would need a parser to read reliably.
      for (const match of source.matchAll(
        /\b(withLocale|localizePath)\(([^()]*)\)/g,
      )) {
        const args = match[2]
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        if (args.length !== 2) continue;
        out.push({
          file,
          callee: match[1],
          first: args[0],
          second: args[1],
        });
      }
    }
    return out;
  }

  test("no call site hands a helper the other's argument", async () => {
    const sites = await callSites();
    // A scan that finds nothing would pass for the wrong reason.
    expect(sites.length).toBeGreaterThan(20);

    const swapped = sites
      .filter((site) =>
        site.callee === "withLocale"
          ? // withLocale(path, locale): a locale in front is the swap.
            isLocaleish(site.first) && isPathish(site.second)
          : // localizePath(locale, path): a path in front is the swap.
            isPathish(site.first) && isLocaleish(site.second),
      )
      .map((site) => `${site.file}: ${site.callee}(${site.first}, ...)`);

    expect(
      swapped,
      "withLocale takes (path, locale) and localizePath takes (locale, path). " +
        "These calls pass each helper the other's argument, which type checks " +
        "but builds a path from the wrong pair: " +
        swapped.join("; "),
    ).toEqual([]);
  });
});

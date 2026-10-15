import { describe, expect, it } from "bun:test";

import { IntlMessageFormat } from "intl-messageformat";

import {
  codeOnly,
  RAW_MESSAGE_PATHS,
  rawCallKeysIn,
  readSource,
  sourceFiles,
} from "@/lib/i18n-raw-keys";

import en from "./messages/en.json";
import es from "./messages/es.json";
import zh from "./messages/zh.json";

const messagesByLocale = { en, es, zh };

function collectStrings(
  value: unknown,
  path = "",
): Array<{ path: string; value: string }> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      collectStrings(child, path ? `${path}.${key}` : key),
    );
  }
  return typeof value === "string" ? [{ path, value }] : [];
}

function at(messages: unknown, path: string): string {
  return String(
    path
      .split(".")
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown>)[key],
        messages,
      ),
  );
}

// The exempt paths live in `@/lib/i18n-raw-keys` so the check and this test
// cannot drift apart. That module also owns the cwd-independent path helpers:
// resolving sources against `process.cwd()` made this suite fail when run from
// anywhere but the repo root.
const declared = new Set(RAW_MESSAGE_PATHS);

// ICU reads an angle-bracketed name as a rich-text tag, so a message that
// means `<slug>` as a literal placeholder throws UNCLOSED_TAG the moment a
// plain `t("key")` formats it — and use-intl answers a thrown message by
// rendering the key itself, which put `about.faq.items.install.a` on /about in
// place of the sentence.
//
// Two kinds of message are legitimately full of angle brackets and must not be
// flagged: `t.rich` messages, whose `<code>`/`<strong>` tags are well-formed
// pairs the caller renders, and messages a call site reads with `t.raw`, which
// never reaches the parser. Constructing the formatter parses without
// formatting, so the first kind passes; the second kind is skipped by key.
describe("locale messages a plain t() call can format", () => {
  for (const [locale, messages] of Object.entries(messagesByLocale)) {
    it(`${locale} formats every message it is asked to`, () => {
      const unformattable = collectStrings(messages).flatMap(
        ({ path, value }) => {
          if (declared.has(path)) return [];
          try {
            new IntlMessageFormat(value, locale);
            return [];
          } catch (error) {
            return [`${path}: ${(error as Error).message}`];
          }
        },
      );

      // Reported as a list so a regression names every offending key at once
      // rather than failing on whichever one the walk reached first.
      expect(unformattable, locale).toEqual([]);
    });
  }
});

// The fix for the above is `t.raw` at the call site, not an edit to the
// message: an earlier attempt wrapped these in ICU single quotes (`'<slug>'`),
// which does escape them — but only on the development code path. use-intl's
// production bundle takes a fast path that returns any message without `{` or
// `'` verbatim, and a message that has already been escaped contains no quote
// left to trigger it, so production rendered the quotes literally while
// development did not. These four keys must therefore stay exactly as written,
// and stay out of a plain `t()`.
describe("literal placeholders", () => {
  // The angle-bracketed placeholder is translated too — zh reads `<路径>` — so
  // the assertion is that each locale still carries a bracketed literal and no
  // ICU single-quote escaping, not that they share a spelling.
  const cases = [
    // A full sentence that mentions the path inline.
    ["about.faq.items.install.a", /\/pets\/<slug>\//],
    // Bare placeholders, read on their own.
    ["docsPage.placeholders.petName", /^<[^>]+>$/],
    ["docsPage.placeholders.yourPetName", /^<[^>]+>$/],
    ["docsPage.placeholders.path", /^<[^>]+>$/],
  ] as const;

  for (const [path, expected] of cases) {
    it(`${path} is a bare placeholder read raw`, () => {
      for (const [locale, messages] of Object.entries(messagesByLocale)) {
        const value = at(messages, path);
        expect(value, locale).toMatch(expected);
        // No ICU escaping: `'<slug>'` breaks the production fast path.
        expect(value, locale).not.toContain("'<");
      }
      expect(declared.has(path), `${path} needs a t.raw call site`).toBe(true);
    });
  }
});

// Guards the two call sites that carry the fix, so deleting a `t.raw` (or
// reintroducing the quote-escaped spelling) fails here rather than in
// production.
describe("the call sites that carry the fix", () => {
  const aboutPage = readSource("src/app/[locale]/about/page.tsx");
  const docsPage = readSource("src/app/[locale]/docs/page.tsx");

  it("about reads the install answer raw", () => {
    expect(aboutPage).toContain('t.raw("faq.items.install.a")');
    expect(aboutPage).not.toContain('t("faq.items.install.a")');
  });

  it("docs reads its placeholders raw", () => {
    for (const key of ["path", "petName", "yourPetName"]) {
      expect(docsPage, key).toContain(`t.raw("placeholders.${key}")`);
    }
  });
});

// The cross-check above is only as good as the scan feeding it, and the scan
// has one hazard that already bit once: it ran over raw file text, so the doc
// comment on `RAW_MESSAGE_PATHS` — which spells out a `t.raw("…")` call to
// explain the list — satisfied the "is this entry still used?" question on its
// own. Deleting the real call site from /about then left the check green while
// the message rendered as its own key. These pin the blanking that fixed it.
describe("the call-site scan ignores prose", () => {
  it("does not count a call spelled out in a comment", () => {
    expect(rawCallKeysIn('// t.raw("commented.out")\n')).toEqual([]);
    expect(rawCallKeysIn('/* t.raw("blocked.out") */\n')).toEqual([]);
    // The real call on the next line still counts, so blanking is not
    // over-reaching into code that follows a comment.
    expect(
      rawCallKeysIn('// t.raw("commented.out")\nt.raw("real.key")\n'),
    ).toEqual(["real.key"]);
  });

  it("does not count one spelled out inside a string", () => {
    expect(rawCallKeysIn('const s = "t.raw("quoted.out")";\n')).toEqual([]);
  });

  it("still reads a real call, spacing and quote style included", () => {
    expect(rawCallKeysIn('t.raw( "spaced.key" )')).toEqual(["spaced.key"]);
    expect(rawCallKeysIn("t.raw('single.key')")).toEqual(["single.key"]);
    expect(rawCallKeysIn("t.raw(`backtick.key`)")).toEqual(["backtick.key"]);
  });

  it("keeps every offset, so a masked match still resolves its key", () => {
    const source = 'const a = 1;\nt.raw("after.code")\n';
    const masked = codeOnly(source);
    expect(masked.length).toBe(source.length);
    expect(masked).toContain('t.raw("');
  });

  it("finds the four real call sites in the tree, and only those", () => {
    const found = new Set<string>();
    for (const file of sourceFiles()) {
      for (const key of rawCallKeysIn(readSource(file))) found.add(key);
    }
    expect([...found].sort()).toEqual([
      "faq.items.install.a",
      "placeholders.path",
      "placeholders.petName",
      "placeholders.yourPetName",
    ]);
  });
});

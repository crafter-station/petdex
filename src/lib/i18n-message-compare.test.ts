import { describe, expect, test } from "bun:test";

import {
  argumentNames,
  findMissingKeys,
  findPlaceholderMismatches,
  findUnformattableMessages,
  type JsonObject,
} from "@/lib/i18n-message-compare";

// The comparisons behind `scripts/i18n-check.ts`. The script runs at import
// time, so none of this was reachable from a test before it moved here, and the
// two subtle rules — cross-locale placeholders and shape mismatches — had no
// coverage at all. Each case below is a defect the check reported as "in sync".

describe("findMissingKeys", () => {
  test("reports a key the translation does not have", () => {
    expect(findMissingKeys({ a: "x" }, {})).toEqual(["a"]);
  });

  test("reports a leaf that became an object", () => {
    // The call site reads a string and gets an object: `[object Object]` on
    // the page, or a throw on `.split`. `key in target` is true, so the old
    // recursion fell straight through.
    const found = findMissingKeys({ a: "x" }, { a: { b: "y" } });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("a");
    expect(found[0]).toContain("shape");
  });

  test("reports an object that became a leaf", () => {
    const found = findMissingKeys({ a: { b: "x" } }, { a: "y" });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("shape");
  });

  test("an array is not an object, so it is a shape mismatch", () => {
    // `isPlainObject` excludes arrays; a message array where a string belongs
    // is as unusable as an object.
    expect(findMissingKeys({ a: "x" }, { a: ["y"] })).toHaveLength(1);
  });

  test("passes when both sides agree", () => {
    expect(findMissingKeys({ a: { b: "x" } }, { a: { b: "y" } })).toEqual([]);
  });

  test("still reports a key missing from a nested object", () => {
    expect(
      findMissingKeys({ a: { b: "x", c: "y" } }, { a: { b: "z" } }),
    ).toEqual(["a.c"]);
  });
});

describe("findUnformattableMessages", () => {
  const none = new Set<string>();

  test("flags a bare angle-bracket placeholder", () => {
    const found = findUnformattableMessages({ a: "<slug>" }, "en", none);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("UNCLOSED_TAG");
  });

  test("a well-formed rich-text pair is fine", () => {
    expect(findUnformattableMessages({ a: "hi <b>x</b>" }, "en", none)).toEqual(
      [],
    );
  });

  test("an exempt path is not parsed", () => {
    // `t.raw` reads it as a literal, so `<slug>` is exactly what it wants.
    expect(
      findUnformattableMessages({ a: "<slug>" }, "en", new Set(["a"])),
    ).toEqual([]);
  });
});

describe("findPlaceholderMismatches", () => {
  test("flags a renamed placeholder", () => {
    // Parses cleanly in isolation, then throws MissingValueError at render —
    // use-intl prints the key. This is the defect that read as "in sync".
    const found = findPlaceholderMismatches(
      { a: "by {name}" },
      { a: "por {nombre}" },
      "es",
    );
    expect(found.length).toBe(2);
    expect(found.join(" ")).toContain("{nombre}");
    expect(found.join(" ")).toContain("{name}");
  });

  test("flags a dropped non-selector placeholder", () => {
    const found = findPlaceholderMismatches(
      { a: "by {name}" },
      { a: "por" },
      "es",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("drops");
  });

  test("allows dropping a plural selector", () => {
    // zh drops `{count}` from the install plural: a language without plural
    // agreement does not need the number to choose a branch.
    const found = findPlaceholderMismatches(
      {
        a: "{count, plural, =1 {{formatted} install} other {{formatted} installs}}",
      },
      { a: "{formatted} 次安装" },
      "zh",
    );
    expect(found).toEqual([]);
  });

  test("agreement passes", () => {
    expect(
      findPlaceholderMismatches({ a: "by {name}" }, { a: "por {name}" }, "es"),
    ).toEqual([]);
  });

  test("a message unparseable in one locale is skipped, not reported twice", () => {
    // It is already a parse failure; reporting a placeholder mismatch too
    // would be noise on the same key.
    expect(
      findPlaceholderMismatches({ a: "<slug>" }, { a: "<slug>" }, "es"),
    ).toEqual([]);
  });

  test("flags a renamed rich-text tag", () => {
    // `<strong>` is supplied by the call site's `t.rich` map. A translation
    // that renames it parses cleanly (the tag pair is still balanced) and then
    // has no renderer, which use-intl answers by printing the key — the same
    // failure class as a renamed `{argument}`, but the earlier checks only
    // looked at argument names, so this read as "in sync".
    const found = findPlaceholderMismatches(
      { a: "read <strong>{name}</strong>" },
      { a: "lee <fuerte>{name}</fuerte>" },
      "es",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("<strong>");
    expect(found[0]).toContain("<fuerte>");
  });

  test("flags a tag the translation dropped", () => {
    const found = findPlaceholderMismatches(
      { a: "read <code>{file}</code> now" },
      { a: "lee {file} ahora" },
      "es",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("tag names differ");
  });

  test("the localized docs placeholders are exempt", () => {
    // These three mean `<slug>` as a literal and are read with `t.raw`, so
    // they never reach ICU and are *supposed* to differ per locale.
    const found = findPlaceholderMismatches(
      { docsPage: { placeholders: { petName: "<slug>" } } },
      { docsPage: { placeholders: { petName: "<宠物名>" } } },
      "zh",
    );
    expect(found).toEqual([]);
  });
});

describe("argumentNames", () => {
  test("separates selectors from plain arguments", () => {
    const { all, selectors } = argumentNames(
      "{name} has {count, plural, one {# pet} other {# pets}}",
      "en",
    );
    expect([...all].sort()).toEqual(["count", "name"]);
    expect([...selectors]).toEqual(["count"]);
  });

  test("finds an argument nested inside a plural branch", () => {
    const { all } = argumentNames(
      "{count, plural, one {# for {name}} other {# for {name}}}",
      "en",
    );
    expect(all.has("name")).toBe(true);
  });

  test("finds an argument nested inside a rich-text tag", () => {
    // The old walk visited `node.value` for a tag, which is the tag's *name*
    // string, so the tag's children were never reached: a `{name}` inside
    // `<brand>…</brand>` was invisible to both the argument and the tag
    // comparison.
    const { all, tags } = argumentNames("for <brand>{name}</brand>", "en");
    expect(all.has("name")).toBe(true);
    expect([...tags]).toEqual(["brand"]);
  });

  test("ignores a non-argument rich-text tag", () => {
    const { all, tags } = argumentNames("hi <b>there</b>", "en");
    expect([...all]).toEqual([]);
    expect([...tags]).toEqual(["b"]);
  });

  test("collects tag names, including nested ones", () => {
    const { tags } = argumentNames(
      "<strong>hi <code>x</code></strong> <slug>y</slug>",
      "en",
    );
    expect([...tags].sort()).toEqual(["code", "slug", "strong"]);
  });
});

describe("the real messages", () => {
  test("a fixture shaped like the tree reports nothing", () => {
    const source: JsonObject = { ns: { a: "by {name}", b: "{n} installs" } };
    const target: JsonObject = {
      ns: { a: "por {name}", b: "{n} instalaciones" },
    };
    expect(findMissingKeys(source, target)).toEqual([]);
    expect(findPlaceholderMismatches(source, target, "es")).toEqual([]);
  });
});

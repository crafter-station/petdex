import { describe, expect, it } from "bun:test";

import {
  BLOCKED_CHINESE_PHRASES,
  BLOCKED_LATIN_TOKENS,
  findBlockedKeyword,
} from "@/lib/keyword-blocklist";

// A blocklist that a single invisible character defeats is not a blocklist.
// Measured before the fix: "i​kun" (ZWSP), "i‌kun" (ZWNJ),
// "i⁠kun" (word joiner), "iku️n" (VS16) and "i­kun" (soft
// hyphen) all returned null, while the plain and full-width spellings were
// caught — so the escape was the easy path and the naive variant the hard one.
describe("findBlockedKeyword resists invisible-character escapes", () => {
  const invisibles = [
    ["​", "ZWSP"],
    ["‌", "ZWNJ"],
    ["‍", "ZWJ"],
    ["⁠", "word joiner"],
    ["﻿", "BOM"],
    ["­", "soft hyphen"],
  ] as const;

  it("catches a latin token split by any single invisible character", () => {
    const base = BLOCKED_LATIN_TOKENS[0]; // "ikun"
    for (const [char, name] of invisibles) {
      const sneaky = base.slice(0, 2) + char + base.slice(2);
      expect(findBlockedKeyword(sneaky), name)?.toMatchObject({
        keyword: base,
        source: "latin",
      });
    }
  });

  it("catches a variation selector inserted mid-token", () => {
    const base = BLOCKED_LATIN_TOKENS[0];
    const sneaky = `${base.slice(0, 3)}️${base.slice(3)}`;
    expect(findBlockedKeyword(sneaky)).toMatchObject({ keyword: base });
  });

  it("catches a chinese phrase split by an invisible character", () => {
    const phrase = BLOCKED_CHINESE_PHRASES[0];
    if (phrase.length < 2) return;
    const sneaky = `${phrase.slice(0, 1)}​${phrase.slice(1)}`;
    expect(findBlockedKeyword(sneaky)).toMatchObject({
      keyword: phrase,
      source: "chinese",
    });
  });

  it("still misses benign substrings that merely contain the letters", () => {
    // The word-boundary rule must survive the scrub: "skunk"/"akin" are not
    // hits even though they contain "kun".
    expect(findBlockedKeyword("a skunk and an akin word")).toBeNull();
  });
});

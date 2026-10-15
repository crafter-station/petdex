import { describe, expect, it } from "bun:test";

import { containsUrl, URL_BLOCKED_REASON } from "@/lib/url-blocklist";

describe("containsUrl — pass cases", () => {
  it("passes on plain text without any URL", () => {
    expect(containsUrl(["description", "carl is cute"])).toBeNull();
    expect(containsUrl(["description", "loves pixels and sunsets"])).toBeNull();
    expect(containsUrl(["displayName", "Boba the Corgi"])).toBeNull();
  });

  it("passes on empty / null / undefined fields", () => {
    expect(containsUrl(["description", null])).toBeNull();
    expect(containsUrl(["description", undefined])).toBeNull();
    expect(containsUrl(["description", ""])).toBeNull();
  });

  it("passes on version strings that look like decimals", () => {
    expect(containsUrl(["description", "requires v1.0"])).toBeNull();
    expect(containsUrl(["description", "version 2.4.1"])).toBeNull();
  });
});

describe("containsUrl — fail cases (each pattern at least once)", () => {
  it("blocks explicit https:// protocol", () => {
    const hit = containsUrl(["description", "visit https://promo.com today"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("protocol_prefix");
    expect(hit?.field).toBe("description");
  });

  it("blocks explicit http:// protocol", () => {
    const hit = containsUrl(["displayName", "from http://spam.net"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("protocol_prefix");
  });

  it("blocks www. prefix", () => {
    const hit = containsUrl(["description", "see www.example.com for details"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("www_prefix");
  });

  it("blocks t.me/ shortlink", () => {
    const hit = containsUrl(["description", "join t.me/channel"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("shortlink");
  });

  it("blocks bit.ly/ shortlink", () => {
    const hit = containsUrl(["description", "click bit.ly/abc123"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("shortlink");
  });

  it("blocks tinyurl.com shortlink", () => {
    const hit = containsUrl(["description", "use tinyurl.com"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("shortlink");
  });

  it("blocks obfuscated h t t p s : protocol", () => {
    const hit = containsUrl(["description", "h t t p s : //promo.io"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("obfuscated_protocol");
  });

  it("blocks obfuscated h t t p : protocol", () => {
    const hit = containsUrl(["description", "go to h t t p : //spam.net"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("obfuscated_protocol");
  });

  it("blocks (dot) obfuscation", () => {
    const hit = containsUrl(["description", "example(dot)com"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("dot_obfuscation");
  });

  it("blocks [dot] obfuscation", () => {
    const hit = containsUrl(["description", "example[dot]org"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("dot_obfuscation");
  });

  it("blocks comma-dot obfuscation", () => {
    const hit = containsUrl(["description", "example, dot , com"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("dot_obfuscation");
  });

  it("blocks bare domain with common TLD", () => {
    const hit = containsUrl(["description", "sponsor.io is the best"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("bare_domain");
  });

  it("blocks bare domain .com", () => {
    const hit = containsUrl(["displayName", "mypet.com"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("bare_domain");
  });

  it("blocks bare domain .ai", () => {
    const hit = containsUrl(["description", "check sponsor.ai now"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("bare_domain");
  });
});

describe("containsUrl — Chinese mixed text", () => {
  it("blocks https URL in Chinese sentence", () => {
    const hit = containsUrl(["description", "这是 https://promo.com 的宠物"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("protocol_prefix");
  });

  it("passes Chinese text with no URL", () => {
    expect(containsUrl(["description", "可爱的像素宠物"])).toBeNull();
  });
});

describe("containsUrl — diacritic normalization", () => {
  it("normalizes diacritics before matching", () => {
    const hit = containsUrl(["description", "https://éxample.com"]);
    expect(hit).not.toBeNull();
  });
});

describe("containsUrl — multi-field", () => {
  it("returns the field name where the hit occurred", () => {
    const hit = containsUrl(
      ["displayName", "clean name"],
      ["description", "visit https://spam.com"],
    );
    expect(hit?.field).toBe("description");
  });

  it("returns first hit when multiple fields have URLs", () => {
    const hit = containsUrl(
      ["displayName", "myname.com"],
      ["description", "also https://other.net"],
    );
    expect(hit?.field).toBe("displayName");
  });
});

describe("containsUrl — allowlisted legit domains", () => {
  it("v0.dev passes (Hunter is v0 Ambassador, common reference)", () => {
    expect(containsUrl(["description", "built with v0.dev"])).toBeNull();
  });

  it("crafter.run passes (own brand)", () => {
    expect(containsUrl(["description", "more at petdex.dev"])).toBeNull();
  });

  it("github.com passes (legit reference)", () => {
    expect(containsUrl(["description", "code on github.com"])).toBeNull();
  });

  it("but https://v0.dev still trips protocol pattern", () => {
    // Protocol-prefixed forms are blocked regardless of allowlist:
    // a clickable link is a clickable link.
    const hit = containsUrl(["description", "visit https://v0.dev"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("protocol_prefix");
  });

  it("non-allowlisted .dev still flags", () => {
    const hit = containsUrl(["description", "join promo.dev for free"]);
    expect(hit).not.toBeNull();
    expect(hit?.pattern).toBe("bare_domain");
  });
});

describe("containsUrl — email addresses", () => {
  it("blocks an email, because the domain in it is what spam harvests", () => {
    const hit = containsUrl([
      "description",
      "A pixel-art companion. Contact haipengzhu33@gmail.com",
    ]);
    expect(hit).not.toBeNull();
    expect(hit?.field).toBe("description");
  });

  it("says so in the reason, so a submitter can tell what tripped it", () => {
    // #631: someone put their address in a description to take
    // suggestions privately, got told "URLs are not allowed", and had no
    // way to connect that to their own email. The rule was right; the
    // wording was not.
    expect(URL_BLOCKED_REASON.toLowerCase()).toContain("email");
  });
});

// An invisible character inside a token defeats a literal pattern, and the URL
// detector's patterns are literal (`https?://`, `\bwww\.`, a bare domain). The
// normalize step now scrubs them first. Measured before the fix: a ZWSP in
// "https\u200b://evil.example" and a VS16 in "sponsor\ufe0f.xyz" both returned
// null, while every plain spelling matched.
describe("containsUrl — invisible-character evasion", () => {
  it("still flags an explicit protocol with an invisible char inside it", () => {
    expect(
      containsUrl(["description", "https\u200b://evil.example"])?.pattern,
    ).toBe("protocol_prefix");
  });

  it("still flags a bare domain with a variation selector inside it", () => {
    expect(containsUrl(["description", "sponsor\ufe0f.xyz"])?.pattern).toBe(
      "bare_domain",
    );
  });

  it("does not turn benign text into a hit", () => {
    // The scrub must not create matches: this has no URL at all.
    expect(containsUrl(["description", "a cozy\u200b round cat"])).toBeNull();
  });
});

describe("containsUrl — whitespace-torn and word-dot obfuscation", () => {
  // The bare_domain regex requires the TLD to sit against the dot, so
  // "evil. com" sailed through; dot_obfuscation only knew the parenthesized
  // and doubled-dot spellings. These pin the forms the expanded patterns
  // now catch.
  it("blocks a domain torn across whitespace before the TLD", () => {
    for (const text of ["evil. com", "evil . com", "evil. net", "node . com"]) {
      const hit = containsUrl(["description", text]);
      expect(hit).not.toBeNull();
    }
  });

  it("blocks the word-dot form with surrounding whitespace", () => {
    for (const text of [
      "evil dot com",
      "evil(dot) com",
      "evil (dot)com",
      "evil ( dot ) com",
      "evil[ dot ]com",
      "spamsite dot net",
    ]) {
      const hit = containsUrl(["description", text]);
      expect(hit).not.toBeNull();
    }
  });

  it("keeps prose uses of the phrase dot com clean", () => {
    // The word "dot" is prose when it follows an everyday English word —
    // gating only the delimiter-free form, because "(dot)"/"[dot]" is
    // already deliberate obfuscation.
    expect(
      containsUrl(["description", "read the dot com intro chapter"]),
    ).toBeNull();
    expect(containsUrl(["description", "the dot com bubble era"])).toBeNull();
  });

  it("keeps the delimited forms obfuscation even after prose words", () => {
    expect(
      containsUrl(["description", "read the (dot) com thing"]),
    ).not.toBeNull();
  });
});

describe("containsUrl — spaced_tld sentence-boundary guard", () => {
  // A sentence boundary ("yes. me too") has the same shape as a torn domain:
  // word, period, space, TLD word. The prose gate keys on the sentence's
  // last word; these pin the ordinary sentences measured as false positives
  // before the gate existed.
  it("keeps ordinary sentences that end before a TLD word", () => {
    for (const text of [
      "yes. me too",
      "wait. io games are fun",
      "he said no. app developers know",
      "do. co ops fail",
      "no. app here",
      "number one. xyz site",
      "i was. com pletely wrong",
    ]) {
      expect(containsUrl(["description", text])).toBeNull();
    }
  });

  it("still catches a torn domain whose left half is a hostname", () => {
    for (const text of ["evil. com", "spam. net", "site. info", "evil. me"]) {
      expect(containsUrl(["description", text])).not.toBeNull();
    }
  });
});

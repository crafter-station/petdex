import { describe, expect, it } from "bun:test";

import { containsUrl } from "@/lib/url-blocklist";

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

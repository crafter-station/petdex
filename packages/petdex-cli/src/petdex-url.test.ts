import { describe, expect, it } from "bun:test";

import { checkPetdexUrl } from "./petdex-url";

describe("checkPetdexUrl", () => {
  it("accepts the default https base", () => {
    expect(checkPetdexUrl("https://petdex.dev")).toEqual({
      ok: true,
      url: "https://petdex.dev",
    });
  });

  it("accepts http only for loopback hosts", () => {
    expect(checkPetdexUrl("http://localhost:3000")).toEqual({
      ok: true,
      url: "http://localhost:3000",
    });
    expect(checkPetdexUrl("http://127.0.0.1:8787").ok).toBe(true);
    expect(checkPetdexUrl("http://[::1]:3000").ok).toBe(true);
  });

  it("refuses plain http against a remote host", () => {
    const r = checkPetdexUrl("http://attacker.tld");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("https");
  });

  it("refuses a malformed URL with the offending value", () => {
    const r = checkPetdexUrl("not a url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not a url");
  });

  it("strips trailing slashes", () => {
    expect(checkPetdexUrl("https://petdex.dev///")).toEqual({
      ok: true,
      url: "https://petdex.dev",
    });
  });
});

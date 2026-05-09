import { describe, expect, test } from "bun:test";

import { normalizeCountry } from "./country-code";

// Country code normalization for the public telemetry endpoint and
// any other surface that reads x-vercel-ip-country. Anything proxying
// the request can pass any header value through, so without this
// filter the admin geo dashboard fills up with junk strings (case-
// mismatched, attempted XSS payloads, malformed two-letter values,
// look-alike unicode, etc.). The contract is "exactly two ASCII
// uppercase letters or null".

describe("normalizeCountry", () => {
  test("accepts a valid two-letter ISO code", () => {
    expect(normalizeCountry("US")).toBe("US");
    expect(normalizeCountry("PE")).toBe("PE");
    expect(normalizeCountry("CN")).toBe("CN");
  });

  test("uppercases lowercase input before validating", () => {
    expect(normalizeCountry("us")).toBe("US");
    expect(normalizeCountry("pe")).toBe("PE");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeCountry(" US ")).toBe("US");
    expect(normalizeCountry("\tUS\n")).toBe("US");
  });

  test("returns null for null/undefined/empty input", () => {
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry("   ")).toBeNull();
  });

  test("rejects values with non-letter characters", () => {
    expect(normalizeCountry("U1")).toBeNull();
    expect(normalizeCountry("U-")).toBeNull();
    expect(normalizeCountry("U!")).toBeNull();
    expect(normalizeCountry("123")).toBeNull();
  });

  test("rejects values that are not exactly two characters", () => {
    expect(normalizeCountry("U")).toBeNull();
    expect(normalizeCountry("USA")).toBeNull();
    expect(normalizeCountry("UNITED STATES")).toBeNull();
  });

  test("rejects HTML/SQL injection attempts", () => {
    expect(normalizeCountry("<script>")).toBeNull();
    expect(normalizeCountry("' OR 1=1 --")).toBeNull();
    expect(normalizeCountry("US' OR")).toBeNull();
  });

  test("rejects unicode letters that look like ASCII", () => {
    // Cyrillic A and fullwidth U/S look identical to ASCII at glyph
    // level but are different code points — they'd pollute the
    // dashboard with values that match no real country.
    expect(normalizeCountry("АА")).toBeNull();
    expect(normalizeCountry("ＵＳ")).toBeNull();
  });
});

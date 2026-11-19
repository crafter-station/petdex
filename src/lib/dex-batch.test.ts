import { describe, expect, test } from "bun:test";

import { formatBatchLabel, getBatchKey } from "./dex-batch";

// The Era filter chip and the card's batch badge read "Class of October 2025".
// The month came from `Intl.DateTimeFormat("en-US", …)` — a hardcoded locale —
// so the chip read an English month on /es and /zh no matter what the page
// said. The label is now built per locale, and the "Class of …" wrapper moved
// into the messages (the caller passes the month to `gallery.batchLabel`).
//
// A `bun test` run cannot see this: the aggregate that feeds the chips is
// cached locale-agnostically, so the string was frozen once and served to
// every locale. Only the formatter's own locale argument is wrong, which is
// what this pins.

describe("formatBatchLabel", () => {
  test("names the month in the requested locale", () => {
    // Compare against `Intl` itself rather than a literal: the point is that
    // the formatter follows the locale argument, and a hardcoded expectation
    // would break on an ICU data update without the code being wrong. The
    // three results must also differ from each other, or the assertion would
    // hold for a hardcoded `en-US` that ignored the argument.
    const rendered = ["en", "es", "zh"].map((locale) =>
      formatBatchLabel("2025-10", locale),
    );
    expect(rendered[0]).toBe("October 2025");
    expect(rendered[1]).not.toBe(rendered[0]);
    expect(rendered[2]).not.toBe(rendered[0]);
    expect(new Set(rendered).size).toBe(3);
    // And each matches what `Intl` produces for that locale.
    for (const locale of ["en", "es", "zh"]) {
      const month = new Intl.DateTimeFormat(locale, {
        month: "long",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2025, 9, 1)));
      expect(formatBatchLabel("2025-10", locale), locale).toBe(`${month} 2025`);
    }
  });

  test("does not prefix the phrase itself", () => {
    // "Class of …" is a message (`gallery.batchLabel`), not part of the
    // formatter, so the value here is the month alone. A regression that
    // moved the phrase back in would make it untranslatable again.
    expect(formatBatchLabel("2025-10", "en")).not.toContain("Class of");
  });

  test("keeps the year on the same UTC month as the key", () => {
    // The date is built at UTC midnight; a formatter without `timeZone: UTC`
    // would shift January back a month in any negative-offset zone.
    expect(formatBatchLabel("2025-01", "en")).toBe("January 2025");
    expect(formatBatchLabel("2025-12", "en")).toBe("December 2025");
  });

  test("round-trips through getBatchKey", () => {
    const key = getBatchKey(new Date("2025-10-15T00:00:00Z"));
    expect(key).toBe("2025-10");
    expect(formatBatchLabel(key, "en")).toBe("October 2025");
  });
});

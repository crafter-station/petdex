import { describe, expect, it } from "bun:test";

import {
  formatChineseNumber,
  formatLocalizedNumber,
} from "@/lib/format-number";

describe("formatChineseNumber", () => {
  it("keeps sub-thousand numbers unchanged", () => {
    expect(formatChineseNumber(999)).toBe("999");
  });

  it("formats ten-thousands with 万", () => {
    expect(formatChineseNumber(15000)).toBe("1.5万");
  });

  it("formats hundred-millions with 亿", () => {
    expect(formatChineseNumber(150000000)).toBe("1.5亿");
  });
});

describe("formatLocalizedNumber", () => {
  it("uses western compact notation for english", () => {
    expect(formatLocalizedNumber(15000, "en")).toBe("15K");
  });

  it("uses western compact notation for other latin locales", () => {
    expect(formatLocalizedNumber(15000, "es")).toBe("15K");
  });
});

// Rounding to one decimal can carry a number into the next unit: 9999/1000 =
// 9.999 -> "10.0", and 999_950/1000 = 999.95 -> "1000.0". Measured before the
// fix: 9999 zh rendered as "10千" (10_000, which 万 names) and 999_950 en as
// "1000K". The unit is chosen from the rounded value so the magnitude word is
// never off by one step.
describe("formatLocalizedNumber promotes when rounding crosses a step", () => {
  it("carries a chinese 千 value into 万", () => {
    expect(formatLocalizedNumber(9999, "zh")).toBe("1万");
    expect(formatLocalizedNumber(10000, "zh")).toBe("1万");
  });

  it("carries a chinese 万 value into 亿", () => {
    expect(formatLocalizedNumber(99_999_999, "zh")).toBe("1亿");
    expect(formatLocalizedNumber(100_000_000, "zh")).toBe("1亿");
  });

  it("carries a latin K value into M", () => {
    expect(formatLocalizedNumber(999_950, "en")).toBe("1M");
    expect(formatLocalizedNumber(1_000_000, "en")).toBe("1M");
  });

  it("does not promote before the threshold is reached", () => {
    expect(formatLocalizedNumber(999_949, "en")).toBe("999.9K");
    expect(formatLocalizedNumber(1500, "zh")).toBe("1.5千");
  });
});

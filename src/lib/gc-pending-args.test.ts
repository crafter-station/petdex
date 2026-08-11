import { describe, expect, it } from "bun:test";

import { parsePendingGcArgs } from "@/lib/gc-pending-args";

describe("pending R2 GC arguments", () => {
  it("keeps a safe default and parses explicit options", () => {
    expect(parsePendingGcArgs([])).toEqual({ apply: false, ageHours: 24 });
    expect(parsePendingGcArgs(["--apply", "--age-hours", "12"])).toEqual({
      apply: true,
      ageHours: 12,
    });
    expect(parsePendingGcArgs(["--age-hours=6.5"])).toEqual({
      apply: false,
      ageHours: 6.5,
    });
  });

  it("rejects malformed or unsupported options without falling back", () => {
    for (const args of [
      ["--age-hours"],
      ["--age-hours", "--apply"],
      ["--age-hours=0"],
      ["--age-hours", "-1"],
      ["--age-hours", "12", "--age-hours", "24"],
      ["--aply"],
    ]) {
      expect(() => parsePendingGcArgs(args)).toThrow();
    }
  });
});

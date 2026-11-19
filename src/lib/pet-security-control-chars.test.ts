import { describe, expect, it } from "bun:test";

import { redactControlCharacters, scanPetSecurity } from "./pet-security";

// `control_character_payload` reports the offending value verbatim, and the
// scan found those characters in the input because they are blocked — so the
// evidence can carry a NUL, ESC or DEL. Postgres refuses a NUL in `text` and
// `jsonb` both, so a value with one made the review write throw and left the
// submission stuck in `running` with no decision; ESC and DEL are legal in
// the DB but are invisible or terminal-driving in the owner-facing rejection
// reason. `redactEvidence` sanitizes the evidence before it is stored.
describe("redactControlCharacters", () => {
  it("names each blocked character instead of carrying it", () => {
    expect(redactControlCharacters("a\u0000b")).toBe("a[NUL]b");
    expect(redactControlCharacters("a\u001bb")).toBe("a[ESC]b");
    expect(redactControlCharacters("a\u007fb")).toBe("a[DEL]b");
  });

  it("leaves ordinary text alone", () => {
    expect(redactControlCharacters("clean note")).toBe("clean note");
  });
});

describe("control_character_payload evidence", () => {
  it("never carries a NUL into the finding", () => {
    const scan = scanPetSecurity({ petJson: { note: "a\u0000b" } });
    expect(scan.decision).toBe("fail");
    const finding = scan.findings.find(
      (f) => f.code === "control_character_payload",
    );
    expect(finding?.evidence).toBe("a[NUL]b");
    expect(finding?.evidence.includes("\u0000")).toBe(false);
  });

  it("scrubs the characters from every code that reports the value", () => {
    // The scrub lives on the shared evidence path, not on one code: a value
    // carrying a NUL used to leave it in the evidence of five different codes.
    const value = "$(curl http://x)\u0000";
    const scan = scanPetSecurity({ petJson: { note: value } });
    const carriers = scan.findings.filter((f) => f.evidence.includes("\u0000"));
    expect(carriers).toEqual([]);
    expect(scan.findings.some((f) => f.evidence.includes("[NUL]"))).toBe(true);
  });

  it("redacts ESC and DEL too", () => {
    for (const [value, marker] of [
      ["a\u001bb", "[ESC]"],
      ["a\u007fb", "[DEL]"],
    ] as const) {
      const scan = scanPetSecurity({ petJson: { note: value } });
      const finding = scan.findings.find(
        (f) => f.code === "control_character_payload",
      );
      expect(finding?.evidence).toBe(`a${marker}b`);
    }
  });
});

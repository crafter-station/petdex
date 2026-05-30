import { describe, expect, it } from "bun:test";

import { textPolicyModerationPasses } from "@/lib/edit-policy";

describe("textPolicyModerationPasses", () => {
  it("accepts clean high-confidence text moderation", () => {
    expect(
      textPolicyModerationPasses(
        '{"decision":"pass","confidence":0.91,"flags":[]}',
      ),
    ).toBe(true);
  });

  it("rejects pass responses that still include flags", () => {
    expect(
      textPolicyModerationPasses(
        JSON.stringify({
          decision: "pass",
          confidence: 0.91,
          flags: [
            {
              category: "embedded_text_sensitive_symbol",
              confidence: 0.8,
              evidence: "risky text",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects malformed flags instead of treating them as clean", () => {
    expect(
      textPolicyModerationPasses(
        JSON.stringify({
          decision: "pass",
          confidence: 0.91,
          flags: {
            category: "embedded_text_sensitive_symbol",
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects low-confidence pass responses", () => {
    expect(
      textPolicyModerationPasses(
        '{"decision":"pass","confidence":0.69,"flags":[]}',
      ),
    ).toBe(false);
  });
});

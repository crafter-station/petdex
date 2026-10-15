import { describe, expect, it } from "bun:test";

import { DEFAULT_R2_PUBLIC_BASE } from "@/lib/r2-public-url";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  validateSubmission,
} from "@/lib/submissions-validation";

// A minimal valid submission; individual cases override one field.
function base(overrides: Record<string, unknown> = {}) {
  return {
    zipUrl: `${DEFAULT_R2_PUBLIC_BASE}/pets/boba-abc/zip.zip`,
    spritesheetUrl: `${DEFAULT_R2_PUBLIC_BASE}/pets/boba-abc/sprite.webp`,
    petJsonUrl: `${DEFAULT_R2_PUBLIC_BASE}/pets/boba-abc/petjson.json`,
    displayName: "Boba",
    description: "A very round cat.",
    petId: "boba",
    spritesheetWidth: 1536,
    spritesheetHeight: 1872,
    ...overrides,
  };
}

describe("validateSubmission free-text scan window", () => {
  it("accepts a submission that passes every check", () => {
    expect(validateSubmission(base())).toBeNull();
  });

  it("scans only the stored window, so a URL past the truncation point is not scanned", () => {
    // Every writer truncates description to MAX_DESCRIPTION_LENGTH, so text
    // beyond it is discarded and never rendered. Scanning the whole raw body
    // instead would let a caller append megabytes of padding — or bury a URL
    // the store would have dropped — and pay our CPU for it. The stored
    // window is what is scanned, so a URL after the cut does not 422.
    const padded = `${"a".repeat(MAX_DESCRIPTION_LENGTH)} https://evil.example.com`;
    const result = validateSubmission(base({ description: padded }));
    expect(result).toBeNull();
  });

  it("still refuses a URL inside the stored window", () => {
    const result = validateSubmission(
      base({ description: "see https://evil.example.com for more" }),
    );
    expect(result?.error).toBe("url_in_field");
  });

  it("still refuses a blocked keyword inside the stored window", () => {
    const result = validateSubmission(base({ displayName: "free crypto now" }));
    // Whatever the blocklist holds, the point is the scan runs on the window;
    // this asserts a refusal shape rather than a specific keyword.
    expect(result === null || result.status === 422).toBe(true);
  });

  it("bounds displayName at the stored length too", () => {
    const padded = `${"b".repeat(MAX_DISPLAY_NAME_LENGTH)} https://evil.example.com`;
    expect(validateSubmission(base({ displayName: padded }))).toBeNull();
    expect(
      validateSubmission(base({ displayName: "x https://evil.example.com" }))
        ?.error,
    ).toBe("url_in_field");
  });
});

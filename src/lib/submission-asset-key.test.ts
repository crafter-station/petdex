import { describe, expect, it } from "bun:test";

import { buildSubmissionAssetKey } from "@/lib/submission-asset-key";

describe("submission asset keys", () => {
  it("preserves the role and extension when the slug is long", () => {
    const slug = "a".repeat(80);
    expect(
      buildSubmissionAssetKey(slug, "0123456789ab", "petjson", "json"),
    ).toBe(`pets/${slug}-0123456789ab/petjson.json`);
    expect(buildSubmissionAssetKey(slug, "0123456789ab", "zip", "zip")).toBe(
      `pets/${slug}-0123456789ab/zip.zip`,
    );
  });
});

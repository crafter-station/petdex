import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "ad-campaign-editor.tsx"),
  "utf8",
);

describe("AdCampaignEditor ad preview", () => {
  it("renders the shared analytics-free sponsored card preview", () => {
    expect(source).toContain("@/components/ads/ad-card");
    expect(source).toContain("<AdCard");
    expect(source).toContain("disableNavigation");
    expect(source).toContain("const previewAd");
    expect(source).not.toContain("Sponsored preview");
    expect(source).not.toContain("FeedAdSlot");
  });
});

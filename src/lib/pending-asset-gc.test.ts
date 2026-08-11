import { describe, expect, it } from "bun:test";

import {
  pendingAssetKeyFromUrl,
  pendingAssetKeysFromUrls,
} from "@/lib/pending-asset-gc";

describe("pending asset GC references", () => {
  it("normalizes only strict pending asset URLs into claim keys", () => {
    expect(
      pendingAssetKeyFromUrl(
        "https://assets.petdex.dev/pets/demo-pending-0123456789ab/sprite.webp",
      ),
    ).toBe("pets/demo-pending-0123456789ab/sprite.webp");
    expect(
      pendingAssetKeyFromUrl("https://assets.petdex.dev/pets/demo/sprite.webp"),
    ).toBeNull();
  });

  it("deduplicates keys when a retry submits the same asset URL", () => {
    const key = "pets/demo-pending-0123456789ab/petjson.json";
    expect(
      pendingAssetKeysFromUrls([
        `https://assets.petdex.dev/${key}`,
        `https://assets.petdex.dev/${key}`,
      ]),
    ).toEqual([key]);
  });
});

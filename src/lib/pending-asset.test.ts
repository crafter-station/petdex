import { describe, expect, it } from "bun:test";

import {
  buildPendingAssetKey,
  isPendingAssetKey,
  isPendingAssetUrl,
} from "@/lib/pending-asset";

const SLUG = "sample-pet";
const UPLOAD_ID = "0123456789ab";

describe("pending asset keys", () => {
  it("builds the exact edit key shape for every role", () => {
    expect(buildPendingAssetKey(SLUG, UPLOAD_ID, "sprite", "webp")).toBe(
      "pets/sample-pet-pending-0123456789ab/sprite.webp",
    );
    expect(buildPendingAssetKey(SLUG, UPLOAD_ID, "petjson", "json")).toBe(
      "pets/sample-pet-pending-0123456789ab/petjson.json",
    );
    expect(buildPendingAssetKey(SLUG, UPLOAD_ID, "zip", "zip")).toBe(
      "pets/sample-pet-pending-0123456789ab/zip.zip",
    );
  });

  it("rejects invalid slugs, upload ids, and extensions", () => {
    expect(buildPendingAssetKey("bad/slug", UPLOAD_ID, "sprite", "webp")).toBe(
      null,
    );
    expect(buildPendingAssetKey(SLUG, "not-hex", "sprite", "webp")).toBe(null);
    expect(buildPendingAssetKey(SLUG, UPLOAD_ID, "petjson", "zip")).toBe(null);
  });

  it("matches only the requested pet and role", () => {
    const key = buildPendingAssetKey(SLUG, UPLOAD_ID, "sprite", "png");
    expect(isPendingAssetKey(key, SLUG, "sprite")).toBe(true);
    expect(isPendingAssetKey(key, "other-pet", "sprite")).toBe(false);
    expect(isPendingAssetKey(key, SLUG, "petjson")).toBe(false);
    expect(isPendingAssetKey(`${key}?x=1`, SLUG, "sprite")).toBe(false);
  });

  it("rejects query strings and trusted-host paths outside pending uploads", () => {
    const base = "https://assets.petdex.dev";
    const url = `${base}/pets/${SLUG}-pending-${UPLOAD_ID}/sprite.webp`;
    expect(isPendingAssetUrl(url, SLUG, "sprite")).toBe(true);
    expect(isPendingAssetUrl(`${url}?download=1`, SLUG, "sprite")).toBe(false);
    expect(
      isPendingAssetUrl(`${base}/pets/${SLUG}/sprite.webp`, SLUG, "sprite"),
    ).toBe(false);
    expect(
      isPendingAssetUrl(
        `https://evil.example/pets/${SLUG}-pending-${UPLOAD_ID}/sprite.webp`,
        SLUG,
        "sprite",
      ),
    ).toBe(false);
  });
});

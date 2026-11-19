import { describe, expect, it } from "bun:test";

import {
  petThumbnailKey,
  petThumbnailUrl,
  petThumbnailUrlForSource,
} from "@/lib/pet-thumbnail";
import { R2_PUBLIC_BASE } from "@/lib/r2-public-url";

// `petThumbnailUrlForSource` decides whether a pet gets a thumbnail URL at
// all: only a spritesheet that lives on our own R2 host has a derived
// thumbnail, and the desktop library and the public collection previews both
// pass the result straight through (`?? undefined`). Nothing tested the
// branch, so a change that returned a URL for a foreign host — a thumbnail
// that 404s — would not have failed a suite.

describe("petThumbnailUrlForSource", () => {
  it("returns a thumbnail URL for a spritesheet on our R2 host", () => {
    const url = petThumbnailUrlForSource(
      "boba",
      `${R2_PUBLIC_BASE}/pets/boba-abc123/sprite.webp`,
    );
    expect(url).toBe(`${R2_PUBLIC_BASE}/${petThumbnailKey("boba")}`);
  });

  it("returns null for a spritesheet hosted anywhere else", () => {
    // A legacy or foreign host has no thumbnail object beside it, so the
    // caller must fall back to omitting thumbnailUrl rather than emitting a
    // link that resolves to nothing.
    expect(
      petThumbnailUrlForSource(
        "boba",
        "https://evil.example.com/pets/boba/sprite.webp",
      ),
    ).toBeNull();
    expect(
      petThumbnailUrlForSource(
        "boba",
        "http://assets.petdex.dev/pets/b/s.webp",
      ),
    ).toBeNull();
    expect(petThumbnailUrlForSource("boba", "")).toBeNull();
  });

  it("builds the thumbnail URL under the pet's own slug", () => {
    expect(petThumbnailUrl("byte-bunny")).toBe(
      `${R2_PUBLIC_BASE}/pets/byte-bunny/thumb.webp`,
    );
  });
});

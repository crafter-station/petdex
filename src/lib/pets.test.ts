import { describe, expect, it, mock } from "bun:test";

import * as schema from "@/lib/db/schema";

mock.module("server-only", () => ({}));
mock.module("@/lib/db/client", () => ({ db: {}, schema }));

const { rowToPet } = await import("@/lib/pets");

const baseRow = {
  id: "pet_abc",
  slug: "boba",
  displayName: "Boba",
  description: "A cozy pet.",
  spritesheetUrl: "https://assets.petdex.dev/pets/boba/spritesheet.webp",
  petJsonUrl: "https://assets.petdex.dev/pets/boba/pet.json",
  zipUrl: "https://assets.petdex.dev/pets/boba/boba.zip",
  soundUrl: null,
  featured: false,
  kind: "creature" as const,
  vibes: [],
  tags: [],
  dominantColor: null,
  colorFamily: null,
  creditName: null,
  creditUrl: null,
  creditImage: null,
  source: "submit" as const,
  approvedAt: null,
  createdAt: new Date("2026-08-04T00:00:00Z"),
};

describe("rowToPet", () => {
  it("preserves the persisted sprite version for gallery and detail pages", () => {
    const pet = rowToPet({ ...baseRow, spriteVersionNumber: 2 });

    expect(pet.spriteVersionNumber).toBe(2);
  });
});

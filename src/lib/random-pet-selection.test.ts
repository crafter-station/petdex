import { describe, expect, test } from "bun:test";

import { pickRandomPet } from "@/lib/random-pet-selection";

const pool = [
  {
    slug: "alpha",
    displayName: "Alpha",
    description: "First",
    spritesheetPath: "https://assets.test/alpha.png",
  },
  {
    slug: "beta",
    displayName: "Beta",
    description: "Second",
    spritesheetPath: "https://assets.test/beta.png",
  },
  {
    slug: "gamma",
    displayName: "Gamma",
    description: "Third",
    spritesheetPath: "https://assets.test/gamma.png",
  },
];

describe("pickRandomPet", () => {
  test("returns null for an empty pool", () => {
    expect(pickRandomPet([], () => 0)).toBeNull();
  });

  test("selects from the full eligible pool", () => {
    expect(pickRandomPet(pool, () => 0)?.slug).toBe("alpha");
    expect(pickRandomPet(pool, () => 0.67)?.slug).toBe("gamma");
  });

  test("clamps out-of-range random sources", () => {
    expect(pickRandomPet(pool, () => 1)?.slug).toBe("gamma");
    expect(pickRandomPet(pool, () => -1)?.slug).toBe("alpha");
  });
});

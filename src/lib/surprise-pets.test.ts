import { describe, expect, test } from "bun:test";

import { toSurprisePet } from "@/lib/surprise-pets";

describe("toSurprisePet", () => {
  test("builds card and install links from a pet", () => {
    expect(
      toSurprisePet({
        slug: "alpha",
        displayName: "Alpha",
        description: "First",
        spritesheetPath: "https://assets.test/alpha.png",
      }),
    ).toEqual({
      slug: "alpha",
      displayName: "Alpha",
      description: "First",
      spritesheetPath: "https://assets.test/alpha.png",
      href: "/pets/alpha",
      installHref: "/install/alpha",
    });
  });
});

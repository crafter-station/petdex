import { describe, expect, it } from "bun:test";

import { buildCodexInstallUrl } from "@/lib/codex-desktop-link";

describe("buildCodexInstallUrl", () => {
  it("builds the install link ChatGPT.app's own parser accepts", () => {
    const url = buildCodexInstallUrl({
      displayName: "Boba",
      description: "A calm companion.",
      spritesheetUrl: "https://cdn.petdex.dev/pets/boba/spritesheet.png",
      spriteVersionNumber: 2,
    });
    expect(url).toBe(
      "codex://pets/install?name=Boba&description=A+calm+companion.&imageUrl=https%3A%2F%2Fcdn.petdex.dev%2Fpets%2Fboba%2Fspritesheet.png&spriteVersionNumber=2",
    );
  });

  // The parser walks every search param and rejects the whole URL on the
  // first one outside its allowlist, so an extra parameter is not ignored
  // -- it voids the install.
  it("sends only the four parameters the parser allows", () => {
    const url = buildCodexInstallUrl({
      displayName: "Boba",
      description: "A calm companion.",
      spritesheetUrl: "https://cdn.petdex.dev/pets/boba/spritesheet.png",
      spriteVersionNumber: 2,
    });
    expect([...new URL(url).searchParams.keys()].sort()).toEqual([
      "description",
      "imageUrl",
      "name",
      "spriteVersionNumber",
    ]);
  });

  // The app defaults a missing version to layout 1 and misreads every frame of
  // the other layout. Petdex ships both (v1 8x9 is the majority of the
  // catalog, v2 8x11 the rest), so the number has to come from the pet, not a
  // fixed guess: the old `?? 2` sent the wrong layout for every v1 pet.
  it("sends the pet's own version, not a hardcoded default", () => {
    const v1 = buildCodexInstallUrl({
      displayName: "Boba",
      description: "x",
      spritesheetUrl: "https://cdn.petdex.dev/pets/boba/spritesheet.webp",
      spriteVersionNumber: 1,
    });
    expect(new URL(v1).searchParams.get("spriteVersionNumber")).toBe("1");

    const v2 = buildCodexInstallUrl({
      displayName: "Boba",
      description: "x",
      spritesheetUrl: "https://cdn.petdex.dev/pets/boba/spritesheet.webp",
      spriteVersionNumber: 2,
    });
    expect(new URL(v2).searchParams.get("spriteVersionNumber")).toBe("2");
  });

  it("keeps the host and path the parser switches on", () => {
    const url = new URL(
      buildCodexInstallUrl({
        displayName: "Boba",
        description: "x",
        spritesheetUrl: "https://cdn.petdex.dev/pets/boba/spritesheet.webp",
        spriteVersionNumber: 2,
      }),
    );
    expect(url.protocol).toBe("codex:");
    expect(url.host).toBe("pets");
    expect(url.pathname.split("/").filter(Boolean)).toEqual(["install"]);
  });

  it("escapes ampersands so a crafted name cannot inject a parameter", () => {
    const url = buildCodexInstallUrl({
      displayName: "Evil&imageUrl=https://attacker.example/x.png",
      description: "x",
      spritesheetUrl: "https://cdn.petdex.dev/pets/ok/spritesheet.png",
      spriteVersionNumber: 2,
    });
    expect(url).not.toContain("attacker.example/x.png&");
    expect(new URL(url).searchParams.getAll("imageUrl")).toEqual([
      "https://cdn.petdex.dev/pets/ok/spritesheet.png",
    ]);
  });

  it("survives unicode display names", () => {
    const url = buildCodexInstallUrl({
      displayName: "小猫",
      description: "猫",
      spritesheetUrl: "https://cdn.petdex.dev/pets/cat/spritesheet.png",
      spriteVersionNumber: 2,
    });
    expect(new URL(url).searchParams.get("name")).toBe("小猫");
  });
});

import { describe, expect, it } from "bun:test";

import {
  assertGameEligiblePetPack,
  isGameDerivatableLicense,
  PET_ANIMATION_STATES,
  PET_LICENSES,
  PET_PACK_V3_SCHEMA_VERSION,
  type PetLicense,
  PetPackLicenseError,
  type PetPackV3,
  parsePetPackV3,
} from "@/lib/pet-pack-v3";

function makeCanonicalStates() {
  return {
    idle: { row: 0, frames: 6, frameDurationMs: 180 },
    "running-right": { row: 1, frames: 8, frameDurationMs: 120 },
    "running-left": { row: 2, frames: 8, frameDurationMs: 120 },
    waving: { row: 3, frames: 4, frameDurationMs: 140 },
    jumping: { row: 4, frames: 5, frameDurationMs: 140 },
    failed: { row: 5, frames: 8, frameDurationMs: 140 },
    waiting: { row: 6, frames: 6, frameDurationMs: 150 },
    running: { row: 7, frames: 6, frameDurationMs: 120 },
    review: { row: 8, frames: 6, frameDurationMs: 150 },
  };
}

function makeValidPack(overrides: Partial<PetPackV3> = {}): PetPackV3 {
  return {
    schemaVersion: PET_PACK_V3_SCHEMA_VERSION,
    slug: "boba-cat",
    displayName: "Boba Cat",
    license: "cc0",
    atlas: {
      width: 1536,
      height: 2288,
      frameWidth: 192,
      frameHeight: 208,
      states: makeCanonicalStates(),
    },
    sound: {
      url: "https://assets.petdex.dev/pets/boba-cat/meow.ogg",
      volume: 0.75,
    },
    game: {
      hitbox: { x: 32, y: 40, width: 128, height: 160 },
      anchor: { x: 0.5, y: 1 },
      stats: { hp: 85, attack: 60, defense: 55, speed: 70 },
    },
    ...overrides,
  };
}

describe("pet-pack-v3 contract", () => {
  it("exports schema version 3 and all 9 canonical animation states", () => {
    expect(PET_PACK_V3_SCHEMA_VERSION).toBe(3);
    expect(PET_ANIMATION_STATES).toEqual([
      "idle",
      "running-right",
      "running-left",
      "waving",
      "jumping",
      "failed",
      "waiting",
      "running",
      "review",
    ]);
    expect(PET_ANIMATION_STATES).toHaveLength(9);
  });

  it("parses a complete valid v3 pack with game and sound metadata", () => {
    const input = makeValidPack();
    const parsed = parsePetPackV3(input);

    expect(parsed).toEqual(input);
  });

  it("parses a v3 pack without optional sound and game blocks", () => {
    const {
      sound: _sound,
      game: _game,
      ...minimal
    } = makeValidPack({
      atlas: {
        width: 1536,
        height: 1872,
        frameWidth: 192,
        frameHeight: 208,
        states: {
          idle: { row: 0, frames: 6 },
        },
      },
    });

    const parsed = parsePetPackV3(minimal);
    expect(parsed.sound).toBeUndefined();
    expect(parsed.game).toBeUndefined();
    expect(parsed.atlas.states.idle).toEqual({ row: 0, frames: 6 });
  });

  it("rejects wrong schemaVersion", () => {
    expect(() =>
      parsePetPackV3({ ...makeValidPack(), schemaVersion: 2 }),
    ).toThrow();
  });

  it("rejects missing required fields and invalid slug", () => {
    expect(() => parsePetPackV3({})).toThrow();
    expect(() =>
      parsePetPackV3({ ...makeValidPack(), slug: "Boba_Cat!" }),
    ).toThrow();
    expect(() =>
      parsePetPackV3({ ...makeValidPack(), displayName: "   " }),
    ).toThrow();
  });

  it("rejects unknown animation state names or missing idle state", () => {
    expect(() =>
      parsePetPackV3({
        ...makeValidPack(),
        atlas: {
          width: 1536,
          height: 1872,
          frameWidth: 192,
          frameHeight: 208,
          states: {
            waving: { row: 3, frames: 4 },
          },
        },
      }),
    ).toThrow();

    expect(() =>
      parsePetPackV3({
        ...makeValidPack(),
        atlas: {
          width: 1536,
          height: 1872,
          frameWidth: 192,
          frameHeight: 208,
          states: {
            idle: { row: 0, frames: 6 },
            dancing: { row: 1, frames: 4 },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects misaligned atlas dimensions and out-of-bounds state rows or frames", () => {
    expect(() =>
      parsePetPackV3({
        ...makeValidPack(),
        atlas: {
          width: 1500,
          height: 1872,
          frameWidth: 192,
          frameHeight: 208,
          states: { idle: { row: 0, frames: 6 } },
        },
      }),
    ).toThrow();

    expect(() =>
      parsePetPackV3({
        ...makeValidPack(),
        atlas: {
          width: 1536,
          height: 1872,
          frameWidth: 192,
          frameHeight: 208,
          states: { idle: { row: 9, frames: 6 } },
        },
      }),
    ).toThrow();

    expect(() =>
      parsePetPackV3({
        ...makeValidPack(),
        atlas: {
          width: 1536,
          height: 1872,
          frameWidth: 192,
          frameHeight: 208,
          states: { idle: { row: 0, frames: 9 } },
        },
      }),
    ).toThrow();
  });

  it("rejects out-of-range fighter stats, anchor, and oversized hitbox", () => {
    const base = makeValidPack();
    const baseGame = {
      hitbox: { x: 32, y: 40, width: 128, height: 160 },
      anchor: { x: 0.5, y: 1 },
      stats: { hp: 85, attack: 60, defense: 55, speed: 70 },
    };

    expect(() =>
      parsePetPackV3({
        ...base,
        game: {
          ...baseGame,
          stats: { hp: 0, attack: 50, defense: 50, speed: 50 },
        },
      }),
    ).toThrow();

    expect(() =>
      parsePetPackV3({
        ...base,
        game: {
          ...baseGame,
          stats: { hp: 100, attack: 101, defense: 50, speed: 50 },
        },
      }),
    ).toThrow();

    expect(() =>
      parsePetPackV3({
        ...base,
        game: {
          ...baseGame,
          anchor: { x: 1.5, y: 0.5 },
        },
      }),
    ).toThrow();

    expect(() =>
      parsePetPackV3({
        ...base,
        game: {
          ...baseGame,
          hitbox: { x: 100, y: 0, width: 100, height: 100 },
        },
      }),
    ).toThrow();
  });

  it("rejects invalid sound URL or volume out of range", () => {
    expect(() =>
      parsePetPackV3({
        ...makeValidPack(),
        sound: { url: "not-a-url", volume: 0.5 },
      }),
    ).toThrow();

    expect(() =>
      parsePetPackV3({
        ...makeValidPack(),
        sound: { url: "https://assets.petdex.dev/a.ogg", volume: 1.2 },
      }),
    ).toThrow();
  });
});

describe("isGameDerivatableLicense", () => {
  const expected: Record<PetLicense, boolean> = {
    cc0: true,
    "cc-by": true,
    "cc-by-sa": true,
    unspecified: false,
    "cc-by-nc": false,
    "all-rights-reserved": false,
  };

  it("covers every pet_license enum value from schema.ts", () => {
    expect(Object.keys(expected).sort()).toEqual([...PET_LICENSES].sort());

    for (const license of PET_LICENSES) {
      expect(isGameDerivatableLicense(license)).toBe(expected[license]);
    }
  });
});

describe("assertGameEligiblePetPack", () => {
  it("allows cc0 without attribution or share-alike requirement", () => {
    const pack = parsePetPackV3(makeValidPack({ license: "cc0" }));
    const result = assertGameEligiblePetPack(pack);

    expect(result).toEqual({
      eligible: true,
      pack,
      license: "cc0",
      requiresAttribution: false,
      requiresShareAlike: false,
    });
  });

  it("allows cc-by with attribution required and share-alike false", () => {
    const pack = parsePetPackV3(makeValidPack({ license: "cc-by" }));
    const result = assertGameEligiblePetPack(pack);

    expect(result).toEqual({
      eligible: true,
      pack,
      license: "cc-by",
      requiresAttribution: true,
      requiresShareAlike: false,
    });
  });

  it("allows cc-by-sa with both attribution and share-alike required", () => {
    const pack = parsePetPackV3(makeValidPack({ license: "cc-by-sa" }));
    const result = assertGameEligiblePetPack(pack);

    expect(result).toEqual({
      eligible: true,
      pack,
      license: "cc-by-sa",
      requiresAttribution: true,
      requiresShareAlike: true,
    });
  });

  it.each([
    "unspecified",
    "cc-by-nc",
    "all-rights-reserved",
  ] as const)("blocks %s with PetPackLicenseError", (blockedLicense) => {
    const pack = parsePetPackV3(makeValidPack({ license: blockedLicense }));

    let caught: unknown;
    try {
      assertGameEligiblePetPack(pack);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PetPackLicenseError);
    const err = caught as PetPackLicenseError;
    expect(err.code).toBe("INELIGIBLE_PET_LICENSE");
    expect(err.slug).toBe("boba-cat");
    expect(err.license).toBe(blockedLicense);
  });
});

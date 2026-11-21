import { z } from "zod";

export const PET_PACK_V3_SCHEMA_VERSION = 3 as const;

export const PET_ANIMATION_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export type PetAnimationState = (typeof PET_ANIMATION_STATES)[number];

export const PET_LICENSES = [
  "unspecified",
  "cc0",
  "cc-by",
  "cc-by-sa",
  "cc-by-nc",
  "all-rights-reserved",
] as const;

export type PetLicense = (typeof PET_LICENSES)[number];

export const GAME_DERIVATABLE_LICENSES = ["cc0", "cc-by", "cc-by-sa"] as const;

export type GameDerivatableLicense = (typeof GAME_DERIVATABLE_LICENSES)[number];

const GAME_DERIVATABLE_LICENSE_SET: ReadonlySet<string> = new Set(
  GAME_DERIVATABLE_LICENSES,
);

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const petAnimationStateSchema = z.enum(PET_ANIMATION_STATES);
export const petLicenseSchema = z.enum(PET_LICENSES);

export const petAtlasStateSpecSchema = z.object({
  row: z.int().nonnegative(),
  frames: z.int().positive(),
  frameDurationMs: z.int().positive().optional(),
});

export const petPackAtlasSchema = z
  .object({
    width: z.int().positive(),
    height: z.int().positive(),
    frameWidth: z.int().positive(),
    frameHeight: z.int().positive(),
    states: z
      .partialRecord(petAnimationStateSchema, petAtlasStateSpecSchema)
      .refine((states) => states.idle !== undefined, {
        message: "atlas.states must include the canonical 'idle' state",
      }),
  })
  .superRefine((atlas, ctx) => {
    if (atlas.width % atlas.frameWidth !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["width"],
        message: "atlas.width must be an integer multiple of atlas.frameWidth",
      });
    }

    if (atlas.height % atlas.frameHeight !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["height"],
        message:
          "atlas.height must be an integer multiple of atlas.frameHeight",
      });
    }

    const columns = Math.floor(atlas.width / atlas.frameWidth);
    const rows = Math.floor(atlas.height / atlas.frameHeight);

    for (const [stateName, spec] of Object.entries(atlas.states)) {
      if (!spec) continue;
      if (spec.row >= rows) {
        ctx.addIssue({
          code: "custom",
          path: ["states", stateName, "row"],
          message: `state '${stateName}' row ${spec.row} exceeds atlas row count ${rows}`,
        });
      }
      if (spec.frames > columns) {
        ctx.addIssue({
          code: "custom",
          path: ["states", stateName, "frames"],
          message: `state '${stateName}' frames ${spec.frames} exceeds atlas column count ${columns}`,
        });
      }
    }
  });

export const petPackSoundSchema = z.object({
  url: z.url(),
  volume: z.number().min(0).max(1).optional(),
});

export const petPackHitboxSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const petPackAnchorSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

const fighterStatSchema = z.int().min(1).max(100);

export const petPackFighterStatsSchema = z.object({
  hp: fighterStatSchema,
  attack: fighterStatSchema,
  defense: fighterStatSchema,
  speed: fighterStatSchema,
});

export const petPackGameSchema = z.object({
  hitbox: petPackHitboxSchema,
  anchor: petPackAnchorSchema,
  stats: petPackFighterStatsSchema,
});

export const petPackV3Schema = z
  .object({
    schemaVersion: z.literal(PET_PACK_V3_SCHEMA_VERSION),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(SLUG_PATTERN, "slug must be lowercase kebab-case"),
    displayName: z.string().trim().min(1).max(80),
    license: petLicenseSchema,
    atlas: petPackAtlasSchema,
    sound: petPackSoundSchema.optional(),
    game: petPackGameSchema.optional(),
  })
  .superRefine((pack, ctx) => {
    if (!pack.game) return;
    const { hitbox } = pack.game;
    if (hitbox.x + hitbox.width > pack.atlas.frameWidth) {
      ctx.addIssue({
        code: "custom",
        path: ["game", "hitbox", "width"],
        message: "game.hitbox exceeds atlas.frameWidth",
      });
    }
    if (hitbox.y + hitbox.height > pack.atlas.frameHeight) {
      ctx.addIssue({
        code: "custom",
        path: ["game", "hitbox", "height"],
        message: "game.hitbox exceeds atlas.frameHeight",
      });
    }
  });

export type PetPackV3 = z.infer<typeof petPackV3Schema>;

export type GameEligibilityResult = {
  eligible: true;
  pack: PetPackV3;
  license: GameDerivatableLicense;
  requiresAttribution: boolean;
  requiresShareAlike: boolean;
};

export class PetPackLicenseError extends Error {
  readonly code = "INELIGIBLE_PET_LICENSE" as const;
  readonly slug: string;
  readonly license: PetLicense;

  constructor(slug: string, license: PetLicense) {
    super(
      `Pet pack "${slug}" has license "${license}", which is not eligible for derivative games`,
    );
    this.name = "PetPackLicenseError";
    this.slug = slug;
    this.license = license;
  }
}

export function isGameDerivatableLicense(
  license: PetLicense,
): license is GameDerivatableLicense {
  return GAME_DERIVATABLE_LICENSE_SET.has(license);
}

export function parsePetPackV3(input: unknown): PetPackV3 {
  return petPackV3Schema.parse(input);
}

export function assertGameEligiblePetPack(
  pack: PetPackV3,
): GameEligibilityResult {
  if (!isGameDerivatableLicense(pack.license)) {
    throw new PetPackLicenseError(pack.slug, pack.license);
  }

  return {
    eligible: true,
    pack,
    license: pack.license,
    requiresAttribution:
      pack.license === "cc-by" || pack.license === "cc-by-sa",
    requiresShareAlike: pack.license === "cc-by-sa",
  };
}

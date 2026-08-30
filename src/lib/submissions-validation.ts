import {
  BLOCKED_KEYWORD_REASON,
  findBlockedKeyword,
} from "@/lib/keyword-blocklist";
import { detectSpriteAtlas } from "@/lib/sprite-atlas";
import { normalizeSpriteVersionNumber } from "@/lib/sprite-version";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";
import { containsUrl, URL_BLOCKED_REASON } from "@/lib/url-blocklist";

export type SubmissionInput = {
  zipUrl: string;
  spritesheetUrl: string;
  petJsonUrl: string;
  displayName: string;
  description: string;
  petId: string;
  spritesheetWidth: number;
  spritesheetHeight: number;
  spriteVersionNumber?: 1 | 2;
  license?: PetLicenseChoice;
};

// Licenses a creator may declare for their pet artwork. The repo's code is
// MIT, but artwork belongs to whoever drew it, so the grant travels per pet.
// 'unspecified' is not offered at submit time — it only describes pets that
// predate this field, where the creator never declared anything.
export const PET_LICENSE_CHOICES = [
  "cc0",
  "cc-by",
  "cc-by-sa",
  "cc-by-nc",
  "all-rights-reserved",
] as const;

export type PetLicenseChoice = (typeof PET_LICENSE_CHOICES)[number];

/** Licenses that let someone ship the pet in a commercial product. */
export const COMMERCIAL_PET_LICENSES: ReadonlyArray<PetLicenseChoice> = [
  "cc0",
  "cc-by",
  "cc-by-sa",
] as const;

export function isPetLicenseChoice(v: unknown): v is PetLicenseChoice {
  return (
    typeof v === "string" &&
    (PET_LICENSE_CHOICES as ReadonlyArray<string>).includes(v)
  );
}

export type SubmissionResult =
  | { ok: true; id: string; slug: string }
  | {
      ok: false;
      status: number;
      error: string;
      message?: string;
      field?: string;
      got?: unknown;
    };

export const REQUIRED_FIELDS: ReadonlyArray<keyof SubmissionInput> = [
  "zipUrl",
  "spritesheetUrl",
  "petJsonUrl",
  "displayName",
  "description",
  "petId",
  "spritesheetWidth",
  "spritesheetHeight",
] as const;

export const MIN_SPRITE_DIM = 256;

const ASSET_URL_FIELDS: ReadonlyArray<
  "zipUrl" | "spritesheetUrl" | "petJsonUrl"
> = ["zipUrl", "spritesheetUrl", "petJsonUrl"];

export function validateSubmission(
  body: Partial<SubmissionInput>,
): SubmissionResult | null {
  for (const field of REQUIRED_FIELDS) {
    if (!body[field]) {
      return {
        ok: false,
        status: 400,
        error: "missing_field",
        field,
      };
    }
  }
  if (!isPetLicenseChoice(body.license)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_license",
      field: "license",
      message: `license must be one of: ${PET_LICENSE_CHOICES.join(", ")}`,
      got: body.license,
    };
  }

  const width = body.spritesheetWidth;
  const height = body.spritesheetHeight;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_SPRITE_DIM ||
    height < MIN_SPRITE_DIM
  ) {
    return {
      ok: false,
      status: 400,
      error: "invalid_spritesheet",
      message: `Spritesheet dimensions are invalid. Got ${String(width)}x${String(height)}, expected integer dimensions at least ${MIN_SPRITE_DIM}x${MIN_SPRITE_DIM}.`,
      got: { width, height },
    };
  }
  const atlas = detectSpriteAtlas(width, height);
  if (!atlas) {
    return {
      ok: false,
      status: 400,
      error: "invalid_spritesheet",
      message: `Spritesheet must preserve the 8x9 (1536x1872) or v2 8x11 (1536x2288) atlas ratio. Got ${width}x${height}, which the pet viewer would squash and misalign.`,
      got: { width, height },
    };
  }
  const spriteVersion = normalizeSpriteVersionNumber(body.spriteVersionNumber);
  if (!spriteVersion.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_sprite_version",
      field: "spriteVersionNumber",
      message: "spriteVersionNumber must be omitted, 1, or 2.",
      got: spriteVersion.value,
    };
  }
  if (atlas.version !== spriteVersion.version) {
    return {
      ok: false,
      status: 400,
      error: "invalid_sprite_version",
      field: "spriteVersionNumber",
      message: `spriteVersionNumber ${spriteVersion.version} does not match the ${atlas.rows}-row atlas dimensions.`,
      got: spriteVersion.version,
    };
  }
  // Reject any URL outside the allowlist. Without this, a malicious
  // submission could land javascript:, attacker.com, or LAN IPs into the
  // pet detail page (XSS) and the install script (RCE on every viewer who
  // pipes it through sh).
  for (const field of ASSET_URL_FIELDS) {
    if (!isAllowedAssetUrl(body[field])) {
      return {
        ok: false,
        status: 400,
        error: "invalid_asset_url",
        field,
        message: `${field} must be hosted on the petdex R2 bucket.`,
      };
    }
  }
  // URL filter — reject any URL embedded in free-text fields.
  const urlHit = containsUrl(
    ["displayName", body.displayName],
    ["description", body.description],
  );
  if (urlHit) {
    return {
      ok: false,
      status: 422,
      error: "url_in_field",
      field: urlHit.field,
      message: URL_BLOCKED_REASON,
    };
  }

  // Keyword blocklist — runs after structural validation so a blocked
  // submission gets the same shape as other 400s. Hit returns 422 to
  // distinguish moderation rejects from bad input in logs.
  const hit = findBlockedKeyword(body.displayName, body.description);
  if (hit) {
    return {
      ok: false,
      status: 422,
      error: "blocked_content",
      field: "displayName",
      message: BLOCKED_KEYWORD_REASON,
    };
  }
  return null;
}

export { deriveSlug, slugify } from "@/lib/slug";

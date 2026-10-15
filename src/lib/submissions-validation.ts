import {
  BLOCKED_KEYWORD_REASON,
  findBlockedKeyword,
} from "@/lib/keyword-blocklist";
import { detectSpriteAtlas } from "@/lib/sprite-atlas";
import { normalizeSpriteVersionNumber } from "@/lib/sprite-version";
import { isAllowedSubmissionAssetUrl } from "@/lib/url-allowlist";
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

// The stored bounds for the two free-text fields. Every writer truncates to
// these (submissions.ts, submission-decisions.ts, pet-edit.ts), so validation
// can bound the blocklist/URL scans to the same length instead of running
// several regexes over an unbounded request body. Kept here, not in a
// component, so the API and the form cannot drift.
export const MAX_DISPLAY_NAME_LENGTH = 60;
export const MAX_DESCRIPTION_LENGTH = 280;

const ASSET_URL_FIELDS: ReadonlyArray<
  "zipUrl" | "spritesheetUrl" | "petJsonUrl"
> = ["zipUrl", "spritesheetUrl", "petJsonUrl"];

export function validateSubmission(
  body: Partial<SubmissionInput>,
): SubmissionResult | null {
  // `req.json()` resolves `null` for a literal `null` body without throwing,
  // and the field reads below would TypeError on it — a 500 on both submit
  // endpoints. Refuse non-objects as a 400, the way the sibling routes do.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid_body" };
  }
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
  // The truthiness check above accepts any truthy value, so `{ displayName:
  // 5 }` walked on and threw inside containsUrl/findBlockedKeyword or the
  // `.trim()` at persist time — a 500 for a malformed body. Require the
  // string fields to actually be strings.
  const STRING_FIELDS = [
    "zipUrl",
    "spritesheetUrl",
    "petJsonUrl",
    "displayName",
    "description",
    "petId",
  ] as const;
  for (const field of STRING_FIELDS) {
    if (typeof body[field] !== "string") {
      return {
        ok: false,
        status: 400,
        error: "invalid_field",
        field,
        message: `${field} must be a string.`,
        got: body[field],
      };
    }
  }
  // Transition window: a CLI published before the license field existed
  // sends no license at all, and rejecting those would break `petdex
  // submit` for everyone who has not upgraded yet. Absent is accepted and
  // stored as 'unspecified'. A license that IS sent must still be valid —
  // silently discarding a typo would record "no grant" for a creator who
  // believed they gave one. Tighten to required once the new CLI is out.
  if (body.license !== undefined && !isPetLicenseChoice(body.license)) {
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
  // pipes it through sh). The submission boundary additionally pins the path
  // namespace: host alone let an asset field point at `requests/<other>/...`,
  // another user's reference upload.
  for (const field of ASSET_URL_FIELDS) {
    if (!isAllowedSubmissionAssetUrl(body[field])) {
      return {
        ok: false,
        status: 400,
        error: "invalid_asset_url",
        field,
        message: `${field} must be hosted on the petdex R2 bucket.`,
      };
    }
  }
  // The URL and keyword scans run several regexes per field (and, for URLs,
  // build more inside stripLegitDomains). Scan only the stored window — every
  // writer truncates these fields to MAX_*_LENGTH — so a multi-MB body cannot
  // make the caller choose how much CPU we spend, and nothing that survives to
  // storage goes unscanned. (The `trim()` matches the writers, which trim
  // before truncating.)
  // `?? ""` because TS cannot see the STRING_FIELDS loop above narrow the
  // optional fields; at runtime both are strings by this point.
  const displayNameForScan = (body.displayName ?? "")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  const descriptionForScan = (body.description ?? "")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);

  // URL filter — reject any URL embedded in free-text fields.
  const urlHit = containsUrl(
    ["displayName", displayNameForScan],
    ["description", descriptionForScan],
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
  const hit = findBlockedKeyword(displayNameForScan, descriptionForScan);
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

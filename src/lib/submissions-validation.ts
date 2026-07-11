import {
  BLOCKED_KEYWORD_REASON,
  findBlockedKeyword,
} from "@/lib/keyword-blocklist";
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
};

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
  if (
    !body.spritesheetWidth ||
    !body.spritesheetHeight ||
    body.spritesheetWidth < MIN_SPRITE_DIM ||
    body.spritesheetHeight < MIN_SPRITE_DIM
  ) {
    return {
      ok: false,
      status: 400,
      error: "invalid_spritesheet",
      message: `Spritesheet seems too small. Got ${body.spritesheetWidth}x${body.spritesheetHeight}, expected at least ${MIN_SPRITE_DIM}x${MIN_SPRITE_DIM} (ideal 1536x1872).`,
      got: { width: body.spritesheetWidth, height: body.spritesheetHeight },
    };
  }
  // The viewer (pet-sprite.tsx) force-renders every sheet at 1536x1872
  // (8 columns x 9 rows), so any other aspect gets squashed and every
  // frame crop lands mid-sprite. A sheet with extra rows passed the
  // min-dim check and shipped visibly broken (pixie, 1536x2288 = 11
  // rows), so enforce the canonical grid shape, allowing clean scales
  // of it (768x936, 3072x3744, ...).
  if (body.spritesheetWidth * 1872 !== body.spritesheetHeight * 1536) {
    return {
      ok: false,
      status: 400,
      error: "invalid_spritesheet",
      message: `Spritesheet must be an 8x9 grid with a 1536:1872 aspect (ideal 1536x1872). Got ${body.spritesheetWidth}x${body.spritesheetHeight}, which the pet viewer would squash and misalign.`,
      got: { width: body.spritesheetWidth, height: body.spritesheetHeight },
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

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

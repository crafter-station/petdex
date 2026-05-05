import { isAllowedAssetUrl } from "@/lib/url-allowlist";

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

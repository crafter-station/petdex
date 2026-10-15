// Server-only sprite color extraction. Loads node-vibrant + sharp,
// which both reach for `child_process` / `fs` / native `jimp` deps —
// importing this file from a client component breaks the browser
// bundle. For type / constants / pure-JS classification, import from
// `@/lib/color-families` instead.

import { Vibrant } from "node-vibrant/node";
import sharp from "sharp";

import {
  COLOR_FAMILIES,
  type ColorFamily,
  classifyColorFamily,
} from "@/lib/color-families";
import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";
import { readResponseBodyBounded } from "@/lib/response-body";
import { isDecodableSpriteSize } from "@/lib/sprite-atlas";
import { PET_ASSET_MAX_BYTES } from "@/lib/upload-limits";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

// Re-export so the existing import surface keeps working for the few
// server-only callers (admin approve hook, backfill script). New
// browser-side imports should target color-families directly.
export { COLOR_FAMILIES, type ColorFamily, classifyColorFamily };

const PALETTE_ORDER = [
  "Vibrant",
  "LightVibrant",
  "Muted",
  "LightMuted",
  "DarkVibrant",
  "DarkMuted",
] as const;

// Same ceiling the review pipeline fetches assets with (`submission-review.ts`
// caps at PET_ASSET_MAX_BYTES too) — this runs in the approve hook against a
// DB row, so the buffer has to be bounded, not `arrayBuffer()`'d blind.
const EXTRACT_MAX_BYTES = PET_ASSET_MAX_BYTES;
const EXTRACT_FETCH_TIMEOUT_MS = 10_000;

export async function extractDominantColor(
  spriteUrl: string,
): Promise<string | null> {
  // Rows normally pass validateSubmission (allowlisted) at insert time, but
  // the review/OG fetch paths still re-check the row before fetching — this
  // helper is the one fetch in the approve hook that did not, so a legacy
  // row or a future writer path cannot turn it into SSRF against a LAN host.
  const url = toCurrentR2PublicUrl(spriteUrl);
  if (!isAllowedAssetUrl(url)) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(EXTRACT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }

    const buffer = await readResponseBodyBounded(
      res,
      EXTRACT_MAX_BYTES,
      EXTRACT_FETCH_TIMEOUT_MS,
    );
    // The byte cap above does not bound the decode: a flat-colour PNG at
    // 13824x16848 is 920 KB but decodes to a ~1.7 GB RGBA buffer inside
    // Vibrant/Jimp (measured). Refuse a sheet whose dimensions exceed the
    // largest legitimate atlas before handing it to the decoder.
    const meta = await sharp(buffer).metadata();
    if (!isDecodableSpriteSize(meta.width, meta.height)) return null;
    const normalized = await sharp(buffer).png().toBuffer();
    const palette = await Vibrant.from(normalized).getPalette();

    for (const key of PALETTE_ORDER) {
      const swatch = palette[key];
      if (swatch?.hex) {
        return swatch.hex.toLowerCase();
      }
    }

    return null;
  } catch {
    return null;
  }
}

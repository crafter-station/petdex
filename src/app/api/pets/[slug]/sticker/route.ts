// Sticker download endpoint. Returns one of:
//   - 240x240 animated WebP (default; best quality + alpha)
//   - 240x240 animated GIF  (?format=gif; for WhatsApp Desktop, Slack)
//   - 240x240 static PNG    (?format=png; for platforms blocking animated)
//
// Query params:
//   ?state=idle|waving|jumping|...   (default 'idle')
//   ?format=webp|gif|png             (default 'webp')
//   ?download=1                       (forces Content-Disposition: attachment)
//
// Why GIF as a first-class format: WhatsApp Desktop and WhatsApp Web only
// render the first frame of imported animated WebP stickers (mobile clients
// animate them correctly). GIF inline messages animate everywhere.
//
// For full WhatsApp packs, see /api/pets/[slug]/wastickers.

import { NextResponse } from "next/server";

import type { PetStateId } from "@/lib/pet-states";
import { getPet } from "@/lib/pets";
import { renderSticker, type StickerFormat } from "@/lib/sticker-renderer";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

export const runtime = "nodejs";

const CACHE_HEADER = "public, max-age=31536000, s-maxage=31536000, immutable";

const VALID_STATES: PetStateId[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

function parseState(value: string | null): PetStateId | undefined {
  if (!value) return undefined;
  return VALID_STATES.includes(value as PetStateId)
    ? (value as PetStateId)
    : undefined;
}

const VALID_FORMATS: StickerFormat[] = ["webp", "gif", "png"];

function parseFormat(value: string | null): StickerFormat | undefined {
  if (!value) return undefined;
  return VALID_FORMATS.includes(value as StickerFormat)
    ? (value as StickerFormat)
    : undefined;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const state = parseState(url.searchParams.get("state"));
  const format = parseFormat(url.searchParams.get("format"));
  const isDownload = url.searchParams.get("download") === "1";

  const pet = await getPet(slug);

  if (!pet) {
    return new NextResponse("not found", { status: 404 });
  }

  if (!isAllowedAssetUrl(pet.spritesheetPath)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let result: Awaited<ReturnType<typeof renderSticker>>;
  try {
    result = await renderSticker(pet.spritesheetPath, { state, format });
  } catch (err) {
    const message =
      err instanceof Error && err.message.startsWith("upstream")
        ? err.message
        : "decode";
    return new NextResponse(message, {
      status: message.startsWith("upstream") ? 502 : 500,
    });
  }

  const extByType: Record<typeof result.contentType, string> = {
    "image/webp": "webp",
    "image/gif": "gif",
    "image/png": "png",
  };
  const ext = extByType[result.contentType];
  const stateSuffix = state ? `-${state}` : "";
  const filename = `${slug}${stateSuffix}-sticker.${ext}`;

  const headers: Record<string, string> = {
    "content-type": result.contentType,
    "cache-control": CACHE_HEADER,
  };
  if (isDownload) {
    headers["content-disposition"] = `attachment; filename="${filename}"`;
  }

  return new NextResponse(new Uint8Array(result.buffer), {
    status: 200,
    headers,
  });
}

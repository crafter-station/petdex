import { NextResponse } from "next/server";

import {
  isValidPetSlug,
  PET_STICKER_REDIRECT_CACHE_HEADER,
  petStickerFilename,
  petStickerUrl,
} from "@/lib/pet-sticker-artifacts";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  if (!isValidPetSlug(slug)) {
    return new NextResponse("invalid_slug", { status: 400 });
  }

  const response = NextResponse.redirect(petStickerUrl(slug), {
    status: 308,
  });
  response.headers.set("cache-control", PET_STICKER_REDIRECT_CACHE_HEADER);
  response.headers.set(
    "content-disposition",
    `attachment; filename="${petStickerFilename(slug)}"`,
  );
  return response;
}

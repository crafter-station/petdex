import { NextResponse } from "next/server";

import { isValidPetSlug } from "@/lib/pet-sticker-artifacts";
import {
  PET_THUMBNAIL_REDIRECT_CACHE_HEADER,
  petThumbnailUrl,
} from "@/lib/pet-thumbnail";
import { getPet } from "@/lib/pets";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  if (!isValidPetSlug(slug)) {
    return new NextResponse("invalid_slug", { status: 400 });
  }
  const pet = await getPet(slug);
  if (!pet) {
    return new NextResponse("not_found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }

  const response = NextResponse.redirect(petThumbnailUrl(pet.slug), {
    status: 308,
  });
  response.headers.set("cache-control", PET_THUMBNAIL_REDIRECT_CACHE_HEADER);
  return response;
}

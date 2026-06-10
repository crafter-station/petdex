import { NextResponse } from "next/server";

import {
  isValidPetSlug,
  PET_STICKER_UNAVAILABLE_CACHE_HEADER,
} from "@/lib/pet-sticker-artifacts";
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

  return new NextResponse("pack_unavailable", {
    status: 410,
    headers: {
      "cache-control": PET_STICKER_UNAVAILABLE_CACHE_HEADER,
    },
  });
}

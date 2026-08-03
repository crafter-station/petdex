import { NextResponse } from "next/server";

import {
  isValidPetSlug,
  parseExactPetStickerFormat,
  parseExactPetStickerState,
  parseExactPetStickerTreatment,
  petStickerUrl,
} from "@/lib/pet-sticker-artifacts";
import { getStickerArtifactAccess } from "@/lib/sticker-export";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  if (!isValidPetSlug(slug)) {
    return new NextResponse("invalid_slug", { status: 400 });
  }
  const url = new URL(req.url);
  const rawState = url.searchParams.get("state");
  const rawFormat = url.searchParams.get("format");
  const rawTreatment = url.searchParams.get("treatment");
  const state = rawState ? parseExactPetStickerState(rawState) : "idle";
  const format = rawFormat ? parseExactPetStickerFormat(rawFormat) : "webp";
  const treatment = rawTreatment
    ? parseExactPetStickerTreatment(rawTreatment)
    : "clean";
  if (!state || !format || !treatment) {
    return new NextResponse("invalid_sticker_variant", { status: 400 });
  }

  const access = await getStickerArtifactAccess(slug, state, format, treatment);
  if (access.status !== "ok") {
    const status =
      access.status === "disabled"
        ? 503
        : access.status === "ineligible"
          ? 403
          : 404;
    return new NextResponse(access.status, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }

  const response = NextResponse.redirect(
    petStickerUrl(access.slug, state, format, treatment),
    { status: 307 },
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

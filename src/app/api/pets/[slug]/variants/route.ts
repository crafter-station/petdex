import { NextResponse } from "next/server";

import { getPet } from "@/lib/pets";
import { getVariantsFor } from "@/lib/variants";

export const runtime = "nodejs";

type Params = { slug: string };

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { slug } = await ctx.params;

  const pet = await getPet(slug);
  if (!pet) {
    return NextResponse.json(
      { error: "not_found" },
      {
        status: 404,
        // A pet that is not (yet) approved 404s here, and the edge rule
        // caches a 404 for ~1h. Once it is approved this endpoint must flip
        // to 200, so the miss has to be uncacheable — the thumb/wastickers
        // siblings carry the same header for the same reason.
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const variants = await getVariantsFor(slug);

  return NextResponse.json(
    { variants },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=600",
      },
    },
  );
}

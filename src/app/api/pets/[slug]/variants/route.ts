import { NextResponse } from "next/server";

import { getVariantsFor } from "@/lib/variants";

export const runtime = "nodejs";

type Params = { slug: string };

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { slug } = await ctx.params;

  try {
    const variants = await getVariantsFor(slug);

    return NextResponse.json(
      { variants },
      {
        headers: {
          "Cache-Control": "public, max-age=300, s-maxage=600",
        },
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "PET_NOT_FOUND") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    throw error;
  }
}

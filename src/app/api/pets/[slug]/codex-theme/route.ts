// Generates a Codex Desktop theme keyed off the pet's dominantColor.
// Public: no auth required, no PII. Cached per-slug at the edge for
// 24h since dominantColor only changes if the pet is re-uploaded.

import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";

import { buildCodexTheme, serializeCodexThemeVariant } from "@/lib/codex-theme";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const [pet] = await db
    .select({
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      dominantColor: schema.submittedPets.dominantColor,
      status: schema.submittedPets.status,
    })
    .from(schema.submittedPets)
    .where(eq(schema.submittedPets.slug, slug))
    .limit(1);

  if (!pet || pet.status !== "approved") {
    // The success path caches per-slug at the edge for 24h. A not-yet-
    // approved slug must not be cached as a 404 for that window — the
    // sibling thumb/wastickers/variants routes carry the same header so
    // approval flips the endpoint from 404 to 200 immediately.
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!pet.dominantColor) {
    // Same reasoning: `no_color` is transient — it clears as soon as the
    // colour extraction lands, so it must not stick at the edge.
    return NextResponse.json(
      {
        error: "no_color",
        message: "Pet has no extracted dominant color yet.",
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }

  const theme = buildCodexTheme(pet.dominantColor);

  return NextResponse.json(
    {
      slug: pet.slug,
      displayName: pet.displayName,
      dominantColor: pet.dominantColor,
      theme,
      // Codex Settings has two separate Import boxes; each variant goes
      // in its own paste, so we ship them as standalone strings.
      clipboardLight: serializeCodexThemeVariant(theme.light),
      clipboardDark: serializeCodexThemeVariant(theme.dark),
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600",
      },
    },
  );
}

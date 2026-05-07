import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { getCaughtSlugSet } from "@/lib/catch-status";

export const runtime = "nodejs";

// Per-visitor list of pet slugs the signed-in user has caught (liked).
// Pulled out of the home page SSR so the gallery can stay statically
// rendered. The client fetches this after hydration and applies the
// "caught" highlight to PetCard. Anonymous viewers get an empty array.
export async function GET(): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { caught: [] },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const set = await getCaughtSlugSet(userId);
  return NextResponse.json(
    { caught: Array.from(set) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { setLikeCount } from "@/lib/db/metrics";
import { likeRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

type Params = { slug: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await likeRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }
  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
    columns: { slug: true, status: true },
  });
  if (!pet || pet.status !== "approved") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const existing = await db.query.petLikes.findFirst({
    where: and(
      eq(schema.petLikes.userId, userId),
      eq(schema.petLikes.petSlug, slug),
    ),
  });

  let liked: boolean;
  if (existing) {
    await db
      .delete(schema.petLikes)
      .where(
        and(
          eq(schema.petLikes.userId, userId),
          eq(schema.petLikes.petSlug, slug),
        ),
      );
    liked = false;
  } else {
    await db.insert(schema.petLikes).values({ userId, petSlug: slug });
    liked = true;
  }

  // Recompute count to avoid drift
  const countRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.petLikes)
    .where(eq(schema.petLikes.petSlug, slug));
  const count = Number(countRow[0]?.c ?? 0);
  await setLikeCount(slug, count);

  return NextResponse.json({ ok: true, liked, count });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { userId } = await auth();
  const { slug } = await ctx.params;

  const countRow = await db
    .select({ c: sql<number>`count(*)` })
    .from(schema.petLikes)
    .where(eq(schema.petLikes.petSlug, slug));
  const count = Number(countRow[0]?.c ?? 0);

  let liked = false;
  if (userId) {
    const row = await db.query.petLikes.findFirst({
      where: and(
        eq(schema.petLikes.userId, userId),
        eq(schema.petLikes.petSlug, slug),
      ),
    });
    liked = Boolean(row);
  }

  return NextResponse.json({ count, liked });
}

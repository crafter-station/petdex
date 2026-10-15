import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, sql as dsql, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { profileEditRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Body = {
  // Owner-defined slug order. First slug = position 1, etc. Slugs not
  // included are pushed to the end, keeping their existing relative order.
  order: string[];
};

const MAX_GALLERY_ITEMS = 500;

export async function PATCH(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await profileEditRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // A literal `null`/array body parses fine and the `.order` read below
  // throws on it. Refuse non-objects as a 400.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!Array.isArray(body.order)) {
    return NextResponse.json({ error: "invalid_order" }, { status: 400 });
  }

  if (body.order.length > MAX_GALLERY_ITEMS) {
    return NextResponse.json({ error: "too_many_items" }, { status: 400 });
  }

  const requested = body.order
    .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
    .filter(Boolean);

  // Dedupe while preserving order
  const seen = new Set<string>();
  const orderedUnique = requested.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  if (orderedUnique.length === 0) {
    return NextResponse.json({ error: "empty_order" }, { status: 400 });
  }

  // Verify every slug belongs to this owner AND is approved. The fetch is
  // deliberately NOT narrowed to the requested slugs: positions are assigned
  // across the owner's whole approved gallery, so unlisted pets must also be
  // read to be pushed behind the ordered ones.
  const owned = await db
    .select({
      slug: schema.submittedPets.slug,
      galleryPosition: schema.submittedPets.galleryPosition,
    })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    );
  const ownedSet = new Set(owned.map((r) => r.slug));
  const validOrder = orderedUnique.filter((s) => ownedSet.has(s));

  if (validOrder.length === 0) {
    return NextResponse.json(
      { error: "no_owned_pets_in_order" },
      { status: 400 },
    );
  }

  // Single UPDATE with CASE WHEN — one round trip, atomic. The old version
  // only touched the listed slugs: the CASE's ELSE was dead (the WHERE
  // excluded every row it could fire on), so unlisted pets kept their old
  // position and sorted ahead of the new 1..n block. Positions now cover the
  // whole approved gallery: listed slugs take 1..n in request order, unlisted
  // ones follow after max(existing)+n so their prior relative order survives.
  const base =
    owned.reduce((m, r) => Math.max(m, r.galleryPosition), 0) +
    validOrder.length;
  const unlisted = owned
    .filter((r) => !validOrder.includes(r.slug))
    .sort(
      (a, b) =>
        a.galleryPosition - b.galleryPosition || a.slug.localeCompare(b.slug),
    );
  const cases = [
    ...validOrder.map((slug, idx) => dsql`WHEN ${slug} THEN ${idx + 1}`),
    ...unlisted.map((r, idx) => dsql`WHEN ${r.slug} THEN ${base + idx + 1}`),
  ].reduce((acc, frag) => dsql`${acc} ${frag}`);

  await db
    .update(schema.submittedPets)
    .set({
      galleryPosition: dsql`CASE ${schema.submittedPets.slug} ${cases} ELSE 0 END`,
    })
    .where(
      and(
        eq(schema.submittedPets.ownerId, userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    );

  return NextResponse.json({ ok: true, count: validOrder.length });
}

import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";

import { db, executeAtomicReturning, rowsOf, schema } from "@/lib/db/client";
import { setLikeCount } from "@/lib/db/metrics";
import { publicTrafficGuardKey } from "@/lib/public-traffic-guard";
import { likeRatelimit, publicCatalogRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

type Params = { slug: string };
type PostBody = { liked?: boolean };

export async function POST(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }

  const lim = await likeRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: PRIVATE_HEADERS },
    );
  }

  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return NextResponse.json(
      { error: "invalid_slug" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
    columns: { slug: true, status: true },
  });
  if (!pet || pet.status !== "approved") {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }

  // An absent `liked` is the toggle default, but a body that does not parse is
  // a client error rather than an instruction to flip the user's state — the
  // old code folded both into `null`, so `{` and `{"liked":"yes"}` silently
  // toggled a like instead of being refused.
  let desiredLiked: boolean | null = null;
  const rawBody = await req.text();
  if (rawBody.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "invalid_json" },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return NextResponse.json(
        { error: "invalid_json" },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    const liked = (parsed as PostBody).liked;
    if (liked !== undefined && typeof liked !== "boolean") {
      return NextResponse.json(
        { error: "invalid_liked", message: "`liked` must be a boolean." },
        { status: 400, headers: PRIVATE_HEADERS },
      );
    }
    desiredLiked = typeof liked === "boolean" ? liked : null;
  }

  // Every branch answers from what the write did, never from a read taken
  // before it. The previous version read `existing` once and then echoed
  // `desiredLiked` back for an explicit request, so two requests that arrived
  // together — a double-click, a retry, two tabs — could both see the row
  // missing, one would insert it, and the other would still be told `liked:
  // false` while the row sat in the table. Both explicit writes are
  // idempotent, so running them unconditionally makes the answer true by
  // construction: insert-then-report-true and delete-then-report-false are
  // each correct no matter what the other request did.
  // Write and recount ride one executeAtomicReturning batch: the recount
  // used to run as a second standalone statement, so a concurrent flip's
  // recount could read a pre-write snapshot and overwrite ours with a stale
  // like_count that persisted until the next like. One transaction gives the
  // count the write's own snapshot — the separate-statements rule
  // executeAtomicReturning enforces everywhere else. setLikeCount's cache
  // invalidations stay outside the batch: they touch Upstash/Next caches,
  // not this database.
  let liked: boolean;
  if (desiredLiked === false) {
    const results = await executeAtomicReturning([
      sql`
        DELETE FROM "pet_likes"
        WHERE "user_id" = ${userId} AND "pet_slug" = ${slug}
      `,
      sql`
        SELECT count(*)::int AS "count"
        FROM "pet_likes"
        WHERE "pet_slug" = ${slug}
      `,
    ]);
    liked = false;
    return finishLike(
      slug,
      liked,
      Number(
        (rowsOf(results[1])[0] as { count?: number } | undefined)?.count ?? 0,
      ),
    );
  } else if (desiredLiked === true) {
    const results = await executeAtomicReturning([
      sql`
        INSERT INTO "pet_likes" ("user_id", "pet_slug")
        VALUES (${userId}, ${slug})
        ON CONFLICT DO NOTHING
      `,
      sql`
        SELECT count(*)::int AS "count"
        FROM "pet_likes"
        WHERE "pet_slug" = ${slug}
      `,
    ]);
    liked = true;
    return finishLike(
      slug,
      liked,
      Number(
        (rowsOf(results[1])[0] as { count?: number } | undefined)?.count ?? 0,
      ),
    );
  } else {
    // No explicit target: flip whatever is there, in one statement — a read
    // followed by a write cannot be atomic here, and the delete's own result
    // is what decides whether the insert runs.
    //
    // `liked` is the delete's *outcome*, not the insert's: a row existed and
    // was removed means unliked, and no row existed means liked. Reading the
    // insert's RETURNING instead gets that backwards under concurrency. Two
    // requests can arrive together with the row absent; the second one's
    // DELETE cannot see the first's uncommitted INSERT, so `removed` is empty,
    // it inserts, and ON CONFLICT DO NOTHING swallows the duplicate — leaving
    // no RETURNING row, which the old shape reported as "unliked" while the
    // row was in fact present. Measured on Postgres, every concurrent round
    // had a caller report the wrong final state.
    const results = await executeAtomicReturning([
      sql`
        WITH removed AS (
          DELETE FROM "pet_likes"
          WHERE "user_id" = ${userId} AND "pet_slug" = ${slug}
          RETURNING 1
        ),
        ins AS (
          INSERT INTO "pet_likes" ("user_id", "pet_slug")
          SELECT ${userId}, ${slug}
          WHERE NOT EXISTS (SELECT 1 FROM removed)
          ON CONFLICT DO NOTHING
          RETURNING 1
        )
        SELECT (SELECT count(*)::int FROM removed) = 0 AS "liked"
      `,
      sql`
        SELECT count(*)::int AS "count"
        FROM "pet_likes"
        WHERE "pet_slug" = ${slug}
      `,
    ]);
    liked =
      (rowsOf(results[0])[0] as { liked?: boolean } | undefined)?.liked ===
      true;
    return finishLike(
      slug,
      liked,
      Number(
        (rowsOf(results[1])[0] as { count?: number } | undefined)?.count ?? 0,
      ),
    );
  }
}

async function finishLike(
  slug: string,
  liked: boolean,
  count: number,
): Promise<Response> {
  // Cache invalidation rides the response path, outside the transaction:
  // it touches Upstash/Next caches, not this database.
  await setLikeCount(slug, count);
  return NextResponse.json(
    { ok: true, liked, count },
    { headers: PRIVATE_HEADERS },
  );
}

export async function GET(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  // Anonymous counter read: without an IP cap a bash loop drives a
  // per-request COUNT(*) into Postgres. Same shape as track-zip's public
  // POST — the POST branch below authenticates, this one anyone can call.
  const { success } = await publicCatalogRatelimit.limit(
    publicTrafficGuardKey(req.headers),
  );
  if (!success) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: PRIVATE_HEADERS },
    );
  }
  const { slug: rawSlug } = await ctx.params;
  if (!/^[a-z0-9-]{1,60}$/.test(rawSlug)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }
  const slug = rawSlug;

  const { userId } = await auth();

  // Same visibility contract the metrics route enforces: a withdrawn or
  // rejected pet answers 404 like its page does, so a slug dictionary
  // cannot use a live counter to confirm a takedown.
  const pet = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.slug, slug),
        eq(schema.submittedPets.status, "approved"),
      ),
    )
    .limit(1);
  if (pet.length === 0) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }

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

  return NextResponse.json({ count, liked }, { headers: PRIVATE_HEADERS });
}

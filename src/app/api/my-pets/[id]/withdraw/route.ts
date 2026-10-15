import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";

import { db, executeAtomicReturning, rowsOf, schema } from "@/lib/db/client";
import { withdrawRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

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

  const lim = await withdrawRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  const { id } = await ctx.params;

  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.id, id),
      eq(schema.submittedPets.ownerId, userId),
    ),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "only_pending_can_be_withdrawn" },
      { status: 400 },
    );
  }

  // Two statements, kept separate on purpose (executeAtomicReturning):
  // reviews used to vanish via an ON DELETE cascade that `drizzle-kit push`
  // has since dropped from the live database, so the delete has to take them
  // itself — a plain DELETE left review rows pointing at a pet that no longer
  // existed. Written as its own statement, not a CTE, because a CTE's DELETE
  // cannot see its sibling's snapshot anyway; see executeAtomicReturning.
  //
  // Order and guards both matter. The pet goes FIRST, and every guard the
  // read above checked is repeated here rather than trusted: under READ
  // COMMITTED a statement that waits on a lock re-evaluates its WHERE against
  // the latest committed row, so a concurrent approve (status flips) or claim
  // (ownerId moves) between the read and this write matches 0 rows instead of
  // deleting a pet that is no longer the pending row we validated. The reviews
  // delete then runs only when the pet row is actually gone, so a lost race
  // takes neither the pet nor its reviews.
  //
  // `RETURNING "id"` is what makes the guard below able to see the race at
  // all: a DELETE without it reports no rows on every driver, so `rowsOf`
  // would read empty whether the pet was removed or not — the withdraw would
  // delete the pet and still answer "only_pending_can_be_withdrawn". The
  // reviews delete needs no RETURNING; its own NOT EXISTS predicate already
  // ties it to the pet's disappearance.
  const withdrawResults = await executeAtomicReturning([
    sql`DELETE FROM "submitted_pets" WHERE "id" = ${id} AND "owner_id" = ${userId} AND "status" = 'pending' RETURNING "id"`,
    sql`DELETE FROM "submission_reviews" WHERE "submitted_pet_id" = ${id} AND NOT EXISTS (SELECT 1 FROM "submitted_pets" WHERE "id" = ${id})`,
  ]);
  if (rowsOf(withdrawResults[0]).length === 0) {
    // The row survived the guards above: a concurrent approve or claim won
    // between the read and the write. Same verdict as the status check, so
    // callers need only one error case for "not withdrawable".
    return NextResponse.json(
      { error: "only_pending_can_be_withdrawn" },
      { status: 400 },
    );
  }

  // The row is gone, so nothing will ever reference these uploads again — but
  // the objects still sit in R2 and the submit-shaped keys (pets/<slug>-<id>/)
  // were not part of the pending-asset GC's net. Delete them best-effort: a
  // failed cleanup is a cost problem, not a correctness one, so it must not
  // turn a successful withdraw into an error.
  //
  // `row` is the caller's own row, but its asset URLs are NOT pinned to the
  // caller's namespace — `validateSubmission` only checks host and path prefix
  // (`/pets/`, `/curated/`, `/community/`), so a submission can point at
  // another pet's live spritesheet, thumbnail or preview. Two things keep the
  // cleanup inside the caller's own uploads:
  //
  //   1. Only keys of the *submission upload* shape are deleted
  //      (`pets/<slug>-<uploadId>/<role>.<ext>`, `isGcCandidateAssetKey`).
  //      That is exactly what a withdrawn submission leaves behind. A live
  //      pet's stored asset is `pets/<slug>/sprite.webp` (no `<slug>-<id>`
  //      directory) and its derived thumbnail/preview are `pets/<slug>/
  //      thumb.webp` / `preview.webp` — none match the shape, so none can be
  //      named here regardless of what the row's URL says. This is the guard
  //      that actually holds: the older code deleted whatever key the row's
  //      URL resolved to, so a row pointing at `pets/<victim>/thumb.webp`
  //      deleted the victim's thumbnail, and a row pointing at a live
  //      spritesheet with a `?query` on it deleted the victim's spritesheet.
  //   2. The surviving reference check compares *normalized keys*, not raw URL
  //      strings. `keyFromR2PublicUrl` drops the query/fragment and folds the
  //      legacy hosts to the canonical one, so two rows naming the same object
  //      with different spellings (`?x=1`, a legacy host) still collide here;
  //      the raw-string `IN` missed them and deleted a referenced object.
  void (async () => {
    try {
      const [
        { deleteR2Objects },
        { keyFromR2PublicUrl },
        { isGcCandidateAssetKey },
      ] = await Promise.all([
        import("@/lib/r2"),
        import("@/lib/r2-public-url"),
        import("@/lib/pending-asset"),
      ]);
      const keys = [row.spritesheetUrl, row.petJsonUrl, row.zipUrl]
        .map((url) => keyFromR2PublicUrl(url))
        .filter((key): key is string => Boolean(key))
        .filter(isGcCandidateAssetKey);
      if (keys.length === 0) return;

      const keyList = sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      );
      const referenced = rowsOf(
        await db.execute(sql`
          SELECT 1 FROM "submitted_pets"
          WHERE "id" <> ${id}
            AND (
              -- The keyList entries come from keyFromR2PublicUrl(), which
              -- strips the leading slash; the regexp_replace result keeps it
              -- ("/pets/..."), so a bare IN never matched and the reference
              -- guard was silently inert. lstrip both to the same shape.
              split_part(ltrim(regexp_replace("spritesheet_url", '^https?://[^/]+', ''), '/'), '?', 1) IN (${keyList})
              OR split_part(ltrim(regexp_replace("pet_json_url", '^https?://[^/]+', ''), '/'), '?', 1) IN (${keyList})
              OR split_part(ltrim(regexp_replace("zip_url", '^https?://[^/]+', ''), '/'), '?', 1) IN (${keyList})
              OR split_part(ltrim(regexp_replace("pending_spritesheet_url", '^https?://[^/]+', ''), '/'), '?', 1) IN (${keyList})
              OR split_part(ltrim(regexp_replace("pending_pet_json_url", '^https?://[^/]+', ''), '/'), '?', 1) IN (${keyList})
              OR split_part(ltrim(regexp_replace("pending_zip_url", '^https?://[^/]+', ''), '/'), '?', 1) IN (${keyList})
            )
          LIMIT 1
        `),
      );
      if (referenced.length > 0) return;

      await deleteR2Objects(keys);
    } catch (error) {
      console.error("[withdraw] asset cleanup failed", { id, error });
    }
  })();

  return NextResponse.json({ ok: true });
}

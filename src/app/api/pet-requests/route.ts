import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db, executeAtomicReturning, rowsOf, schema } from "@/lib/db/client";
import {
  embeddingVectorLiteral,
  PETDEX_EMBEDDING_MODEL,
} from "@/lib/embeddings";
import {
  BLOCKED_KEYWORD_REASON,
  containsBlockedKeyword,
} from "@/lib/keyword-blocklist";
import { embedQuery } from "@/lib/query-embed";
import { checkR2ObjectSize, keyFromR2Url, R2_PUBLIC_BASE } from "@/lib/r2";
import { petRequestRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";
import { containsUrl, URL_BLOCKED_REASON } from "@/lib/url-blocklist";
import { fetchVisibleRequestVotes } from "@/lib/visible-request-votes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-user body on a URL that carries no user identity (see the GET handler).
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

const rawSql = neon(process.env.DATABASE_URL ?? "");
const VISIBLE_VOTER_LIMIT = 3;

function normalize(q: string): string {
  return q
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, "")
    .slice(0, 200);
}

// GET — list requests with requester info, top voters, and fulfilled
// pet thumbnail. The page hydrates from this so card UI stays rich.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Coerced to a positive integer, because `LIMIT` accepts nothing else.
  // `Number()` alone let three shapes through and each behaved differently:
  // a positive float (`?limit=0.5`) is not an integer, so Postgres rejected
  // the query and the route answered 500; `NaN` (`?limit=abc`) and a negative
  // (`?limit=-1`) are both accepted by the driver and mean "no limit", so the
  // caller silently got every row and the 80-row cap did not apply. Anything
  // unparseable or out of range falls back to the default instead.
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit >= 1
      ? Math.min(80, Math.floor(requestedLimit))
      : 60;
  // 'open' is the default. Pass status=all to include fulfilled and
  // dismissed (used by the public page when the user picks the
  // 'Fulfilled' sort tab).
  const statusParam = url.searchParams.get("status") ?? "open";
  const includeAll = statusParam === "all";

  const rows = includeAll
    ? await db
        .select({
          id: schema.petRequests.id,
          query: schema.petRequests.query,
          requestedBy: schema.petRequests.requestedBy,
          upvoteCount: schema.petRequests.upvoteCount,
          status: schema.petRequests.status,
          fulfilledPetSlug: schema.petRequests.fulfilledPetSlug,
          imageUrl: schema.petRequests.imageUrl,
          imageReviewStatus: schema.petRequests.imageReviewStatus,
          createdAt: schema.petRequests.createdAt,
        })
        .from(schema.petRequests)
        .orderBy(
          sql`${schema.petRequests.upvoteCount} DESC, ${schema.petRequests.createdAt} DESC`,
        )
        .limit(limit)
    : await db
        .select({
          id: schema.petRequests.id,
          query: schema.petRequests.query,
          requestedBy: schema.petRequests.requestedBy,
          upvoteCount: schema.petRequests.upvoteCount,
          status: schema.petRequests.status,
          fulfilledPetSlug: schema.petRequests.fulfilledPetSlug,
          imageUrl: schema.petRequests.imageUrl,
          imageReviewStatus: schema.petRequests.imageReviewStatus,
          createdAt: schema.petRequests.createdAt,
        })
        .from(schema.petRequests)
        .where(eq(schema.petRequests.status, statusParam))
        .orderBy(
          sql`${schema.petRequests.upvoteCount} DESC, ${schema.petRequests.createdAt} DESC`,
        )
        .limit(limit);

  const requestIds = rows.map((r) => r.id);

  // Tell the caller which ones they've already upvoted (UI state).
  const { userId } = await auth();
  let myVotes: Set<string> = new Set();
  if (userId && rows.length > 0) {
    const v = await db
      .select({ requestId: schema.petRequestVotes.requestId })
      .from(schema.petRequestVotes)
      .where(
        and(
          eq(schema.petRequestVotes.userId, userId),
          inArray(schema.petRequestVotes.requestId, requestIds),
        ),
      );
    myVotes = new Set(v.map((r) => r.requestId));
  }

  // Top voters per request, most-recent first. Same SQL-side cap the /requests
  // page uses (fetchVisibleRequestVotes): the old select here took *every* vote
  // row for all 80 listed requests and threw all but 3-per-request away in JS,
  // so one popular request made each list refresh pull the whole vote history
  // across the wire. The ranking and the requester exclusion now happen in SQL,
  // and a PGlite test beside the helper pins both.
  const votes = await fetchVisibleRequestVotes(
    db,
    requestIds,
    VISIBLE_VOTER_LIMIT,
  );

  // Batch one Clerk lookup for all relevant userIds (requesters + voters).
  const userIdSet = new Set<string>();
  for (const r of rows) if (r.requestedBy) userIdSet.add(r.requestedBy);

  type ClerkInfo = {
    handle: string;
    displayName: string | null;
    imageUrl: string | null;
  };
  const clerkInfo = new Map<string, ClerkInfo>();
  const votersByRequestId = new Map<string, string[]>();
  const requesterByRequestId = new Map(rows.map((r) => [r.id, r.requestedBy]));
  for (const v of votes) {
    if (v.userId === requesterByRequestId.get(v.requestId)) continue;
    const current = votersByRequestId.get(v.requestId) ?? [];
    if (current.length >= VISIBLE_VOTER_LIMIT) continue;
    current.push(v.userId);
    votersByRequestId.set(v.requestId, current);
    userIdSet.add(v.userId);
  }
  if (userIdSet.size > 0) {
    try {
      const client = await clerkClient();
      const all = [...userIdSet];
      for (let i = 0; i < all.length; i += 100) {
        const batch = await client.users.getUserList({
          userId: all.slice(i, i + 100),
          limit: 100,
        });
        for (const u of batch.data) {
          const displayName = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(" ")
            .trim();
          clerkInfo.set(u.id, {
            handle: u.username
              ? u.username.toLowerCase()
              : u.id.slice(-8).toLowerCase(),
            displayName: displayName || null,
            imageUrl: u.imageUrl ?? null,
          });
        }
      }
    } catch {
      /* fall through; rows render without identity */
    }
  }

  if (userIdSet.size > 0) {
    const profiles = await db
      .select({
        userId: schema.userProfiles.userId,
        handle: schema.userProfiles.handle,
        displayName: schema.userProfiles.displayName,
      })
      .from(schema.userProfiles)
      .where(inArray(schema.userProfiles.userId, [...userIdSet]));
    for (const profile of profiles) {
      const fallback = clerkInfo.get(profile.userId);
      clerkInfo.set(profile.userId, {
        handle:
          profile.handle ??
          fallback?.handle ??
          profile.userId.slice(-8).toLowerCase(),
        displayName: profile.displayName ?? fallback?.displayName ?? null,
        imageUrl: fallback?.imageUrl ?? null,
      });
    }
  }

  // Fulfilled pet thumbnail lookup.
  const fulfilledSlugs = rows
    .filter(
      (r): r is typeof r & { fulfilledPetSlug: string } =>
        r.status === "fulfilled" && typeof r.fulfilledPetSlug === "string",
    )
    .map((r) => r.fulfilledPetSlug);
  const fulfilledPets = fulfilledSlugs.length
    ? await db
        .select({
          slug: schema.submittedPets.slug,
          displayName: schema.submittedPets.displayName,
        })
        .from(schema.submittedPets)
        .where(inArray(schema.submittedPets.slug, fulfilledSlugs))
    : [];
  const petBySlug = new Map(fulfilledPets.map((p) => [p.slug, p]));

  // The body carries `voted` for the caller, so the response is per-user even
  // though the URL is not. `force-dynamic` keeps Next from caching it, but it
  // says nothing to an intermediary, and the Cloudflare rule in front of the
  // deployment caches what it is not told otherwise — one visitor's vote flags
  // would be served to the next. Same header as `/api/notifications`.
  return NextResponse.json(
    {
      requests: rows.map((r) => {
        const requester = r.requestedBy
          ? (clerkInfo.get(r.requestedBy) ?? null)
          : null;
        const voters = (votersByRequestId.get(r.id) ?? [])
          .map((id) => clerkInfo.get(id))
          .filter((v): v is ClerkInfo => Boolean(v))
          .slice(0, VISIBLE_VOTER_LIMIT);
        const fulfilledPet = r.fulfilledPetSlug
          ? (petBySlug.get(r.fulfilledPetSlug) ?? null)
          : null;
        return {
          id: r.id,
          query: r.query,
          upvoteCount: r.upvoteCount,
          status: r.status,
          fulfilledPetSlug: r.fulfilledPetSlug,
          imageUrl: r.imageReviewStatus === "approved" ? r.imageUrl : null,
          imageReviewStatus: r.imageReviewStatus,
          hasPendingImage: r.imageReviewStatus === "pending",
          createdAt: r.createdAt,
          voted: myVotes.has(r.id),
          requester,
          voters,
          fulfilledPet,
        };
      }),
    },
    { headers: PRIVATE_HEADERS },
  );
}

// POST — create a new request OR upvote an existing one if the
// normalized query already exists.
export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }

  const lim = await petRequestRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: PRIVATE_HEADERS },
    );
  }

  // The body is untrusted and typed only by assertion, so each field is
  // checked before use. `body.query?.trim()` looked safe but `?.` only guards
  // null and undefined: a number, array, object or boolean reached `.trim()`
  // and threw, and a literal `null` body threw on the property read. Both
  // answered 500 to a signed-in caller.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "invalid_json" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  const rawQuery = (body as { query?: unknown }).query;
  if (rawQuery !== undefined && typeof rawQuery !== "string") {
    return NextResponse.json(
      { error: "invalid_query" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  const rawImageUrl = (body as { imageUrl?: unknown }).imageUrl;
  if (
    rawImageUrl !== undefined &&
    rawImageUrl !== null &&
    typeof rawImageUrl !== "string"
  ) {
    return NextResponse.json(
      { error: "invalid_image_url" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }

  const query = rawQuery?.trim();
  if (!query || query.length < 4 || query.length > 200) {
    return NextResponse.json(
      { error: "query_length", message: "Use 4-200 characters." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  // NUL is the one control character Postgres rejects outright in a `text`
  // column — `invalid byte sequence for encoding "UTF8": 0x00` — and it is not
  // stripped by `normalize`, so a query containing it answered 500. The other
  // C0 controls pass through fine and are left alone.
  if (query.includes("\u0000")) {
    return NextResponse.json(
      { error: "query_invalid_characters", message: "Use plain text." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }

  const queryUrlHit = containsUrl(["query", query]);
  if (queryUrlHit) {
    return NextResponse.json(
      {
        error: "url_in_field",
        field: queryUrlHit.field,
        message: URL_BLOCKED_REASON,
      },
      { status: 422, headers: PRIVATE_HEADERS },
    );
  }

  if (containsBlockedKeyword(query)) {
    return NextResponse.json(
      { error: "blocked_content", message: BLOCKED_KEYWORD_REASON },
      { status: 422, headers: PRIVATE_HEADERS },
    );
  }

  const normalized = normalize(query);
  // `normalize` strips everything that is not a letter, digit, space, quote or
  // dash, so a query made only of punctuation or emoji collapses to the empty
  // string. Left through, every such query would dedup against the first one —
  // `"!!!!"` and `"🎉🎉🎉🎉"` both landing on the same row, with the second
  // caller told they had upvoted a request they never wrote. They are not pet
  // requests, so they are refused rather than folded together.
  if (normalized.length < 2) {
    return NextResponse.json(
      { error: "query_not_searchable", message: "Use words, not symbols." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  const imageUrl = normalizeRequestImageUrl(rawImageUrl, userId);
  if (imageUrl === false) {
    return NextResponse.json(
      { error: "invalid_image_url" },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  // The presign endpoint only checks the client-declared size; the actual
  // object is whatever the caller PUT to the signed URL. Head it before the
  // row lands so a replayed-or-oversized upload cannot become a permanent,
  // un-gc'd public object — the requests/ prefix is outside every GC
  // candidate shape, so nothing else would ever reclaim it.
  if (imageUrl) {
    const key = keyFromR2Url(imageUrl);
    const check = key ? await checkR2ObjectSize(key, 4 * 1024 * 1024) : null;
    // A missing object answers `{ ok: true, missing: true }`, so the ok
    // check alone lets a well-formed URL whose upload never happened become
    // a request row pointing at nothing. The size-guard callers keep the
    // lenient policy — their retry flows treat a missing object as "not yet
    // there" — but this row is written once.
    if (!check || check.ok === false || check.missing) {
      return NextResponse.json(
        { error: "image_not_verifiable" },
        { status: 422, headers: PRIVATE_HEADERS },
      );
    }
  }

  const id = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;

  // Dedup and write in one transaction.
  //
  // The look-up used to be a read followed by a branch outside any
  // transaction, so two requests for the same text could both miss each
  // other's row and both create one. `normalized` carries only a plain index,
  // and the rows that would collide predate this change, so a unique
  // constraint needs its own migration; the advisory lock serializes the same
  // normalized value instead, which closes the race without touching existing
  // data.
  //
  // Four separate statements rather than one CTE, and not by preference.
  // Every CTE in a statement shares the snapshot taken when that statement
  // began, so a statement that waits on the lock and then reads still sees
  // the pre-lock snapshot, and an UPDATE in the same statement cannot see the
  // row its own INSERT CTE just wrote. Both were measured on Postgres: two
  // sessions serialized by the same lock each missed the other's committed
  // row and both inserted, and the UPDATE returned no rows for the row the
  // INSERT had just created. As separate statements in one transaction each
  // read takes a fresh snapshot under READ COMMITTED, which is what makes the
  // lock mean anything.
  //
  // The statements are deliberately independent rather than threaded: each
  // re-derives the canonical row by `normalized`, so none depends on a
  // previous statement's output shape, which differs between drivers.
  const [, insertResult, , updateResult] = await executeAtomicReturning([
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${normalized}, 0))`,
    // Create only when no request for this text exists yet.
    sql`
      INSERT INTO "pet_requests"
        ("id", "query", "normalized", "requested_by", "image_url", "image_review_status")
      SELECT ${id}, ${query}, ${normalized}, ${userId}, ${imageUrl},
             ${imageUrl ? "pending" : "none"}
      WHERE NOT EXISTS (
        SELECT 1 FROM "pet_requests" WHERE "normalized" = ${normalized}
      )
      RETURNING "id"
    `,
    // The creator's own vote. The primary key makes it idempotent, so a
    // concurrent duplicate of the same user's request is a no-op here.
    sql`
      INSERT INTO "pet_request_votes" ("request_id", "user_id")
      SELECT "id", ${userId}
      FROM "pet_requests"
      WHERE "normalized" = ${normalized}
      ORDER BY "created_at", "id"
      LIMIT 1
      ON CONFLICT DO NOTHING
    `,
    // Recount from the votes table rather than incrementing, which keeps the
    // column correct after a duplicate vote was swallowed above. The image
    // fields move only while the image is not already approved AND the call
    // comes from the request's own author: any voter may upvote with the same
    // text, and without the author gate a voter's `imageUrl` replaced the
    // author's reference image (the UI only lets the author attach one).
    sql`
      UPDATE "pet_requests" AS p
      SET "upvote_count" = (
            SELECT count(*)::int FROM "pet_request_votes" v
            WHERE v."request_id" = p."id"
          ),
          "updated_at" = now(),
          "image_url" = CASE
            WHEN ${userId}::text = p."requested_by"
              AND ${imageUrl}::text IS NOT NULL
              AND p."image_review_status" <> 'approved'
            THEN ${imageUrl}::text ELSE p."image_url" END,
          "image_review_status" = CASE
            WHEN ${userId}::text = p."requested_by"
              AND ${imageUrl}::text IS NOT NULL
              AND p."image_review_status" <> 'approved'
            THEN 'pending' ELSE p."image_review_status" END,
          "image_rejection_reason" = CASE
            WHEN ${userId}::text = p."requested_by"
              AND ${imageUrl}::text IS NOT NULL
              AND p."image_review_status" <> 'approved'
            THEN NULL ELSE p."image_rejection_reason" END
      WHERE p."id" = (
        SELECT "id" FROM "pet_requests"
        WHERE "normalized" = ${normalized}
        ORDER BY "created_at", "id"
        LIMIT 1
      )
      RETURNING p."id", p."upvote_count"
    `,
  ]);

  const created = rowsOf(insertResult).length > 0;
  const written = rowsOf(updateResult)[0] as
    | { id?: unknown; upvote_count?: unknown }
    | undefined;
  if (!written || typeof written.id !== "string") {
    return NextResponse.json(
      { error: "request_write_failed" },
      { status: 500, headers: PRIVATE_HEADERS },
    );
  }

  // Only a fresh request needs an embedding; an upvote reuses the existing
  // row's. Still best-effort and still outside the transaction: a failed
  // embedding must not roll back a request the user can see.
  if (created) {
    const vec = await embedQuery(query).catch(() => null);
    if (vec) {
      const literal = embeddingVectorLiteral(vec);
      await rawSql`
        UPDATE pet_requests
        SET embedding = ${literal}::vector,
            embedding_model = ${PETDEX_EMBEDDING_MODEL}
        WHERE id = ${written.id}
      `.catch(() => {});
    }
  }

  return NextResponse.json(
    {
      ok: true,
      mode: created ? "created" : "upvoted",
      id: written.id,
      upvoteCount:
        typeof written.upvote_count === "number" ? written.upvote_count : 1,
    },
    { headers: PRIVATE_HEADERS },
  );
}

function normalizeRequestImageUrl(
  value: string | null | undefined,
  userId: string,
): string | null | false {
  // The caller now type-checks before calling, so this only ever sees a string
  // or a nullish value; the guard stays as the boundary's own defence.
  if (value != null && typeof value !== "string") return false;
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const base = new URL(R2_PUBLIC_BASE);
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.host !== base.host) return false;
    if (!url.pathname.startsWith("/requests/")) return false;
    // `/api/pet-requests/image` presigns keys under the caller's own slice
    // (`requests/<userId.slice(-8)>-<uploadId>/…`). Accepting any
    // `/requests/` path let an author attach another user's unreviewed
    // reference upload by copying its path; the namespace is the caller's or
    // the URL is refused.
    const folder = url.pathname.split("/")[2] ?? "";
    if (!folder.startsWith(`${userId.slice(-8).toLowerCase()}-`)) return false;
    return url.toString();
  } catch {
    return false;
  }
}

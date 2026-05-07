import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";
import { desc, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import {
  embeddingVectorLiteral,
  PETDEX_EMBEDDING_MODEL,
} from "@/lib/embeddings";
import { embedQuery } from "@/lib/query-embed";
import { R2_PUBLIC_BASE } from "@/lib/r2";
import { petRequestRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rawSql = neon(process.env.DATABASE_URL ?? "");

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
  const limit = Math.min(80, Number(url.searchParams.get("limit") ?? 60));
  // 'open' is the default. Pass status=all to include fulfilled and
  // dismissed (used by the public page when the user picks the
  // 'Fulfilled' sort tab).
  const statusParam = url.searchParams.get("status") ?? "open";
  const includeAll = statusParam === "all";

  const rows = includeAll
    ? await db
        .select()
        .from(schema.petRequests)
        .orderBy(
          sql`${schema.petRequests.upvoteCount} DESC, ${schema.petRequests.createdAt} DESC`,
        )
        .limit(limit)
    : await db
        .select()
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
      .where(eq(schema.petRequestVotes.userId, userId));
    myVotes = new Set(v.map((r) => r.requestId));
  }

  // Top voters per request (most-recent first; cap is enforced client-
  // side as we render up to 3).
  type VoteRow = { requestId: string; userId: string };
  const votes: VoteRow[] = requestIds.length
    ? ((await db
        .select({
          requestId: schema.petRequestVotes.requestId,
          userId: schema.petRequestVotes.userId,
        })
        .from(schema.petRequestVotes)
        .where(inArray(schema.petRequestVotes.requestId, requestIds))
        .orderBy(desc(schema.petRequestVotes.createdAt))) as VoteRow[])
    : [];

  // Batch one Clerk lookup for all relevant userIds (requesters + voters).
  const userIdSet = new Set<string>();
  for (const r of rows) if (r.requestedBy) userIdSet.add(r.requestedBy);
  for (const v of votes) userIdSet.add(v.userId);

  type ClerkInfo = {
    handle: string;
    displayName: string | null;
    username: string | null;
    imageUrl: string | null;
  };
  const clerkInfo = new Map<string, ClerkInfo>();
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
            username: u.username ?? null,
            imageUrl: u.imageUrl ?? null,
          });
        }
      }
    } catch {
      /* fall through; rows render without identity */
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
          spritesheetUrl: schema.submittedPets.spritesheetUrl,
        })
        .from(schema.submittedPets)
        .where(inArray(schema.submittedPets.slug, fulfilledSlugs))
    : [];
  const petBySlug = new Map(fulfilledPets.map((p) => [p.slug, p]));

  return NextResponse.json({
    requests: rows.map((r) => {
      const requester = r.requestedBy
        ? (clerkInfo.get(r.requestedBy) ?? null)
        : null;
      // Exclude the requester from the voter stack — they auto-vote
      // for their own request, but rendering them twice in the UI
      // (chip + duplicate avatar) feels broken.
      const voterUserIds = votes
        .filter((v) => v.requestId === r.id && v.userId !== r.requestedBy)
        .map((v) => v.userId);
      const voters = voterUserIds
        .map((id) => clerkInfo.get(id))
        .filter((v): v is ClerkInfo => Boolean(v))
        .slice(0, 6);
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
  });
}

// POST — create a new request OR upvote an existing one if the
// normalized query already exists.
export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await petRequestRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { query?: string; imageUrl?: string | null };
  try {
    body = (await req.json()) as { query?: string; imageUrl?: string | null };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const query = body.query?.trim();
  if (!query || query.length < 4 || query.length > 200) {
    return NextResponse.json(
      { error: "query_length", message: "Use 4-200 characters." },
      { status: 400 },
    );
  }

  const normalized = normalize(query);
  const imageUrl = normalizeRequestImageUrl(body.imageUrl);
  if (imageUrl === false) {
    return NextResponse.json({ error: "invalid_image_url" }, { status: 400 });
  }

  // Dedup: if a request with the same normalized text exists, just upvote.
  const existing = await db.query.petRequests.findFirst({
    where: eq(schema.petRequests.normalized, normalized),
  });

  if (existing) {
    // Upsert vote — primary key (request_id, user_id) makes this idempotent.
    const before = existing.upvoteCount;
    await rawSql`
      INSERT INTO pet_request_votes (request_id, user_id)
      VALUES (${existing.id}, ${userId})
      ON CONFLICT DO NOTHING
    `;
    const recount = (await rawSql`
      SELECT count(*)::int as c FROM pet_request_votes WHERE request_id = ${existing.id}
    `) as Array<{ c: number }>;
    await db
      .update(schema.petRequests)
      .set({
        upvoteCount: recount[0]?.c ?? before,
        ...(imageUrl && existing.imageReviewStatus !== "approved"
          ? {
              imageUrl,
              imageReviewStatus: "pending",
              imageRejectionReason: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.petRequests.id, existing.id));
    return NextResponse.json({
      ok: true,
      mode: "upvoted",
      id: existing.id,
      upvoteCount: recount[0]?.c ?? before,
    });
  }

  // Create new request.
  const id = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const vec = await embedQuery(query).catch(() => null);

  await db.insert(schema.petRequests).values({
    id,
    query,
    normalized,
    requestedBy: userId,
    imageUrl,
    imageReviewStatus: imageUrl ? "pending" : "none",
  });
  if (vec) {
    const literal = embeddingVectorLiteral(vec);
    await rawSql`
      UPDATE pet_requests
      SET embedding = ${literal}::vector,
          embedding_model = ${PETDEX_EMBEDDING_MODEL}
      WHERE id = ${id}
    `.catch(() => {});
  }
  // First vote = creator's own.
  await rawSql`
    INSERT INTO pet_request_votes (request_id, user_id)
    VALUES (${id}, ${userId})
    ON CONFLICT DO NOTHING
  `;

  return NextResponse.json({
    ok: true,
    mode: "created",
    id,
    upvoteCount: 1,
  });
}

function normalizeRequestImageUrl(
  value: string | null | undefined,
): string | null | false {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  try {
    const base = new URL(R2_PUBLIC_BASE);
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.host !== base.host) return false;
    if (!url.pathname.startsWith("/requests/")) return false;
    return url.toString();
  } catch {
    return false;
  }
}

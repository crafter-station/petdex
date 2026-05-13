import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { and, eq, ne, or, sql } from "drizzle-orm";

import { invalidatePetCaches } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { claimRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type ClaimIdentity = {
  email: string | null;
  githubUrl: string | null;
};

// GET — list pets that look claimable for the signed-in user. A pet is
// claimable when its current owner is *not* the signed-in user AND one of:
//   - its owner_email equals the user's verified primary email (the
//     normal path: a deleted-then-re-created Clerk account)
//   - its credit_url matches the user's verified GitHub OAuth profile
//     (the rescue path: petdex admin recovered a failed submission and
//     credited the original GitHub author by URL).
// We never auto-transfer on submit. The user has to opt in here.
export async function GET(): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ident = await getClaimIdentity(userId);
  if (!ident.email && !ident.githubUrl) {
    return NextResponse.json({ pets: [] });
  }

  const filters = [];
  if (ident.email) {
    // ownerEmail is normalized to lowercase on insert; Clerk email is
    // also lowercased above. Plain eq is fine.
    filters.push(eq(schema.submittedPets.ownerEmail, ident.email));
  }
  if (ident.githubUrl) {
    // GitHub usernames are case-insensitive (github.com/Episode0621
    // and github.com/episode0621 resolve to the same profile), but
    // credit_url historically stored whatever case the OAuth payload
    // returned. Compare lowercased strings so cases don't drop matches.
    filters.push(
      sql`lower(${schema.submittedPets.creditUrl}) = ${ident.githubUrl.toLowerCase()}`,
    );
  }

  const rows = await db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      status: schema.submittedPets.status,
      createdAt: schema.submittedPets.createdAt,
    })
    .from(schema.submittedPets)
    .where(
      and(
        ne(schema.submittedPets.ownerId, userId),
        filters.length === 1 ? filters[0] : or(...filters),
      ),
    );

  return NextResponse.json({
    pets: rows,
    email: ident.email,
    githubUrl: ident.githubUrl,
  });
}

// POST — claim a single pet by id. Same checks as the listing query, plus
// the explicit user click serves as confirmation.
export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lim = await claimRatelimit.limit(userId);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  let body: { id?: string };
  try {
    body = (await req.json()) as { id?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = body.id?.trim();
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const ident = await getClaimIdentity(userId);
  if (!ident.email && !ident.githubUrl) {
    return NextResponse.json(
      {
        error: "no_verified_identity",
        message:
          "Sign in with a verified email or a GitHub account before claiming.",
      },
      { status: 403 },
    );
  }

  const row = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (row.ownerId === userId) {
    return NextResponse.json({ ok: true, alreadyOwned: true });
  }

  const emailMatch =
    !!row.ownerEmail &&
    !!ident.email &&
    row.ownerEmail.toLowerCase() === ident.email;
  const githubMatch =
    !!row.creditUrl &&
    !!ident.githubUrl &&
    row.creditUrl.toLowerCase() === ident.githubUrl.toLowerCase();

  if (!emailMatch && !githubMatch) {
    return NextResponse.json({ error: "identity_mismatch" }, { status: 403 });
  }

  // When claiming via GitHub match (admin rescue path), also rewrite
  // the owner_email so the pet behaves like a normal user-owned row.
  const update: Partial<typeof schema.submittedPets.$inferInsert> = {
    ownerId: userId,
  };
  if (githubMatch && !emailMatch && ident.email) {
    update.ownerEmail = ident.email;
  }

  await db
    .update(schema.submittedPets)
    .set(update)
    .where(eq(schema.submittedPets.id, id));
  await invalidatePetCaches(row.slug);

  return NextResponse.json({ ok: true, slug: row.slug });
}

async function getClaimIdentity(userId: string): Promise<ClaimIdentity> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);

    let email: string | null = null;
    const primaryId = user.primaryEmailAddressId;
    const addr = user.emailAddresses.find((e) => e.id === primaryId);
    if (addr && addr.verification?.status === "verified") {
      email = addr.emailAddress.toLowerCase();
    }

    let githubUrl: string | null = null;
    for (const acc of user.externalAccounts ?? []) {
      if (acc.provider !== "oauth_github") continue;
      const v = (acc as { verification?: { status?: string } }).verification
        ?.status;
      if (v && v !== "verified") continue;
      const username = (acc as { username?: string }).username?.trim();
      if (username) {
        githubUrl = `https://github.com/${username}`;
        break;
      }
    }

    return { email, githubUrl };
  } catch {
    return { email: null, githubUrl: null };
  }
}

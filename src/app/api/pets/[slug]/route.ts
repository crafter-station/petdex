// Slug to internal id, for the CLI's edit flow.
//
// `petdex edit <slug>` resolves the slug here before it can ask
// /api/cli/edit-presign for upload slots, because that route keys on the
// internal id. The route never existed (#606): only sub-resources under
// [slug] did, so every edit died at "not found or you do not own it"
// before a single byte was uploaded.
//
// Ownership is enforced here, not just disclosed: the lookup is scoped to
// the bearer's own pets, so this cannot be used to enumerate ids for pets
// the caller does not own. That matches /api/cli/edit-presign, which
// re-checks ownership anyway; this is defense in depth, not the only gate.

import { NextResponse } from "next/server";

import { and, eq } from "drizzle-orm";

import { verifyCliBearer } from "@/lib/cli-auth";
import { db, schema } from "@/lib/db/client";
import { cliVerifyRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0]?.trim() || "anon";
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const limit = await cliVerifyRatelimit.limit(clientIp(req));
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { slug: raw } = await ctx.params;
  const slug = typeof raw === "string" ? raw.trim() : "";
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }

  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.slug, slug),
      eq(schema.submittedPets.ownerId, principal.userId),
    ),
    columns: { id: true, slug: true, status: true, displayName: true },
  });
  // Not-found and not-yours answer the same way on purpose: a distinct
  // 403 would confirm a slug exists and belongs to someone else.
  if (!row) {
    return NextResponse.json({ error: "pet_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    id: row.id,
    slug: row.slug,
    status: row.status,
    displayName: row.displayName,
  });
}

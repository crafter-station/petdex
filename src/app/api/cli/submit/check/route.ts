// Pre-flight check the CLI uses before bulk-uploading pets to avoid silently
// creating duplicates. Given a list of {petId, slugHint} candidates, return
// only the ones that already exist for the authenticated user. The CLI then
// asks the user whether to skip, replace, or submit-as-new for each match.
//
// Identity comes from the OAuth bearer (verifyCliBearer); body fields are
// only treated as lookup keys, never as ownership claims.

import { NextResponse } from "next/server";

import { and, eq, inArray } from "drizzle-orm";

import { verifyCliBearer } from "@/lib/cli-auth";
import { db, schema } from "@/lib/db/client";
import { cliVerifyRatelimit } from "@/lib/ratelimit";
import { slugify } from "@/lib/submissions";

const MAX_CANDIDATES = 100;

type Candidate = { petId?: string; slugHint?: string };
type Body = { candidates?: Candidate[] };

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0]?.trim() || "anon";
}

export async function POST(req: Request): Promise<Response> {
  const verifyLim = await cliVerifyRatelimit.limit(clientIp(req));
  if (!verifyLim.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, existing: [] });
  }
  if (candidates.length > MAX_CANDIDATES) {
    return NextResponse.json(
      { error: "too_many_candidates", max: MAX_CANDIDATES },
      { status: 400 },
    );
  }

  const slugSet = new Set<string>();
  for (const c of candidates) {
    const raw = (c.petId ?? c.slugHint ?? "").toString();
    const s = slugify(raw);
    if (s) slugSet.add(s);
  }
  const slugs = Array.from(slugSet);
  if (slugs.length === 0) {
    return NextResponse.json({ ok: true, existing: [] });
  }

  const rows = await db
    .select({
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      status: schema.submittedPets.status,
      createdAt: schema.submittedPets.createdAt,
    })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, principal.userId),
        inArray(schema.submittedPets.slug, slugs),
      ),
    );

  return NextResponse.json({ ok: true, existing: rows });
}

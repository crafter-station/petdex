import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { editRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

type PatchBody = {
  displayName?: string;
  description?: string;
  tags?: string[];
};

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MAX_TAGS = 8;

function normalizeTags(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of input) {
    if (typeof t !== "string") continue;
    const v = t.trim().toLowerCase();
    if (!TAG_RE.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// PATCH = create-or-update a pending edit. Pet stays publicly approved
// with current values; admin sees a diff and approves/rejects.
export async function PATCH(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  // Only approved pets can be edited via this flow. Pending pets edit
  // their own record directly when admin approves; rejected pets need
  // a fresh /submit. Withdrawn pets are gone.
  if (row.status !== "approved") {
    return NextResponse.json(
      { error: "only_approved_editable" },
      { status: 400 },
    );
  }

  const lim = await editRatelimit.limit(`${userId}:${id}`);
  if (!lim.success) {
    return NextResponse.json(
      { error: "rate_limited", retryAfter: lim.reset },
      { status: 429 },
    );
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: {
    pendingDisplayName: string | null;
    pendingDescription: string | null;
    pendingTags: string[] | null;
    pendingSubmittedAt: Date;
    pendingRejectionReason: null;
  } = {
    pendingDisplayName: null,
    pendingDescription: null,
    pendingTags: null,
    pendingSubmittedAt: new Date(),
    pendingRejectionReason: null,
  };

  if (typeof body.displayName === "string") {
    const v = body.displayName.trim().slice(0, 60);
    if (v.length < 2) {
      return NextResponse.json(
        { error: "display_name_too_short" },
        { status: 400 },
      );
    }
    if (v !== row.displayName) patch.pendingDisplayName = v;
  }
  if (typeof body.description === "string") {
    const v = body.description.trim().slice(0, 280);
    if (v.length < 10) {
      return NextResponse.json(
        { error: "description_too_short" },
        { status: 400 },
      );
    }
    if (v !== row.description) patch.pendingDescription = v;
  }
  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    if (tags === null) {
      return NextResponse.json({ error: "invalid_tags" }, { status: 400 });
    }
    const currentTags = (row.tags as string[]) ?? [];
    if (!sameArray(tags, currentTags)) patch.pendingTags = tags;
  }

  const noOp =
    patch.pendingDisplayName === null &&
    patch.pendingDescription === null &&
    patch.pendingTags === null;
  if (noOp) {
    return NextResponse.json(
      { error: "nothing_changed" },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(schema.submittedPets)
    .set(patch)
    .where(eq(schema.submittedPets.id, id))
    .returning();

  return NextResponse.json({
    ok: true,
    pending: {
      displayName: updated.pendingDisplayName,
      description: updated.pendingDescription,
      tags: updated.pendingTags,
      submittedAt: updated.pendingSubmittedAt,
    },
  });
}

// DELETE = withdraw the in-flight edit (no admin notice needed).
export async function DELETE(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  await db
    .update(schema.submittedPets)
    .set({
      pendingDisplayName: null,
      pendingDescription: null,
      pendingTags: null,
      pendingSubmittedAt: null,
      pendingRejectionReason: null,
    })
    .where(eq(schema.submittedPets.id, id));

  return NextResponse.json({ ok: true });
}

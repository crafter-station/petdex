// Web edit-presign: Clerk cookie-auth counterpart to /api/cli/edit-presign.
// Presigns R2 PUT URLs for sprite/petJson slots so the web UI can upload
// assets directly to R2 before including the public URLs in the PATCH body.

import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { presignPut } from "@/lib/r2";
import { editRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

type Body = {
  hasSprite?: boolean;
  hasMeta?: boolean;
  hasZip?: boolean;
  spritesheetExt?: "webp" | "png";
};

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

  const { id } = await ctx.params;

  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.id, id),
      eq(schema.submittedPets.ownerId, userId),
    ),
    columns: { id: true, slug: true, status: true },
  });
  if (!row) {
    return NextResponse.json({ error: "pet_not_found" }, { status: 404 });
  }
  if (row.status !== "approved") {
    return NextResponse.json(
      { error: "pet_not_editable", status: row.status },
      { status: 409 },
    );
  }

  const lim = await editRatelimit.limit(`${userId}:${row.id}`);
  if (!lim.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Limit reached: 5 edits per pet / 24h.",
        retryAfter: lim.reset,
      },
      { status: 429 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const ext: "webp" | "png" = body.spritesheetExt === "png" ? "png" : "webp";
  const spriteCT = ext === "png" ? "image/png" : "image/webp";

  const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);

  const slots: Array<{
    role: "sprite" | "petjson" | "zip";
    ext: string;
    ct: string;
  }> = [];
  if (body.hasSprite) slots.push({ role: "sprite", ext, ct: spriteCT });
  if (body.hasMeta)
    slots.push({ role: "petjson", ext: "json", ct: "application/json" });
  if (body.hasZip)
    slots.push({ role: "zip", ext: "zip", ct: "application/zip" });

  if (slots.length === 0) {
    return NextResponse.json({ error: "no_assets_requested" }, { status: 400 });
  }

  const presigned = await Promise.all(
    slots.map(async (s) => {
      const key = `pets/${row.slug}-pending-${uploadId}/${s.role}.${s.ext}`;
      const result = await presignPut(key, s.ct);
      return { role: s.role, ...result };
    }),
  );

  return NextResponse.json({ files: presigned });
}

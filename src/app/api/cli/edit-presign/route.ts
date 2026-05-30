// CLI edit-presign: verify bearer, confirm ownership of the target pet,
// rate-limit, and presign R2 PUT URLs for the asset slots the CLI wants
// to update (sprite, petJson, zip). Mirrors /api/cli/submit but scoped
// to an existing pet the caller already owns.

import { NextResponse } from "next/server";

import { and, eq } from "drizzle-orm";

import { verifyCliBearer } from "@/lib/cli-auth";
import { db, schema } from "@/lib/db/client";
import { presignPut } from "@/lib/r2";
import { cliVerifyRatelimit, editRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const MAX_KEY_LEN = 80;

type Body = {
  petId?: string;
  hasSprite?: boolean;
  hasMeta?: boolean;
  hasZip?: boolean;
  spritesheetExt?: "webp" | "png";
};

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

  const petId = typeof body.petId === "string" ? body.petId.trim() : "";
  if (!petId) {
    return NextResponse.json({ error: "missing_pet_id" }, { status: 400 });
  }

  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.id, petId),
      eq(schema.submittedPets.ownerId, principal.userId),
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

  const lim = await editRatelimit.limit(`${principal.userId}:${row.id}`);
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
      const key =
        `pets/${row.slug}-pending-${uploadId}/${s.role}.${s.ext}`.slice(
          0,
          MAX_KEY_LEN + 32,
        );
      const result = await presignPut(key, s.ct);
      return { role: s.role, ...result };
    }),
  );

  return NextResponse.json({ files: presigned });
}

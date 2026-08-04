// CLI edit-presign: verify bearer, confirm ownership of the target pet,
// rate-limit, and presign R2 PUT URLs for the asset slots the CLI wants
// to update (sprite, petJson, zip). Mirrors /api/cli/submit but scoped
// to an existing pet the caller already owns.

import { NextResponse } from "next/server";

import { and, eq } from "drizzle-orm";

import { verifyCliBearer } from "@/lib/cli-auth";
import { db, schema } from "@/lib/db/client";
import {
  buildPendingAssetKey,
  type PendingAssetRole,
} from "@/lib/pending-asset";
import { presignPut } from "@/lib/r2";
import { cliVerifyRatelimit, editPresignRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

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

  const lim = await editPresignRatelimit.limit(`${principal.userId}:${row.id}`);
  if (!lim.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Limit reached: 20 asset presign requests per hour.",
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

  const keyedSlots = slots.map((slot) => ({
    slot,
    key: buildPendingAssetKey(
      row.slug,
      uploadId,
      slot.role as PendingAssetRole,
      slot.ext,
    ),
  }));
  if (keyedSlots.some(({ key }) => key === null)) {
    return NextResponse.json({ error: "invalid_pet_slug" }, { status: 500 });
  }

  const presigned = await Promise.all(
    keyedSlots.map(async ({ slot, key }) => {
      const result = await presignPut(key as string, slot.ct);
      return { role: slot.role, ...result };
    }),
  );

  return NextResponse.json({ files: presigned });
}

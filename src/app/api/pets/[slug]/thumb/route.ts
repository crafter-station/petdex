// Pre-rendered 80x80 webp thumbnail of a pet's first idle frame. The
// raw spritesheet is ~2MB (1536x1872 with all states); a 40px tile
// only needs the top-left 192x208 cell. Serving the crop directly
// turns 2MB downloads into ~2KB downloads — a ~1000x cut.
//
// Why a route + sharp instead of pre-baked artifacts at submit time?
// We can layer caching at the edge and warm new pets on first view
// without a backfill, and we keep the source of truth (the sheet)
// untouched.

import { NextResponse } from "next/server";

import { eq } from "drizzle-orm";
import sharp from "sharp";

import { db, schema } from "@/lib/db/client";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

export const runtime = "nodejs";

// Per-pet thumbnails are content-addressed by slug; the underlying
// sheet only changes on resubmit. One year + immutable lets the CDN +
// browser cache hold them indefinitely. Resubmits already mint a new
// slug suffix, so we never invalidate.
const CACHE_HEADER = "public, max-age=31536000, s-maxage=31536000, immutable";

// First idle frame inside the sheet. See src/lib/pet-states.ts.
const FRAME_W = 192;
const FRAME_H = 208;
// 80x80 is enough for a crisp thumb at 1x and 2x DPR (we render the
// element at 40x40). webp at q70 keeps these under ~3KB even with
// detailed sprites.
const OUT_W = 80;
const OUT_H = 80;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;

  const pet = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
    columns: { spritesheetUrl: true, status: true },
  });

  if (!pet || pet.status !== "approved") {
    return new NextResponse("not found", { status: 404 });
  }

  if (!isAllowedAssetUrl(pet.spritesheetUrl)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let buf: Buffer;
  try {
    const res = await fetch(pet.spritesheetUrl, { redirect: "error" });
    if (!res.ok) {
      return new NextResponse("upstream", { status: 502 });
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return new NextResponse("upstream", { status: 502 });
  }

  let outBuf: Buffer;
  try {
    outBuf = await sharp(buf)
      .extract({ left: 0, top: 0, width: FRAME_W, height: FRAME_H })
      .resize(OUT_W, OUT_H, { fit: "contain", kernel: "nearest" })
      .webp({ quality: 70 })
      .toBuffer();
  } catch {
    return new NextResponse("decode", { status: 500 });
  }

  // NextResponse expects BodyInit; Buffer needs to land as a Uint8Array
  // view (or ArrayBuffer) for the type checker. The bytes are identical.
  return new NextResponse(new Uint8Array(outBuf), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(outBuf.byteLength),
      "Cache-Control": CACHE_HEADER,
    },
  });
}

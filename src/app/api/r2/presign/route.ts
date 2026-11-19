import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "@/lib/admin";
import { presignPut } from "@/lib/r2";
import { presignRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";
import { PET_ASSET_MAX_BYTES } from "@/lib/upload-limits";

export const runtime = "nodejs";

const MAX_KEY_LEN = 80;
const ALLOWED_CT = new Set([
  "application/zip",
  "image/webp",
  "image/png",
  "application/json",
]);
const ALLOWED_ROLES = new Set(["zip", "sprite", "petjson"]);

type AskedFile = {
  // Logical role helps us scope the key path: pets/<random>/<role>.<ext>
  role: "zip" | "sprite" | "petjson";
  contentType: string;
  size: number;
};

const MAX_BYTES = PET_ASSET_MAX_BYTES;

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Cap loop attacks that would otherwise burn R2 storage with orphan
  // PUT URLs. Admins skip the limit since the curated backfill needs to
  // burst-presign every featured pet.
  if (!isAdmin(userId)) {
    const lim = await presignRatelimit.limit(userId);
    if (!lim.success) {
      return NextResponse.json(
        { error: "rate_limited", retryAfter: lim.reset },
        { status: 429 },
      );
    }
  }

  let body: { files?: AskedFile[]; slugHint?: string };
  try {
    body = (await req.json()) as { files?: AskedFile[]; slugHint?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const files = body.files ?? [];
  if (files.length !== 3) {
    return NextResponse.json(
      { error: "expected_3_files", message: "Need zip + sprite + petjson." },
      { status: 400 },
    );
  }
  // Each role must appear exactly once: the three keys are derived from the
  // role, so a duplicate would sign the same object twice and a missing one
  // would leave the caller without a slot it was promised.
  const roles = new Set<string>();
  for (const f of files) {
    // The cast above is compile-time only: `[null,null,null]` passes the
    // length check and `f.contentType` on null throws. Refuse non-objects
    // as a 400 instead of 500ing on the property access.
    if (f === null || typeof f !== "object") {
      return NextResponse.json({ error: "invalid_files" }, { status: 400 });
    }
    // `role` is a compile-time union only: whatever string arrives is
    // interpolated into the R2 key, so an unchecked value let an
    // authenticated caller name the object themselves.
    if (!ALLOWED_ROLES.has(f.role)) {
      return NextResponse.json(
        { error: "invalid_role", got: f.role },
        { status: 400 },
      );
    }
    roles.add(f.role);
    if (!ALLOWED_CT.has(f.contentType)) {
      return NextResponse.json(
        { error: "unsupported_content_type", got: f.contentType },
        { status: 400 },
      );
    }
    if (!Number.isFinite(f.size) || f.size <= 0 || f.size > MAX_BYTES) {
      // Name the file and both numbers. The bare code sent someone to
      // #594 with a 1536x2288 sprite, the canonical size, and no way to
      // tell which of the three uploads was over or by how much — the
      // zip is sent alongside the sprite and a webp barely compresses,
      // so it is usually the zip that trips this, not the art.
      const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
      const size = typeof f.size === "number" ? f.size : 0;
      return NextResponse.json(
        {
          error: "file_too_large",
          maxBytes: MAX_BYTES,
          role: f.role,
          size,
          message:
            size > 0
              ? `Your ${f.role} is ${mb(size)}, over the ${mb(MAX_BYTES)} limit.`
              : `Your ${f.role} has no readable size.`,
        },
        { status: 400 },
      );
    }
  }
  if (roles.size !== 3) {
    return NextResponse.json(
      {
        error: "duplicate_role",
        message: "Need one zip, one sprite, one petjson.",
      },
      { status: 400 },
    );
  }

  // Random short upload id for this batch — DB will keep the canonical slug
  // separately (server resolves uniqueness in /api/submit).
  const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  // `slugHint` is an unchecked cast too: a number/array reached `.toLowerCase`
  // and 500'd. Coerce, then let the slug filter normalize it.
  const slugHint = String(body.slugHint ?? "pet")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_KEY_LEN);

  const presigned = await Promise.all(
    files.map(async (f) => {
      const ext = extensionFor(f.contentType, f.role);
      const key = `pets/${slugHint}-${uploadId}/${f.role}.${ext}`;
      return {
        role: f.role,
        ...(await presignPut(key, f.contentType)),
      };
    }),
  );

  return NextResponse.json({ ok: true, files: presigned });
}

function extensionFor(ct: string, role: AskedFile["role"]): string {
  if (role === "zip") return "zip";
  if (role === "petjson") return "json";
  if (ct === "image/png") return "png";
  return "webp";
}

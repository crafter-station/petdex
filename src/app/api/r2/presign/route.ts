import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "@/lib/admin";
import { presignPut } from "@/lib/r2";
import { presignRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

const MAX_KEY_LEN = 80;
const ALLOWED_CT = new Set([
  "application/zip",
  "image/webp",
  "image/png",
  "application/json",
]);

type AskedFile = {
  // Logical role helps us scope the key path: pets/<random>/<role>.<ext>
  role: "zip" | "sprite" | "petjson";
  contentType: string;
  size: number;
};

const MAX_BYTES = 8 * 1024 * 1024;

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

  const files = body.files ?? [];
  if (files.length !== 3) {
    return NextResponse.json(
      { error: "expected_3_files", message: "Need zip + sprite + petjson." },
      { status: 400 },
    );
  }

  for (const f of files) {
    if (!ALLOWED_CT.has(f.contentType)) {
      return NextResponse.json(
        { error: "unsupported_content_type", got: f.contentType },
        { status: 400 },
      );
    }
    if (typeof f.size !== "number" || f.size <= 0 || f.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "file_too_large", maxBytes: MAX_BYTES },
        { status: 400 },
      );
    }
  }

  // Random short upload id for this batch — DB will keep the canonical slug
  // separately (server resolves uniqueness in /api/submit).
  const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const slugHint = (body.slugHint ?? "pet")
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

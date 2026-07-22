import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Body = { all: true } | { ids: string[] };

// No database in this repo — there's nothing to mark read. Keep the
// same auth/CSRF/body validation contract so the notifications bell's
// fetch still succeeds the same way it always did.
export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if ("all" in body && body.all === true) {
    return NextResponse.json({ ok: true });
  }

  if ("ids" in body && Array.isArray(body.ids) && body.ids.length > 0) {
    const ids = body.ids.filter((v) => typeof v === "string");
    if (ids.length === 0) {
      return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "invalid_body" }, { status: 400 });
}

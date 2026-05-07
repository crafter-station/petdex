import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { createManualCandidate } from "@/lib/request-candidates";
import { requireSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";

type Params = { id: string };

type Body = { petId: string };

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

  const { id: requestId } = await ctx.params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.petId || typeof body.petId !== "string") {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const result = await createManualCandidate({
    petId: body.petId,
    requestId,
    ownerId: userId,
  });

  if (!result.ok) {
    const status =
      result.reason === "pet_not_found" || result.reason === "request_not_found"
        ? 404
        : result.reason === "not_owner"
          ? 403
          : 409;
    return NextResponse.json({ error: result.reason }, { status });
  }

  return NextResponse.json({ ok: true });
}

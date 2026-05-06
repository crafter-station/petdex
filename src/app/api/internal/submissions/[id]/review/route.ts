import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "@/lib/admin";
import { requireSameOrigin } from "@/lib/same-origin";
import { reviewSubmission } from "@/lib/submission-review";

type Params = { id: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const result = await reviewSubmission(id, {
    force: true,
  });

  return NextResponse.json({
    ok: true,
    applied: result.applied,
    review: {
      id: result.review.id,
      status: result.review.status,
      decision: result.review.decision,
      reasonCode: result.review.reasonCode,
      summary: result.review.summary,
      confidence: result.review.confidence,
      error: result.review.error,
    },
  });
}

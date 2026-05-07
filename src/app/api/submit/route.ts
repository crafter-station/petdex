import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { auth, currentUser } from "@clerk/nextjs/server";

import { isAdmin } from "@/lib/admin";
import { submitRatelimit } from "@/lib/ratelimit";
import { requireSameOrigin } from "@/lib/same-origin";
import {
  persistSubmission,
  type SubmissionInput,
  type SubmissionPrincipal,
  validateSubmission,
} from "@/lib/submissions";

export async function POST(req: Request) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const skipLimit = isAdmin(userId);
  const limit = skipLimit
    ? { success: true, reset: 0 }
    : await submitRatelimit.limit(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Limit reached: 10 submissions / 24h. Try again tomorrow.",
        retryAfter: limit.reset,
      },
      { status: 429 },
    );
  }

  let body: SubmissionInput;
  try {
    body = (await req.json()) as SubmissionInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const validation = validateSubmission(body);
  if (validation && !validation.ok) {
    const { status, ...rest } = validation;
    return NextResponse.json(rest, { status });
  }

  const user = await currentUser();
  const externalAccounts =
    (
      user as {
        externalAccounts?: Array<{ provider?: string; username?: string }>;
      } | null
    )?.externalAccounts ?? [];
  let url: string | null = null;
  for (const acc of externalAccounts) {
    if (!acc.username) continue;
    if (acc.provider === "oauth_x" || acc.provider === "oauth_twitter") {
      url = `https://x.com/${acc.username}`;
      break;
    }
    if (acc.provider === "oauth_github" && !url) {
      url = `https://github.com/${acc.username}`;
    }
  }

  const principal: SubmissionPrincipal = {
    userId,
    email:
      user?.emailAddresses?.[0]?.emailAddress ??
      user?.primaryEmailAddress?.emailAddress ??
      null,
    username: user?.username ?? null,
    imageUrl: user?.imageUrl ?? null,
    firstName: user?.firstName ?? null,
    lastName: user?.lastName ?? null,
    url,
  };

  const result = await persistSubmission(body, principal);
  if (!result.ok) {
    const { status, ...rest } = result;
    return NextResponse.json(rest, { status });
  }
  revalidateTag("gallery", "max");
  revalidateTag(`profile:${result.profileHandle}`, "max");
  if (result.status === "approved") {
    revalidateTag(`pet:${result.slug}`, "max");
  }
  return NextResponse.json(result, { status: 201 });
}

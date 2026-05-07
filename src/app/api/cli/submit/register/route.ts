// Step 2 of the CLI submit flow: persist the submission to DB after R2 PUTs
// completed. Same identity-from-token discipline as /api/cli/submit.
//
// We re-validate by fetching the persisted public URLs are reachable so the
// user doesn't end up with a row pointing to a missing file.

import { NextResponse } from "next/server";

import { verifyCliBearer } from "@/lib/cli-auth";
import { cliVerifyRatelimit } from "@/lib/ratelimit";
import {
  persistSubmission,
  type SubmissionInput,
  type SubmissionPrincipal,
  validateSubmission,
} from "@/lib/submissions";

export const runtime = "nodejs";

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

  const submissionPrincipal: SubmissionPrincipal = {
    userId: principal.userId,
    email: principal.email,
    username: principal.username,
    imageUrl: principal.imageUrl,
    firstName: principal.firstName,
    lastName: principal.lastName,
    url: null,
  };

  const result = await persistSubmission(body, submissionPrincipal);
  if (!result.ok) {
    const { status, ...rest } = result;
    return NextResponse.json(rest, { status });
  }
  return NextResponse.json(result, { status: 201 });
}

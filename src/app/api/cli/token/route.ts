import { NextResponse } from "next/server";

import { auth, currentUser } from "@clerk/nextjs/server";

import { issueCliToken } from "@/lib/cli-auth";

export const runtime = "nodejs";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await currentUser();
  const ownerEmail =
    user?.emailAddresses?.[0]?.emailAddress ??
    user?.primaryEmailAddress?.emailAddress ??
    null;
  const issued = issueCliToken({ ownerId: userId, ownerEmail });

  if (!issued) {
    return NextResponse.json(
      {
        error: "cli_auth_disabled",
        message:
          "Set PETDEX_CLI_TOKEN_SECRET or CLERK_SECRET_KEY to enable CLI login.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    token: issued.token,
    ownerEmail,
    expiresAt: issued.expiresAt,
  });
}

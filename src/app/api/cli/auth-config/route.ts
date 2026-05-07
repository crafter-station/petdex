// Public auth config the CLI fetches at the start of `petdex login` so we can
// rotate the OAuth client id without forcing every user to upgrade their CLI.
// Anything sensitive (client secret) stays server-side — this endpoint only
// exposes the public OAuth metadata a PKCE client already needs to know.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_ISSUER = "https://clerk.petdex.crafter.run";
const DEFAULT_CLIENT_ID = "LcThwEayl6KAA1Qm";
const DEFAULT_SCOPES = ["profile", "email", "openid", "offline_access"];

export async function GET(): Promise<Response> {
  const issuer = process.env.CLERK_CLI_ISSUER ?? DEFAULT_ISSUER;
  const clientId = process.env.CLERK_CLI_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const scopes = (process.env.CLERK_CLI_SCOPES ?? DEFAULT_SCOPES.join(" "))
    .split(/\s+/)
    .filter(Boolean);

  return NextResponse.json(
    { issuer, clientId, scopes },
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300",
      },
    },
  );
}

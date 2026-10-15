// Server-side helper: verify a Clerk OAuth bearer token from a CLI client.
// Uses the OIDC userinfo endpoint to authenticate the access token. We trust
// only the userId (sub) and email returned by Clerk — never any value the
// client sent in the request body.

const ISSUER = process.env.CLERK_CLI_ISSUER ?? "https://clerk.petdex.dev";

// Every CLI/desktop route awaits this while handling its request, so a stalled
// Clerk userinfo call would hold the instance until the platform timeout. The
// rate limit only caps how often this is called, not how long each call may
// take.
const USERINFO_TIMEOUT_MS = 5000;

export type CliPrincipal = {
  userId: string;
  email: string | null;
  username: string | null;
  imageUrl: string | null;
  firstName: string | null;
  lastName: string | null;
};

export async function verifyCliBearer(
  authorizationHeader: string | null,
): Promise<CliPrincipal | null> {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  const url = `${ISSUER.replace(/\/+$/, "")}/oauth/userinfo`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or a connection failure reaches here. Return null like every
    // other failure branch instead of letting the rejection escape: callers
    // (the /api/cli/* and /api/desktop/* routes) await this bare and map null
    // to 401, so a thrown error would surface as a 500 on a merely slow Clerk
    // userinfo call. A 401 is the right answer — the caller can retry or
    // re-authenticate; a 500 is not.
    console.warn(
      "[cli-auth] userinfo fetch failed:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
  if (!res.ok) return null;

  const data = (await res.json().catch(() => null)) as
    | (Partial<Record<string, unknown>> & { sub?: string })
    | null;
  if (!data || typeof data.sub !== "string" || !data.sub.startsWith("user_")) {
    return null;
  }

  return {
    userId: data.sub,
    email: pickString(data.email),
    username: pickString(data.username) ?? pickString(data.preferred_username),
    imageUrl: pickString(data.picture) ?? pickString(data.image_url),
    firstName: pickString(data.given_name),
    lastName: pickString(data.family_name),
  };
}

function pickString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

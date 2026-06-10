// Server-side helper: verify a Clerk OAuth bearer token from a CLI client.
// Uses the OIDC userinfo endpoint to authenticate the access token. We trust
// only the userId (sub) and email returned by Clerk — never any value the
// client sent in the request body.

const ISSUER = process.env.CLERK_CLI_ISSUER ?? "https://clerk.petdex.dev";

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
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
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

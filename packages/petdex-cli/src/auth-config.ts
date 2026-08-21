export type AuthConfig = {
  issuer: string;
  clientId: string;
  scopes: string[];
};

export type AuthConfigFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export const FALLBACK_ISSUER = "https://clerk.petdex.dev";
export const FALLBACK_CLIENT_ID = "LcThwEayl6KAA1Qm";
export const DEFAULT_SCOPES = ["profile", "email", "openid", "offline_access"];

export const AUTH_CONFIG_FALLBACK_WARNING =
  "petdex: unable to refresh auth configuration; using fallback authentication values.";

// Resolve OAuth config in this order:
// 1. Environment overrides (advanced users, CI)
// 2. Server-side /api/cli/auth-config (so we can rotate clientId without
//    forcing every CLI user to reinstall)
// 3. Hardcoded fallback (works offline / first-run / server down)
export async function resolveAuthConfig({
  petdexUrl,
  env = process.env,
  fetchImpl = fetch,
  warnOnFallback = true,
}: {
  petdexUrl: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: AuthConfigFetch;
  warnOnFallback?: boolean;
}): Promise<AuthConfig> {
  const envIssuer = env.CLERK_ISSUER;
  const envClientId = env.CLERK_OAUTH_CLIENT_ID;

  if (envIssuer && envClientId) {
    return {
      issuer: envIssuer,
      clientId: envClientId,
      scopes: DEFAULT_SCOPES,
    };
  }

  try {
    const res = await fetchImpl(`${petdexUrl}/api/cli/auth-config`, {
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        issuer?: unknown;
        clientId?: unknown;
        scopes?: unknown;
      };
      const issuer = typeof data.issuer === "string" ? data.issuer : null;
      const clientId = typeof data.clientId === "string" ? data.clientId : null;
      const scopes = Array.isArray(data.scopes)
        ? data.scopes.filter(
            (scope): scope is string => typeof scope === "string",
          )
        : null;

      if (issuer && clientId) {
        return {
          issuer: envIssuer ?? issuer,
          clientId: envClientId ?? clientId,
          scopes: scopes && scopes.length > 0 ? scopes : DEFAULT_SCOPES,
        };
      }
    }
  } catch {
    // Fall through to the built-in defaults.
  }

  if (warnOnFallback) console.error(AUTH_CONFIG_FALLBACK_WARNING);
  return {
    issuer: envIssuer ?? FALLBACK_ISSUER,
    clientId: envClientId ?? FALLBACK_CLIENT_ID,
    scopes: DEFAULT_SCOPES,
  };
}

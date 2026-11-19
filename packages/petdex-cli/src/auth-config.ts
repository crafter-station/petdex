import { fetchCapped } from "./fetch-capped.js";

export type AuthConfig = {
  issuer: string;
  clientId: string;
  scopes: string[];
};

// A `fetch`-shaped seam. It resolved a `Response` before this — the tests stub
// one — and `fetchCapped` needs the real thing to read the body under a cap.
// Typed as the two fields those callers touch rather than `typeof fetch`, whose
// Bun definition also carries `preconnect` a test mock has no reason to stub.
export type AuthConfigFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export const FALLBACK_ISSUER = "https://clerk.petdex.dev";
export const FALLBACK_CLIENT_ID = "LcThwEayl6KAA1Qm";
export const DEFAULT_SCOPES = ["profile", "email", "openid", "offline_access"];
// The response is three short strings, so 64 KB is generous. The seam exists so
// the read is bounded: every other network path in this package routes through
// `fetchCapped`, and a bare `res.json()` has no size limit at all (measured: a
// hostile endpoint streamed 124 MB into 218 MB of RSS before the 3s timeout).
const AUTH_CONFIG_MAX_BYTES = 64 * 1024;

// The issuer is where access/refresh tokens get exchanged and refreshed, so a
// server (or env) that answers with `http://` or a non-URL would send refresh
// tokens to a network attacker. Accept https, or http only on loopback where a
// local dev issuer legitimately has no TLS. Exported so the validation is
// directly testable and reused at the CLI-auth boundary.
export function isAllowedIssuer(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

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

  // An env issuer still has to pass the same scheme check as the server one:
  // a misconfigured `CLERK_ISSUER=http://…` must not become the token
  // destination just because it came from the environment.
  if (envIssuer && envClientId && isAllowedIssuer(envIssuer)) {
    return {
      issuer: envIssuer,
      clientId: envClientId,
      scopes: DEFAULT_SCOPES,
    };
  }

  try {
    const res = await fetchCapped(`${petdexUrl}/api/cli/auth-config`, {
      maxBytes: AUTH_CONFIG_MAX_BYTES,
      timeoutMs: 3000,
      fetchImpl: fetchImpl as typeof fetch | undefined,
    });

    if (res.ok) {
      const data = JSON.parse(res.body.toString("utf8")) as {
        issuer?: unknown;
        clientId?: unknown;
        scopes?: unknown;
      };
      const issuer = isAllowedIssuer(data.issuer) ? data.issuer.trim() : null;
      const clientId =
        typeof data.clientId === "string" && data.clientId.length > 0
          ? data.clientId
          : null;
      const scopes = Array.isArray(data.scopes)
        ? data.scopes.filter(
            (scope): scope is string => typeof scope === "string",
          )
        : null;

      if (issuer && clientId) {
        return {
          issuer: envIssuer && isAllowedIssuer(envIssuer) ? envIssuer : issuer,
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
    issuer:
      envIssuer && isAllowedIssuer(envIssuer) ? envIssuer : FALLBACK_ISSUER,
    clientId: envClientId ?? FALLBACK_CLIENT_ID,
    scopes: DEFAULT_SCOPES,
  };
}

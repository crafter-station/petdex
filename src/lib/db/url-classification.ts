// Shared DATABASE_URL classification. The app talks to two different
// Postgres servers depending on where it runs: Neon over HTTP in
// production, and a plain local Postgres (docker compose, `postgres`
// service name, loopback) in development. Two call sites need the same
// answer — `db/client.ts` picks a driver, and the Neon rate limiter has
// to know it cannot use its Neon HTTP adapter against a local server.

/**
 * True when the URL points at a local Postgres rather than Neon: loopback
 * addresses and the compose service name. `URL.hostname` for an IPv6
 * literal keeps its brackets (`[::1]`), so match that spelling too.
 */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "postgres" // docker compose service name
    );
  } catch {
    return false;
  }
}

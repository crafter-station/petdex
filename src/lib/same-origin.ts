// CSRF defense: every state-changing endpoint should accept requests only
// from our own origin. Without this, a malicious page on attacker.com can
// fire a POST with the visitor's Clerk cookie attached and write to our
// DB on their behalf (likes, withdrawals, claims, feedback).
//
// Strategy: check the Origin header (modern browsers always set it on
// cross-origin POST/PUT/DELETE). If Origin is present and not on our
// allowlist, reject. If Origin is missing (some same-origin clients
// like server-to-server fetch don't send it), we fall back to checking
// Sec-Fetch-Site, which is set by all modern browsers.
//
// Allow same-origin, the canonical site URL, the Vercel URL of the running
// deployment (preview or production), and localhost for local dev.

// Compared as full origins, not hosts, so the scheme is part of the entry.
// A host-only check admitted `http://petdex.dev` on the https site: the app
// never serves that origin (Cloudflare 308s it to https and HSTS pins it),
// so nothing legitimate carries it, and a request that does is claiming a
// site this deployment is not. The loopback names keep both schemes because
// local dev serves plain http and a dev over https is still the same server.
const SITE_ORIGINS = new Set<string>([
  "https://petdex.dev",
  "http://localhost:3000",
  "https://localhost:3000",
  "http://localhost",
  "https://localhost",
]);

/**
 * The origins this deployment answers on as a Vercel deployment (preview or
 * production), as exact `protocol//host` strings.
 *
 * Compared as a full origin, not a bare host, for the same reason as
 * `SITE_ORIGINS` above: these vars are set on the deployment's own hosts, so
 * the scheme is known and has to match. A host-only check admitted
 * `http://<this deployment's host>` on an https deployment — the plaintext
 * twin of an origin this app does not serve, carryable by a browser that
 * reached the host before the Cloudflare 308/HSTS applied.
 *
 * A bare `host.endsWith(".vercel.app")` check was also here once, and it
 * defeated the point of the module: `vercel.app` is a public suffix anyone
 * can deploy under, so `https://evil.vercel.app` passed the origin check and
 * could POST to every `requireSameOrigin` endpoint with the visitor's Clerk
 * cookie — the exact cross-site write this file exists to stop. Vercel sets
 * these three env vars on the deployment itself, so the real hosts are known
 * and a suffix match is not needed.
 */
function vercelOrigins(): string[] {
  const origins = new Set<string>();
  for (const value of [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]) {
    if (!value) continue;
    // Vercel sets these as bare hosts (`my-app-abc123.vercel.app`), but a
    // deployment that sets them itself may include a scheme; accept either and
    // pin the scheme to https, which is what Vercel serves. A value that
    // parses to nothing contributes nothing — the allowlist must only hold
    // origins someone configured on purpose.
    const candidate = value.includes("://") ? value : `https://${value}`;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (!url.host || url.origin === "null") continue;
    origins.add(url.origin);
  }
  return [...origins];
}

/**
 * The origins this deployment is configured to serve, from `PETDEX_URL`.
 *
 * `SITE_ORIGINS` names petdex.dev and localhost, so a self-hosted deployment
 * (a container on its own origin) rejected its own browser origin: a
 * same-origin `fetch()` POST sends `Origin: <that origin>`, and every
 * guarded endpoint 403s. The compose deployment hit this on
 * `http://127.0.0.1:3100`. `PETDEX_URL` is already read as the configured
 * public origin by `src/proxy.ts` and `/api/pets/random`.
 *
 * The loopback names are included at the configured port because they are the
 * same server: a developer reaches the container by whichever the browser
 * autocompletes, and `public-origin.ts` already treats `127.0.0.1`,
 * `localhost`, and `[::1]` as equivalent. Restricting the aliases to the
 * configured port keeps this from admitting an unrelated local service.
 *
 * A malformed value contributes nothing rather than being coerced — the
 * allowlist must only ever contain origins someone configured on purpose.
 */
function configuredOrigins(): Set<string> {
  const raw = process.env.PETDEX_URL?.trim();
  if (!raw) return new Set();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new Set();
  }
  // `new URL("file:///x")` has host "" and origin "null" — neither is an
  // origin a request could carry, so neither belongs in the allowlist.
  if (!url.host || url.origin === "null") return new Set();
  const origins = new Set([url.origin]);
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    const port = url.port ? `:${url.port}` : "";
    for (const name of LOOPBACK_HOSTS)
      origins.add(`${url.protocol}//${name}${port}`);
  }
  return origins;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (SITE_ORIGINS.has(parsed.origin)) return true;
    // Compared as a full origin, not a host, so the scheme has to match the
    // configured one: an `http://` deployment must not accept an `https://`
    // origin of the same host, and vice versa.
    if (configuredOrigins().has(parsed.origin)) return true;
    return vercelOrigins().includes(parsed.origin);
  }
  // No Origin header. Use Sec-Fetch-Site as a fallback. Only `same-origin`
  // and `none` qualify: `same-site` covers sibling subdomains, which are not
  // this app's origin, and browsers that set Sec-Fetch-Site send Origin on
  // every state-changing request anyway.
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs === "same-origin" || sfs === "none") {
    return true;
  }
  // No Origin and no Sec-Fetch-Site: this is most likely a non-browser
  // client (curl, server fetch). We let it through here — those callers
  // authenticate by other means (bearer token for CLI) and the auth
  // gate elsewhere already covers them.
  if (!sfs) return true;
  return false;
}

export function requireSameOrigin(req: Request): Response | null {
  if (!isSameOrigin(req)) {
    return new Response(JSON.stringify({ error: "csrf_blocked" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

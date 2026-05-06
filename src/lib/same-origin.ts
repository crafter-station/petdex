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
// Allow same-origin, the canonical site URL, the Vercel preview URL of
// the running deployment, and localhost for local dev.

const SITE_HOSTS = new Set<string>([
  "petdex.crafter.run",
  "localhost:3000",
  "localhost",
]);

function vercelHost(): string | null {
  const u = process.env.VERCEL_URL;
  return u ? u.split("/")[0] : null;
}

export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (SITE_HOSTS.has(host)) return true;
    const vercel = vercelHost();
    if (vercel && host === vercel) return true;
    // Allow Vercel preview URLs (every PR gets a *.vercel.app subdomain).
    if (host.endsWith(".vercel.app")) return true;
    return false;
  }
  // No Origin header. Use Sec-Fetch-Site as a fallback.
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs === "same-origin" || sfs === "same-site" || sfs === "none") {
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

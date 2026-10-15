// Resolving the origin a response may point a client at.
//
// `new URL(path, req.url)` and `new URL(req.url).origin` both read the
// request's own host. Behind a container bind address that is not a public
// host at all: the standalone server answers on `0.0.0.0:3000`, so a
// manifest built from `req.url` advertised
// `curl -sSf http://0.0.0.0:3000/install/<slug> | sh` — a host no client can
// reach. Where the caller has no Host header to trust, the deployment's
// configured public origin is the right source, and `PETDEX_URL` is what the
// project already reads for that purpose (`src/proxy.ts` builds its canonical
// redirect from it).
import { SITE_URL } from "./locale-routing";

// Hosts a developer reaches the app on, allowed to resolve to themselves so
// `bun run dev:docker` works. Every other host resolves to the canonical
// origin.
// `new URL(...).hostname` brackets an IPv6 literal, so the loopback address
// arrives as `[::1]` and a bare `"::1"` entry would never match. Listed in the
// form the parser actually produces.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin this deployment is publicly reachable at.
 *
 * `PETDEX_URL` when it is set to a real origin, otherwise the request's own
 * origin on loopback, otherwise {@link SITE_URL}. A malformed or hostless
 * `PETDEX_URL` (`new URL("file:///x")` has origin `"null"`) falls through to
 * the request rather than propagating — a misconfigured value should not take
 * a route down, and it must not become a public URL.
 */
export function publicOrigin(req: Request): string {
  const configured = process.env.PETDEX_URL?.trim();
  if (configured) {
    try {
      // `.origin` is the string `"null"` — not a URL — for any scheme without
      // a host (data:, file:, javascript:), so accept it only when it is a
      // real origin.
      const origin = new URL(configured).origin;
      if (origin !== "null") return origin;
    } catch {
      // Fall through rather than throwing on every request.
    }
  }
  const { hostname, origin } = new URL(req.url);
  return LOOPBACK_HOSTS.has(hostname) ? origin : SITE_URL;
}

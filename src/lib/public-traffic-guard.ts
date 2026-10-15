type HeaderBag =
  | Pick<Headers, "get">
  | Record<string, string | null | undefined>;

const BLOCKED_IPS = new Set(["133.106.50.116"]);
const BLOCKED_USER_AGENTS = ["petoverlaycompose-pixelartclassifier"];

export type PublicTrafficGuardRule = "catalog" | "metadata" | "state";

export function publicTrafficGuardRule(input: {
  method: string;
  pathname: string;
}): PublicTrafficGuardRule | null {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const pathname = input.pathname;
  // The sticker routes are redirects to R2 objects (thumb 308, sticker 307)
  // and wastickers is a constant 410, so none of them does work worth a Redis
  // round trip. They were the single largest share of guarded traffic, which
  // means the limiter spent most of its command budget guarding redirects.
  // Abuse of the underlying objects is bounded by R2 and the CDN, not here.
  // /api/manifest is a static 307 to the R2 object with a 300s CDN cache and
  // no database read, so rate limiting it spends a Redis round trip to guard
  // a redirect. It is also the single most requested path, which made it the
  // largest contributor to the command volume that got the Upstash database
  // blocked. Leave it out of the guard.
  if (pathname === "/api/pet-requests") return "catalog";
  if (pathname === "/api/desktop/latest-release") return "metadata";
  if (pathname === "/api/pets/random") return "catalog";
  if (pathname === "/api/pets/search") return "catalog";
  if (pathname === "/api/me/header-state") return "state";
  if (pathname === "/api/og") return "metadata";
  if (pathname === "/api/wechat-qr") return "metadata";
  if (
    /^\/(?:en\/|es\/|zh\/)?(?:pets|collections|u)\/[^/]+\/opengraph-image\/?$/.test(
      pathname,
    )
  ) {
    return "metadata";
  }
  if (
    /^\/(?:en\/|es\/|zh\/)?(?:collections|download)\/opengraph-image\/?$/.test(
      pathname,
    )
  ) {
    return "metadata";
  }
  if (/^\/api\/pets\/[^/]+\/codex-theme\/?$/.test(pathname)) {
    return "catalog";
  }
  if (/^\/api\/pets\/[^/]+\/metrics\/?$/.test(pathname)) return "catalog";
  if (/^\/api\/pets\/[^/]+\/variants\/?$/.test(pathname)) return "catalog";
  if (/^\/api\/install-pet\/[^/]+\/?$/.test(pathname)) return "catalog";
  if (/^\/(?:en\/|es\/|zh\/)?install\/[^/]+\/?$/.test(pathname)) {
    return "catalog";
  }
  return null;
}

export function shouldBlockKnownAbusiveClient(
  headers: HeaderBag | undefined,
): boolean {
  const ip = publicTrafficGuardKey(headers);
  if (BLOCKED_IPS.has(ip)) return true;
  const userAgent = readHeader(headers, "user-agent").toLowerCase();
  return BLOCKED_USER_AGENTS.some((blocked) => userAgent.includes(blocked));
}

/**
 * Rate-limit key for a request.
 *
 * Measured locally, rotating `x-forwarded-for` hands every request a fresh
 * quota, so the question is whether the key is spoofable. On Vercel it is not:
 * the platform overwrites `x-forwarded-for` and does not forward a
 * client-supplied value — "This restriction is in place to prevent IP
 * spoofing" — and documents `x-real-ip` as carrying the same value.
 *
 * That guarantee is scoped, and the scope matters here. The sentence above is
 * Vercel's own, written for the case of Vercel *behind a proxy*, and that is
 * how this app is deployed: Cloudflare sits in front of it with a
 * cache-everything rule (`src/app/api/revalidate/route.ts`). In that topology
 * Vercel does not forward the external IP either, so the key can resolve to
 * the proxy's address rather than the visitor's — one bucket for everyone,
 * which the 60-per-hour ceiling would then apply to the whole site. Unverified
 * against the live deployment; what was measured is the local stack, where the
 * headers arrive exactly as sent and neither guarantee is in play.
 *
 * So this is not a defence against a caller who picks their own bucket, and it
 * is not a per-visitor identity until someone confirms what the edge actually
 * forwards. Rotating the headers off Vercel remains a property of running the
 * app directly (`bun run dev`, the docker stack) rather than something to
 * paper over here: a limiter that ignored them would have no client identity
 * to key on at all.
 */
export function publicTrafficGuardKey(headers: HeaderBag | undefined): string {
  const ip =
    readHeader(headers, "x-real-ip") ||
    readHeader(headers, "x-forwarded-for").split(",")[0]?.trim() ||
    "anon";
  return ip;
}

function readHeader(headers: HeaderBag | undefined, name: string): string {
  if (!headers) return "";
  if (typeof (headers as Pick<Headers, "get">).get === "function") {
    return (headers as Pick<Headers, "get">).get(name) ?? "";
  }
  const bag = headers as Record<string, string | null | undefined>;
  return bag[name] ?? bag[name.toLowerCase()] ?? bag[name.toUpperCase()] ?? "";
}

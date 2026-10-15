import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createMiddleware from "next-intl/middleware";

import { checkBurst } from "@/lib/burst-guard";
import {
  isResolvedLocaleRewrite,
  LOCALE_REWRITE_MARKER,
  markLocaleRewrite,
} from "@/lib/locale-rewrite-guard";
import { shouldBypassClerkMiddleware } from "@/lib/public-clerk-bypass";
import {
  publicTrafficGuardKey,
  publicTrafficGuardRule,
  shouldBlockKnownAbusiveClient,
} from "@/lib/public-traffic-guard";
import {
  publicCatalogRatelimit,
  publicMetadataRatelimit,
  publicStateRatelimit,
} from "@/lib/ratelimit";
import {
  buildRouteCostSample,
  routeCostSampleRate,
  routeCostSecret,
  shouldSampleRouteCost,
  signRouteCostPayload,
} from "@/lib/route-cost";

import { defaultLocale, locales } from "@/i18n/config";

const IS_MOCK_AUTH =
  process.env.PETDEX_MOCK === "1" || process.env.PETDEX_MOCK_AUTH === "1";
const ADMIN_URL = normalizeBaseUrl(
  process.env.PETDEX_ADMIN_URL || process.env.NEXT_PUBLIC_PETDEX_ADMIN_URL,
  "https://admin.petdex.dev",
);
const CANONICAL_URL = normalizeBaseUrl(
  process.env.PETDEX_URL,
  "https://petdex.dev",
);
// Hosts that must not serve the app in their own right. The `crafter.run`
// pair is the old domain; `www.petdex.dev` is not legacy, it is the
// conventional `www` alias of the canonical host, and it was the one host
// left answering 200 with the whole site. That is worse than a duplicate:
// every canonical, hreflang, `og:url`, and sitemap URL is absolute on
// `petdex.dev`, so a `www` render advertises a different origin than the one
// it is served from. `SITE_URL` in `src/lib/locale-routing.ts` pins the
// canonical origin, so the alias can never be the one that is right.
const REDIRECT_HOSTS = new Set([
  "petdex.crafter.run",
  "www.petdex.crafter.run",
  "www.petdex.dev",
]);

// The /api entries are unreachable while the /api early return above
// runs first, and they stay as a backstop in case that order changes.
// Every route they name already answers 401 on its own.
const isProtected = createRouteMatcher([
  "/submit",
  "/submit/(.*)",
  "/:locale/submit",
  "/:locale/submit/(.*)",
  "/api/submit",
  "/api/submit/(.*)",
  "/api/r2",
  "/api/r2/(.*)",
  "/api/my-pets",
  "/api/my-pets/(.*)",
]);

// `alternateLinks: false` drops the `Link: rel="alternate"; hreflang=…`
// response header. Every `Link` header would be emitted for the same URLs by
// the `<link rel="alternate">` elements Next renders from `buildLocaleAlternates`
// and by the sitemap, both of which say `zh-Hans` for the Chinese pages, and
// the header is the only one that cannot: next-intl derives the hreflang from
// the locale key itself and `alternateLinks` is a plain boolean with no
// mapping hook, so it emitted `hreflang="zh"` — a different language tag for
// the same pair. Google treats the three placements as equivalent and says
// maintaining all three buys nothing, so the disagreeing third goes rather
// than being rewritten by hand.
const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: false,
  alternateLinks: false,
});

// In mock auth mode the user is always signed in, so we skip
// clerkMiddleware entirely (it would otherwise try to validate a real
// backend secret before our shims have a chance to short-circuit).
// Everything else — next-intl routing, the shuffle cookie — keeps working.
const baseMiddleware = async (req: NextRequest, event?: NextFetchEvent) => {
  const hostRedirect = canonicalHostRedirect(req);
  if (hostRedirect) return hostRedirect;
  const adminSurface = adminSurfaceResponse(req);
  if (adminSurface) return adminSurface;
  scheduleRouteCostSample(req, event);
  const guard = await guardPublicTraffic(req);
  if (guard) return guard;
  if (new URL(req.url).pathname.startsWith("/api")) {
    return NextResponse.next();
  }
  return handleI18nRoutingWithoutLocaleCookie(
    req as Parameters<typeof handleI18nRouting>[0],
  );
};

const clerkBackedMiddleware = clerkMiddleware(async (auth, req, event) => {
  const hostRedirect = canonicalHostRedirect(req);
  if (hostRedirect) return hostRedirect;
  const adminSurface = adminSurfaceResponse(req);
  if (adminSurface) return adminSurface;
  scheduleRouteCostSample(req, event);
  const guard = await guardPublicTraffic(req);
  if (guard) return guard;

  // API routes authenticate themselves and answer 401. Running
  // auth.protect() here instead sends them down Clerk's page path,
  // which redirects a document request but calls notFound() for a
  // fetch(), so /api/r2/presign answered 404 to an expired session
  // and the submit form reported "presign 404" (#717).
  if (req.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  if (isProtected(req)) {
    await auth.protect();
  }

  return handleI18nRoutingWithoutLocaleCookie(req);
});

export default function proxy(req: NextRequest, event: NextFetchEvent) {
  if (
    IS_MOCK_AUTH ||
    shouldBypassClerkMiddleware({
      method: req.method,
      pathname: req.nextUrl.pathname,
    })
  ) {
    return baseMiddleware(req, event);
  }
  return clerkBackedMiddleware(req, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals + static assets + SEO files (robots, sitemap)
    "/((?!_next|robots\\.txt|sitemap\\.xml|manifest\\.json|version\\.json|opengraph-image|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(pets|collections|u)/:slug/opengraph-image",
    "/(en|es|zh)/(pets|collections|u)/:slug/opengraph-image",
    "/(collections|download)/opengraph-image",
    "/(en|es|zh)/(collections|download)/opengraph-image",
    "/(api|trpc)(.*)",
  ],
};

async function guardPublicTraffic(
  req: NextRequest,
): Promise<NextResponse | null> {
  if (shouldBlockKnownAbusiveClient(req.headers)) {
    return new NextResponse(null, {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  }

  const rule = publicTrafficGuardRule({
    method: req.method,
    pathname: req.nextUrl.pathname,
  });
  if (!rule) return null;

  // The burst check runs in process, so a spike costs no Redis commands. Only
  // the sustained per-rule limit below reaches Upstash.
  const key = publicTrafficGuardKey(req.headers);
  const burst = checkBurst(key);
  if (!burst.success) return rateLimitedResponse(burst.reset);

  // Every limiter fails open (see createRatelimit in @/lib/ratelimit), so a
  // limiter outage degrades to "allow" here instead of throwing into the
  // middleware and turning each matched route into a 500.
  const limit =
    rule === "metadata"
      ? await publicMetadataRatelimit.limit(key)
      : rule === "state"
        ? await publicStateRatelimit.limit(key)
        : await publicCatalogRatelimit.limit(key);
  if (limit.success) return null;

  return rateLimitedResponse(limit.reset);
}

function rateLimitedResponse(reset: number): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return NextResponse.json(
    { error: "rate_limited" },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfter),
      },
    },
  );
}

function adminSurfaceResponse(req: NextRequest): NextResponse | null {
  const pathname = req.nextUrl.pathname;
  if (pathname === "/api/admin" || pathname.startsWith("/api/admin/")) {
    return new NextResponse(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }

  const stripped = pathname.replace(/^\/(?:en|es|zh)(?=\/|$)/, "") || "/";
  if (stripped !== "/admin" && !stripped.startsWith("/admin/")) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new NextResponse(null, {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }

  const url = new URL(pathname, ADMIN_URL);
  url.search = req.nextUrl.search;
  return NextResponse.redirect(url);
}

function canonicalHostRedirect(req: NextRequest): NextResponse | null {
  const host = normalizeHost(req.headers.get("host"));
  if (!REDIRECT_HOSTS.has(host)) return null;

  // Build the target from the path rather than `new URL(path, CANONICAL_URL)`.
  // The two-argument form resolves a protocol-relative path: if `pathname`
  // were ever `//evil.example/x`, the result is `https://evil.example/x` and
  // the redirect becomes an open redirect. Next normalizes a leading `//`
  // today (measured: `//evil.example/pwn` arrives as `/evil.example/pwn`), so
  // it is not reachable on this version — but that is the framework's
  // behaviour to keep, not this function's. Assigning `pathname` onto a URL
  // built from the canonical origin pins the host and cannot escape it.
  const url = new URL(CANONICAL_URL);
  url.pathname = req.nextUrl.pathname;
  url.search = req.nextUrl.search;
  return NextResponse.redirect(url, 308);
}

function normalizeBaseUrl(raw: string | null | undefined, fallback: string) {
  try {
    const url = new URL(raw?.trim() || fallback);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback.replace(/\/$/, "");
  }
}

function normalizeHost(raw: string | null): string {
  // The trailing dot is the root label, and a host is the same host with or
  // without it — `www.petdex.dev.` resolves to the same address as
  // `www.petdex.dev`. Browsers strip it, but curl, some crawlers, and a few
  // resolvers send it as typed, and it made the `www` alias serve the whole
  // site again: the set below holds the dotless spelling, so the lookup
  // missed and every canonical/og:url/hreflang on the page advertised an
  // origin the request had not come from. Stripped here so the redirect
  // covers the spelling the DNS actually allows.
  return (raw?.split(":")[0]?.toLowerCase() ?? "").replace(/\.$/, "");
}

function handleI18nRoutingWithoutLocaleCookie(
  req: Parameters<typeof handleI18nRouting>[0],
) {
  const response = isResolvedLocaleRewrite({
    marker: req.headers.get(LOCALE_REWRITE_MARKER),
    pathname: req.nextUrl.pathname,
  })
    ? NextResponse.next()
    : markLocaleRewrite(handleI18nRouting(req));
  if (req.cookies.has("NEXT_LOCALE")) {
    response.cookies.delete("NEXT_LOCALE");
  }
  return response;
}

function scheduleRouteCostSample(req: NextRequest, event?: NextFetchEvent) {
  if (!event) return;
  const secret = routeCostSecret();
  const sampleRate = routeCostSampleRate();
  if (!secret || !shouldSampleRouteCost(sampleRate)) return;
  const sample = buildRouteCostSample({
    method: req.method,
    pathname: req.nextUrl.pathname,
    headers: req.headers,
    origin: req.nextUrl.origin,
    sampleRate,
  });
  if (!sample) return;

  const body = JSON.stringify(sample);
  event.waitUntil(
    signRouteCostPayload(body, secret)
      .then((signature) =>
        // Destination pinned to the configured public origin: `req.url`
        // carries whatever Host the client sent, so a forged Host would
        // have the app POST its signed sample to the attacker's server.
        // Same reasoning that pins /api/pets/random's redirect above.
        fetch(new URL("/api/internal/route-cost", CANONICAL_URL), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-petdex-signature": signature,
          },
          body,
          cache: "no-store",
        }),
      )
      .then(() => undefined)
      .catch(() => undefined),
  );
}

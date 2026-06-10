import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createMiddleware from "next-intl/middleware";

import { shouldBypassClerkMiddleware } from "@/lib/public-clerk-bypass";
import {
  publicTrafficGuardKey,
  publicTrafficGuardRule,
  shouldBlockKnownAbusiveClient,
} from "@/lib/public-traffic-guard";
import {
  packAssetRatelimit,
  publicCatalogRatelimit,
  publicMetadataRatelimit,
  publicStateRatelimit,
  publicTrafficBurstRatelimit,
  stickerAssetRatelimit,
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
const LEGACY_REDIRECT_HOSTS = new Set([
  "petdex.crafter.run",
  "www.petdex.crafter.run",
]);

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

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: false,
});

// In mock auth mode the user is always signed in, so we skip
// clerkMiddleware entirely (it would otherwise try to validate a real
// backend secret before our shims have a chance to short-circuit).
// Everything else — next-intl routing, the shuffle cookie — keeps working.
const baseMiddleware = async (req: NextRequest, event?: NextFetchEvent) => {
  const legacyRedirect = legacyHostRedirect(req);
  if (legacyRedirect) return legacyRedirect;
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
  const legacyRedirect = legacyHostRedirect(req);
  if (legacyRedirect) return legacyRedirect;
  const adminSurface = adminSurfaceResponse(req);
  if (adminSurface) return adminSurface;
  scheduleRouteCostSample(req, event);
  const guard = await guardPublicTraffic(req);
  if (guard) return guard;

  if (isProtected(req)) {
    await auth.protect();
  }

  if (req.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.next();
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

  const key = publicTrafficGuardKey(req.headers);
  const burst = await publicTrafficBurstRatelimit.limit(key);
  if (!burst.success) return rateLimitedResponse(burst.reset);

  const limit =
    rule === "sticker"
      ? await stickerAssetRatelimit.limit(key)
      : rule === "pack"
        ? await packAssetRatelimit.limit(key)
        : rule === "metadata"
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

function legacyHostRedirect(req: NextRequest): NextResponse | null {
  const host = normalizeHost(req.headers.get("host"));
  if (!LEGACY_REDIRECT_HOSTS.has(host)) return null;

  const url = new URL(req.nextUrl.pathname, CANONICAL_URL);
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
  return raw?.split(":")[0]?.toLowerCase() ?? "";
}

function handleI18nRoutingWithoutLocaleCookie(
  req: Parameters<typeof handleI18nRouting>[0],
) {
  const response = handleI18nRouting(req);
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
        fetch(new URL("/api/internal/route-cost", req.url), {
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

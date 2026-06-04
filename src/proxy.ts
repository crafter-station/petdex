import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createMiddleware from "next-intl/middleware";

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

const isProtected = createRouteMatcher([
  "/submit",
  "/submit/(.*)",
  "/:locale/submit",
  "/:locale/submit/(.*)",
  "/api/submit",
  "/api/submit/(.*)",
  "/api/r2",
  "/api/r2/(.*)",
  "/admin",
  "/admin/(.*)",
  "/:locale/admin",
  "/:locale/admin/(.*)",
  "/api/admin",
  "/api/admin/(.*)",
  "/api/my-pets",
  "/api/my-pets/(.*)",
]);

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: "as-needed",
});

// In mock auth mode the user is always signed in, so we skip
// clerkMiddleware entirely (it would otherwise try to validate a real
// backend secret before our shims have a chance to short-circuit).
// Everything else — next-intl routing, the shuffle cookie — keeps working.
const baseMiddleware = (req: NextRequest, event?: NextFetchEvent) => {
  scheduleRouteCostSample(req, event);
  if (new URL(req.url).pathname.startsWith("/api")) {
    return NextResponse.next();
  }
  return handleI18nRouting(req as Parameters<typeof handleI18nRouting>[0]);
};

export default IS_MOCK_AUTH
  ? baseMiddleware
  : clerkMiddleware(async (auth, req, event) => {
      scheduleRouteCostSample(req, event);

      if (isProtected(req)) {
        await auth.protect();
      }

      if (req.nextUrl.pathname.startsWith("/api")) {
        return NextResponse.next();
      }

      return handleI18nRouting(req);
    });

export const config = {
  matcher: [
    // Skip Next.js internals + static assets + SEO files (robots, sitemap)
    "/((?!_next|robots\\.txt|sitemap\\.xml|manifest\\.json|version\\.json|opengraph-image|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

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

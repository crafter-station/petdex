import { NextResponse } from "next/server";

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import createMiddleware from "next-intl/middleware";

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
const baseMiddleware = (req: Request) => {
  if (new URL(req.url).pathname.startsWith("/api")) {
    return NextResponse.next();
  }
  return handleI18nRouting(req as Parameters<typeof handleI18nRouting>[0]);
};

export default IS_MOCK_AUTH
  ? baseMiddleware
  : clerkMiddleware(async (auth, req) => {
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

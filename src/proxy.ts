import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtected = createRouteMatcher([
  "/submit",
  "/submit/(.*)",
  "/api/submit",
  "/api/submit/(.*)",
  "/cli-auth",
  "/cli-auth/(.*)",
  "/api/cli/token",
  "/api/cli/token/(.*)",
  "/admin",
  "/admin/(.*)",
  "/api/admin",
  "/api/admin/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

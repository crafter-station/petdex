import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// The proxy itself pulls in Clerk and next-intl, so we assert on its
// source instead of importing it. What matters is an ordering the type
// system cannot express: /api must return before auth.protect() runs.
// Comments are stripped first, otherwise prose mentioning auth.protect()
// would be read as the call site and the assertion would measure itself.
const source = readFileSync(new URL("./proxy.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

describe("protected API routes bypass auth.protect", () => {
  it("returns for /api before calling auth.protect", () => {
    // Scope to the Clerk-backed middleware. The anonymous middleware
    // above it has its own /api early return, and matching that one
    // would pass no matter how the Clerk branch is ordered.
    const start = source.indexOf("const clerkBackedMiddleware");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start);

    const apiReturn = body.indexOf('pathname.startsWith("/api")');
    const protect = body.indexOf("auth.protect()");

    expect(apiReturn).toBeGreaterThan(-1);
    expect(protect).toBeGreaterThan(-1);
    // auth.protect() answers a fetch() with notFound(), so an API route
    // reaching it returns 404 to an expired session instead of 401 (#717).
    expect(apiReturn).toBeLessThan(protect);
  });
});

describe("every proxy-protected API route rejects on its own", () => {
  // Mirrors the /api entries of isProtected. Each must answer 401
  // itself, because the proxy no longer guards them.
  const routes = [
    "src/app/api/submit/route.ts",
    "src/app/api/r2/presign/route.ts",
    "src/app/api/my-pets/approved/route.ts",
    "src/app/api/my-pets/claim/route.ts",
    "src/app/api/my-pets/[id]/edit/route.ts",
    "src/app/api/my-pets/[id]/edit-presign/route.ts",
    "src/app/api/my-pets/[id]/withdraw/route.ts",
  ];

  for (const route of routes) {
    it(`${route} answers 401 without a session`, () => {
      const body = readFileSync(route, "utf8");
      expect(body).toContain("await auth()");
      expect(body).toMatch(/if \(!userId\)/);
      expect(body).toContain("status: 401");
    });
  }
});

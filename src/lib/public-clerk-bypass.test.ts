import { describe, expect, it } from "bun:test";

import { shouldBypassClerkMiddleware } from "@/lib/public-clerk-bypass";

describe("shouldBypassClerkMiddleware", () => {
  it("bypasses Clerk for public read-only HTML pages", () => {
    for (const pathname of [
      "/",
      "/es",
      "/built-with",
      "/zh/docs",
      "/download",
      "/leaderboard/",
      "/requests",
      "/legal/takedown",
      "/pets/boba",
      "/es/collections/cute-coders",
      "/kind/cat",
      "/zh/vibe/cozy",
    ]) {
      expect(shouldBypassClerkMiddleware({ method: "GET", pathname })).toBe(
        true,
      );
      expect(shouldBypassClerkMiddleware({ method: "HEAD", pathname })).toBe(
        true,
      );
    }
  });

  it("bypasses Clerk for public catalog APIs", () => {
    for (const pathname of [
      "/api/manifest",
      "/api/manifest/v2",
      "/api/pets/random",
      "/api/pets/search",
      "/api/pets/boba/metrics",
      "/api/pets/boba/thumb",
      "/api/pets/boba/sticker",
      "/api/pets/boba/wastickers",
      "/api/pets/boba/variants",
      "/api/pets/boba/codex-theme",
      "/api/install-pet/boba",
      "/api/desktop/latest-release",
    ]) {
      expect(shouldBypassClerkMiddleware({ method: "GET", pathname })).toBe(
        true,
      );
    }
  });

  it("keeps Clerk on auth, profile, feedback, submit, and full manifest surfaces", () => {
    for (const pathname of [
      "/u/hunter",
      "/es/u/hunter",
      "/submit",
      "/es/submit",
      "/my-pets",
      "/my-feedback",
      "/advertise/dashboard",
      "/advertise/new",
      "/api/manifest/full",
      "/api/me/header-state",
      "/api/profile",
      "/api/profile/gallery-order",
      "/api/feedback",
      "/api/pet-requests",
      "/api/submit",
      "/api/pets/boba/like",
      "/api/pets/boba/owner",
      "/api/pets/boba/owner-state",
      "/api/pets/boba/can-delete",
    ]) {
      expect(shouldBypassClerkMiddleware({ method: "GET", pathname })).toBe(
        false,
      );
    }
  });

  it("keeps Clerk on mutations even for public catalog read paths", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        shouldBypassClerkMiddleware({
          method,
          pathname: "/api/pets/boba/metrics",
        }),
      ).toBe(false);
    }
  });
});

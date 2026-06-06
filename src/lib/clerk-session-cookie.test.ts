import { describe, expect, it } from "bun:test";

import { hasClerkSessionCookie } from "@/lib/clerk-session-cookie";

describe("hasClerkSessionCookie", () => {
  it("detects Clerk session cookies", () => {
    expect(hasClerkSessionCookie("__session=abc")).toBe(true);
    expect(hasClerkSessionCookie("theme=dark; __session=abc")).toBe(true);
    expect(hasClerkSessionCookie("__session_legacy=abc")).toBe(true);
  });

  it("ignores non-session cookies", () => {
    expect(hasClerkSessionCookie(null)).toBe(false);
    expect(hasClerkSessionCookie("theme=dark")).toBe(false);
    expect(hasClerkSessionCookie("__client_uat=1780770000")).toBe(false);
  });
});

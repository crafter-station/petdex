import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  getAdminUserIds,
  getPublicAdminUserIds,
  isAdmin,
  isAdminClientSafe,
} from "@/lib/admin";

const ENV_KEYS = [
  "PETDEX_ADMIN_USER_IDS",
  "NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

describe("admin permissions", () => {
  it("parses private admin user IDs", () => {
    process.env.PETDEX_ADMIN_USER_IDS = " user_a, user_b ,,";

    expect([...getAdminUserIds()]).toEqual(["user_a", "user_b"]);
    expect(isAdmin("user_a")).toBe(true);
    expect(isAdmin("user_x")).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });

  it("keeps public admin IDs visibility-only", () => {
    process.env.NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS = " user_public ";

    expect([...getPublicAdminUserIds()]).toEqual(["user_public"]);
    expect(isAdminClientSafe("user_public")).toBe(true);
    expect(isAdmin("user_public")).toBe(false);
  });
});

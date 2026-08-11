import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  AUTH_CONFIG_FALLBACK_WARNING,
  DEFAULT_SCOPES,
  FALLBACK_CLIENT_ID,
  FALLBACK_ISSUER,
  resolveAuthConfig,
  type AuthConfigFetch,
} from "./auth-config.js";

describe("resolveAuthConfig", () => {
  test("warns on stderr and uses built-in defaults when fetch rejects", async () => {
    const fetchImpl: AuthConfigFetch = mock(async () => {
      throw new Error("offline");
    });
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const config = await resolveAuthConfig({
        petdexUrl: "https://petdex.test",
        env: {},
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(AUTH_CONFIG_FALLBACK_WARNING);
      expect(config).toEqual({
        issuer: FALLBACK_ISSUER,
        clientId: FALLBACK_CLIENT_ID,
        scopes: DEFAULT_SCOPES,
      });
    } finally {
      stderr.mockRestore();
    }
  });

  test("does not warn when the server returns valid auth config", async () => {
    const fetchImpl: AuthConfigFetch = mock(async () =>
      new Response(
        JSON.stringify({
          issuer: "https://clerk.example.test",
          clientId: "client_test",
          scopes: ["profile", "email"],
        }),
      ),
    );
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const config = await resolveAuthConfig({
        petdexUrl: "https://petdex.test",
        env: {},
        fetchImpl,
      });

      expect(stderr).not.toHaveBeenCalled();
      expect(config).toEqual({
        issuer: "https://clerk.example.test",
        clientId: "client_test",
        scopes: ["profile", "email"],
      });
    } finally {
      stderr.mockRestore();
    }
  });
});
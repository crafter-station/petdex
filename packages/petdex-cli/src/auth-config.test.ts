import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  AUTH_CONFIG_FALLBACK_WARNING,
  DEFAULT_SCOPES,
  FALLBACK_CLIENT_ID,
  FALLBACK_ISSUER,
  isAllowedIssuer,
  resolveAuthConfig,
} from "./auth-config.js";

describe("resolveAuthConfig", () => {
  test("warns on stderr and uses built-in defaults when fetch rejects", async () => {
    const fetchImpl = mock(async () => {
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
    const fetchImpl = mock(
      async () =>
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

  test("allows local-only callers to suppress the fallback warning", async () => {
    const fetchImpl = mock(async () => {
      throw new Error("offline");
    });
    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const config = await resolveAuthConfig({
        petdexUrl: "https://petdex.test",
        env: {},
        fetchImpl,
        warnOnFallback: false,
      });

      expect(stderr).not.toHaveBeenCalled();
      expect(config).toEqual({
        issuer: FALLBACK_ISSUER,
        clientId: FALLBACK_CLIENT_ID,
        scopes: DEFAULT_SCOPES,
      });
    } finally {
      stderr.mockRestore();
    }
  });

  test("ignores a server issuer that is not https", async () => {
    // The issuer receives the refresh token, so a server (or a MITM on the
    // auth-config fetch) answering with http:// must not become the token
    // destination — fall back to the built-in https issuer instead.
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            issuer: "http://clerk.evil.test",
            clientId: "client_evil",
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

      expect(config.issuer).toBe(FALLBACK_ISSUER);
      expect(config.clientId).toBe(FALLBACK_CLIENT_ID);
      expect(stderr).toHaveBeenCalledWith(AUTH_CONFIG_FALLBACK_WARNING);
    } finally {
      stderr.mockRestore();
    }
  });

  test("ignores an http CLERK_ISSUER environment override", async () => {
    const fetchImpl = mock(async () => {
      throw new Error("offline");
    });

    const config = await resolveAuthConfig({
      petdexUrl: "https://petdex.test",
      env: {
        CLERK_ISSUER: "http://clerk.evil.test",
        CLERK_OAUTH_CLIENT_ID: "client_evil",
      },
      fetchImpl,
      warnOnFallback: false,
    });

    expect(config.issuer).toBe(FALLBACK_ISSUER);
  });
});

describe("isAllowedIssuer", () => {
  test("accepts https anywhere and http only on loopback", () => {
    expect(isAllowedIssuer("https://clerk.petdex.dev")).toBe(true);
    expect(isAllowedIssuer("http://localhost:3000")).toBe(true);
    expect(isAllowedIssuer("http://127.0.0.1:8787")).toBe(true);
    expect(isAllowedIssuer("http://clerk.petdex.dev")).toBe(false);
    expect(isAllowedIssuer("ftp://clerk.petdex.dev")).toBe(false);
    expect(isAllowedIssuer("not a url")).toBe(false);
    expect(isAllowedIssuer(42)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ClerkCliAuthError } from "../types";
import { exchangeCodeForTokens, fetchUserInfo } from "./token-exchange";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type FetchArgs = Parameters<typeof fetch>;

function stubFetch(
  impl: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response>,
) {
  globalThis.fetch = impl as typeof fetch;
}

const params = {
  issuer: "https://clerk.test",
  clientId: "client-id",
  code: "auth-code",
  codeVerifier: "verifier",
  redirectUri: "http://127.0.0.1:1/callback",
};

/**
 * Both network calls must carry a deadline.
 *
 * Without one a stalled connection leaves `login()` waiting forever: the
 * callback server's own timeout answers the browser, but nothing breaks the
 * request the CLI is sitting on.
 *
 * These watch `AbortSignal.timeout` rather than waiting out the real 15s,
 * which would cost the suite half a minute to re-prove that a timeout signal
 * aborts — Node's guarantee, not this module's. What belongs to the module is
 * asking for a bounded deadline at all, and that is what is asserted. A
 * signal from `new AbortController()` would satisfy "is an AbortSignal" while
 * never aborting; it cannot satisfy this.
 */
describe("token exchange request bounds", () => {
  const realTimeout = AbortSignal.timeout;
  let deadlines: number[];

  beforeEach(() => {
    deadlines = [];
    AbortSignal.timeout = ((ms: number) => {
      deadlines.push(ms);
      return realTimeout(ms);
    }) as typeof AbortSignal.timeout;
  });

  afterEach(() => {
    AbortSignal.timeout = realTimeout;
  });

  test("asks for a bounded deadline on the token request", async () => {
    let signal: AbortSignal | undefined;
    stubFetch(async (_input, init) => {
      signal = init?.signal ?? undefined;
      throw new Error("stopped before the request went out");
    });

    await exchangeCodeForTokens(params).catch(() => {});

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThan(0);
    // Bounded, not merely present: an hour is not a deadline anyone waits out.
    expect(deadlines[0]).toBeLessThanOrEqual(60_000);
  });

  test("asks for a bounded deadline on the userinfo request", async () => {
    let signal: AbortSignal | undefined;
    stubFetch(async (_input, init) => {
      signal = init?.signal ?? undefined;
      throw new Error("stopped before the request went out");
    });

    await fetchUserInfo({
      issuer: "https://clerk.test",
      accessToken: "token",
    }).catch(() => {});

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThan(0);
    expect(deadlines[0]).toBeLessThanOrEqual(60_000);
  });

  test("reports a request that failed as a token_exchange error", async () => {
    stubFetch(async () => {
      throw new Error("socket hang up");
    });

    const error = (await exchangeCodeForTokens(params).catch(
      (err: Error) => err,
    )) as ClerkCliAuthError;
    expect(error).toBeInstanceOf(ClerkCliAuthError);
    expect(error.code).toBe("token_exchange");
    expect(error.message).toContain("Token request failed");
  });

  test("reports an HTTP failure from the token endpoint", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = (await exchangeCodeForTokens(params).catch(
      (err: Error) => err,
    )) as ClerkCliAuthError;
    expect(error.code).toBe("token_exchange");
    expect(error.message).toBe("invalid_grant");
  });

  test("refuses a token response with no access_token", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = (await exchangeCodeForTokens(params).catch(
      (err: Error) => err,
    )) as ClerkCliAuthError;
    expect(error.code).toBe("token_exchange");
    expect(error.message).toContain("access_token");
  });
});

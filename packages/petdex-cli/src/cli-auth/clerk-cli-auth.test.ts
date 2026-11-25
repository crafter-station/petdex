import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClerkCliAuth } from "./clerk-cli-auth";
import { callbackStringsByLocale } from "./lib/callback-page";
import { createCredentialStore } from "./lib/credential-store";
import type { CredentialStore } from "./types";

const ISSUER = "https://clerk.test";

/** The token endpoint only parses JSON when the response says it is JSON. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** In-memory store, so a login never touches the OS keychain. */
function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    replaceIfUnchanged: async (key, expected, value, guard) => {
      if ((values.get(key) ?? null) !== expected) return false;
      if (guard && (values.get(guard.key) ?? null) !== guard.expected)
        return false;
      values.set(key, value);
      return true;
    },
  };
}

const realFetch = globalThis.fetch;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

afterEach(() => {
  globalThis.fetch = realFetch;
  unhandled.length = 0;
});

/**
 * Drive a full login against a fake issuer, and return the page the browser
 * was served once the flow finished.
 */
async function runLogin(options: {
  tokenStatus?: number;
  userinfoStatus?: number;
  store?: CredentialStore;
  openBrowserThrows?: boolean;
}) {
  const store = options.store ?? memoryStore();
  let captured: Promise<Response> | null = null;

  const auth = new ClerkCliAuth({
    clientId: "client-id",
    issuer: ISSUER,
    storage: store,
    callbackPort: 0,
    timeoutMs: 4000,
    openBrowser: async (authorizeUrl: string) => {
      if (options.openBrowserThrows) throw new Error("no browser available");
      const url = new URL(authorizeUrl);
      const redirectUri = url.searchParams.get("redirect_uri") as string;
      const state = url.searchParams.get("state") as string;
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "auth-code");
      callback.searchParams.set("state", state);
      // Deliberately not awaited: like a real browser, this request stays
      // open until the CLI has finished the exchange and answered it.
      captured = fetch(callback.toString());
    },
  });

  type FetchArgs = Parameters<typeof fetch>;
  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const url = String(input);
    if (url.startsWith(`${ISSUER}/oauth/token`)) {
      if (options.tokenStatus && options.tokenStatus >= 400) {
        return json({ error: "invalid_grant" }, options.tokenStatus);
      }
      return json({ access_token: "token", token_type: "Bearer" });
    }
    if (url.startsWith(`${ISSUER}/oauth/userinfo`)) {
      if (options.userinfoStatus && options.userinfoStatus >= 400) {
        return json({ error: "unavailable" }, options.userinfoStatus);
      }
      return json({ sub: "user_1" });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const outcome = await auth.login().then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({ ok: false as const, error }),
  );
  const page: Response | null = captured
    ? await (captured as Promise<Response>)
    : null;
  return { outcome, page };
}

describe("clerk cli auth token refresh", () => {
  /** A store seeded with one `tokens` record, plus a hook on the guarded write. */
  function seededStore(
    tokens: unknown,
    opts: {
      onReplace?: (
        expected: string | null,
        value: string,
      ) => Promise<boolean> | boolean;
    } = {},
  ) {
    const values = new Map<string, string>([
      ["tokens", JSON.stringify(tokens)],
    ]);
    const store: CredentialStore = {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
      replaceIfUnchanged: async (key, expected, value, guard) => {
        if (opts.onReplace) {
          const written = await opts.onReplace(expected, value);
          if (!written) return false;
        }
        if ((values.get(key) ?? null) !== expected) return false;
        if (guard && (values.get(guard.key) ?? null) !== guard.expected)
          return false;
        values.set(key, value);
        return true;
      },
    };
    return { store, values };
  }

  function answerToken(body: unknown, userInfo: unknown = { sub: "user_1" }) {
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input);
      if (url.startsWith(`${ISSUER}/oauth/token`)) return json(body);
      if (url.startsWith(`${ISSUER}/oauth/userinfo`)) return json(userInfo);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
  }

  const expired = {
    accessToken: "tok-A",
    refreshToken: "r-A",
    expiresAt: Date.now() - 1000,
  };

  test("a refresh that the issuer does not rotate keeps the stored refresh token", async () => {
    const { store } = seededStore(expired);
    answerToken({ access_token: "tok-A-refreshed", token_type: "Bearer" });

    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
    expect(await auth.getAccessToken()).toBe("tok-A-refreshed");

    const stored = JSON.parse((await store.get("tokens")) as string) as {
      accessToken: string;
      refreshToken: string;
    };
    expect(stored.accessToken).toBe("tok-A-refreshed");
    // No rotation means the old refresh token is still the only one there is.
    expect(stored.refreshToken).toBe("r-A");
  });

  test("a refresh whose record changed mid-flight is dropped, and the stored session is used", async () => {
    // A login lands while the refresh is in the network round trip. The
    // guarded write must compare the bytes read before that round trip and
    // drop the result; the call then answers as the account that is actually
    // signed in, without throwing and without printing anything.
    let compared: { expected: string | null; value: string } | undefined;
    const { store, values } = seededStore(expired, {
      onReplace: (expected, value) => {
        compared = { expected, value };
        values.set(
          "tokens",
          JSON.stringify({
            accessToken: "tok-B",
            refreshToken: "r-B",
            expiresAt: Date.now() + 3_600_000,
          }),
        );
        return false;
      },
    });
    answerToken({ access_token: "tok-A-refreshed", token_type: "Bearer" });

    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
    expect(await auth.getAccessToken()).toBe("tok-B");

    // What was compared: the exact record the refresh was computed from.
    const compare = compared as { expected: string | null; value: string };
    expect(JSON.parse(compare.expected as string)).toEqual(expired);
    // What would have been written had the compare passed.
    expect(JSON.parse(compare.value).accessToken).toBe("tok-A-refreshed");
    // The store still holds the login's session, untouched.
    expect(JSON.parse(values.get("tokens") as string)).toEqual({
      accessToken: "tok-B",
      refreshToken: "r-B",
      expiresAt: expect.any(Number),
    });
  });

  test("whoami names the account that won a login race on that very call", async () => {
    // A's token is due and another terminal finishes `petdex login` as B
    // inside this call's refresh round trip, replacing both records. The
    // refresh write-back is refused because the record changed under it, so
    // the store now holds B's session. `whoami` must answer as B on *this*
    // call — it used to read the profile before refreshing the token, so it
    // returned A's name and only the next command saw B.
    const userA = { sub: "user_A", email: "alice@example.test" };
    const userB = { sub: "user_B", email: "bob@example.test" };
    let compared: { expected: string | null; value: string } | undefined;
    const { store, values } = seededStore(expired, {
      onReplace: (expected, value) => {
        compared = { expected, value };
        // B's login in login()'s own order: drop the old profile, write the
        // new tokens, then the new profile.
        values.delete("user");
        values.set(
          "tokens",
          JSON.stringify({
            accessToken: "tok-B",
            refreshToken: "r-B",
            expiresAt: Date.now() + 3_600_000,
          }),
        );
        values.set("user", JSON.stringify(userB));
        return false;
      },
    });
    // A's profile sits beside A's expired token when the command starts.
    values.set("user", JSON.stringify(userA));
    // The token answer is A's refresh (dropped), and userinfo would answer a
    // third identity — distinct from both, so the assertions below cannot be
    // satisfied by an accidental network fetch.
    answerToken(
      { access_token: "tok-A-refreshed", token_type: "Bearer" },
      {
        sub: "user_FROM_SERVER",
        email: "server@example.test",
      },
    );

    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });

    // The very call that lost the race reports B, not the A profile it would
    // have read first, and not the server's third identity (so no fetch
    // happened — the winner's cached profile was used).
    expect(await auth.whoami()).toEqual(userB);

    // A's refresh was compared against the record it came from and dropped;
    // B's tokens and profile are exactly what the login wrote.
    const compare = compared as { expected: string | null; value: string };
    expect(JSON.parse(compare.expected as string)).toEqual(expired);
    expect(JSON.parse(values.get("tokens") as string).accessToken).toBe(
      "tok-B",
    );
    expect(values.get("user")).toBe(JSON.stringify(userB));
  });

  test("whoami stays signed out when only a profile is stored, with no tokens", async () => {
    // The cached profile is not evidence of a session: ordering the credential
    // check first must still turn a profile-without-tokens store into "signed
    // out" rather than naming an account no command can act as.
    const store = memoryStore();
    await store.set("user", JSON.stringify({ sub: "user_A" }));
    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
    expect(await auth.whoami()).toBeNull();
  });
});

describe("clerk cli auth login page", () => {
  test("serves the success page only after the credentials are stored", async () => {
    const store = memoryStore();
    const { outcome, page } = await runLogin({ store });

    expect(outcome.ok).toBe(true);
    expect(page?.status).toBe(200);
    const html = await page?.text();
    expect(html).toContain('class="chip chip-success"');
    expect(await store.get("tokens")).toContain("token");
    expect(await store.get("user")).toContain("user_1");
  });

  test("shows a failure page when the code exchange fails", async () => {
    // The regression this deferral exists for: the page used to say
    // "signed in" while the terminal reported a failed exchange.
    const { outcome, page } = await runLogin({ tokenStatus: 400 });

    expect(outcome.ok).toBe(false);
    expect(page?.status).toBe(500);
    const html = await page?.text();
    expect(html).toContain('class="chip chip-danger"');
    expect(html).not.toContain('class="chip chip-success"');
  });

  test("shows a failure page when the userinfo call fails", async () => {
    const { outcome, page } = await runLogin({ userinfoStatus: 500 });

    expect(outcome.ok).toBe(false);
    expect(page?.status).toBe(500);
    expect(await page?.text()).toContain('class="chip chip-danger"');
  });

  test("a re-login that fails at userinfo keeps the previous account intact", async () => {
    const store = memoryStore();
    await store.set("tokens", JSON.stringify({ accessToken: "tok-A" }));
    await store.set("user", JSON.stringify({ sub: "user_A" }));

    const { outcome } = await runLogin({ store, userinfoStatus: 503 });

    expect(outcome.ok).toBe(false);
    expect(await store.get("tokens")).toContain("tok-A");
    expect(await store.get("user")).toContain("user_A");
  });

  test("a re-login that cannot store the profile leaves no stale profile behind", async () => {
    const base = memoryStore();
    await base.set("tokens", JSON.stringify({ accessToken: "tok-A" }));
    await base.set("user", JSON.stringify({ sub: "user_A" }));
    const store: CredentialStore = {
      ...base,
      set: async (key, value) => {
        if (key === "user") throw new Error("keychain unavailable");
        await base.set(key, value);
      },
    };

    const { outcome } = await runLogin({ store });

    expect(outcome.ok).toBe(false);
    expect(await base.get("tokens")).toContain('"token"');
    expect(await base.get("user")).toBeNull();
  });

  test("shows a failure page when the credentials cannot be stored", async () => {
    const failing: CredentialStore = {
      get: async () => null,
      set: async () => {
        throw new Error("keychain unavailable");
      },
      delete: async () => {},
      // Never reached: the login fails at `set` before any refresh can ask
      // for a guarded write.
      replaceIfUnchanged: async () => {
        throw new Error("keychain unavailable");
      },
    };
    const { outcome, page } = await runLogin({ store: failing });

    expect(outcome.ok).toBe(false);
    expect(page?.status).toBe(500);
    expect(await page?.text()).toContain('class="chip chip-danger"');
  });

  test("fails without an unhandled rejection when the browser cannot open", async () => {
    process.on("unhandledRejection", onUnhandled);
    try {
      const { outcome, page } = await runLogin({ openBrowserThrows: true });
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: Error }).error.message).toContain(
        "Failed to open authorization URL",
      );
      // No callback was ever delivered, so there is no page to inspect.
      expect(page).toBeNull();
      // Let the rejection queue drain before asserting it stayed empty.
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

/**
 * An in-memory store whose map the test can seed and inspect mid-flight, so a
 * concurrent login can be placed at an exact point in a network round trip.
 */
function inspectableStore(seed: Record<string, string> = {}): {
  store: CredentialStore;
  values: Map<string, string>;
} {
  const values = new Map<string, string>(Object.entries(seed));
  const store: CredentialStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    replaceIfUnchanged: async (key, expected, value, guard) => {
      if ((values.get(key) ?? null) !== expected) return false;
      if (guard && (values.get(guard.key) ?? null) !== guard.expected)
        return false;
      values.set(key, value);
      return true;
    },
  };
  return { store, values };
}

describe("whoami profile write-back", () => {
  const userA = { sub: "user_A", email: "alice@example.test" };
  const userB = { sub: "user_B", email: "bob@example.test" };

  test("a profile fetched before a login lands is not cached over the new account", async () => {
    // The reviewer's P1. A's token is live, so `whoami` goes to the network
    // for A's profile. Inside that round trip B's login writes B's token
    // record and has not written B's profile yet (login deletes the old
    // profile first). Writing A's answer back unconditionally — or even
    // conditioned only on `user` being absent, which it is in that window —
    // would pair B's tokens with A's name, and every later command would
    // keep trusting the cached profile.
    const { store, values } = inspectableStore({
      tokens: JSON.stringify({
        accessToken: "tok-A",
        expiresAt: Date.now() + 3_600_000,
      }),
    });
    let userinfoCalls = 0;
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      const url = String(input);
      if (!url.startsWith(`${ISSUER}/oauth/userinfo`)) {
        return new Response("unexpected", { status: 500 });
      }
      userinfoCalls++;
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === "Bearer tok-A") {
        // B's login lands mid-flight: tokens first, profile later.
        values.set(
          "tokens",
          JSON.stringify({
            accessToken: "tok-B",
            expiresAt: Date.now() + 3_600_000,
          }),
        );
        return json(userA);
      }
      if (bearer === "Bearer tok-B") return json(userB);
      return new Response("wrong bearer", { status: 401 });
    }) as unknown as typeof fetch;

    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });

    // Answers as B — the account the store now describes — not A, whose
    // profile was the answer to a token the store has replaced.
    expect(await auth.whoami()).toEqual(userB);
    expect(userinfoCalls).toBe(2);
    // A's profile never reached the store; the pair belongs to B.
    expect(JSON.parse(values.get("user") as string)).toEqual(userB);
    expect(JSON.parse(values.get("tokens") as string).accessToken).toBe(
      "tok-B",
    );
  });
});

describe("a refresh that failed", () => {
  const expiredA = {
    accessToken: "tok-A",
    refreshToken: "r-A",
    expiresAt: Date.now() - 1_000,
  };
  const liveB = {
    accessToken: "tok-B",
    refreshToken: "r-B",
    expiresAt: Date.now() + 3_600_000,
  };

  function authOver(store: CredentialStore) {
    return new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
  }

  test("answers a login that landed inside the round trip instead of calling it expired", async () => {
    // The refresh is refused for A's dead credentials, but B's login landed
    // while the request was open. A used to report "your session expired"
    // about a session the store no longer holds — and refused to use B's.
    const { store, values } = inspectableStore({
      tokens: JSON.stringify(expiredA),
      user: JSON.stringify({ sub: "user_A" }),
    });
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      if (!String(input).startsWith(`${ISSUER}/oauth/token`)) {
        return new Response("unexpected", { status: 500 });
      }
      values.set("tokens", JSON.stringify(liveB));
      values.set("user", JSON.stringify({ sub: "user_B" }));
      return json({ error: "invalid_grant" }, 400);
    }) as unknown as typeof fetch;

    expect(await authOver(store).getAccessToken()).toBe("tok-B");
    expect(JSON.parse(values.get("tokens") as string).accessToken).toBe(
      "tok-B",
    );
  });

  test("keeps a temporary failure distinct from an expired session", async () => {
    // A 503 says nothing about the refresh token. Reporting it as expiry
    // sends the reader to `petdex login` over an outage, so it keeps its own
    // reason, and the record is not rewritten either way.
    const { store, values } = inspectableStore({
      tokens: JSON.stringify(expiredA),
    });
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      if (!String(input).startsWith(`${ISSUER}/oauth/token`)) {
        return new Response("unexpected", { status: 500 });
      }
      return json({ error: "unavailable" }, 503);
    }) as unknown as typeof fetch;

    const failure = await authOver(store)
      .getAccessToken()
      .then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string },
      );
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("refresh_failed");
    expect(failure?.message).toContain("could not be checked");
    // The provider's own words survive (the body says `unavailable`), so the
    // reader is not told to re-authenticate over an outage.
    expect(failure?.message).not.toMatch(/expired/i);
    expect(values.get("tokens")).toBe(JSON.stringify(expiredA));
  });

  test("answers signed out when a logout landed inside the round trip", async () => {
    // The record is gone, so there is no session to call expired and none to
    // answer with. The caller must hear "signed out", which is `null`.
    const { store, values } = inspectableStore({
      tokens: JSON.stringify(expiredA),
    });
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      if (!String(input).startsWith(`${ISSUER}/oauth/token`)) {
        return new Response("unexpected", { status: 500 });
      }
      values.delete("tokens");
      return json({ error: "invalid_grant" }, 400);
    }) as unknown as typeof fetch;

    expect(await authOver(store).getAccessToken()).toBeNull();
  });

  test("a verdict read that fails is not mistaken for a session that changed", async () => {
    // The provider refused the refresh, and the re-read that decides whether
    // anyone replaced the record fails too. "Unreadable" is not evidence of a
    // new session: treating it as one repeats the refused refresh until the
    // attempt cap returns the same dead bearer as a success. The failure must
    // surface, on the first refused refresh, with the session's expiry named.
    const values = new Map<string, string>([
      ["tokens", JSON.stringify(expiredA)],
    ]);
    let tokensGets = 0;
    const store: CredentialStore = {
      get: async (key) => {
        if (key === "tokens") {
          tokensGets++;
          // The loop's own read is fine; the verdict re-read is the failure.
          if (tokensGets === 2) throw new Error("transient store read failure");
        }
        return values.get(key) ?? null;
      },
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
      replaceIfUnchanged: async () => false,
    };
    let refreshRequests = 0;
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      if (!String(input).startsWith(`${ISSUER}/oauth/token`)) {
        return new Response("unexpected", { status: 500 });
      }
      refreshRequests++;
      return json({ error: "invalid_grant" }, 400);
    }) as unknown as typeof fetch;

    const outcome = await authOver(store)
      .getAccessToken()
      .then(
        (token) => ({ ok: true as const, token }),
        (error: { code?: string; message?: string }) => ({
          ok: false as const,
          error,
        }),
      );

    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("token_expired");
      expect(outcome.error.message).toContain("invalid_grant");
      // The verdict could not be read *because the store failed*, not
      // because the endpoint was unreachable. Without that sentence the
      // reader waits for the service instead of repairing the credentials.
      expect(outcome.error.message).toContain(
        "could not be read on this machine",
      );
      expect(outcome.error.message).toContain("transient store read failure");
    }
    // One refresh, one decision: the refused bearer is never returned and the
    // loop does not spend a second round trip on it.
    expect(refreshRequests).toBe(1);
    expect(values.get("tokens")).toBe(JSON.stringify(expiredA));
  });

  test("a temporary refresh failure with an unreadable store names the local read failure", async () => {
    // Same folding, the other code: the provider is merely unavailable, so
    // the reader is told to retry — and also that this machine could not
    // read its own copy, which is the half the generic text used to hide.
    const values = new Map<string, string>([
      ["tokens", JSON.stringify(expiredA)],
    ]);
    let tokensGets = 0;
    const store: CredentialStore = {
      get: async (key) => {
        if (key === "tokens") {
          tokensGets++;
          // Not an Error object: a keyring binding can reject with a plain
          // string, and the message must still carry it.
          if (tokensGets === 2) throw "keychain is locked";
        }
        return values.get(key) ?? null;
      },
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
      replaceIfUnchanged: async () => false,
    };
    let refreshRequests = 0;
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      if (!String(input).startsWith(`${ISSUER}/oauth/token`)) {
        return new Response("unexpected", { status: 500 });
      }
      refreshRequests++;
      return json({ error: "unavailable" }, 503);
    }) as unknown as typeof fetch;

    const failure = await authOver(store)
      .getAccessToken()
      .then(
        () => null,
        (error: { code?: string; message?: string }) => error,
      );
    expect(failure?.code).toBe("refresh_failed");
    expect(failure?.message).toContain("could not be checked");
    expect(failure?.message).toContain("keychain is locked");
    expect(refreshRequests).toBe(1);
    expect(values.get("tokens")).toBe(JSON.stringify(expiredA));
  });
});

describe("describeSavedSession", () => {
  function authOver(store: CredentialStore) {
    return new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
  }

  test("a usable credential with no cached profile names no account", async () => {
    // `login` can leave exactly this state; every command still works from
    // it, so the summary must say "usable" even though it cannot name anyone.
    const { store } = inspectableStore({
      tokens: JSON.stringify({
        accessToken: "tok",
        expiresAt: Date.now() + 60_000,
      }),
    });
    expect(await authOver(store).describeSavedSession()).toEqual({
      state: "usable",
      label: undefined,
    });
  });

  test("an expired credential beside a profile is expired, and names the profile", async () => {
    // The profile reads fine, but `getAccessToken()` is null: the two facts
    // the old single-read message conflated.
    const { store } = inspectableStore({
      tokens: JSON.stringify({
        accessToken: "tok",
        expiresAt: Date.now() - 60_000,
      }),
      user: JSON.stringify({ sub: "user_A", email: "alice@example.test" }),
    });
    expect(await authOver(store).describeSavedSession()).toEqual({
      state: "expired",
      label: "alice@example.test",
    });
  });

  test("an unparseable token record is damaged, not absent and not usable", async () => {
    // A record that is there but cannot be read is evidence something was
    // saved. Calling it `none` lets the login-failure copy say "nothing was
    // saved before this attempt either" — a claim about the past that the
    // store contradicts.
    const { store } = inspectableStore({
      tokens: "{not json",
      user: JSON.stringify({ sub: "user_A" }),
    });
    expect(await authOver(store).describeSavedSession()).toEqual({
      state: "damaged",
    });
  });

  test("an empty token value is damaged too", async () => {
    // Only an absent key may read as "no record": an empty string is a
    // stored value that cannot be parsed, and folding it into `null` would
    // make every credential read silently answer "signed out" over a record
    // that is there.
    const { store } = inspectableStore({ tokens: "" });
    expect(await authOver(store).describeSavedSession()).toEqual({
      state: "damaged",
    });

    const failure = await authOver(store)
      .getAccessToken()
      .then(
        () => null,
        (error: { code?: string; message?: string }) => error,
      );
    expect(failure?.code).toBe("storage");
    expect(failure?.message).toContain("parse stored tokens");
  });

  test("an unreadable store claims nothing", async () => {
    const store: CredentialStore = {
      get: async () => {
        throw new Error("keychain locked");
      },
      set: async () => {},
      delete: async () => {},
      replaceIfUnchanged: async () => false,
    };
    expect(await authOver(store).describeSavedSession()).toEqual({
      state: "unknown",
    });
  });
});

describe("legacy single-record session", () => {
  test("logout clears the legacy session key as well as the two records", async () => {
    // An earlier build stored the whole session under `session`. Nothing here
    // reads it, but leaving it means a build that does could sign the machine
    // back in after the user logged out.
    const store = memoryStore();
    await store.set("tokens", "tokens");
    await store.set("user", "user");
    await store.set("session", "legacy-access-and-refresh");
    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });

    await auth.logout();

    expect(await store.get("tokens")).toBeNull();
    expect(await store.get("user")).toBeNull();
    expect(await store.get("session")).toBeNull();
  });

  test("a successful login drops the legacy record best-effort", async () => {
    const store = memoryStore();
    await store.set("session", "legacy-access-and-refresh");
    const { outcome } = await runLogin({ store });

    expect(outcome.ok).toBe(true);
    expect(await store.get("session")).toBeNull();
  });
});

describe("failed-refresh classification", () => {
  test("an invalid_grant described in prose is still an expired session", async () => {
    // The provider may send `error: invalid_grant` *with* an
    // `error_description`, and the description is what reaches the message
    // (the prose is more useful to a reader). Classifying from the message
    // alone then misses the code and calls a dead session a temporary
    // outage — the reader is told to retry instead of signing in again.
    const { store } = inspectableStore({
      tokens: JSON.stringify({
        accessToken: "tok-A",
        refreshToken: "r-A",
        expiresAt: Date.now() - 1_000,
      }),
    });
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      if (!String(input).startsWith(`${ISSUER}/oauth/token`)) {
        return new Response("unexpected", { status: 500 });
      }
      return json(
        {
          error: "invalid_grant",
          error_description: "unknown refresh token",
        },
        400,
      );
    }) as unknown as typeof fetch;

    const failure = await new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    })
      .getAccessToken()
      .then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
    expect(failure?.code).toBe("token_expired");
  });
});

describe("a tokens record that is not a token set", () => {
  // `describeSavedSession` calls these bytes `damaged`, and `readCurrentSession`
  // rejects them. The primary read path must agree: handing `JSON.parse`'s
  // result on unchecked turned `"null"` into a bare TypeError (reported as
  // "Not signed in.") and `"false"`/`"[]"`/`"{}"` into a userinfo call with
  // `Bearer undefined`, which the CLI then described as "Signed in".
  const BAD_SHAPES: Array<[string, string]> = [
    ["null", "null"],
    ["false", "false"],
    ["zero", "0"],
    ["empty string", '""'],
    ["array", "[]"],
    ["empty object", "{}"],
    ["empty access token", '{"accessToken":""}'],
  ];

  for (const [name, raw] of BAD_SHAPES) {
    test(`is a storage failure, not a session (${name})`, async () => {
      const store = memoryStore();
      await store.set("tokens", raw);
      let userinfoCalls = 0;
      type FetchArgs = Parameters<typeof fetch>;
      globalThis.fetch = (async (input: FetchArgs[0]) => {
        if (String(input).includes("/oauth/userinfo")) userinfoCalls++;
        return json({ sub: "user_A" });
      }) as unknown as typeof fetch;

      const auth = new ClerkCliAuth({
        clientId: "client-id",
        issuer: ISSUER,
        storage: store,
      });

      const tokenFailure = await auth.getAccessToken().then(
        () => null,
        (error: { code?: string }) => error,
      );
      expect(tokenFailure?.code).toBe("storage");
      const whoamiFailure = await auth.whoami().then(
        () => null,
        (error: { code?: string }) => error,
      );
      expect(whoamiFailure?.code).toBe("storage");
      // No request ever carried the record to the provider.
      expect(userinfoCalls).toBe(0);
      expect(await auth.describeSavedSession()).toEqual({ state: "damaged" });
    });
  }

  test("a tokens slot that cannot be read is a read failure, not a sign-out", async () => {
    // Different failure, same reader: an unreadable store must say so, not
    // answer "no session" and let every command behave as if the user had
    // never signed in.
    const store: CredentialStore = {
      get: async () => {
        throw new Error("keychain is locked");
      },
      set: async () => {},
      delete: async () => {},
      replaceIfUnchanged: async () => false,
    };
    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
    const failure = await auth.getAccessToken().then(
      () => null,
      (error: { code?: string; message?: string }) => error,
    );
    expect(failure?.code).toBe("storage");
    expect(failure?.message).toContain("read tokens");
    expect(failure?.message).toContain("keychain is locked");
  });
});

describe("getTokenSet", () => {
  // The public accessor an embedder uses to read the whole pair rather than
  // just `getAccessToken`'s string. It used to answer with whatever JSON sat
  // in the slot, so these same records came back typed as a `TokenSet` and a
  // consumer built `Bearer undefined` from them — the defect every internal
  // reader has already stopped making. It must answer through the same shape
  // rule, and fail the same way, or the package's public API is the one place
  // that still lies about a damaged record.
  const BAD_SHAPES: Array<[string, string]> = [
    ["null", "null"],
    ["false", "false"],
    ["array", "[]"],
    ["empty object", "{}"],
    ["empty access token", '{"accessToken":""}'],
  ];

  function authOver(store: CredentialStore) {
    return new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
  }

  for (const [name, raw] of BAD_SHAPES) {
    test(`throws storage, not a token set, for a slot holding ${name}`, async () => {
      const store = memoryStore();
      await store.set("tokens", raw);
      const failure = await authOver(store)
        .getTokenSet()
        .then(
          () => null,
          (error: { code?: string; message?: string }) => error,
        );
      // A record that is present and unreadable is a storage failure. `null`
      // here would be the "signed out" claim this branch spent a whole round
      // removing, and returning the parsed value would be worse still.
      expect(failure?.code).toBe("storage");
      expect(failure?.message).toContain("parse stored tokens");
      expect(failure?.message).toContain(
        "the saved token record is not a token set",
      );
    });
  }

  test("answers the stored record when it is a token set", async () => {
    // The control: a valid record is returned as it was written, so the fix
    // did not turn a working read into an error.
    const tokens = {
      accessToken: "tok-A",
      refreshToken: "refresh-A",
      expiresAt: 1_900_000_000_000,
      scope: "profile",
    };
    const store = memoryStore();
    await store.set("tokens", JSON.stringify(tokens));
    expect(await authOver(store).getTokenSet()).toEqual(tokens);
  });

  test("answers null only when the key is absent", async () => {
    // "No record" is the one state that is not an error. It is told apart
    // from a damaged record by the store's own answer (`null`), never by a
    // parse that failed — the same rule `getAccessToken` applies.
    expect(await authOver(memoryStore()).getTokenSet()).toBeNull();
  });

  test("keeps the parse reason when the bytes are not JSON", async () => {
    // A torn record is a different failure from a wrong shape, and the
    // message must not swallow why: the reader's fix (a corrupted file)
    // differs from the one for bytes that parsed into the wrong thing.
    const raw = "{torn";
    const store = memoryStore();
    await store.set("tokens", raw);
    const parseReason = (() => {
      try {
        JSON.parse(raw);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(parseReason).not.toBe("");

    const failure = await authOver(store)
      .getTokenSet()
      .then(
        () => null,
        (error: { code?: string; message?: string }) => error,
      );
    expect(failure?.code).toBe("storage");
    expect(failure?.message).toContain("parse stored tokens");
    expect(failure?.message).toContain(parseReason);
    // And not the shape wording: these bytes never parsed, so no shape was
    // ever examined.
    expect(failure?.message).not.toContain(
      "the saved token record is not a token set",
    );
  });

  test("gives the same answer as getAccessToken on the same record", async () => {
    // One assertion over two readers: the package must not have a public
    // accessor that calls a record a token set while the credential path
    // calls it damaged. Both go through `getStoredTokens`, so both the
    // category and the message are the same.
    for (const [name, raw] of BAD_SHAPES) {
      const store = memoryStore();
      await store.set("tokens", raw);
      const auth = authOver(store);
      const read = (promise: Promise<unknown>) =>
        promise.then(
          () => null,
          (error: { code?: string; message?: string }) => error,
        );

      const tokenSetFailure = await read(auth.getTokenSet());
      const accessTokenFailure = await read(auth.getAccessToken());
      expect({
        name,
        tokenSet: tokenSetFailure?.code,
        accessToken: accessTokenFailure?.code,
      }).toEqual({ name, tokenSet: "storage", accessToken: "storage" });
      expect(tokenSetFailure?.message).toBe(accessTokenFailure?.message);
    }
  });
});

describe("a tokens record whose optional fields have the wrong type", () => {
  // Asked only about `accessToken`, the shape rule let these through, and the
  // readers then disagreed about the same bytes: `describeSavedSession` said
  // `usable` for a string `expiresAt` that `resolveSession` compared to a
  // number (so the session never looked live), and said `expired` for
  // `expiresAt: null`, which `??` folded into "never expires" — the opposite
  // verdict from the same record. A non-string `refreshToken` reached the
  // refresh request body verbatim, so the provider was asked about a
  // credential the CLI had invented. `mapTokenResponse` writes only a
  // `number` `expiresAt` and a `string` `refreshToken`, so these records did
  // not come from this build; the honest answer is `damaged`, and every
  // reader can give it without the network.
  const RECORDS: Array<[string, Record<string, unknown>]> = [
    ["a string expiresAt", { accessToken: "tok-A", expiresAt: "not-a-number" }],
    ["a null expiresAt", { accessToken: "tok-A", expiresAt: null }],
    [
      "an epoch rendered as a string",
      { accessToken: "tok-A", expiresAt: "1300000000000" },
    ],
    ["an object refreshToken", { accessToken: "tok-A", refreshToken: {} }],
    [
      "a numeric refreshToken",
      { accessToken: "tok-A", expiresAt: 1, refreshToken: 12345 },
    ],
  ];

  for (const [name, tokens] of RECORDS) {
    test(`is damaged to every reader (${name})`, async () => {
      const { store } = inspectableStore({
        tokens: JSON.stringify(tokens),
        user: JSON.stringify({ sub: "user_A" }),
      });
      let tokenCalls = 0;
      type FetchArgs = Parameters<typeof fetch>;
      globalThis.fetch = (async (input: FetchArgs[0]) => {
        if (String(input).includes("/oauth/token")) tokenCalls++;
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch;
      const auth = new ClerkCliAuth({
        clientId: "client-id",
        issuer: ISSUER,
        storage: store,
      });
      const read = (promise: Promise<unknown>) =>
        promise.then(
          () => null,
          (error: { code?: string; message?: string }) => error,
        );

      // Both token readers call it the same thing — a storage failure — and
      // the summary calls the same bytes `damaged`. No reader gets as far as
      // a refresh request with the wrong-typed field in its body.
      expect({
        name,
        accessToken: (await read(auth.getAccessToken()))?.code,
        tokenSet: (await read(auth.getTokenSet()))?.code,
        summary: await auth.describeSavedSession(),
        tokenCalls,
      }).toEqual({
        name,
        accessToken: "storage",
        tokenSet: "storage",
        summary: { state: "damaged" },
        tokenCalls: 0,
      });
    });
  }

  test("still reads a record whose optional fields have the right types", async () => {
    // The control: tightening the rule must not turn a token set this build
    // writes into an error.
    const tokens = {
      accessToken: "tok-A",
      refreshToken: "r-A",
      expiresAt: Date.now() + 3_600_000,
    };
    const { store } = inspectableStore({
      tokens: JSON.stringify(tokens),
      user: JSON.stringify({ sub: "user_A" }),
    });
    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
    expect(await auth.describeSavedSession()).toEqual({
      state: "usable",
      label: "user_A",
    });
    expect(await auth.getAccessToken()).toBe("tok-A");
    expect(await auth.getTokenSet()).toEqual(tokens);
  });
});

describe("whoami when the profile slot cannot be read", () => {
  test("reports the store failure instead of fetching a profile", async () => {
    // A slot that does not parse is not an error (it heals — see the damaged
    // profile tests); a store that cannot be read at all is. Folding it into
    // "no profile" would send whoami to the network and then write the answer
    // into a store it just failed to read.
    const values = new Map<string, string>([
      [
        "tokens",
        JSON.stringify({
          accessToken: "tok-A",
          expiresAt: Date.now() + 3_600_000,
        }),
      ],
    ]);
    const store: CredentialStore = {
      get: async (key) => {
        if (key === "user") throw new Error("keychain is locked");
        return values.get(key) ?? null;
      },
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
      replaceIfUnchanged: async () => false,
    };
    let userinfoCalls = 0;
    globalThis.fetch = (async () => {
      userinfoCalls++;
      return json({ sub: "user_A" });
    }) as unknown as typeof fetch;

    const auth = new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });

    const failure = await auth.whoami().then(
      () => null,
      (error: { code?: string; message?: string }) => error,
    );
    expect(failure?.code).toBe("storage");
    expect(failure?.message).toContain("read user");
    expect(userinfoCalls).toBe(0);
    expect(values.has("user")).toBe(false);
  });
});

describe("whoami over a damaged profile slot", () => {
  // The guarded profile write has to name the slot's current bytes as its
  // expectation. A slot holding `null`, `false`, `0`, `""`, empty bytes or
  // non-JSON is not a profile, but it is what the store holds: expecting
  // absence there refuses every write, and the command answers "Not signed
  // in" forever while the token works. A real file store, because the
  // compare-and-swap that refuses is the store's.
  const CASES: Array<[string, string]> = [
    ["null", "null"],
    ["false", "false"],
    ["zero", "0"],
    ["empty string", '""'],
    ["empty bytes", ""],
    ["not json", "{torn"],
  ];

  for (const [name, raw] of CASES) {
    test(`heals a ${name} user record instead of refusing every write`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "petdex-profile-slot-"));
      try {
        const filePath = join(directory, "credentials.json");
        await writeFile(
          filePath,
          JSON.stringify({
            tokens: JSON.stringify({
              accessToken: "tok-A",
              refreshToken: "r-A",
              expiresAt: Date.now() + 3_600_000,
            }),
            user: raw,
          }),
        );
        const storage = createCredentialStore("file", {
          filePath,
          lockPath: `${filePath}.lock`,
        });

        let userinfoCalls = 0;
        type FetchArgs = Parameters<typeof fetch>;
        globalThis.fetch = (async (input: FetchArgs[0]) => {
          const url = String(input);
          if (!url.startsWith(`${ISSUER}/oauth/userinfo`)) {
            return new Response("unexpected", { status: 500 });
          }
          userinfoCalls++;
          return json({ sub: "user_A", email: "a@example.test" });
        }) as unknown as typeof fetch;

        const auth = new ClerkCliAuth({
          clientId: "client-id",
          issuer: ISSUER,
          storage,
        });

        // A live token plus a successful userinfo answer names the account on
        // the first pass, whatever the damaged slot holds.
        expect(await auth.whoami()).toEqual({
          sub: "user_A",
          email: "a@example.test",
        });
        expect(userinfoCalls).toBe(1);
        const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<
          string,
          string
        >;
        expect(JSON.parse(stored.user)).toMatchObject({ sub: "user_A" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

describe("a user slot that is valid JSON but not a profile", () => {
  // `parseStoredProfile` used to answer anything `typeof` called an object, so
  // an array or a plain object in the `user` slot read as a cached profile:
  // `whoami` skipped the userinfo call that would have healed the slot and
  // answered with the parsed bytes, which `petdex whoami` printed as the
  // account (an empty block for `{}` and `[]`, `{"sub":123}` verbatim).
  // `tokens` has had a shape rule since the damaged-record work; this is the
  // same rule for the other record of the pair, shared by every reader.
  const userA = { sub: "user_A", email: "alice@example.test" };
  const liveTokens = JSON.stringify({
    accessToken: "tok-A",
    refreshToken: "r-A",
    expiresAt: Date.now() + 3_600_000,
  });

  /**
   * Values `typeof` calls objects and a reader must not call profiles.
   *
   * The last one carries a string a lax reader would happily name:
   * `accountLabel` falls back to `username`, so a `describeSavedSession` (and
   * the callback page built from it) that only checked `typeof` would show
   * `ghost@example.test` as the account in effect while `whoami` refuses to
   * act as it.
   */
  const NOT_PROFILES: Array<[string, string]> = [
    ["empty object", "{}"],
    ["array", "[]"],
    ["object without sub", '{"error":"nope"}'],
    ["sub is not a string", '{"sub":123}'],
    ["empty sub", '{"sub":""}'],
    [
      "non-string sub beside a username",
      '{"sub":123,"username":"ghost@example.test"}',
    ],
  ];

  function authOver(store: CredentialStore) {
    return new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
  }

  /** A userinfo endpoint that counts calls and answers as `userA`. */
  function stubUserinfo(): () => number {
    let userinfoCalls = 0;
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      const url = String(input);
      if (!url.startsWith(`${ISSUER}/oauth/userinfo`)) {
        return new Response("unexpected", { status: 500 });
      }
      userinfoCalls++;
      return json(userA);
    }) as unknown as typeof fetch;
    return () => userinfoCalls;
  }

  for (const [name, raw] of NOT_PROFILES) {
    test(`heals a ${name} user record instead of reporting it`, async () => {
      // The credential is live, so the first pass reaches the profile read.
      // A slot that is not a profile must send the call to the network and
      // write the answer over the bytes — not answer with them.
      const { store, values } = inspectableStore({
        tokens: liveTokens,
        user: raw,
      });
      const userinfoCalls = stubUserinfo();

      expect(await authOver(store).whoami()).toEqual(userA);
      expect(userinfoCalls()).toBe(1);
      // The guarded write healed the slot: the next command reads a profile.
      expect(JSON.parse(values.get("user") as string)).toEqual(userA);
    });
  }

  test("uses a profile that passes the shape rule without a network call", async () => {
    // The control for the tests above: a real profile is cached, so `whoami`
    // answers from the store and never reaches userinfo.
    const { store } = inspectableStore({
      tokens: liveTokens,
      user: JSON.stringify(userA),
    });
    const userinfoCalls = stubUserinfo();

    expect(await authOver(store).whoami()).toEqual(userA);
    expect(userinfoCalls()).toBe(0);
  });

  test("every reader gives a non-profile slot the same answer", async () => {
    // `whoami`, `getCachedUser` and `describeSavedSession` see the same bytes
    // and must agree about them. A split here is the bug shape the last round
    // fixed on the token side: one reader trusting a value another refuses
    // leaves the CLI naming an account the command will not act as.
    for (const [name, raw] of NOT_PROFILES) {
      const { store } = inspectableStore({
        tokens: liveTokens,
        user: raw,
      });
      const auth = authOver(store);
      // Read before `whoami` heals the slot, so all three describe the same
      // record rather than two readers and a repaired copy.
      expect({
        reader: "getCachedUser",
        name,
        value: await auth.getCachedUser(),
      }).toEqual({ reader: "getCachedUser", name, value: null });
      expect({
        reader: "describeSavedSession",
        name,
        value: await auth.describeSavedSession(),
      }).toEqual({
        reader: "describeSavedSession",
        name,
        value: { state: "usable", label: undefined },
      });
      const userinfoCalls = stubUserinfo();
      expect({ reader: "whoami", name, value: await auth.whoami() }).toEqual({
        reader: "whoami",
        name,
        value: userA,
      });
      expect(userinfoCalls()).toBe(1);
    }
  });

  test("every reader gives a profile slot the same account", async () => {
    // The control: with a real profile stored, the three readers agree the
    // other way — the account is named and no network call is made.
    const { store } = inspectableStore({
      tokens: liveTokens,
      user: JSON.stringify(userA),
    });
    const auth = authOver(store);
    const userinfoCalls = stubUserinfo();

    expect(await auth.getCachedUser()).toEqual(userA);
    expect(await auth.describeSavedSession()).toEqual({
      state: "usable",
      label: "alice@example.test",
    });
    expect(await auth.whoami()).toEqual(userA);
    expect(userinfoCalls()).toBe(0);
  });

  test("getCachedUser answers null for an absent, unreadable or torn slot", async () => {
    // The documented contract: "never throws — a store it cannot read is
    // reported as no profile". `describeSavedSession` keeps the label
    // optional for the same reason, so a locked keychain does not turn a
    // readable token record into `unknown`.
    expect(await authOver(inspectableStore().store).getCachedUser()).toBeNull();
    expect(
      await authOver(inspectableStore({ user: "{torn" }).store).getCachedUser(),
    ).toBeNull();

    const locked: CredentialStore = {
      get: async () => {
        throw new Error("keychain locked");
      },
      set: async () => {},
      delete: async () => {},
      replaceIfUnchanged: async () => false,
    };
    expect(await authOver(locked).getCachedUser()).toBeNull();
    expect(await authOver(locked).describeSavedSession()).toEqual({
      state: "unknown",
    });
  });

  test("an unreadable user slot leaves the summary's state standing", async () => {
    // The label is the optional half of `describeSavedSession`. A store that
    // reads `tokens` fine and fails on `user` still describes a usable
    // credential — the opposite (turning the whole answer into `unknown`)
    // would hide a working session behind a profile-read failure, and the
    // session is the part the reader can act on.
    const values = new Map<string, string>([["tokens", liveTokens]]);
    const store: CredentialStore = {
      get: async (key) => {
        if (key === "user") throw new Error("keychain locked");
        return values.get(key) ?? null;
      },
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
      replaceIfUnchanged: async () => false,
    };
    const auth = authOver(store);

    expect(await auth.describeSavedSession()).toEqual({
      state: "usable",
      label: undefined,
    });
    expect(await auth.getCachedUser()).toBeNull();
  });
});

describe("a profile carrying a non-string email claim", () => {
  // `fetchUserInfo` accepts any answer with a non-empty string `sub` and never
  // inspects `email`; it is the only writer of the `user` slot, because both
  // `login` and `whoami`'s write-back store its return value. Every record
  // below is therefore a profile this build writes, and `parseStoredProfile`
  // has to read it back. A stricter rule (email, when present, a string) made
  // the slot never act as a cache: each `whoami` paid a userinfo round trip
  // and rewrote the same bytes, `whoami` could not answer at all with the
  // endpoint down, and `describeSavedSession` lost the account name.
  const liveTokens = JSON.stringify({
    accessToken: "tok-A",
    refreshToken: "r-A",
    expiresAt: Date.now() + 3_600_000,
  });

  /**
   * Every `email` claim `fetchUserInfo` will accept and write back. The
   * expected profile is the bytes themselves (`JSON.parse`), because that is
   * exactly what a reader must answer with — including claims `UserInfo`'s
   * TypeScript type does not admit (`email: null`), which is the point.
   */
  const EMAILS: Array<[string, string]> = [
    ["null", '{"sub":"user_A","email":null}'],
    ["an array", '{"sub":"user_A","email":[]}'],
    ["a number", '{"sub":"user_A","email":123}'],
    ["missing", '{"sub":"user_A"}'],
    ["an empty string", '{"sub":"user_A","email":""}'],
  ];

  function authOver(store: CredentialStore) {
    return new ClerkCliAuth({
      clientId: "client-id",
      issuer: ISSUER,
      storage: store,
    });
  }

  /** A userinfo endpoint that counts calls and answers as `userA`. */
  function stubUserinfo(userA: Record<string, unknown> = { sub: "user_A" }) {
    let userinfoCalls = 0;
    type FetchArgs = Parameters<typeof fetch>;
    globalThis.fetch = (async (input: FetchArgs[0]) => {
      if (!String(input).startsWith(`${ISSUER}/oauth/userinfo`)) {
        return new Response("unexpected", { status: 500 });
      }
      userinfoCalls++;
      return json(userA);
    }) as unknown as typeof fetch;
    return () => userinfoCalls;
  }

  for (const [name, raw] of EMAILS) {
    test(`is a cache hit named by its subject when email is ${name}`, async () => {
      const { store } = inspectableStore({ tokens: liveTokens, user: raw });
      const userinfoCalls = stubUserinfo();
      const auth = authOver(store);
      const profile = JSON.parse(raw);

      expect(await auth.getCachedUser()).toEqual(profile);
      expect(await auth.describeSavedSession()).toEqual({
        state: "usable",
        label: "user_A",
      });
      expect(await auth.whoami()).toEqual(profile);
      // The whole point: the profile is in the store, so nothing goes to the
      // network and the slot is not rewritten.
      expect(userinfoCalls()).toBe(0);
    });
  }

  test("every reader gives the same answer for every email claim", async () => {
    // One assertion over three readers: `whoami`, `getCachedUser` and the
    // summary's label must not disagree about a record that is in the store.
    // A split here is how the CLI names an account (or refuses to) on bytes
    // it wrote itself.
    for (const [name, raw] of EMAILS) {
      const { store, values } = inspectableStore({
        tokens: liveTokens,
        user: raw,
      });
      const auth = authOver(store);
      const profile = JSON.parse(raw);
      expect({
        name,
        cached: await auth.getCachedUser(),
        summary: await auth.describeSavedSession(),
        whoami: await auth.whoami(),
        slot: values.get("user"),
      }).toEqual({
        name,
        cached: profile,
        summary: { state: "usable", label: "user_A" },
        whoami: profile,
        slot: raw,
      });
    }
  });

  test("a profile the producer just wrote is a steady-state hit", async () => {
    // The end the two rules have to meet: take bytes from the *real*
    // `fetchUserInfo`, put them in the store, and ask again. The producer's
    // answer has no email claim it would keep, so this uses the case the old
    // rule rejected — `email: null` — served live on both passes.
    const { fetchUserInfo } = await import("./lib/token-exchange");
    const body = { sub: "user_A", email: null };
    stubUserinfo(body);
    const produced = await fetchUserInfo({
      issuer: ISSUER,
      accessToken: "tok-A",
    });
    const written = JSON.stringify(produced);
    expect(written).toBe('{"sub":"user_A","email":null}');

    const { store, values } = inspectableStore({
      tokens: liveTokens,
      user: written,
    });
    const userinfoCalls = stubUserinfo(body);
    const auth = authOver(store);

    const expected = JSON.parse(written);
    expect(await auth.getCachedUser()).toEqual(expected);
    expect(await auth.whoami()).toEqual(expected);
    expect(await auth.whoami()).toEqual(expected);
    // Two commands on a profile that is already stored: no round trip, and
    // the same bytes in the slot (no write-back of an identical value).
    expect(userinfoCalls()).toBe(0);
    expect(values.get("user")).toBe(written);
  });

  test("answers the cached profile with the userinfo endpoint unreachable", async () => {
    // The failure the strict rule turned into a lie: the profile is on disk,
    // so `whoami` must answer it rather than report that the profile it is
    // holding "couldn't be loaded" and send the user to `petdex login` (which
    // would only write the same shape again).
    const raw = '{"sub":"user_A","email":null}';
    const { store } = inspectableStore({ tokens: liveTokens, user: raw });
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const auth = authOver(store);

    const expected = JSON.parse(raw);
    expect(await auth.whoami()).toEqual(expected);
    expect(await auth.getCachedUser()).toEqual(expected);
  });

  test("does not name a non-string email as the account", async () => {
    // `accountLabel` takes the first value whose `typeof` is `"string"`, which
    // is what makes dropping the shape rule safe: `email: 123` cannot reach a
    // message. With a username beside it, the label is the username — proof
    // the number was skipped rather than stringified.
    const { store } = inspectableStore({
      tokens: liveTokens,
      user: '{"sub":"user_A","email":123,"username":"alice"}',
    });
    expect(await authOver(store).describeSavedSession()).toEqual({
      state: "usable",
      label: "alice",
    });
  });
});

describe("the callback page a failed login leaves behind", () => {
  const userA = { sub: "user_A", email: "alice@example.test" };

  /** The body copy the browser would show, per locale. */
  function pageBodies(html: string): Record<"en" | "es" | "zh", string> {
    const payload =
      /<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/.exec(
        html,
      )?.[1];
    const strings = (
      JSON.parse(payload ?? "{}") as {
        strings?: Record<string, { body: string }>;
      }
    ).strings;
    return {
      en: strings?.en?.body ?? "",
      es: strings?.es?.body ?? "",
      zh: strings?.zh?.body ?? "",
    };
  }

  test("does not call an orphan profile 'still in use'", async () => {
    // `logout` deletes `tokens` and `user` independently, so a half-cleared
    // store can hold a profile with no credential beside it. No command can
    // act as that account, and the page must not tell the reader it is in
    // use — in any of the three languages it ships.
    const store = memoryStore();
    await store.set("user", JSON.stringify(userA));

    const { outcome, page } = await runLogin({ store, userinfoStatus: 503 });
    expect(outcome.ok).toBe(false);
    const html = (await page?.text()) ?? "";

    expect(await store.get("tokens")).toBeNull();
    expect(html).not.toContain("still saved and still in use");
    expect(html).not.toContain("sigue guardado y sigue en uso");
    expect(html).not.toContain("仍然保存并继续有效");
    const bodies = pageBodies(html);
    for (const body of Object.values(bodies)) {
      expect(body).not.toContain("a***@example.test");
    }
    // With no account to name, all three locales fall back to the neutral
    // copy rather than inventing one.
    const strings = callbackStringsByLocale();
    expect(bodies.en).toBe(strings.en.reason.userinfo_failed);
    expect(bodies.es).toBe(strings.es.reason.userinfo_failed);
    expect(bodies.zh).toBe(strings.zh.reason.userinfo_failed);
  });

  test("still names the account a failed re-login left in use", async () => {
    // The control for the test above: when the store does pair a name with a
    // usable credential, the page names it — masked — in every locale.
    const store = memoryStore();
    await store.set(
      "tokens",
      JSON.stringify({
        accessToken: "tok-A",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    await store.set("user", JSON.stringify(userA));

    const { outcome, page } = await runLogin({ store, userinfoStatus: 503 });
    expect(outcome.ok).toBe(false);
    const bodies = pageBodies((await page?.text()) ?? "");

    expect(bodies.en).toContain(
      "Your previous sign-in (a***@example.test) is still saved and still in use.",
    );
    expect(bodies.es).toContain(
      "Tu acceso anterior (a***@example.test) sigue guardado y sigue en uso.",
    );
    expect(bodies.zh).toContain(
      "此前的登录（a***@example.test）仍然保存并继续有效。",
    );
  });

  test("names an expired previous session as saved, not as in use", async () => {
    // A saved record with no refresh token and a past expiry is an account
    // name and nothing else: `getAccessToken()` answers null. "Still in use"
    // would be the same false claim as above, one state over.
    const store = memoryStore();
    await store.set(
      "tokens",
      JSON.stringify({ accessToken: "tok-A", expiresAt: Date.now() - 60_000 }),
    );
    await store.set("user", JSON.stringify(userA));

    const { outcome, page } = await runLogin({ store, userinfoStatus: 503 });
    expect(outcome.ok).toBe(false);
    const html = (await page?.text()) ?? "";
    const bodies = pageBodies(html);

    expect(bodies.en).toContain("a***@example.test");
    expect(bodies.en).toContain("has expired");
    expect(bodies.es).toContain("ha caducado");
    expect(bodies.zh).toContain("已过期");
    expect(html).not.toContain("still saved and still in use");
    expect(html).not.toContain("sigue guardado y sigue en uso");
    expect(html).not.toContain("仍然保存并继续有效");
  });

  test("does not name a non-profile user object as the previous account", async () => {
    // The page's label comes from `describeSavedSession`, so a `user` slot
    // that is an object but not a profile used to reach the copy as a name.
    // This value is exactly that: `sub` is not a string, so no command can
    // act as it and `whoami` refuses it — but `accountLabel` would happily
    // fall back to `username` and the page would print the masked handle of
    // an account the CLI does not have.
    const store = memoryStore();
    await store.set(
      "tokens",
      JSON.stringify({
        accessToken: "tok-A",
        refreshToken: "r-A",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    await store.set("user", '{"sub":123,"username":"ghost@example.test"}');

    const { outcome, page } = await runLogin({ store, userinfoStatus: 503 });
    expect(outcome.ok).toBe(false);
    const html = (await page?.text()) ?? "";
    const bodies = pageBodies(html);

    expect(html).not.toContain("ghost@example.test");
    expect(html).not.toContain("g***@example.test");
    expect(html).not.toContain("still saved and still in use");
    // With no account to name, all three locales fall back to the neutral
    // copy rather than inventing one — the same answer as the orphan-profile
    // case above, for the same reason.
    const strings = callbackStringsByLocale();
    expect(bodies.en).toBe(strings.en.reason.userinfo_failed);
    expect(bodies.es).toBe(strings.es.reason.userinfo_failed);
    expect(bodies.zh).toBe(strings.zh.reason.userinfo_failed);
  });
});

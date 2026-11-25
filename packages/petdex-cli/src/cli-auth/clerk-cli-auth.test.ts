import { afterEach, describe, expect, test } from "bun:test";

import { ClerkCliAuth } from "./clerk-cli-auth";
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

  test("an unparseable token record is no credential, not a usable one", async () => {
    const { store } = inspectableStore({
      tokens: "{not json",
      user: JSON.stringify({ sub: "user_A" }),
    });
    expect(await authOver(store).describeSavedSession()).toEqual({
      state: "none",
    });
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

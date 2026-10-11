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

  test("shows a failure page when the credentials cannot be stored", async () => {
    const failing: CredentialStore = {
      get: async () => null,
      set: async () => {
        throw new Error("keychain unavailable");
      },
      delete: async () => {},
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

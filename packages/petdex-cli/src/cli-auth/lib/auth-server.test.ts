import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";

import { ClerkCliAuthError } from "../types";
import { type AuthServerHandle, startAuthServer } from "./auth-server";

const STATE = "expected-state";

let handle: AuthServerHandle | undefined;
const aborters: AbortController[] = [];

afterEach(() => {
  // A held response leaves a connection that is still waiting to be answered,
  // and `server.close()` deliberately keeps those alive. Not aborting here
  // would leave the test process unable to exit.
  for (const controller of aborters.splice(0)) controller.abort();
  handle?.close();
  handle = undefined;
});

async function start(
  overrides: Partial<Parameters<typeof startAuthServer>[0]> = {},
): Promise<AuthServerHandle> {
  handle = await startAuthServer({
    expectedState: STATE,
    port: 0,
    timeoutMs: 150,
    ...overrides,
  });
  return handle;
}

function callbackUrl(
  handle: AuthServerHandle,
  query: Record<string, string> = {},
): string {
  const url = new URL(handle.redirectUri);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A request whose promise is kept, so the test can inspect it before it settles. */
function beginFetch(url: string) {
  const controller = new AbortController();
  aborters.push(controller);
  // A rejected request is normal here (the reader closing the tab), so the
  // outcome is a result rather than a throw. Tests that need the response
  // check the status first.
  const response: Promise<Response | null> = fetch(url).then(
    (res) => res,
    () => null,
  );
  return { controller, response };
}

/** Status of a finished request, failing the test if it never arrived. */
async function statusOf(page: Promise<Response | null>): Promise<number> {
  const res = await page;
  expect(res).not.toBeNull();
  return (res as Response).status;
}

/** True while `promise` has not settled. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return (
    (await Promise.race([promise, Bun.sleep(20).then(() => marker)])) === marker
  );
}

/** Send a raw request line, bypassing fetch's normalisation of the target. */
function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = "";
    socket.on("data", (chunk) => (buf += chunk));
    socket.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
    socket.on("error", (error) => resolve(`error: ${error.message}`));
    setTimeout(() => {
      socket.destroy();
      resolve(buf.split("\r\n")[0] ?? "timeout");
    }, 800);
  });
}

describe("auth server malformed request targets", () => {
  test("answers an unparseable request target instead of throwing", async () => {
    // `new URL()` rejects some valid request lines — `GET //` is the cheapest
    // to send. An uncaught throw here kills the CLI mid-login, because this
    // handler is the only thing running.
    // A generous deadline on purpose. This case makes four raw round-trips
    // before the real callback, and the default 150ms is a budget for the
    // reader's browsing, not for the test's own traffic — on a loaded machine
    // the first-phase clock would expire mid-test and the failure would look
    // like a broken server rather than a slow one.
    const server = await start({ timeoutMs: 5_000 });
    const targets = ["//", "///", "http://[", "http://:80/"];

    for (const target of targets) {
      const status = await rawRequest(server.port, target);
      expect(status).toContain("404");
    }

    // The server survived all of them and still serves the callback.
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(response)).toBe(200);
  });
});

describe("auth server deferred response", () => {
  test("holds the page until respond is called, then answers with the success page", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );

    expect(await server.waitForCallback()).toEqual({
      code: "abc",
      state: STATE,
    });
    expect(await stillPending(response)).toBe(true);

    expect(server.respond({ kind: "success" })).toBe(true);

    const res = await response;
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(await res?.text()).toContain('href="https://petdex.dev/my-pets"');
  });

  test("answers with a failure page when the server is closed without a respond", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    expect(await stillPending(response)).toBe(true);

    server.close();

    const res = await response;
    expect(res?.status).toBe(500);
    expect(await res?.text()).toContain('class="chip chip-danger"');
  });

  test("reports false when the reader closed the tab first", async () => {
    const server = await start();
    const { controller, response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();

    controller.abort();
    await response;
    // The socket teardown is asynchronous, so wait for the connection to
    // actually go away rather than guessing at a delay. `respond` reporting
    // false is what tells us the held response was dropped.
    expect(server.respond({ kind: "success" })).toBe(false);
  });

  test("sends the page-security headers on the answer", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    server.respond({ kind: "success" });

    const res = await response;
    // `font-src data:` is the only allowance beyond the inline style and
    // script: the page carries the site's two faces inline, and the listener
    // is already closed by the time it renders, so it cannot fetch them.
    expect(res?.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:",
    );
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(res?.headers.get("x-frame-options")).toBe("DENY");
  });

  test("sends the same headers on a plain-text reply", async () => {
    // The protections belong to the listener, not to whichever branch
    // answered. A 404 that skipped them would be a gap on the same origin.
    const server = await start();
    const res = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("is idempotent across two respond calls", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(server.respond({ kind: "error", reason: "timeout" })).toBe(false);
    const page = await response;
    expect(await page?.text()).toContain('class="chip chip-success"');
  });

  test("reports false when responding after close", async () => {
    const server = await start();
    server.close();
    expect(server.respond({ kind: "success" })).toBe(false);
  });

  test("survives being closed twice", async () => {
    const server = await start();
    expect(() => {
      server.close();
      server.close();
    }).not.toThrow();
  });
});

describe("auth server rejected callbacks", () => {
  test("answers a declined authorization with the injected error page", async () => {
    const server = await start({ errorHtml: "<p>custom failure</p>" });
    const pending = server.waitForCallback().catch((error: Error) => error);

    const res = await fetch(
      callbackUrl(server, {
        error: "access_denied",
        error_description: "user said no",
        state: STATE,
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("<p>custom failure</p>");
    const error = (await pending) as ClerkCliAuthError;
    expect(error.code).toBe("token_exchange");
  });

  test("answers a mismatched state without settling the login", async () => {
    // The mismatch is reported to the caller that made it, and to nobody
    // else. Letting it reject the login would hand every web page the reader
    // has open a way to cancel a sign-in by asking for a refusal.
    const server = await start();
    const pending = server.waitForCallback().catch((error: Error) => error);

    const res = await fetch(
      callbackUrl(server, { code: "abc", state: "someone-else" }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("state");
    expect(((await pending) as ClerkCliAuthError).code).toBe("timeout");
  });

  test("rejects a callback with no code", async () => {
    const server = await start();
    const pending = server.waitForCallback().catch((error: Error) => error);

    const res = await fetch(callbackUrl(server, { state: STATE }));

    expect(res.status).toBe(400);
    expect(((await pending) as ClerkCliAuthError).code).toBe("token_exchange");
  });
});

describe("auth server while a response is held", () => {
  test("hands over to a second valid callback and ends the first", async () => {
    const server = await start();
    const first = beginFetch(
      callbackUrl(server, { code: "one", state: STATE }),
    );
    expect(await server.waitForCallback()).toEqual({
      code: "one",
      state: STATE,
    });

    const second = beginFetch(
      callbackUrl(server, { code: "two", state: STATE }),
    );
    // The superseded response is answered so its connection stops waiting.
    expect(await statusOf(first.response)).toBe(409);

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(second.response)).toBe(200);
  });

  test("answers a bogus callback without disturbing the held one", async () => {
    const server = await start();
    const held = beginFetch(callbackUrl(server, { code: "abc", state: STATE }));
    await server.waitForCallback();

    const bogus = await fetch(
      callbackUrl(server, { code: "x", state: "not-the-state" }),
    );
    expect(bogus.status).toBe(400);

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(held.response)).toBe(200);
  });

  test("lets a forged callback answer only itself, not the login", async () => {
    // A page the reader has open, or anything else on the machine, can reach
    // loopback without being able to read the response. If a request that
    // cannot prove it carries the expected state were allowed to settle the
    // callback, any of them could cancel a sign-in it knows nothing about by
    // asking for a refusal. Each of these must get its own 400 and leave the
    // login exactly as it was.
    const forgeries: Record<string, string>[] = [
      { error: "access_denied", state: "not-the-state" },
      { code: "x", state: "not-the-state" },
      { state: "not-the-state" },
      { error: "access_denied" },
      {},
    ];

    for (const query of forgeries) {
      // A deadline well past this iteration, so the assertions below are about
      // what the forgery did and not about how fast the machine is.
      const server = await start({ timeoutMs: 5_000 });
      let outcome: unknown;
      const pending = server.waitForCallback().then(
        (value) => (outcome = value),
        (error: Error) => (outcome = error),
      );

      const res = await fetch(callbackUrl(server, query));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("state");

      // Still undecided: the forgery neither settled the promise nor spent
      // the response.
      expect(await stillPending(pending)).toBe(true);
      expect(outcome).toBeUndefined();

      // Proof the held response was left alone: a real callback that arrives
      // afterwards is still served.
      const real = beginFetch(
        callbackUrl(server, { code: "abc", state: STATE }),
      );
      expect(await server.waitForCallback()).toEqual({
        code: "abc",
        state: STATE,
      });
      expect(server.respond({ kind: "success" })).toBe(true);
      expect(await statusOf(real.response)).toBe(200);
    }
  });

  test("answers a forged callback while a real one is held", async () => {
    const server = await start();
    const held = beginFetch(callbackUrl(server, { code: "abc", state: STATE }));
    await server.waitForCallback();

    const forged = await fetch(
      callbackUrl(server, { error: "access_denied", state: "not-the-state" }),
    );
    expect(forged.status).toBe(400);

    // The refusal is the forgery's alone; the held page is untouched.
    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(held.response)).toBe(200);
  });

  test("still serves an ordinary 404 for a favicon while holding", async () => {
    const server = await start();
    const held = beginFetch(callbackUrl(server, { code: "abc", state: STATE }));
    await server.waitForCallback();

    const favicon = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
    expect(favicon.status).toBe(404);

    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(held.response)).toBe(200);
  });
});

describe("auth server after the login is answered", () => {
  test("answers a callback that arrives on an already-open connection", async () => {
    // A connection the server accepted before the listener closed can have its
    // request parsed after `respond()` has run. Holding it would leave a socket
    // that nothing can ever answer — `sendOutcome` returns early once
    // `responseSent` is set — so the tab would spin until the process exits.
    //
    // The request is sent in two pieces. A bare `connect()` is not enough: the
    // TCP handshake can finish with the server never having accepted the
    // socket (it sits in the listen backlog), and closing the listener then
    // resets it — measured on Linux as an ECONNRESET with no bytes read. The
    // first piece reaches the server through an accepted connection, which is
    // the state the guarantee is about, and leaves the request incomplete so
    // the handler does not run until the second piece goes out after
    // `respond()`.
    const server = await start();
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write(
      `GET /callback?code=two&state=${STATE} HTTP/1.1\r\nHost: 127.0.0.1\r\n`,
    );
    await Bun.sleep(50);

    const first = beginFetch(
      callbackUrl(server, { code: "one", state: STATE }),
    );
    await server.waitForCallback();
    expect(server.respond({ kind: "success" })).toBe(true);
    expect(await statusOf(first.response)).toBe(200);

    const reply = await new Promise<string>((resolve) => {
      let buf = "";
      socket.on("data", (chunk) => (buf += chunk));
      socket.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
      socket.on("error", () => resolve("error"));
      socket.write("Connection: close\r\n\r\n");
      setTimeout(() => {
        socket.destroy();
        resolve("no response");
      }, 1500);
    });

    expect(reply).toContain("409");
  });
});

describe("auth server timeouts", () => {
  test("rejects when no callback arrives in time", async () => {
    const server = await start({ timeoutMs: 120 });
    const error = (await server
      .waitForCallback()
      .catch((err: Error) => err)) as ClerkCliAuthError;
    expect(error.code).toBe("timeout");
  });

  test("answers the held page when the exchange window expires", async () => {
    const server = await start({ timeoutMs: 120 });
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();

    const res = await response;
    expect(res?.status).toBe(500);
    expect(await res?.text()).toContain('class="chip chip-danger"');
  });

  test("still serves the timeout page to a callback that arrives late", async () => {
    // Pins the module's contract, not a user-visible outcome: the deadline
    // leaves the listener up so an in-flight request is answered rather than
    // refused. In the real flow `login()` answers and closes within a tick of
    // the rejection, so a reader who only arrives after the timeout gets the
    // browser's own error page — keeping the process alive for them would
    // mean outliving the failure that just ended the login.
    const server = await start({ timeoutMs: 120 });
    await server.waitForCallback().catch(() => {});

    const res = await fetch(
      callbackUrl(server, { code: "late", state: STATE }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('class="chip chip-danger"');
  });

  test("refuses a late callback that fails state validation", async () => {
    const server = await start({ timeoutMs: 120 });
    await server.waitForCallback().catch(() => {});

    const res = await fetch(callbackUrl(server, { code: "x", state: "wrong" }));
    expect(res.status).toBe(400);
  });

  test("releases the port on close after a timeout", async () => {
    const server = await start({ timeoutMs: 120 });
    await server.waitForCallback().catch(() => {});
    server.close();

    const res = await fetch(server.redirectUri).catch(() => null);
    expect(res).toBeNull();
  });
});

describe("auth server page rendering", () => {
  test("escapes provider text that reaches the page", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, {
        error: "access_denied",
        error_description: "<img src=x onerror=alert(1)>",
        state: STATE,
      }),
    );
    await server.waitForCallback().catch(() => {});

    const html = await (await response)?.text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("uses an injected success page verbatim", async () => {
    const server = await start({ successHtml: "<p>done</p>" });
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    server.respond({ kind: "success" });

    expect(await (await response)?.text()).toBe("<p>done</p>");
  });

  test("sets the hardening headers", async () => {
    const server = await start();
    const { response } = beginFetch(
      callbackUrl(server, { code: "abc", state: STATE }),
    );
    await server.waitForCallback();
    server.respond({ kind: "success" });

    const headers = (await response)?.headers;
    expect(headers?.get("x-content-type-options")).toBe("nosniff");
    expect(headers?.get("referrer-policy")).toBe("no-referrer");
    expect(headers?.get("cache-control")).toBe("no-store");
    expect(headers?.get("x-frame-options")).toBe("DENY");
  });
});

describe("auth server startup", () => {
  test("reports a port already in use as a config error", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve()),
    );
    const taken = (blocker.address() as AddressInfo).port;

    try {
      const error = (await startAuthServer({
        expectedState: STATE,
        port: taken,
      }).catch((err: Error) => err)) as ClerkCliAuthError;
      expect(error).toBeInstanceOf(ClerkCliAuthError);
      expect(error.code).toBe("config");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

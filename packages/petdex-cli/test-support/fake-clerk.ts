/**
 * A local stand-in for the Clerk Frontend API the CLI talks to.
 *
 * It answers the two endpoints the CLI's OAuth flow needs — `/oauth/token`
 * and `/oauth/userinfo` — plus a minimal authorize page that immediately
 * redirects back to the loopback callback with a code. Accounts are chosen by
 * the login name embedded in the authorization request, so one server can
 * play several accounts in sequence.
 *
 * This file is test support only: it is never imported by product code, and
 * the only production knob it relies on is the CLI's existing `PETDEX_URL` /
 * `CLERK_ISSUER` / `CLERK_OAUTH_CLIENT_ID` environment overrides.
 *
 * This is the tracked copy — the one `bin/petdex.test.ts` imports.
 * `test/local-env/fake-clerk.ts` is the local probe's copy and is deliberately
 * untracked, so CI cannot see it. Apart from this paragraph the two files are
 * identical, so a `diff` between them shows pure drift; if they ever disagree,
 * this copy is authoritative.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeAccount {
  sub: string;
  email: string;
  name?: string;
  /** When set, `/oauth/userinfo` answers this HTTP status instead of the profile. */
  userinfoStatus?: number;
  /** When set, `/oauth/token` answers this HTTP status instead of tokens. */
  tokenStatus?: number;
  /** Seconds until the issued access token expires. */
  expiresIn?: number;
}

export interface FakeClerkOptions {
  accounts: FakeAccount[];
  /** Which account the authorize page picks when no hint is given. */
  defaultSub?: string;
  /** Fixed port, for a server that has to outlive one test process. */
  port?: number;
  /**
   * Rows `POST /api/cli/submit/check` reports as already owned by the caller.
   * The endpoint rides on this server because the CLI takes both its issuer
   * and its API base from the same `PETDEX_URL`.
   */
  ownedPets?: Array<{ slug: string; status?: string }>;
}

export interface FakeClerk {
  issuer: string;
  clientId: string;
  /** Requests seen, for assertions. */
  requests: string[];
  /**
   * Hold `/oauth/token` refresh grants for this many milliseconds.
   *
   * The point is to make the refresh window observable: a test can wait for
   * the request to arrive, act on the credential store while the CLI is
   * waiting for the answer, and only then let the grant complete. `0` (the
   * default) answers immediately.
   */
  setRefreshDelay(ms: number): void;
  closed: Promise<void>;
  close(): Promise<void>;
}

const CLIENT_ID = "local-review-client";

export async function startFakeClerk(
  options: FakeClerkOptions,
): Promise<FakeClerk> {
  const requests: string[] = [];
  const issued = new Map<string, FakeAccount>();
  let counter = 0;
  let refreshDelayMs = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const findAccount = (subOrEmail: string | null): FakeAccount | undefined => {
    if (!subOrEmail) {
      return (
        options.accounts.find((a) => a.sub === options.defaultSub) ??
        options.accounts[0]
      );
    }
    return options.accounts.find(
      (a) => a.sub === subOrEmail || a.email === subOrEmail,
    );
  };

  const readBody = (req: import("node:http").IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    const json = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(text)),
      });
      res.end(text);
    };

    if (url.pathname === "/oauth/authorize") {
      // The real page asks the user; here the account is selected by the
      // `login_hint` the test passes through the CLI's openBrowser hook, or
      // by the default. Redirect straight back with a code.
      const account = findAccount(url.searchParams.get("login_hint"));
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri || !state || !account) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("bad authorize request");
        return;
      }
      const code = `code-${account.sub}-${++counter}`;
      issued.set(code, account);
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }

    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const grant = body.get("grant_type");
      if (body.get("client_id") !== CLIENT_ID) {
        json(401, { error: "invalid_client" });
        return;
      }
      if (grant === "authorization_code") {
        const account = issued.get(body.get("code") ?? "");
        if (!account) {
          json(400, {
            error: "invalid_grant",
            error_description: "unknown authorization code",
          });
          return;
        }
        issued.delete(body.get("code") ?? "");
        if (account.tokenStatus && account.tokenStatus >= 400) {
          json(account.tokenStatus, {
            error: "server_error",
            error_description: "token endpoint unavailable",
          });
          return;
        }
        json(200, {
          access_token: `access-${account.sub}-${counter}`,
          refresh_token: `refresh-${account.sub}-${counter}`,
          id_token: idTokenFor(account.sub),
          expires_in: account.expiresIn ?? 3600,
          scope: body.get("scope") ?? "profile email",
          token_type: "Bearer",
        });
        return;
      }
      if (grant === "refresh_token") {
        const refresh = body.get("refresh_token") ?? "";
        const account = options.accounts.find((a) =>
          refresh.startsWith(`refresh-${a.sub}-`),
        );
        if (!account) {
          json(400, {
            error: "invalid_grant",
            error_description: "unknown refresh token",
          });
          return;
        }
        // Held open on request, so a test can act on the store while the CLI
        // is waiting for this answer.
        if (refreshDelayMs > 0) await Bun.sleep(refreshDelayMs);
        json(200, {
          access_token: `access-${account.sub}-refreshed-${++counter}`,
          refresh_token: `refresh-${account.sub}-${counter}`,
          id_token: idTokenFor(account.sub),
          expires_in: account.expiresIn ?? 3600,
          token_type: "Bearer",
        });
        return;
      }
      json(400, { error: "unsupported_grant_type" });
      return;
    }

    if (url.pathname === "/oauth/userinfo" && req.method === "GET") {
      const auth = req.headers.authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const account = options.accounts.find((a) =>
        token.startsWith(`access-${a.sub}-`),
      );
      if (!account) {
        json(401, { error: "invalid_token" });
        return;
      }
      if (account.userinfoStatus && account.userinfoStatus >= 400) {
        json(account.userinfoStatus, {
          error: "server_error",
          error_description: "userinfo endpoint unavailable",
        });
        return;
      }
      const fullName = account.name ?? account.email;
      const [givenName, ...rest] = fullName.split(/\s+/);
      json(200, {
        sub: account.sub,
        email: account.email,
        name: fullName,
        given_name: givenName,
        family_name: rest.join(" ") || undefined,
        preferred_username: account.email.split("@")[0],
      });
      return;
    }

    if (url.pathname === "/api/cli/submit/check" && req.method === "POST") {
      // Answer only for the slugs the caller asked about, as the real
      // endpoint does; the CLI treats any non-2xx here as "server has no
      // dedup" and carries on, so a test that needs the duplicates branch
      // depends on this answering 200.
      const asked = new Set<string>();
      try {
        const body = JSON.parse(await readBody(req)) as {
          candidates?: Array<{ slugHint?: string }>;
        };
        for (const cand of body.candidates ?? []) {
          if (typeof cand.slugHint === "string") asked.add(cand.slugHint);
        }
      } catch {
        /* malformed body: answer with nothing owned */
      }
      const existing = (options.ownedPets ?? []).filter((p) =>
        asked.has(p.slug),
      );
      json(200, { existing });
      return;
    }

    json(404, { error: "not_found", path: url.pathname });
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    clientId: CLIENT_ID,
    requests,
    setRefreshDelay: (ms: number) => {
      refreshDelayMs = ms;
    },
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolveClosed();
          resolve();
        });
      }),
  };
}

function idTokenFor(sub: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub })}.sig`;
}

/** Unused in most tests, but keeps the type import honest. */
export type { Server };

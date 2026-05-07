import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { ClerkCliAuthError } from "../types.js";

export interface AuthServerOptions {
  expectedState: string;
  port?: number;
  timeoutMs?: number;
  successHtml?: string;
  errorHtml?: string;
}

export interface AuthServerHandle {
  port: number;
  redirectUri: string;
  waitForCallback(): Promise<{ code: string; state: string }>;
  close(): void;
}

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authentication complete</title></head>
<body><h1>Authentication complete</h1><p>You can close this tab and return to your terminal.</p></body>
</html>`;

const DEFAULT_ERROR_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Authentication failed</title></head>
<body><h1>Authentication failed</h1><p>You can close this tab and return to your terminal.</p></body>
</html>`;

function oauthCallbackError(code: string, message: string): ClerkCliAuthError {
  return new ClerkCliAuthError(code, message);
}

export function startAuthServer(
  options: AuthServerOptions,
): Promise<AuthServerHandle> {
  const {
    expectedState,
    port = 0,
    timeoutMs = 120_000,
    successHtml = DEFAULT_SUCCESS_HTML,
    errorHtml = DEFAULT_ERROR_HTML,
  } = options;

  let timeout: NodeJS.Timeout | undefined;
  let settled = false;
  let closed = false;
  let resolveCallback!: (value: { code: string; state: string }) => void;
  let rejectCallback!: (reason: ClerkCliAuthError) => void;

  const callbackPromise = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    },
  );

  const closeListening = (server: Server) => {
    if (closed) return;
    closed = true;
    server.close();
  };

  const server = createServer((req, res) => {
    if (settled) {
      res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authentication callback already handled.");
      return;
    }

    if (req.method !== "GET" || !req.url) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Clerk CLI auth server is waiting for /callback.");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") ?? error;

    const settle = (
      statusCode: number,
      html: string,
      errorToReject?: ClerkCliAuthError,
    ) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html, () => {
        if (errorToReject) {
          rejectCallback(errorToReject);
        } else if (code && state) {
          resolveCallback({ code, state });
        }
        closeListening(server);
      });
    };

    if (error) {
      settle(
        400,
        errorHtml,
        oauthCallbackError(
          "token_exchange",
          `OAuth authorization failed: ${errorDescription ?? "unknown error"}`,
        ),
      );
      return;
    }

    if (state !== expectedState) {
      settle(
        400,
        errorHtml,
        oauthCallbackError(
          "state_mismatch",
          "OAuth callback state did not match.",
        ),
      );
      return;
    }

    if (!code) {
      settle(
        400,
        errorHtml,
        oauthCallbackError(
          "token_exchange",
          "OAuth callback did not include an authorization code.",
        ),
      );
      return;
    }

    settle(200, successHtml);
  });

  return new Promise<AuthServerHandle>((resolve, reject) => {
    server.once("error", (error) => {
      reject(
        new ClerkCliAuthError(
          "config",
          `Failed to start local auth callback server: ${(error as Error).message}`,
        ),
      );
    });

    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const actualPort = address.port;
      const redirectUri = `http://127.0.0.1:${actualPort}/callback`;

      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectCallback(
          new ClerkCliAuthError(
            "timeout",
            `OAuth callback timed out after ${timeoutMs}ms.`,
          ),
        );
        closeListening(server);
      }, timeoutMs);

      resolve({
        port: actualPort,
        redirectUri,
        waitForCallback: () => callbackPromise,
        close: () => {
          if (timeout) clearTimeout(timeout);
          if (!settled) {
            settled = true;
            rejectCallback(
              new ClerkCliAuthError(
                "timeout",
                "OAuth callback server was closed.",
              ),
            );
          }
          closeListening(server);
        },
      });
    });
  });
}

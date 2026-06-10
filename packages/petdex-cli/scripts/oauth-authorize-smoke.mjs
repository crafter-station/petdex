import crypto from "node:crypto";
import { createServer } from "node:http";

const PETDEX_URL = "https://petdex.dev";
const DEFAULT_SCOPES = ["profile", "email", "openid", "offline_access"];
const REQUEST_TIMEOUT_MS = 10_000;

function assertString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`auth-config must include ${name}`);
  }
  return value.trim();
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function readAuthConfig() {
  const configUrl = new URL("/api/cli/auth-config", PETDEX_URL);
  const res = await fetchWithTimeout(configUrl);

  if (!res.ok) {
    throw new Error(`auth-config returned HTTP ${res.status}`);
  }

  const config = await res.json();
  const issuer = assertString(config.issuer, "issuer").replace(/\/+$/, "");
  const clientId = assertString(config.clientId, "clientId");
  const scopes = Array.isArray(config.scopes)
    ? config.scopes.filter(
        (scope) => typeof scope === "string" && scope.trim().length > 0,
      )
    : DEFAULT_SCOPES;

  new URL(issuer);

  return {
    issuer,
    clientId,
    scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES,
  };
}

function createCodeChallenge() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function startLoopbackCallbackServer() {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/callback")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OAuth smoke callback received.");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("OAuth smoke callback server did not expose a port"));
        return;
      }

      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          }),
      });
    });
  });
}

function createAuthorizeUrl(config, redirectUri) {
  const authorizeUrl = new URL(`${config.issuer}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", config.scopes.join(" "));
  authorizeUrl.searchParams.set("state", "github-actions-smoke");
  authorizeUrl.searchParams.set("code_challenge", createCodeChallenge());
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  return authorizeUrl;
}

async function readUsefulResponseText(res) {
  const location = res.headers.get("location") ?? "";
  const contentType = res.headers.get("content-type") ?? "";
  const shouldReadBody =
    res.status >= 400 ||
    contentType.includes("application/json") ||
    contentType.includes("text/");
  const body = shouldReadBody ? await res.text() : "";
  return `${location}\n${body}`;
}

async function main() {
  const config = await readAuthConfig();
  const callbackServer = await startLoopbackCallbackServer();

  try {
    // Bind a random loopback port, matching the real CLI login path. Stop
    // before user sign-in; the failure this catches is Clerk rejecting the
    // public CLI OAuth client before the browser can show the login screen.
    const authorizeRes = await fetchWithTimeout(
      createAuthorizeUrl(config, callbackServer.redirectUri),
      {
        redirect: "manual",
      },
    );
    const responseText = await readUsefulResponseText(authorizeRes);

    if (/invalid_client/i.test(responseText)) {
      throw new Error(
        "Clerk rejected the production CLI OAuth client with invalid_client",
      );
    }

    if (authorizeRes.status >= 500) {
      throw new Error(
        `OAuth authorize endpoint returned HTTP ${authorizeRes.status}`,
      );
    }

    if (authorizeRes.status >= 400 && /error/i.test(responseText)) {
      throw new Error(
        `OAuth authorize endpoint returned an error before sign-in: HTTP ${authorizeRes.status}`,
      );
    }

    console.log(
      `OAuth authorize smoke reached Clerk without invalid_client (HTTP ${authorizeRes.status}).`,
    );
  } finally {
    await callbackServer.close();
  }
}

await main();

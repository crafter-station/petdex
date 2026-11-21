import { authMessages } from "../../i18n/auth-messages.js";
import type { TokenSet, UserInfo } from "../types.js";
import { ClerkCliAuthError } from "../types.js";

export interface ExchangeParams {
  issuer: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RefreshParams {
  issuer: string;
  clientId: string;
  refreshToken: string;
  scopes?: string[];
}

export interface UserInfoParams {
  issuer: string;
  accessToken: string;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

/**
 * How long either network call may take before it is abandoned.
 *
 * Without this, a stalled connection leaves `login()` waiting forever: the
 * callback server's own timeout answers the browser, but nothing breaks the
 * request the CLI is sitting on. The smoke script in `scripts/` already
 * bounded its authorize probe this way.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function endpoint(issuer: string, path: string): string {
  return `${issuer.replace(/\/+$/, "")}${path}`;
}

async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["error_description", "message", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return fallback;
}

function mapTokenResponse(data: OAuthTokenResponse): TokenSet {
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new ClerkCliAuthError(
      "token_exchange",
      "Token response did not include access_token.",
    );
  }

  const tokenSet: TokenSet = {
    accessToken: data.access_token,
  };

  if (typeof data.refresh_token === "string")
    tokenSet.refreshToken = data.refresh_token;
  if (typeof data.id_token === "string") tokenSet.idToken = data.id_token;
  if (typeof data.scope === "string") tokenSet.scope = data.scope;
  if (typeof data.token_type === "string") tokenSet.tokenType = data.token_type;
  if (typeof data.expires_in === "number") {
    tokenSet.expiresAt = Date.now() + data.expires_in * 1000;
  }

  return tokenSet;
}

async function requestTokens(
  issuer: string,
  body: URLSearchParams,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetch(endpoint(issuer, "/oauth/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ClerkCliAuthError(
      "token_exchange",
      authMessages().tokenRequestFailed((error as Error).message),
    );
  }

  let parsed: unknown;
  try {
    parsed = await parseBody(response);
  } catch (error) {
    throw new ClerkCliAuthError(
      "token_exchange",
      `Token response could not be parsed: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new ClerkCliAuthError(
      "token_exchange",
      messageFromBody(parsed, authMessages().tokenRequestHttp(response.status)),
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ClerkCliAuthError(
      "token_exchange",
      "Token response was not JSON.",
    );
  }

  return mapTokenResponse(parsed as OAuthTokenResponse);
}

export async function exchangeCodeForTokens(
  params: ExchangeParams,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });

  return requestTokens(params.issuer, body);
}

export async function refreshAccessToken(
  params: RefreshParams,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  });

  if (params.scopes?.length) body.set("scope", params.scopes.join(" "));

  return requestTokens(params.issuer, body);
}

export async function fetchUserInfo(params: UserInfoParams): Promise<UserInfo> {
  let response: Response;
  try {
    response = await fetch(endpoint(params.issuer, "/oauth/userinfo"), {
      headers: { Authorization: `Bearer ${params.accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ClerkCliAuthError(
      "userinfo",
      authMessages().userinfoRequestFailed((error as Error).message),
    );
  }

  let parsed: unknown;
  try {
    parsed = await parseBody(response);
  } catch (error) {
    throw new ClerkCliAuthError(
      "userinfo",
      `Userinfo response could not be parsed: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new ClerkCliAuthError(
      "userinfo",
      messageFromBody(
        parsed,
        authMessages().userinfoRequestHttp(response.status),
      ),
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ClerkCliAuthError("userinfo", "Userinfo response was not JSON.");
  }

  const user = parsed as UserInfo;
  if (typeof user.sub !== "string" || user.sub.length === 0) {
    throw new ClerkCliAuthError(
      "userinfo",
      "Userinfo response did not include sub.",
    );
  }

  return user;
}

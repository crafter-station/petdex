import { spawn } from "node:child_process";

import { startAuthServer } from "./lib/auth-server.js";
import { createCredentialStore } from "./lib/credential-store.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./lib/pkce.js";
import {
  exchangeCodeForTokens,
  fetchUserInfo,
  refreshAccessToken,
} from "./lib/token-exchange.js";
import type {
  ClerkCliAuthConfig,
  CredentialStore,
  LoginResult,
  TokenSet,
  UserInfo,
} from "./types.js";
import { ClerkCliAuthError } from "./types.js";

const DEFAULT_SCOPES = ["profile", "email", "openid", "offline_access"];

function normalizeIssuer(issuer: string): string {
  const normalized = issuer.trim().replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("issuer must use http or https");
    }
    return normalized;
  } catch (error) {
    throw new ClerkCliAuthError(
      "config",
      `issuer must be a valid URL: ${(error as Error).message}`,
    );
  }
}

function storageError(operation: string, error: unknown): ClerkCliAuthError {
  if (error instanceof ClerkCliAuthError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ClerkCliAuthError("storage", `Failed to ${operation}: ${detail}`);
}

async function openBrowserFallback(url: string): Promise<void> {
  console.log(`Open this URL to sign in:\n${url}`);

  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve());
    child.unref();
    resolve();
  });
}

export class ClerkCliAuth {
  private readonly config: Required<
    Omit<ClerkCliAuthConfig, "openBrowser" | "storage">
  > & {
    storage: CredentialStore;
    openBrowser?: (url: string) => Promise<void>;
  };

  constructor(config: ClerkCliAuthConfig) {
    if (!config.clientId)
      throw new ClerkCliAuthError("config", "clientId is required");
    if (!config.issuer)
      throw new ClerkCliAuthError("config", "issuer is required");

    const environment = config.environment ?? "default";
    const storage =
      typeof config.storage === "object" && config.storage !== null
        ? config.storage
        : createCredentialStore(config.storage ?? "keychain", {
            environment,
            keychainService: config.keychainService,
          });

    this.config = {
      clientId: config.clientId,
      issuer: normalizeIssuer(config.issuer),
      scopes: config.scopes ?? DEFAULT_SCOPES,
      storage,
      keychainService: config.keychainService ?? "clerk-cli-auth",
      environment,
      callbackPort: config.callbackPort ?? 0,
      timeoutMs: config.timeoutMs ?? 120_000,
      openBrowser: config.openBrowser,
    };
  }

  async login(): Promise<LoginResult> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    const server = await startAuthServer({
      expectedState: state,
      port: this.config.callbackPort,
      timeoutMs: this.config.timeoutMs,
    });

    try {
      const authorizeUrl = new URL(`${this.config.issuer}/oauth/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", this.config.clientId);
      authorizeUrl.searchParams.set("redirect_uri", server.redirectUri);
      authorizeUrl.searchParams.set("scope", this.config.scopes.join(" "));
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      try {
        await (this.config.openBrowser ?? openBrowserFallback)(
          authorizeUrl.toString(),
        );
      } catch (error) {
        throw new ClerkCliAuthError(
          "config",
          `Failed to open authorization URL: ${(error as Error).message}`,
        );
      }

      const { code } = await server.waitForCallback();
      const tokens = await exchangeCodeForTokens({
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        code,
        codeVerifier,
        redirectUri: server.redirectUri,
      });

      await this.setJson("tokens", tokens);
      const user = await fetchUserInfo({
        issuer: this.config.issuer,
        accessToken: tokens.accessToken,
      });
      await this.setJson("user", user);

      return { tokens, user };
    } finally {
      server.close();
    }
  }

  async getAccessToken(): Promise<string | null> {
    const tokens = await this.getTokenSet();
    if (!tokens) return null;

    const expiresAt = tokens.expiresAt ?? Number.POSITIVE_INFINITY;
    if (expiresAt >= Date.now() + 30_000) return tokens.accessToken;

    if (!tokens.refreshToken) return null;

    const refreshed = await refreshAccessToken({
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      refreshToken: tokens.refreshToken,
      scopes: this.config.scopes,
    });
    const nextTokens = {
      ...tokens,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    };
    await this.setJson("tokens", nextTokens);
    return nextTokens.accessToken;
  }

  async whoami(): Promise<UserInfo | null> {
    const cachedUser = await this.getJson<UserInfo>("user");
    if (cachedUser) return cachedUser;

    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;

    const user = await fetchUserInfo({
      issuer: this.config.issuer,
      accessToken,
    });
    await this.setJson("user", user);
    return user;
  }

  async logout(): Promise<void> {
    try {
      await Promise.all([
        this.config.storage.delete("tokens"),
        this.config.storage.delete("user"),
      ]);
    } catch (error) {
      throw storageError("clear stored credentials", error);
    }
  }

  async getTokenSet(): Promise<TokenSet | null> {
    return this.getJson<TokenSet>("tokens");
  }

  private async getJson<T>(key: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.config.storage.get(key);
    } catch (error) {
      throw storageError(`read ${key}`, error);
    }
    if (!raw) return null;

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      throw storageError(`parse stored ${key}`, error);
    }
  }

  private async setJson(key: string, value: unknown): Promise<void> {
    try {
      await this.config.storage.set(key, JSON.stringify(value));
    } catch (error) {
      throw storageError(`write ${key}`, error);
    }
  }
}

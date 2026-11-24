import { spawn } from "node:child_process";

import { accountLabel } from "./cli-messages.js";
import { startAuthServer } from "./lib/auth-server.js";
import { browserCommand } from "./lib/browser-command.js";
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

/**
 * A refresh that could not renew the saved token.
 *
 * `refreshAccessToken` reports a dead refresh token as `token_exchange`, the
 * same code a failed code exchange uses — but the reader's situation is
 * different: the store holds a session that has expired, and the fix is to
 * sign in again, not to retry a login that was never attempted. The CLI's
 * message table has a case for exactly that, so the code is raised here
 * rather than leaving it to fall through to "Not signed in".
 */
function tokenExpired(error: unknown): ClerkCliAuthError {
  if (error instanceof ClerkCliAuthError && error.code === "token_expired")
    return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ClerkCliAuthError(
    "token_expired",
    `Saved session could not be refreshed: ${detail}`,
  );
}

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

  const { command, args } = browserCommand(url);

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

      // Resolve the profile before touching storage, and drop the old one
      // before the new tokens land, so the store never pairs one account's
      // tokens with another account's profile.
      const user = await fetchUserInfo({
        issuer: this.config.issuer,
        accessToken: tokens.accessToken,
      });
      try {
        await this.config.storage.delete("user");
      } catch (error) {
        // A delete can fail on a machine whose keychain is unreachable while
        // the file store works — a redirected HOME, a locked login keychain,
        // a CI container — even after it cleared the copy `get()` would have
        // read. Aborting the whole login there would make the CLI unusable on
        // exactly the machines that already fell back to the file, so check
        // what the guarantee actually needs: no *readable* old profile to
        // pair with the new token. Only a definite "there is nothing to
        // read" clears the way; an unreadable store is treated like a
        // still-readable profile, because a pairing this call cannot rule
        // out is exactly what must not be written.
        let cleared = false;
        try {
          cleared = (await this.config.storage.get("user")) === null;
        } catch {
          cleared = false;
        }
        if (!cleared) throw storageError("clear stored user", error);
      }
      await this.setJson("tokens", tokens);
      await this.setJson("user", user);

      // Last, and only once every step that can still fail has succeeded.
      // The browser is holding its connection open until this call, so
      // answering earlier would report success for a login that then failed
      // to save its credentials — the same mismatch this deferral exists to
      // remove, just moved one step later.
      server.respond({ kind: "success" });
      return { tokens, user };
    } catch (error) {
      // Also reached when the opener rejects after the browser has already
      // delivered its callback, which is the case where only this call can
      // tell the reader anything. A no-op if the response was already sent.
      // A configuration failure is its own reason on the page: the reader's
      // fix is an updated or corrected CLI, not a retry of the code exchange
      // that never ran. The account a failed sign-in left in place is passed
      // along too, read from the store and never the network, so the page can
      // say what the terminal says — but the page shows it only for
      // `userinfo_failed`, where the store provably was not touched.
      const reason = (error as { code?: unknown }).code;
      server.respond({
        kind: "error",
        reason:
          reason === "userinfo" || reason === "storage"
            ? (`${reason}_failed` as const)
            : reason === "config"
              ? "config_failed"
              : "token_exchange_failed",
        previousAccount: accountLabel(await this.getCachedUser()),
      });
      throw error;
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

    let refreshed: TokenSet;
    try {
      refreshed = await refreshAccessToken({
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        refreshToken: tokens.refreshToken,
        scopes: this.config.scopes,
      });
    } catch (error) {
      // The stored token is unusable and could not be renewed. This is its
      // own outcome: "not signed in" would hide a session the user still has
      // to clear or renew with `petdex login`.
      throw tokenExpired(error);
    }
    const nextTokens = {
      ...tokens,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    };
    await this.setJson("tokens", nextTokens);
    return nextTokens.accessToken;
  }

  async whoami(): Promise<UserInfo | null> {
    // The cached profile is not evidence of a usable session: `logout` clears
    // both records through Promise.allSettled, so a half-cleared store can
    // leave the profile behind with no tokens next to it. Reporting that as
    // "signed in" hides the problem until some later command 401s, which is
    // the one place the user cannot act on it. Confirming the credential
    // first turns a confusing failure into a prompt to sign in again.
    const cachedUser = await this.getJson<UserInfo>("user");
    if (cachedUser) {
      const accessToken = await this.getAccessToken();
      if (!accessToken) return null;
      return cachedUser;
    }

    const accessToken = await this.getAccessToken();
    if (!accessToken) return null;

    const user = await fetchUserInfo({
      issuer: this.config.issuer,
      accessToken,
    });
    await this.setJson("user", user);
    return user;
  }

  /**
   * The profile of a session that is actually usable, without any network
   * call. Used by the CLI to name the account in a message that claims a
   * previous sign-in is still in effect.
   *
   * Both records are read, because only the pair is evidence: `tokens` are
   * written before `user`, and either key can be damaged on its own, so a
   * readable profile beside an unparsable token record is an account no
   * command can act as. Reporting that as "your previous sign-in" would be
   * the same wrong-answer problem the messages exist to remove.
   *
   * Never throws: a store it cannot read is reported as "no previous
   * session", which is what the command's own credential access will hit
   * anyway.
   */
  async getCachedUser(): Promise<UserInfo | null> {
    try {
      const tokens = await this.getJson<TokenSet>("tokens");
      if (!tokens?.accessToken) return null;
      return await this.getJson<UserInfo>("user");
    } catch {
      return null;
    }
  }

  async logout(): Promise<void> {
    try {
      const results = await Promise.allSettled([
        this.config.storage.delete("tokens"),
        this.config.storage.delete("user"),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
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

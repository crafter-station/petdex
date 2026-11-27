/**
 * Public types for @clerk/cli-auth.
 * This file is the CONTRACT — Codex agents building the implementation
 * and the demo consumer both import from here. Keep signatures stable.
 */

export type StorageKind = "keychain" | "file" | "memory";

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Write `value` under `key` only if the stored record is still exactly
   * `expected` (`null` meaning "absent"), and report whether it was written.
   *
   * This is the primitive a read-modify-write that spans a network round trip
   * needs: the caller compares against the value it *read before* the round
   * trip, and a `false` means someone else replaced the record in the
   * meantime, so writing now would overwrite their value with one computed
   * from an older one. The store decides how atomic that is; each
   * implementation documents its own strength. A store that cannot compare
   * honestly cannot offer this guarantee, so this is a required member rather
   * than an optional one a silent fallback could paper over.
   */
  replaceIfUnchanged(
    key: string,
    expected: string | null,
    value: string,
    /**
     * An additional condition read and compared in the same critical
     * section: `guard.key` must still be exactly `guard.expected`, or
     * nothing is written and `false` is returned. `whoami` uses it to make a
     * profile's write-back conditional on the `tokens` record the profile
     * was fetched with, because the pair is what names an account.
     */
    guard?: { key: string; expected: string | null },
  ): Promise<boolean>;
}

export interface ClerkCliAuthConfig {
  /** OAuth Application client_id from Clerk Dashboard (public client, PKCE). */
  clientId: string;
  /** Frontend API base URL, e.g. https://clerk.myapp.com (no trailing slash). */
  issuer: string;
  /** OAuth scopes to request. Default: ["profile", "email", "openid", "offline_access"]. */
  scopes?: string[];
  /** Credential storage strategy. Default: "keychain" (with file fallback). */
  storage?: StorageKind | CredentialStore;
  /** Keychain service name (macOS/Linux/Windows credential manager). Default: "clerk-cli-auth". */
  keychainService?: string;
  /** Environment label to namespace stored tokens. Default: "default". */
  environment?: string;
  /** Override the port the ephemeral callback server binds to. Default: 0 (random). */
  callbackPort?: number;
  /** Callback server timeout in ms. Default: 120000 (2min). */
  timeoutMs?: number;
  /** Injected opener for the browser step (for testing). Default: auto-detect. */
  openBrowser?: (url: string) => Promise<void>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export interface UserInfo {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface LoginResult {
  tokens: TokenSet;
  user: UserInfo;
}

export class ClerkCliAuthError extends Error {
  code: string;
  /**
   * The OAuth `error` code the provider returned, when it sent one.
   *
   * Kept apart from `message` because the human-readable description and the
   * machine-readable code answer different questions: an endpoint can say
   * `invalid_grant` with any wording, and the message may quote the wording.
   * Code that must not guess — telling an expired session from a temporary
   * outage — reads this, not the prose.
   */
  providerError?: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClerkCliAuthError";
    this.code = code;
  }
}

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
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClerkCliAuthError";
    this.code = code;
  }
}

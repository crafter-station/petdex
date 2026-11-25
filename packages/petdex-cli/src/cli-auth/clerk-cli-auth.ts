import { spawn } from "node:child_process";

import {
  accountLabel,
  type SavedSessionState,
  type SavedSessionSummary,
} from "./cli-messages.js";
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
 * The record key an earlier build stored the whole session under.
 *
 * Nothing in this build reads or writes it — `tokens` and `user` are the
 * layout, and this branch does not migrate between the two. It is named here
 * only so `logout` (and a successful login) can remove it: it holds a full
 * access + refresh token pair, and any old bundle that still reads it would
 * sign the machine back in as whoever wrote it.
 */
const LEGACY_SESSION_KEY = "session";

/**
 * How many refreshes `getAccessToken()` will attempt before it settles for
 * whatever the store holds.
 *
 * One is the normal case. A second is only reached when the first refresh's
 * write-back was refused because another process replaced the session inside
 * the refresh window — and that replacement is itself a freshly written
 * session, so it almost always answers on the next read without any network
 * call at all. Reaching the cap means logins are landing faster than this
 * command can refresh, where another round would keep losing the same race.
 */
const MAX_REFRESH_ATTEMPTS = 2;

/**
 * How many times `whoami` re-reads the store to pair a profile with its
 * credential.
 *
 * One pass is the normal case. A second is only reached when a login landed
 * between the token read and the profile read (or answered the userinfo call
 * first), which is one writer moving once; the re-read almost always pairs.
 * Past the cap the call answers `null` rather than naming an account it
 * cannot tie to the credential it holds — a wrong name is worse than asking
 * the reader to run the command again.
 */
const WHOAMI_PROFILE_READS = 3;

/**
 * A stored `tokens` record, or null when the bytes are not one.
 *
 * Only used to read the access token for a userinfo call; a record that does
 * not parse has no credential to check, so the caller reports "signed out"
 * for the same reason `getStoredTokens` does.
 */
function parseStoredTokens(raw: string): TokenSet | null {
  const read = readStoredTokens(raw);
  return read.ok ? read.tokens : null;
}

/**
 * The one place that decides whether a stored `tokens` value is a credential.
 *
 * Three readers see the same bytes — `resolveSession` (through
 * `getStoredTokens`), `readCurrentSession` and `describeSavedSession` — and
 * all of them must give the same answer. Calling a `null`, `false`, `[]` or
 * `{}` record a token set sends `Bearer undefined` to the profile endpoint
 * and then reports "Signed in, but your profile couldn't be loaded", while
 * `describeSavedSession` calls the same bytes `damaged`. So the shape rule
 * lives here and the failure carries *why* it failed: bytes that are not JSON
 * at all are a parse error, bytes that parse into something else are a shape
 * error, and both become a `storage` answer upstream.
 */
type StoredTokensRead =
  | { ok: true; tokens: TokenSet }
  | { ok: false; reason: "parse"; error: unknown }
  | { ok: false; reason: "shape" };

function readStoredTokens(raw: string): StoredTokensRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: "parse", error };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, reason: "shape" };
  const tokens = parsed as TokenSet;
  if (typeof tokens.accessToken !== "string" || !tokens.accessToken)
    return { ok: false, reason: "shape" };
  return { ok: true, tokens };
}

/**
 * The one place that decides whether a stored `user` value is a profile.
 *
 * Three readers see the same bytes — `whoami`, `getCachedUser` (the callback
 * page's label) and `describeSavedSession` — and all of them must give the
 * same answer; a split here is how `whoami` ends up trusting a cached value
 * that `describeSavedSession` refuses to name. So the rule lives here, the
 * same way `readStoredTokens` owns the `tokens` shape.
 *
 * The predicate is `fetchUserInfo`'s, because that is the only producer: a
 * stored profile is whatever that call wrote back, so it has to pass the
 * check that call applies to the network answer. `typeof x === "object"` is
 * not enough on its own — `[]`, `{}`, `{"error":"boom"}` and `{"sub":123}`
 * are all objects, and handing one to `whoami` prints it as the account or
 * reports an identity with no subject.
 *
 * - an object that is not null and not an array (a JSON array is not an
 *   object shape here, whatever `typeof` says);
 * - `sub` present as a non-empty string — `fetchUserInfo` throws without it,
 *   and it is `accountLabel`'s last resort when there is no email;
 * - `email`, when present, a string — `UserInfo` types it as one, and it is
 *   the first thing `accountLabel` shows a person.
 *
 * Everything else about the object is left alone: `UserInfo` carries an
 * index signature, so extra keys (`username`, provider claims) are expected,
 * and a profile is not rejected for having them.
 *
 * Damaged and falsey slots (`"null"`, `"false"`, `"0"`, `"\"\""`, an empty
 * string, bytes that are not JSON) also answer null: none of them names an
 * account, so the caller fetches the profile and writes it back. The raw
 * bytes stay with the caller as the write's expectation — see
 * `writeBackProfile`.
 */
function parseStoredProfile(raw: string | null): UserInfo | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const user = parsed as UserInfo;
  if (typeof user.sub !== "string" || user.sub.length === 0) return null;
  if (user.email !== undefined && typeof user.email !== "string") return null;
  return user;
}

/**
 * Read the store's current `tokens` record and say which of three states it
 * is in, relative to the bytes a refresh was computed from.
 *
 * - `"same"`: the record is still those bytes. The failure is about the
 *   session the caller already had, so it is reported.
 * - `"changed"`: something replaced the record — a login, a winning refresh
 *   in another process. The caller's session is history; the new one answers
 *   the next pass.
 * - `"logged-out"`: the record is gone, and so is the session; `null` is the
 *   honest answer.
 * - `"unknown"`: the read failed. Reported like `"same"`: the caller is about
 *   to fail anyway, and a retry loop over an unreadable store would never
 *   end.
 *
 * At most `MAX_REFRESH_ATTEMPTS` reads, so a store that keeps changing under
 * a failing refresh cannot spin.
 */
type TokensVerdict = "same" | "changed" | "logged-out" | "unknown";

async function classifyTokens(
  raw: string | null,
  previous: string,
): Promise<TokensVerdict> {
  if (raw === null) return "logged-out";
  return raw === previous ? "same" : "changed";
}

/**
 * The token endpoint answered `invalid_grant` for a refresh.
 *
 * That is the provider saying *these* refresh credentials are dead — spent,
 * revoked, or expired — and `refreshAccessToken` reports it as
 * `token_exchange` because it shares the code with a failed code exchange.
 * For a reader the situation is different from a login that never was: the
 * store holds a session that cannot be renewed, and the fix is to sign in
 * again. The CLI's message table has a case for exactly that.
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

/**
 * Whether an `invalid_grant` answer is the only thing a failed refresh can
 * mean, rather than "the exchange failed for some reason".
 *
 * `refreshAccessToken` flattens every failure into `token_exchange`: a 400
 * with `error: invalid_grant`, a 503 from the endpoint, a DNS failure and an
 * aborted timeout all arrive as that one code. Only the first is evidence
 * the refresh credentials are dead; a 5xx or an offline machine says nothing
 * about them, and telling the reader to sign in again would be a wrong
 * answer with a destructive-sounding fix. Only the provider can draw that
 * line, so the body's `error` code — kept on the error by `token-exchange` —
 * is what decides, with the quoted description as a fallback for callers that
 * do not carry the code. Everything else keeps a temporary-failure reason.
 */
function isDeadRefreshGrant(error: unknown): boolean {
  if (!(error instanceof ClerkCliAuthError) || error.code !== "token_exchange")
    return false;
  // The provider's own code is the authoritative signal. Its description is
  // arbitrary text (`unknown refresh token`, `refresh token revoked`) and can
  // arrive *instead of* the code in the message, so the message alone misses
  // a genuine `invalid_grant` whenever a description is present.
  if (error.providerError === "invalid_grant") return true;
  const detail = (error.message ?? "").toLowerCase();
  return detail.includes("invalid_grant");
}

/**
 * A refresh that failed while the stored session was still the one it came
 * from. Dead credentials are `token_expired`; anything else — an endpoint
 * outage, an offline machine, a timeout — keeps its own code, because the
 * session may well still be valid and only the check failed.
 *
 * `readFailure` is the re-read that decides "still the same session" failing
 * too. The provider's answer still picks the code — the session's own fate
 * does not depend on whether this machine could read its copy — but the
 * message has to mention it: without that, a local credential file that
 * cannot be read looks exactly like a service outage, and the reader waits
 * for the endpoint instead of repairing the store.
 */
function refreshFailure(
  error: unknown,
  readFailure?: unknown,
): ClerkCliAuthError {
  const suffix =
    readFailure === undefined
      ? ""
      : `; the saved credentials also could not be read on this machine (${
          readFailure instanceof Error
            ? readFailure.message
            : String(readFailure)
        })`;
  if (isDeadRefreshGrant(error)) {
    const expired = tokenExpired(error);
    return suffix
      ? new ClerkCliAuthError(expired.code, `${expired.message}${suffix}`)
      : expired;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ClerkCliAuthError(
    "refresh_failed",
    `Saved session could not be checked with the sign-in service right now: ${detail}${suffix}`,
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
      // A successful sign-in is the other safe moment to drop the legacy
      // record: the two keys now describe the new session, and an old
      // single-record copy beside them is a stale secret nothing should
      // revive. Best effort here — unlike `logout`, the session is saved and
      // a cleanup failure must not turn a good login into a failed one. The
      // next `logout` will try again.
      await this.config.storage.delete(LEGACY_SESSION_KEY).catch(() => {});

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
      // that never ran. What the failed sign-in left in place is passed along
      // too, read from the store and never the network — but only when the
      // store pairs a name with a credential-shaped record. An account the
      // CLI cannot act as (a profile with no `tokens` beside it, a record it
      // cannot parse) is not "still in use", and the page must not say it is.
      const reason = (error as { code?: unknown }).code;
      const previous = await this.describeSavedSession();
      // Account and state travel together or not at all: the page has no
      // default between them, and passing a name with no state would make it
      // describe a session it has no evidence for.
      const inEffect =
        (previous.state === "usable" || previous.state === "expired") &&
        previous.label
          ? { previousAccount: previous.label, previousSession: previous.state }
          : {};
      server.respond({
        kind: "error",
        reason:
          reason === "userinfo" || reason === "storage"
            ? (`${reason}_failed` as const)
            : reason === "config"
              ? "config_failed"
              : "token_exchange_failed",
        ...inEffect,
      });
      throw error;
    } finally {
      server.close();
    }
  }

  /**
   * A token for the next API call, refreshed when it is about to expire.
   *
   * The refreshed record is written back only if the `tokens` record it was
   * computed from is still the one in the store (see `writeBackRefresh`).
   * The refresh holds a network round trip open, and a `petdex login`
   * finishing inside it used to have its session overwritten by a result
   * derived from the previous one — leaving the new account's profile beside
   * the old account's tokens, invisible to `whoami`, and destroying the new
   * session's refresh token. That is now refused instead.
   *
   * A refusal is not an error and prints nothing: the store's current
   * session is the newer one, so this call re-reads it and answers for *that*
   * account — the command carries on exactly as the next command would, just
   * without refreshing. `MAX_REFRESH_ATTEMPTS` bounds the loop; past it the
   * stored record is returned as it is rather than refreshing again, because
   * the server, not this 30-second heuristic, decides whether a token still
   * works.
   *
   * A *failed* refresh takes the same route through the store before it is
   * an error. The fetch can fail because `petdex login` replaced the session
   * inside the round trip — in which case the new session simply answers the
   * next pass, and there is nothing wrong with it — or because the issuer
   * refused *these* refresh credentials, or because the endpoint was briefly
   * unavailable. Only the middle case is a session the user has to renew; it
   * is the only one reported as `token_expired`, and only when the record is
   * still byte-for-byte the one the refresh was computed from. A temporary
   * failure keeps its own reason (`refresh_failed`) so the reader is not told
   * to sign in again over an outage.
   */
  async getAccessToken(): Promise<string | null> {
    return (await this.resolveSession())?.accessToken ?? null;
  }

  /**
   * The token and the exact record it was read from.
   *
   * `whoami` needs the bytes, not only the token: the profile has to be
   * paired with the `tokens` record this call is acting on, and only that
   * record's identity survives a concurrent login.
   */
  private async resolveSession(): Promise<{
    accessToken: string;
    raw: string;
  } | null> {
    for (let attempt = 1; ; attempt++) {
      const stored = await this.getStoredTokens();
      if (!stored) return null;

      const { raw, tokens } = stored;
      const expiresAt = tokens.expiresAt ?? Number.POSITIVE_INFINITY;
      if (expiresAt >= Date.now() + 30_000)
        return { accessToken: tokens.accessToken, raw };

      if (!tokens.refreshToken) return null;
      if (attempt > MAX_REFRESH_ATTEMPTS)
        return { accessToken: tokens.accessToken, raw };

      let refreshed: TokenSet;
      try {
        refreshed = await refreshAccessToken({
          issuer: this.config.issuer,
          clientId: this.config.clientId,
          refreshToken: tokens.refreshToken,
          scopes: this.config.scopes,
        });
      } catch (error) {
        // Re-read before deciding. A login (or a winning refresh) that landed
        // inside this round trip owns the store now, and that session is what
        // the command must answer with — not "your session expired" about a
        // refresh token the store no longer describes. `storedTokensVerdict`
        // bounds the re-reads. "unknown" — the store could not be read at
        // all — is reported exactly like an unchanged record: there is no
        // evidence anyone replaced the session, and treating it as "a new
        // session landed" would re-run a refresh the provider just refused
        // until the attempt cap returns that same refused credential as if
        // it worked. The loop only continues on a record that actually
        // changed.
        const changed = await this.storedTokensVerdict(raw);
        if (changed.verdict === "logged-out") return null;
        if (changed.verdict === "same" || changed.verdict === "unknown")
          throw refreshFailure(error, changed.readFailure);
        continue;
      }
      const nextTokens = {
        ...tokens,
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      };
      // Refused: the record changed while the refresh was in flight, so this
      // result belongs to a session the store no longer describes. Dropped,
      // not written — and not returned either, because the command must run
      // as the account that is actually signed in. The next pass reads that
      // account's record.
      if (await this.writeBackRefresh(raw, nextTokens)) {
        // The bytes the store now holds for this session: the guarded write
        // succeeded, so the record is exactly what it was given.
        return {
          accessToken: nextTokens.accessToken,
          raw: JSON.stringify(nextTokens),
        };
      }
    }
  }

  /**
   * Re-read the `tokens` record after a failed refresh, within a bound.
   *
   * The first read decides: unchanged bytes mean the failure is about the
   * session this call started with, and the second pass reads again. A record
   * that changed hands (or vanished) answers the first pass. The loop exists
   * for the opposite case: a login that is *still* writing can replace the
   * record again while this call is reading, so each observation is
   * classified in turn, up to `MAX_REFRESH_ATTEMPTS` reads.
   *
   * `readFailure` travels with an `unknown` verdict so the message built from
   * it can say the store could not be read, rather than leaving the reader to
   * guess "service outage" from a provider answer that was fine.
   */
  private async storedTokensVerdict(raw: string): Promise<{
    verdict: TokensVerdict;
    readFailure?: unknown;
  }> {
    // Every path out of this loop is a `return`, so the bound is the
    // `read + 1 >= MAX_REFRESH_ATTEMPTS` check rather than the loop header.
    // Keeping it that way leaves no unreachable tail for coverage to report
    // as a branch nobody exercises.
    for (let read = 0; ; read++) {
      let current: string | null;
      try {
        current = await this.config.storage.get("tokens");
      } catch (readFailure) {
        return { verdict: "unknown", readFailure };
      }
      const verdict = await classifyTokens(current, raw);
      if (verdict !== "changed") return { verdict };
      // Still moving: either this read is the settled one, or the next pass
      // in `getAccessToken` takes over on the last observation.
      if (read + 1 >= MAX_REFRESH_ATTEMPTS) return { verdict };
      await Promise.resolve();
    }
  }

  async whoami(): Promise<UserInfo | null> {
    // The credential comes first, before the cached profile, for two reasons.
    //
    // The cached profile is not evidence of a usable session: `logout` clears
    // both records through Promise.allSettled, so a half-cleared store can
    // leave the profile behind with no tokens next to it. Reporting that as
    // "signed in" hides the problem until some later command 401s, which is
    // the one place the user cannot act on it. Confirming the credential
    // first turns a confusing failure into a prompt to sign in again.
    //
    // Reading it *first* also answered with the account that had just lost a
    // login race: `getAccessToken()` can refuse a refresh whose store record
    // changed mid-flight and re-read the winner's session, but a profile read
    // before that call is already stale by the time the answer is returned.
    // Resolving the token first means the profile read below describes the
    // same session the command will actually use.
    const session = await this.resolveSession();
    if (!session) return null;

    // The profile must belong to the credential above, and both keys are
    // separate records: a login writes them one after the other, so the read
    // of `user` can land in the middle of a login and describe a different
    // account than the token this call holds.
    //
    // The first pass reads the pair and only trusts the profile if the
    // `tokens` record is still the one the access token came from. On a
    // mismatch — a login landed, a refresh in this or another process wrote
    // a new record — it re-reads under the memory of who it just saw. That
    // re-read is bounded by `WHOAMI_PROFILE_READS`; past it the call reports
    // a profile it cannot pair with *this* credential as missing rather than
    // serving the wrong account's name.
    //
    // A profile fetched from the network is written back only when the
    // record is still the one the userinfo call was made with
    // (`writeBackProfile`). Without that check a login finishing inside the
    // userinfo round trip would be paired with the *previous* account's
    // profile — and because the profile then looks cached, every later
    // command would keep reporting it while the API ran as the new account.
    let current = session;
    for (let read = 0; read < WHOAMI_PROFILE_READS; read++) {
      // The raw bytes, not only the parsed profile: the guarded write below
      // has to name the slot's *current* value as its expectation. A record
      // that parses to a falsey scalar (`null`, `false`, `0`, `""`), an empty
      // string, or bytes that are not JSON at all is not a profile — but it
      // is still what the store holds, and expecting `null` there would make
      // the compare-and-swap refuse forever and leave the command alternating
      // between network calls and "Not signed in" while the token works. Only
      // a key that is genuinely absent is `null`.
      const rawUser = await this.currentUserRaw();
      const cachedUser = parseStoredProfile(rawUser);
      if (cachedUser && (await this.tokensStillCurrent(current.raw))) {
        return cachedUser;
      }
      if (cachedUser) {
        // A profile that is not this token's: a login is writing the pair.
        const next = await this.readCurrentSession();
        if (!next) return null;
        current = next;
        continue;
      }

      const user = await fetchUserInfo({
        issuer: this.config.issuer,
        accessToken: current.accessToken,
      });
      if (await this.writeBackProfile(current.raw, rawUser, user)) return user;
      // The session changed while userinfo was in flight: the answer names an
      // account the store no longer describes. Re-read and answer for the
      // session that is signed in now.
      const next = await this.readCurrentSession();
      if (!next) return null;
      current = next;
    }
    return null;
  }

  /**
   * The store's current session, or null when it holds no usable token.
   *
   * Deliberately a plain read rather than `resolveSession`: the caller is
   * mid-`whoami` and only needs the record that replaced the one it held. A
   * refresh here would be a second network call in a re-read loop bound by
   * `WHOAMI_PROFILE_READS`; the next command refreshes as usual.
   */
  private async readCurrentSession(): Promise<{
    accessToken: string;
    raw: string;
  } | null> {
    const raw = await this.currentTokensRaw();
    if (raw === null) return null;
    const tokens = parseStoredTokens(raw);
    if (!tokens) return null;
    return { accessToken: tokens.accessToken, raw };
  }

  /**
   * The raw `user` record, or null when the store holds none.
   *
   * Kept apart from `getRawJson` because a profile slot that does not
   * parse is not an error here: `whoami` can answer from the network and
   * overwrite it, and the raw bytes are exactly what the guarded write uses
   * as its expectation. A store that cannot be read still throws — that is a
   * different failure from a value that is merely not a profile.
   */
  private async currentUserRaw(): Promise<string | null> {
    try {
      return await this.config.storage.get("user");
    } catch (error) {
      throw storageError("read user", error);
    }
  }

  /**
   * The raw `tokens` record, or null when the store holds none.
   *
   * `whoami` binds every profile read to these bytes: the record is what a
   * login replaces when it drops the old profile, so comparing it is the only
   * way to tell "this profile is the one beside this token" from "this
   * profile is from before a login that is still writing".
   */
  private async currentTokensRaw(): Promise<string | null> {
    try {
      return await this.config.storage.get("tokens");
    } catch (error) {
      throw storageError("read tokens", error);
    }
  }

  /** Whether the stored `tokens` record is still exactly `raw`. */
  private async tokensStillCurrent(raw: string): Promise<boolean> {
    try {
      return (await this.config.storage.get("tokens")) === raw;
    } catch {
      // An unreadable store cannot confirm the pairing; the caller treats it
      // like a mismatch and re-reads, which surfaces the storage error.
      return false;
    }
  }

  /**
   * Write a profile fetched with `accessToken` back, only onto the slot and
   * token record it was fetched from.
   *
   * `tokens` and `user` are separate records, so a login running at the same
   * time can replace the token while the userinfo call is in flight. Writing
   * the answer unconditionally then leaves the new session's token beside the
   * previous account's profile — a pairing no later command can detect,
   * because the profile looks cached and `whoami` trusts a cached profile.
   * The guarded write makes the pairing itself the condition: it lands only
   * if the token record is still the bytes the userinfo call used, and the
   * caller re-reads the winner when it does not.
   *
   * `expectedUser` is the raw value the `user` slot held when the caller
   * decided it had no usable profile — `null` only when the key is absent,
   * never as a stand-in for "not a profile". A slot holding a damaged or
   * falsey value is exactly what this write exists to heal; expecting
   * absence there would refuse every attempt and pin the command to that
   * value forever.
   */
  private async writeBackProfile(
    rawTokens: string,
    expectedUser: string | null,
    user: UserInfo,
  ): Promise<boolean> {
    try {
      // One store call, not `get` + `set`: the check and the write have to
      // share a critical section, or the gap between them is the same race
      // one step smaller. The compare-and-swap primitive the store contract
      // already has writes one key conditioned on another's bytes; the
      // stores implement it so that a refused compare writes nothing at all,
      // including the key the compare read.
      return await this.config.storage.replaceIfUnchanged(
        "user",
        expectedUser,
        JSON.stringify(user),
        // The condition: `tokens` must still be the bytes userinfo ran with.
        { key: "tokens", expected: rawTokens },
      );
    } catch (error) {
      throw storageError("write user", error);
    }
  }

  /**
   * The stored profile, without any network call.
   *
   * It is deliberately *only* the profile: whether a credential is stored
   * beside it, and whether that credential could still work, are separate
   * questions, and `describeSavedSession` answers both together. Callers that
   * need to name an account the CLI can still act as must use that summary —
   * a cached name beside no credential is not a session (`logout` can leave
   * exactly that pair behind when one of its two deletes fails).
   *
   * "The stored profile" means one that passes `parseStoredProfile`: a slot
   * holding `[]`, `{}` or `{"sub":123}` is an empty slot to every reader,
   * including this one, so a caller never gets bytes back that `whoami`
   * would refuse. Never throws: a store it cannot read is reported as "no
   * profile", which is what the command's own credential access will hit
   * anyway.
   */
  async getCachedUser(): Promise<UserInfo | null> {
    try {
      return parseStoredProfile(await this.config.storage.get("user"));
    } catch {
      return null;
    }
  }

  /**
   * What a failed login left in the store, as far as reading it can say.
   *
   * Split from `getCachedUser` on purpose: the login-failure message used to
   * read "is there a cached name?" as "is there a session?", and both
   * directions of that are wrong. A usable token record with no `user` is a
   * state `login` itself can leave and every command still uses, and the
   * message called it "signed out". An expired token with no refresh token
   * sits beside a perfectly readable profile, and the message called that
   * account "still in use" while `getAccessToken()` returns null.
   *
   * The answer therefore carries two independent facts: whether the store
   * holds a credential-shaped `tokens` record (`state`), and which account
   * the pair names (`label`, when readable). "Usable" is a claim about the
   * record only — expiry and a refresh token, not a live check — because
   * nothing here may go to the network; the message built from it says the
   * attempt did not change it, not that it works.
   *
   * A record that is present but does not parse is `damaged`, not `none`.
   * `none` means there was never anything to read; a damaged record is
   * evidence that something was saved and can no longer be read, and the
   * message for `none` ("nothing was saved before this attempt either")
   * would be a claim about the past the store contradicts.
   */
  async describeSavedSession(): Promise<SavedSessionSummary> {
    let raw: string | null;
    try {
      raw = await this.config.storage.get("tokens");
    } catch {
      return { state: "unknown" };
    }
    if (raw === null) return { state: "none" };

    const tokens = parseStoredTokens(raw);
    if (!tokens) return { state: "damaged" };
    const state: SavedSessionState =
      tokens.expiresAt !== undefined &&
      tokens.expiresAt < Date.now() &&
      !tokens.refreshToken
        ? "expired"
        : "usable";

    // The label comes from the same shape rule `whoami` and `getCachedUser`
    // apply, so all three agree on what counts as a stored account: a slot
    // holding `[]` or `{"sub":123}` names nobody, and the page falls back to
    // its neutral copy instead of showing the parsed bytes. A store this read
    // cannot reach still leaves the state above standing — the label is the
    // optional half, and throwing here would turn a readable token record
    // into "unknown".
    let label: string | undefined;
    try {
      label = accountLabel(
        parseStoredProfile(await this.config.storage.get("user")),
      );
    } catch {
      label = undefined;
    }
    return { state, label };
  }

  async logout(): Promise<void> {
    try {
      // `tokens` and `user` are what every read uses. The legacy `session`
      // record is a leftover of the single-record layout an earlier build
      // wrote; nothing reads it, but it holds a whole access + refresh token
      // pair, and a build that still understands that layout would revive the
      // old account from it. Clearing it is cleanup, deliberately not a
      // merge: nothing from it may reach `tokens` or `user`, and a failure to
      // remove it fails the logout rather than being swallowed — a secret
      // left behind is what this is meant to prevent.
      const results = await Promise.allSettled([
        this.config.storage.delete("tokens"),
        this.config.storage.delete("user"),
        this.config.storage.delete(LEGACY_SESSION_KEY),
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

  /** The token record together with the exact bytes it was read from. */
  private async getStoredTokens(): Promise<{
    raw: string;
    tokens: TokenSet;
  } | null> {
    const raw = await this.currentTokensRaw();
    if (raw === null) return null;

    // The same shape rule `describeSavedSession` and `readCurrentSession`
    // apply. A record that is present but is not a token set is a storage
    // failure, not "signed out" and not a session: handing it to the refresh
    // and userinfo paths produces a bare TypeError or a `Bearer undefined`
    // request — and, on the second, the false claim that the user is signed
    // in. `raw` is returned to the caller as the write's expectation, so an
    // empty or damaged value still has somewhere to be compared against.
    const read = readStoredTokens(raw);
    if (!read.ok) {
      throw storageError(
        "parse stored tokens",
        read.reason === "shape"
          ? new Error("the saved token record is not a token set")
          : read.error,
      );
    }
    return { raw, tokens: read.tokens };
  }

  /**
   * Write a refreshed record back only onto the bytes it was computed from.
   *
   * Returns false when the stored `tokens` record changed while the refresh
   * was in flight — another `petdex login`, or another process's refresh.
   * The caller then keeps that record and drops this result: writing it would
   * pair the newer account's `user` with the older account's tokens and
   * destroy the newer session's refresh token.
   *
   * The comparison is byte-for-byte on the stored string rather than on the
   * parsed record. The store's unit is an opaque string, so bytes are the
   * only comparison that assumes nothing about JSON key order or number
   * formatting; a semantic compare would have to parse both sides and decide
   * what "equivalent" means, for no gain. A rewrite that carries the same
   * session in different bytes is refused too, which costs one extra read
   * (the caller falls back to that stored session) and can never write a
   * wrong value.
   *
   * Only `tokens` is compared and only `tokens` is written: `user` is
   * deliberately left alone, because a refresh never changes who the account
   * is — and if it did, the compare above would have refused the write.
   */
  private async writeBackRefresh(
    raw: string,
    value: TokenSet,
  ): Promise<boolean> {
    try {
      return await this.config.storage.replaceIfUnchanged(
        "tokens",
        raw,
        JSON.stringify(value),
      );
    } catch (error) {
      throw storageError("write tokens", error);
    }
  }

  private async getJson<T>(key: string): Promise<T | null> {
    return (await this.getRawJson<T>(key))?.value ?? null;
  }

  private async getRawJson<T>(
    key: string,
  ): Promise<{ raw: string; value: T } | null> {
    let raw: string | null;
    try {
      raw = await this.config.storage.get(key);
    } catch (error) {
      throw storageError(`read ${key}`, error);
    }
    // Only an absent key is "no record". An empty string is a stored value
    // that does not parse, which is reported as such: folding it into "no
    // record" would hand a caller `null` as the slot's expectation and make
    // its compare-and-swap refuse forever.
    if (raw === null) return null;

    try {
      return { raw, value: JSON.parse(raw) as T };
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

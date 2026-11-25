import { ClerkCliAuthError, type UserInfo } from "./types.js";

/**
 * What a failed login left behind, as far as a read of the store can say.
 *
 * The two questions the messages used to answer from one `getCachedUser()`
 * are different, and a profile alone answers neither:
 *
 * - `none`: no token record at all. Nothing was in effect to begin with.
 * - `damaged`: a token record is stored but cannot be read as one. Something
 *   *was* saved; saying "nothing was ever saved" would be a claim the store
 *   contradicts, and saying it is usable would be one the bytes cannot back.
 * - `expired`: a token record that has run out and has no refresh token to
 *   renew it. A profile may well sit beside it; it names an account, not a
 *   usable session.
 * - `usable`: a token record that has not expired, or has a refresh token.
 *   Still not proof — a revoked token reads the same — which is why the
 *   message below says the attempt did not change it, not that it works.
 * - `unknown`: the store could not be read. The attempt may or may not have
 *   written something, and nothing about the account can be claimed.
 */
export type SavedSessionState =
  | "none"
  | "damaged"
  | "expired"
  | "usable"
  | "unknown";

export interface SavedSessionSummary {
  state: SavedSessionState;
  /** The account the stored pair names, when the store reads far enough. */
  label?: string;
}

/**
 * The name a person recognises for an account: the email they signed in
 * with, then a username, then the opaque subject as the last resort. Shared
 * by the terminal and the callback page so both name the same account with
 * the same string.
 */
export function accountLabel(
  user: UserInfo | null | undefined,
): string | undefined {
  for (const value of [user?.email, user?.username, user?.sub]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * How a saved session failed to work, in terms the reader can act on.
 *
 * The categories match the callback page's failure reasons, so the terminal
 * and the browser tell the same story about the same login: "not signed in"
 * is reserved for a store that genuinely holds no session, because a locked
 * keychain, a profile-endpoint outage and an expired refresh token each have
 * a different fix and none of them is `petdex login` alone.
 */
export function describeAuthFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof ClerkCliAuthError ? error.code : undefined;
  switch (code) {
    case "userinfo":
      return `Signed in, but your profile couldn't be loaded (${detail}). Try again, or run \`petdex login\`.`;
    case "storage":
      return `Your saved credentials couldn't be read on this machine (${detail}). Run \`petdex logout\`, then \`petdex login\`.`;
    case "token_expired":
      return `Your saved session has expired (${detail}). Run \`petdex login\` to sign in again.`;
    case "refresh_failed":
      return `Your saved session couldn't be checked with the sign-in service (${detail}). It has not been changed; try again once the service is reachable, or run \`petdex login\` if the problem is your account.`;
    case "config":
      return `The CLI's sign-in configuration is wrong (${detail}).`;
    default:
      return "Not signed in.";
  }
}

/**
 * Turn a failed `petdex login` into what the terminal should say.
 *
 * What survived a failed login depends on where it failed, and the message
 * must not claim more than the write sequence allows:
 *
 * - `userinfo`: the profile call runs before anything is written, so the
 *   stored `tokens` + `user` pair is untouched. The caller reads it from the
 *   store, no network call.
 * - `storage`: `tokens` are written before `user`, so a failure can leave the
 *   new token with no profile, or the old profile already cleared. Which
 *   account the CLI now acts as is exactly what the terminal must not guess;
 *   `petdex whoami` answers it.
 * - `timeout` / `config`: nothing reached storage.
 *
 * The sentence about the old session is built from `SavedSessionSummary`,
 * because the two facts it needs are independent: a stored profile does not
 * mean the credential works (an expired token with no refresh token sits
 * beside one and `getAccessToken()` still returns null), and a missing
 * profile does not mean there is no credential (a token record with no
 * `user` is a state `login` can leave and every command still uses). So the
 * message names an account only when the store pairs one with a credential,
 * says only that the attempt did not change what was saved, and never
 * announces a sign-out the store cannot prove.
 */
export function describeLoginFailure(
  error: unknown,
  previous?: SavedSessionSummary,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof ClerkCliAuthError ? error.code : undefined;
  const kept = describeSavedSession(previous);

  if (code === "userinfo") {
    return `This sign-in wasn't saved: your profile couldn't be loaded (${detail}). ${kept}`;
  }
  if (code === "storage") {
    return `This sign-in may not have been saved: the credentials couldn't be written on this machine (${detail}). Run \`petdex whoami\` to see which account is in effect, and \`petdex login\` if it is not the one you wanted.`;
  }
  if (code === "timeout") {
    return `This sign-in timed out before it completed and was not saved. ${kept}`;
  }
  if (code === "refresh_failed") {
    return `Your saved session couldn't be checked with the sign-in service (${detail}). It was not changed; try again, or run \`petdex login\` if it keeps failing.`;
  }
  if (code === "config") {
    return `This sign-in couldn't start (${detail}).`;
  }
  if (code === "token_expired") {
    return `Your saved session has expired (${detail}). Run \`petdex login\` to sign in again.`;
  }

  const m = detail.toLowerCase();
  if (m.includes("invalid_client") || m.includes("client does not exist")) {
    return [
      "Clerk OAuth rejected this CLI build (invalid_client).",
      "This usually means your installed CLI is out of date. Try:",
      "  npm cache clean --force && npx -y petdex@latest login",
      "If it still fails: https://github.com/crafter-station/petdex/issues",
    ].join("\n");
  }
  if (
    m.includes("invalid_grant") ||
    m.includes("does not match the redirect")
  ) {
    return [
      "OAuth callback was rejected by Clerk (invalid_grant).",
      "Common cause: you closed the browser before approving, or the local",
      "callback server timed out. Try `petdex login` again.",
    ].join("\n");
  }
  if (m.includes("redirect_uri") && m.includes("pre-registered")) {
    return [
      "Clerk OAuth rejected the local callback URL.",
      "The petdex OAuth Application needs http://127.0.0.1 in its allowed",
      "redirect URLs. Please file an issue:",
      "  https://github.com/crafter-station/petdex/issues",
    ].join("\n");
  }
  return detail;
}

/**
 * The one-sentence account of what a failed login left in the store.
 *
 * Deliberately not a claim about usability: a read without the network
 * cannot tell a working token from a revoked one, so the strongest true
 * statement is that the attempt did not rewrite it.
 */
export function describeSavedSession(
  previous: SavedSessionSummary | undefined,
): string {
  if (!previous || previous.state === "unknown") {
    return "What was saved on this machine could not be checked; run `petdex whoami` to see which account is in effect.";
  }
  if (previous.state === "damaged") {
    return "A saved sign-in is stored on this machine but could not be checked; run `petdex whoami` to see which account is in effect.";
  }
  if (previous.state === "none") {
    return "No sign-in was saved before this attempt either; run `petdex whoami` to confirm.";
  }
  if (previous.label && previous.state === "expired") {
    return `Your previous sign-in (${previous.label}) is still saved, but that session has expired; run \`petdex login\` to sign in again.`;
  }
  if (previous.label) {
    return `Your previous sign-in (${previous.label}) is still saved, and this attempt did not change it.`;
  }
  return "A saved sign-in was not changed by this attempt; run `petdex whoami` to see which account is in effect.";
}

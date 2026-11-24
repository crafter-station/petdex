import { ClerkCliAuthError, type UserInfo } from "./types.js";

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
 *   stored `tokens` + `user` pair is untouched. The previous account can be
 *   named — the caller reads it from the store, no network call.
 * - `storage`: `tokens` are written before `user`, so a failure can leave the
 *   new token with no profile, or the old profile already cleared. Which
 *   account the CLI now acts as is exactly what the terminal must not guess;
 *   `petdex whoami` answers it.
 * - `timeout` / `config`: nothing reached storage.
 */
export function describeLoginFailure(
  error: unknown,
  previousAccount?: string,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof ClerkCliAuthError ? error.code : undefined;
  const kept = previousAccount
    ? `Your previous sign-in (${previousAccount}) is still saved and still in use.`
    : "Nothing was saved, and the CLI stays signed out.";

  if (code === "userinfo") {
    return `This sign-in wasn't saved: your profile couldn't be loaded (${detail}). ${kept}`;
  }
  if (code === "storage") {
    return `This sign-in may not have been saved: the credentials couldn't be written on this machine (${detail}). Run \`petdex whoami\` to see which account is in effect, and \`petdex login\` if it is not the one you wanted.`;
  }
  if (code === "timeout") {
    return `This sign-in timed out before it completed and was not saved. ${kept}`;
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

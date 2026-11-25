import { describe, expect, test } from "bun:test";

import {
  describeAuthFailure,
  describeLoginFailure,
  describeSavedSession,
} from "./cli-messages";
import { ClerkCliAuthError } from "./types";

describe("describeAuthFailure", () => {
  test("maps each code to its own actionable message", () => {
    expect(
      describeAuthFailure(new ClerkCliAuthError("userinfo", "503")),
    ).toContain("profile couldn't be loaded");
    expect(
      describeAuthFailure(new ClerkCliAuthError("storage", "locked")),
    ).toContain("couldn't be read on this machine");
    expect(
      describeAuthFailure(
        new ClerkCliAuthError("token_expired", "invalid_grant"),
      ),
    ).toContain("has expired");
    expect(
      describeAuthFailure(new ClerkCliAuthError("config", "bad issuer")),
    ).toContain("configuration is wrong");
    expect(describeAuthFailure(new Error("something"))).toBe("Not signed in.");
  });

  test("keeps the server detail visible", () => {
    expect(
      describeAuthFailure(new ClerkCliAuthError("userinfo", "HTTP 503")),
    ).toContain("HTTP 503");
  });
});

describe("describeLoginFailure", () => {
  test("a failed re-login says nothing was saved and names the kept account", () => {
    const message = describeLoginFailure(
      new ClerkCliAuthError("userinfo", "HTTP 503"),
      { state: "usable", label: "old@example.test" },
    );
    expect(message).toContain("wasn't saved");
    expect(message).toContain("old@example.test");
    // The read cannot know the token still works, so the sentence stops at
    // "this attempt did not change it".
    expect(message).toContain(
      "still saved, and this attempt did not change it",
    );
    // The wording the reviewer caught: the CLI did not switch accounts, so
    // the terminal must not open with "Signed in".
    expect(message).not.toMatch(/^Signed in/);
  });

  test("with no stored credential it says so instead of naming an account", () => {
    // The state the old message misread: a missing or damaged token record.
    // The profile may be readable, but no command could act as that account.
    const message = describeLoginFailure(
      new ClerkCliAuthError("userinfo", "HTTP 503"),
      { state: "none", label: "old@example.test" },
    );
    expect(message).toContain("No sign-in was saved before this attempt");
    expect(message).not.toContain("old@example.test");
  });

  test("a storage failure points at whoami instead of guessing the account", () => {
    // The token is written before the profile, so this failure can leave the
    // new sign-in half saved. Naming the previous account here would be a
    // guess the CLI cannot back up.
    const message = describeLoginFailure(
      new ClerkCliAuthError("storage", "full"),
      { state: "usable", label: "old@example.test" },
    );
    expect(message).toContain("may not have been saved");
    expect(message).toContain("petdex whoami");
    expect(message).not.toContain("old@example.test");
  });

  test("a timeout keeps the previous account when one is usable", () => {
    const message = describeLoginFailure(
      new ClerkCliAuthError("timeout", "2min"),
      { state: "usable", label: "old@example.test" },
    );
    expect(message).toContain("timed out");
    expect(message).toContain("old@example.test");
  });

  test("maps timeout, config and the provider-specific exchanges", () => {
    expect(
      describeLoginFailure(new ClerkCliAuthError("config", "issuer")),
    ).toContain("couldn't start");
    expect(
      describeLoginFailure(
        new ClerkCliAuthError("token_exchange", "invalid_client rejected"),
      ),
    ).toContain("out of date");
    expect(
      describeLoginFailure(
        new ClerkCliAuthError("token_exchange", "invalid_grant"),
      ),
    ).toContain("petdex login");
    expect(
      describeLoginFailure(
        new Error("redirect_uri must be pre-registered in the Clerk Dashboard"),
      ),
    ).toContain("petdex OAuth Application");
  });
});

describe("describeSavedSession", () => {
  // The two states the old one-line message conflated. Each is a real store
  // shape the CLI can hold, and each must reach a sentence that neither
  // claims a sign-out it cannot prove nor a session it cannot check.
  test("a usable credential with no cached name is not called signed out", () => {
    // `tokens` with a live expiry and no `user` record: every command still
    // gets a bearer from it, and login itself can leave this state.
    const message = describeSavedSession({ state: "usable" });
    expect(message).toBe(
      "A saved sign-in was not changed by this attempt; run `petdex whoami` to see which account is in effect.",
    );
    expect(message).not.toContain("signed out");
  });

  test("an expired credential beside a cached name is not called still in use", () => {
    // `expiresAt` in the past and no refresh token: `getAccessToken()` is
    // null, so "still in use" would be false no matter that the profile reads.
    const message = describeSavedSession({
      state: "expired",
      label: "old@example.test",
    });
    expect(message).toContain("has expired");
    expect(message).not.toContain("did not change it");
  });

  test("an unreadable store claims nothing about the account", () => {
    const message = describeSavedSession({ state: "unknown" });
    expect(message).toContain("could not be checked");
    expect(message).not.toContain("signed out");
  });

  test("no summary at all — the login never reached the store read", () => {
    expect(describeSavedSession(undefined)).toContain("could not be checked");
  });
});

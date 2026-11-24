import { describe, expect, test } from "bun:test";

import { describeAuthFailure, describeLoginFailure } from "./cli-messages";
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
      "old@example.test",
    );
    expect(message).toContain("wasn't saved");
    expect(message).toContain("old@example.test");
    expect(message).toContain("still saved and still in use");
    // The wording the reviewer caught: the CLI did not switch accounts, so
    // the terminal must not open with "Signed in".
    expect(message).not.toMatch(/^Signed in/);
  });

  test("with no usable stored account it says so instead of naming one", () => {
    // `getCachedUser` returns null when the token record is missing or
    // damaged, so this is the branch a half-written store reaches: the
    // profile may be readable, but no command could act as that account.
    const message = describeLoginFailure(
      new ClerkCliAuthError("userinfo", "HTTP 503"),
    );
    expect(message).toContain("No usable sign-in is stored");
    expect(message).not.toContain("previous sign-in");
  });

  test("a storage failure points at whoami instead of guessing the account", () => {
    // The token is written before the profile, so this failure can leave the
    // new sign-in half saved. Naming the previous account here would be a
    // guess the CLI cannot back up.
    const message = describeLoginFailure(
      new ClerkCliAuthError("storage", "full"),
      "old@example.test",
    );
    expect(message).toContain("may not have been saved");
    expect(message).toContain("petdex whoami");
    expect(message).not.toContain("old@example.test");
  });

  test("a timeout keeps the previous account when one is usable", () => {
    const message = describeLoginFailure(
      new ClerkCliAuthError("timeout", "2min"),
      "old@example.test",
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

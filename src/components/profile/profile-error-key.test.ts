import { describe, expect, it } from "bun:test";

import { profileErrorKey } from "./profile-error-key";

// Both profile editors (the inline one on /u/[handle] and the dashboard card
// on /my-pets) PATCH the same route, so they share this mapping. The route
// answers with an internal code, never a sentence; a panel that rendered the
// code through `error.replace(/_/g, " ")` showed "HANDLE TAKEN" on every
// locale. Pins every code `validateProfileHandle` can put on the wire, and
// returns null for anything unrecognised so the caller can still render
// `errors.failed` with the code.
describe("profileErrorKey", () => {
  it("maps every code the route can send", () => {
    const codes: Array<[string, string]> = [
      ["unauthorized", "unauthorized"],
      ["rate_limited", "rateLimited"],
      ["invalid_display_name", "invalidDisplayName"],
      ["invalid_handle", "invalidHandle"],
      ["handle_invalid_format", "invalidHandle"],
      ["handle_too_short", "handleTooShort"],
      ["handle_too_long", "handleTooLong"],
      ["handle_reserved", "handleReserved"],
      ["handle_taken", "handleTaken"],
      ["invalid_bio", "invalidBio"],
      ["invalid_featured", "invalidFeatured"],
      ["pin_cap_reached", "pinCapReached"],
      ["pet_not_owned_or_not_approved", "petNotOwned"],
      ["nothing_to_update", "nothingToUpdate"],
    ];
    for (const [code, key] of codes) {
      expect(profileErrorKey(code), code).toBe(key);
    }
  });

  it("returns null for an unrecognised code or no error", () => {
    expect(profileErrorKey("something_new")).toBeNull();
    expect(profileErrorKey(null)).toBeNull();
  });
});

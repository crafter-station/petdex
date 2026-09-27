import { describe, expect, test } from "bun:test";

// Imports the leaf module the server cap is defined in, not the route or the
// shared input validator: collection-constants.ts has no imports of its own, so
// the CLI's tsconfig can resolve it without the app's `@/` alias. This mirrors
// asset-hosts.test.ts, which pins the CLI allowlist to the server's the same
// way.
import { MAX_COLLECTION_PETS as SERVER_MAX_COLLECTION_PETS } from "../../../src/lib/collection-constants";
import { MAX_COLLECTION_PETS } from "./collections";

// The CLI cannot import the server's constant at runtime — it is published as a
// standalone package — so it carries its own copy. A copy with no test is a
// silent divergence: raising the server cap to 40 would leave the CLI refusing
// legitimate 30-pet creates, with every CLI test still green because they all
// compare against the local constant.
describe("collection limit sync with server", () => {
  test("MAX_COLLECTION_PETS matches the server-side cap", () => {
    expect(MAX_COLLECTION_PETS).toBe(SERVER_MAX_COLLECTION_PETS);
  });
});

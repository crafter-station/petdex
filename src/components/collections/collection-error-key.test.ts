import { describe, expect, it } from "bun:test";

import enMessages from "@/i18n/messages/en.json";
import esMessages from "@/i18n/messages/es.json";
import zhMessages from "@/i18n/messages/zh.json";
import {
  COLLECTION_ERROR_KEYS,
  collectionErrorKey,
} from "./collection-error-key";

// Both collection surfaces (the create/edit manager and the featured-collection
// editor) POST/PATCH the same route, so they share this mapping. The route
// answers with a code, never a sentence; a panel that rendered the code through
// `error.replace(/_/g, " ")` showed "INVALID URL" on every locale. The editor
// did exactly that for nine of the route's codes until it was pointed here.
describe("collectionErrorKey", () => {
  it("maps every code the collection route can send", () => {
    // Straight from the `error: "…"` literals in
    // src/app/api/profile/collection/route.ts.
    const codes = [
      "unauthorized",
      "forbidden",
      "not_found",
      "featured_not_editable",
      "invalid_url",
      "collection_pet_limit",
      "pet_not_owned_or_approved",
      "collection_cap_reached",
      "collection_slug_conflict",
      "empty_pet_slugs",
    ];
    for (const code of codes) {
      expect(collectionErrorKey(code), code).not.toBeNull();
    }
  });

  it("returns null for an unrecognised code so the caller can fall back", () => {
    expect(collectionErrorKey("some_future_code")).toBeNull();
    expect(collectionErrorKey(undefined)).toBeNull();
  });

  it("points every key at a message that exists in all three locales", () => {
    // A mapping to a missing key renders the key's own name — the failure this
    // whole table exists to prevent — so check the key, not just the mapping.
    const locales: Array<[string, Record<string, unknown>]> = [
      ["en", enMessages as unknown as Record<string, unknown>],
      ["es", esMessages as unknown as Record<string, unknown>],
      ["zh", zhMessages as unknown as Record<string, unknown>],
    ];
    for (const [name, messages] of locales) {
      const root = messages.ownerCollections as Record<string, unknown>;
      for (const key of Object.values(COLLECTION_ERROR_KEYS)) {
        expect(root[key], `${name}: ownerCollections.${key}`).toBeString();
      }
    }
  });
});

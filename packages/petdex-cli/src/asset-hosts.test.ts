import { describe, expect, test } from "bun:test";

import { listAllowedHosts } from "../../../src/lib/url-allowlist";
import { isTrustedAssetUrl, TRUSTED_ASSET_HOSTS } from "./asset-hosts";

describe("allowlist sync with server", () => {
  test("TRUSTED_ASSET_HOSTS matches the server-side asset allowlist", () => {
    expect(new Set(TRUSTED_ASSET_HOSTS)).toEqual(new Set(listAllowedHosts()));
  });

  test("every server-allowed asset URL is accepted by the CLI", () => {
    for (const host of listAllowedHosts()) {
      expect(
        isTrustedAssetUrl(`https://${host}/pets/boba/spritesheet.webp`),
      ).toBe(true);
    }
  });
});

describe("isTrustedAssetUrl", () => {
  test("accepts the canonical asset host", () => {
    expect(
      isTrustedAssetUrl("https://assets.petdex.dev/pets/boba/spritesheet.webp"),
    ).toBe(true);
  });

  test("rejects the retired R2 worker host", () => {
    expect(
      isTrustedAssetUrl(
        "https://petdex-assets.raillyhugo.workers.dev/pets/boba/spritesheet.webp",
      ),
    ).toBe(false);
  });

  test("rejects the retired R2 public bucket host", () => {
    expect(
      isTrustedAssetUrl(
        "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/boba/spritesheet.webp",
      ),
    ).toBe(false);
  });

  test("rejects http (must be https)", () => {
    expect(
      isTrustedAssetUrl("http://assets.petdex.dev/pets/boba/spritesheet.webp"),
    ).toBe(false);
  });

  test("rejects an unknown host even on https", () => {
    expect(isTrustedAssetUrl("https://attacker.example.com/pet.json")).toBe(
      false,
    );
  });

  test("rejects javascript: / data: / file: pseudo-URLs", () => {
    expect(isTrustedAssetUrl("javascript:alert(1)")).toBe(false);
    expect(isTrustedAssetUrl("data:text/html,evil")).toBe(false);
    expect(isTrustedAssetUrl("file:///etc/passwd")).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(isTrustedAssetUrl("not a url")).toBe(false);
    expect(isTrustedAssetUrl("")).toBe(false);
  });

  test("rejects subdomain spoof attempts", () => {
    expect(isTrustedAssetUrl("https://attacker.r2.dev/x")).toBe(false);
    // A hostname suffix attack must not slip through a substring match.
    expect(
      isTrustedAssetUrl(
        "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev.attacker.com/x",
      ),
    ).toBe(false);
  });
});

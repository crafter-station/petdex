import { describe, expect, it } from "bun:test";

import {
  fetchManifest,
  parseCompactManifest,
  parseLegacyManifest,
  parseManifestPayload,
} from "./manifest";

const compact = {
  v: 2,
  generatedAt: "2026-08-25T00:00:00.000Z",
  total: 1,
  assetBase: "https://assets.petdex.dev",
  fields: [
    "slug",
    "displayName",
    "kind",
    "submittedBy",
    "spritesheet",
    "petJson",
    "zip",
    "spriteVersionNumber",
  ],
  pets: [
    [
      "demo",
      "Demo",
      "character",
      null,
      "pets/demo/sprite.webp",
      "pets/demo/pet.json",
      null,
      2,
    ],
  ],
};

const legacy = {
  total: 1,
  pets: [
    {
      slug: "demo",
      displayName: "Demo",
      kind: "character",
      submittedBy: null,
      spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
      petJsonUrl: "https://assets.petdex.dev/pets/demo/pet.json",
      zipUrl: null,
    },
  ],
};

describe("manifest parsing", () => {
  it("parses compact v2 rows and resolves asset references", () => {
    expect(parseCompactManifest(compact)).toEqual([
      {
        slug: "demo",
        displayName: "Demo",
        kind: "character",
        submittedBy: null,
        spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        petJsonUrl: "https://assets.petdex.dev/pets/demo/pet.json",
        zipUrl: null,
        spriteVersionNumber: 2,
      },
    ]);
  });

  it("parses legacy rows and defaults an omitted version to v1", () => {
    expect(parseLegacyManifest(legacy)[0]?.spriteVersionNumber).toBe(1);
    expect(parseManifestPayload(legacy)).toHaveLength(1);
  });

  it("rejects malformed or untrusted rows", () => {
    expect(() =>
      parseCompactManifest({ ...compact, fields: ["wrong"] }),
    ).toThrow("compact manifest fields");
    expect(() =>
      parseCompactManifest({
        ...compact,
        pets: [[...compact.pets[0].slice(0, 7), 3]],
      }),
    ).toThrow("compact manifest pet");
    expect(() =>
      parseLegacyManifest({
        ...legacy,
        pets: [
          {
            ...legacy.pets[0],
            spritesheetUrl: "https://example.test/sprite.webp",
          },
        ],
      }),
    ).toThrow("untrusted asset host");
  });
});

describe("manifest endpoint compatibility", () => {
  it("prefers v2 and does not request the legacy endpoint", async () => {
    const requested: string[] = [];
    const pets = await fetchManifest("https://petdex.test", async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify(compact), {
        headers: { "content-type": "application/json" },
      });
    });
    expect(pets).toHaveLength(1);
    expect(requested).toEqual(["https://petdex.test/api/manifest/v2"]);
  });

  it("falls back to the legacy endpoint when v2 is unavailable", async () => {
    const requested: string[] = [];
    const pets = await fetchManifest("https://petdex.test", async (url) => {
      requested.push(String(url));
      if (requested.length === 1) return new Response("", { status: 500 });
      return new Response(JSON.stringify(legacy), {
        headers: { "content-type": "application/json" },
      });
    });
    expect(pets[0]?.slug).toBe("demo");
    expect(requested).toEqual([
      "https://petdex.test/api/manifest/v2",
      "https://petdex.test/api/manifest",
    ]);
  });

  it("reports both endpoint failures", async () => {
    await expect(
      fetchManifest(
        "https://petdex.test",
        async () => new Response("", { status: 503 }),
      ),
    ).rejects.toThrow("manifest unavailable");
  });
});

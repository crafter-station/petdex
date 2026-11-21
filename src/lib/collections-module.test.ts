import { describe, expect, it } from "bun:test";

import {
  type CollectionsStorePort,
  collectionsModule,
  createCollectionsModule,
  type OwnerCollectionSummary,
  type PetCollectionWithPets,
} from "@/lib/collections-module";
import type { PetWithMetrics } from "@/lib/pets";

function makePet(slug: string): PetWithMetrics {
  return {
    id: `pet-${slug}`,
    slug,
    displayName: slug,
    description: `Pet ${slug}`,
    spritesheetPath: `https://assets.example.test/${slug}.png`,
    petJsonPath: `https://assets.example.test/${slug}.json`,
    spriteVersionNumber: 2,
    soundUrl: null,
    approvalState: "approved",
    kind: "creature",
    vibes: ["cozy"],
    tags: [],
    dominantColor: null,
    colorFamily: null,
    source: "submit",
    approvedAt: "2026-01-01T00:00:00.000Z",
    importedAt: "2026-01-01T00:00:00.000Z",
    qa: {},
    metrics: {
      installCount: 0,
      zipDownloadCount: 0,
      likeCount: 0,
    },
  };
}

function makeCollection(
  overrides: Partial<PetCollectionWithPets> & { slug: string; title: string },
): PetCollectionWithPets {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: `col-${overrides.slug}`,
    description: "",
    ownerId: "user-1",
    externalUrl: null,
    coverPetSlug: null,
    featured: false,
    createdAt: now,
    updatedAt: now,
    pets: [],
    ...overrides,
  };
}

function createInMemoryStore(records: PetCollectionWithPets[]) {
  const calls = {
    getPublicBySlug: [] as Array<{ slug: string; limit?: number }>,
    listPublicBySlugs: [] as Array<{
      slugs: readonly string[];
      limit?: number;
    }>,
    listOwnerCollections: [] as Array<{
      ownerId: string;
      petsPerPreview?: number | null;
    }>,
  };

  const store: CollectionsStorePort = {
    async getPublicBySlug(slug, limit) {
      calls.getPublicBySlug.push({ slug, limit });
      return records.find((item) => item.slug === slug) ?? null;
    },
    async listPublicBySlugs(slugs, limit) {
      calls.listPublicBySlugs.push({ slugs, limit });
      const allowed = new Set(slugs);
      return records.filter((item) => allowed.has(item.slug)).reverse();
    },
    async listOwnerCollections(ownerId, petsPerPreview) {
      calls.listOwnerCollections.push({ ownerId, petsPerPreview });
      return records
        .filter((item) => item.ownerId === ownerId)
        .map<OwnerCollectionSummary>((item) => ({
          ...item,
          petCount: item.pets.length,
        }));
    },
  };

  return { store, calls };
}

describe("CollectionsModule", () => {
  describe("limits", () => {
    it("exposes a single frozen source of truth for collection limits", () => {
      expect(collectionsModule.limits).toEqual({
        maxOwnerCollections: 10,
        maxPetsPerCollection: 24,
        maxTitleLength: 80,
        maxDescriptionLength: 280,
        slugAttempts: 20,
      });
      expect(Object.isFrozen(collectionsModule.limits)).toBe(true);
    });
  });

  describe("validateCreateInput", () => {
    const mod = createCollectionsModule();

    it("normalizes fields, deduplicates pet slugs, and defaults cover to first pet", () => {
      const result = mod.validateCreateInput({
        title: "  Cozy Squad  ",
        description: "  Desk buddies  ",
        petSlugs: [" Boba ", "boba", "Dora"],
        externalUrl: " https://example.test/squad ",
        allApproved: true,
      });

      expect(result).toEqual({
        ok: true,
        value: {
          title: "Cozy Squad",
          description: "Desk buddies",
          petSlugs: ["boba", "dora"],
          externalUrl: "https://example.test/squad",
          coverPetSlug: "boba",
          allApproved: true,
        },
      });
    });

    it("keeps an explicit blank cover as null instead of defaulting to first pet", () => {
      const result = mod.validateCreateInput({
        title: "Cozy Squad",
        petSlugs: ["boba", "dora"],
        coverPetSlug: "",
      });

      expect(result).toEqual({
        ok: true,
        value: {
          title: "Cozy Squad",
          description: "",
          petSlugs: ["boba", "dora"],
          externalUrl: null,
          coverPetSlug: null,
          allApproved: false,
        },
      });
    });

    it("rejects invalid bodies, lengths, caps, urls, and cover slugs", () => {
      expect(mod.validateCreateInput(null)).toEqual({
        ok: false,
        error: "invalid_body",
      });
      expect(
        mod.validateCreateInput({ title: "Valid", allApproved: "yes" }),
      ).toEqual({
        ok: false,
        error: "invalid_body",
      });
      expect(mod.validateCreateInput({ title: "x" })).toEqual({
        ok: false,
        error: "title_length",
      });
      expect(
        mod.validateCreateInput({ title: "Valid", description: 42 }),
      ).toEqual({
        ok: false,
        error: "description_type",
      });
      expect(
        mod.validateCreateInput({
          title: "Valid",
          description: "a".repeat(mod.limits.maxDescriptionLength + 1),
        }),
      ).toEqual({
        ok: false,
        error: "description_length",
      });
      expect(
        mod.validateCreateInput({
          title: "Valid",
          petSlugs: ["bad slug"],
        }),
      ).toEqual({
        ok: false,
        error: "pet_slug",
      });
      expect(
        mod.validateCreateInput({
          title: "Valid",
          petSlugs: Array.from(
            { length: mod.limits.maxPetsPerCollection + 1 },
            (_, i) => `pet-${i}`,
          ),
        }),
      ).toEqual({
        ok: false,
        error: "collection_pet_limit",
      });
      expect(
        mod.validateCreateInput({
          title: "Valid",
          externalUrl: "javascript:alert(1)",
        }),
      ).toEqual({
        ok: false,
        error: "external_url",
      });
      expect(
        mod.validateCreateInput({
          title: "Valid",
          coverPetSlug: "not valid!",
        }),
      ).toEqual({
        ok: false,
        error: "cover_pet_slug",
      });
    });
  });

  describe("validateUpdateInput", () => {
    const mod = createCollectionsModule();

    it("validates only fields present in the patch and keeps omitted fields absent", () => {
      const result = mod.validateUpdateInput({ title: "  Renamed  " });

      expect(result).toEqual({
        ok: true,
        value: { title: "Renamed" },
      });
      if (result.ok) {
        expect("description" in result.value).toBe(false);
        expect("petSlugs" in result.value).toBe(false);
        expect("coverPetSlug" in result.value).toBe(false);
        expect("externalUrl" in result.value).toBe(false);
      }
    });

    it("preserves existing cover when still a member and falls back when removed", () => {
      const kept = mod.validateUpdateInput(
        { petSlugs: ["first", "hero"] },
        { existingCoverPetSlug: "hero" },
      );
      expect(kept).toEqual({
        ok: true,
        value: { petSlugs: ["first", "hero"], coverPetSlug: "hero" },
      });

      const fallback = mod.validateUpdateInput(
        { petSlugs: ["first"] },
        { existingCoverPetSlug: "hero" },
      );
      expect(fallback).toEqual({
        ok: true,
        value: { petSlugs: ["first"], coverPetSlug: "first" },
      });

      const cleared = mod.validateUpdateInput(
        { petSlugs: ["first", "hero"], coverPetSlug: "" },
        { existingCoverPetSlug: "hero" },
      );
      expect(cleared).toEqual({
        ok: true,
        value: { petSlugs: ["first", "hero"], coverPetSlug: null },
      });
    });

    it("enforces growth limit while allowing legacy over-cap collections to stay editable or shrink", () => {
      const stored = Array.from(
        { length: mod.limits.maxPetsPerCollection + 4 },
        (_, i) => `pet-${i}`,
      );

      expect(
        mod.validateUpdateInput(
          { petSlugs: stored },
          { existingPetSlugs: stored },
        ).ok,
      ).toBe(true);

      expect(
        mod.validateUpdateInput(
          { petSlugs: stored.slice(0, -1) },
          { existingPetSlugs: stored },
        ).ok,
      ).toBe(true);

      expect(
        mod.validateUpdateInput(
          { petSlugs: [...stored.slice(0, -1), "pet-new"] },
          { existingPetSlugs: stored },
        ),
      ).toEqual({
        ok: false,
        error: "collection_pet_limit",
      });
    });
  });

  describe("buildSlug and isReservedSlug", () => {
    const mod = createCollectionsModule();

    it("builds normalized slugs and avoids trailing dashes at the length cap", () => {
      expect(mod.buildSlug("Lulu Capybara")).toBe("lulu-capybara");
      expect(mod.buildSlug("  Mixed_Case-Name  ")).toBe("mixed-case-name");
      const atBoundary = mod.buildSlug(`${"a".repeat(47)} ${"b".repeat(20)}`);
      expect(atBoundary).toBe("a".repeat(47));
      expect(atBoundary.endsWith("-")).toBe(false);
    });

    it("detects reserved slugs and falls back to a random slug when building them", () => {
      expect(mod.isReservedSlug("admin")).toBe(true);
      expect(mod.isReservedSlug("  Collections  ")).toBe(true);
      expect(mod.isReservedSlug("api")).toBe(true);
      expect(mod.isReservedSlug("cozy-squad")).toBe(false);
      expect(mod.isReservedSlug("   ")).toBe(false);

      expect(mod.buildSlug("admin")).toMatch(/^collection-[0-9a-f]{32}$/);
      expect(mod.buildSlug("   ")).toMatch(/^collection-[0-9a-f]{32}$/);
    });
  });

  describe("sortListings", () => {
    const mod = createCollectionsModule();

    it("pins priority franchise slugs first and sorts the rest by size by default or by title", () => {
      const input = [
        { slug: "zeta", title: "Zeta", petCount: 20 },
        {
          slug: "franchise-jojos-bizarre-adventure",
          title: "JoJo",
          petCount: 2,
        },
        { slug: "alpha", title: "Alpha", petCount: 5 },
        { slug: "franchise-pokemon", title: "Pokemon", petCount: 1 },
      ];

      const bySize = mod.sortListings(input);
      expect(bySize.map((item) => item.slug)).toEqual([
        "franchise-pokemon",
        "franchise-jojos-bizarre-adventure",
        "zeta",
        "alpha",
      ]);

      const byTitle = mod.sortListings(input, "title");
      expect(byTitle.map((item) => item.slug)).toEqual([
        "franchise-pokemon",
        "franchise-jojos-bizarre-adventure",
        "alpha",
        "zeta",
      ]);

      expect(input.map((item) => item.slug)).toEqual([
        "zeta",
        "franchise-jojos-bizarre-adventure",
        "alpha",
        "franchise-pokemon",
      ]);
    });
  });

  describe("store-backed queries through CollectionsStorePort", () => {
    const records: PetCollectionWithPets[] = [
      makeCollection({
        slug: "cozy-squad",
        title: "Cozy Squad",
        ownerId: "owner-1",
        featured: true,
        pets: [makePet("boba"), makePet("dora"), makePet("mochi")],
      }),
      makeCollection({
        slug: "pixel-cats",
        title: "Pixel Cats",
        ownerId: "owner-1",
        featured: false,
        pets: [makePet("nyan"), makePet("milo")],
      }),
      makeCollection({
        slug: "other-owner",
        title: "Other Owner",
        ownerId: "owner-2",
        featured: true,
        pets: [makePet("pico")],
      }),
    ];

    it("gets a public collection by normalized slug, caps pets, and short-circuits empty slugs", async () => {
      const { store, calls } = createInMemoryStore(records);
      const mod = createCollectionsModule({ store });

      expect(await mod.getPublicBySlug("   ")).toBeNull();
      expect(calls.getPublicBySlug).toHaveLength(0);

      const found = await mod.getPublicBySlug("  Cozy-Squad ", 2);
      expect(found?.slug).toBe("cozy-squad");
      expect(found?.pets.map((p) => p.slug)).toEqual(["boba", "dora"]);
      expect(calls.getPublicBySlug).toEqual([{ slug: "cozy-squad", limit: 2 }]);
    });

    it("lists public collections in requested slug order, deduplicating and skipping missing slugs", async () => {
      const { store, calls } = createInMemoryStore(records);
      const mod = createCollectionsModule({ store });

      expect(await mod.listPublicBySlugs(["", "   "])).toEqual([]);
      expect(calls.listPublicBySlugs).toHaveLength(0);

      const list = await mod.listPublicBySlugs(
        [" Pixel-Cats ", "missing", "cozy-squad", "pixel-cats"],
        1,
      );
      expect(list.map((item) => item.slug)).toEqual([
        "pixel-cats",
        "cozy-squad",
      ]);
      expect(list.map((item) => item.pets.map((p) => p.slug))).toEqual([
        ["nyan"],
        ["boba"],
      ]);
      expect(calls.listPublicBySlugs).toEqual([
        { slugs: ["pixel-cats", "missing", "cozy-squad"], limit: 1 },
      ]);
    });

    it("lists owner collections, preserves total petCount when preview-limited, and short-circuits blank ownerId", async () => {
      const { store, calls } = createInMemoryStore(records);
      const mod = createCollectionsModule({ store });

      expect(await mod.listOwnerCollections("   ")).toEqual([]);
      expect(calls.listOwnerCollections).toHaveLength(0);

      const preview = await mod.listOwnerCollections("  owner-1 ", 1);
      expect(preview.map((item) => item.slug)).toEqual([
        "cozy-squad",
        "pixel-cats",
      ]);
      expect(preview.map((item) => item.petCount)).toEqual([3, 2]);
      expect(preview.map((item) => item.pets.length)).toEqual([1, 1]);

      const full = await mod.listOwnerCollections("owner-1", null);
      expect(full.map((item) => item.pets.length)).toEqual([3, 2]);
    });
  });
});

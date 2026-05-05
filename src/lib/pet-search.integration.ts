// Integration tests for the gallery search / sort. Hits the real Postgres
// instance pointed at by DATABASE_URL — same shape the API route uses.
//
// Run: DATABASE_URL=... bun run test:db

import { describe, expect, it } from "bun:test";

import type { searchPets as searchPetsFn } from "@/lib/pet-search";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for pet-search integration tests");
}

async function loadSearchPets(): Promise<typeof searchPetsFn> {
  return (await import("@/lib/pet-search")).searchPets;
}

describe("searchPets", () => {
  it("returns pets and total > 0 with no filters", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({});
    expect(out.pets.length).toBeGreaterThan(0);
    expect(out.total).toBeGreaterThanOrEqual(out.pets.length);
    expect(out.facets.kinds).toBeDefined();
    expect(out.facets.vibes).toBeDefined();
    expect(out.facets.batches).toBeDefined();
  });

  it("sort=installed orders by installCount descending (regression #11)", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ sort: "installed", limit: 60 });
    expect(out.pets.length).toBeGreaterThan(1);
    for (let i = 1; i < out.pets.length; i++) {
      const prev = out.pets[i - 1].metrics.installCount;
      const curr = out.pets[i].metrics.installCount;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it("sort=popular orders by likeCount descending", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ sort: "popular", limit: 60 });
    expect(out.pets.length).toBeGreaterThan(1);
    for (let i = 1; i < out.pets.length; i++) {
      const prev = out.pets[i - 1].metrics.likeCount;
      const curr = out.pets[i].metrics.likeCount;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it("sort=alpha orders pets by displayName ascending", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ sort: "alpha", limit: 60 });
    expect(out.pets.length).toBeGreaterThan(1);
    // Postgres asc(displayName) orders by raw byte order (ASCII first),
    // not localeCompare. Validate that — the absence of an explicit locale
    // is a deliberate trade-off (cheap, no collation index) and
    // pets are mostly ASCII anyway.
    for (let i = 1; i < out.pets.length; i++) {
      const prev = out.pets[i - 1].displayName;
      const curr = out.pets[i].displayName;
      expect(prev <= curr).toBe(true);
    }
  });

  it("sort=curated puts featured pets first", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ sort: "curated", limit: 60 });
    let sawNonFeatured = false;
    for (const pet of out.pets) {
      if (!pet.featured) {
        sawNonFeatured = true;
      } else if (sawNonFeatured) {
        throw new Error(
          `Featured pet ${pet.slug} appeared after a non-featured one`,
        );
      }
    }
  });

  it("ties in sort=installed break by displayName ascending", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ sort: "installed", limit: 60 });
    for (let i = 1; i < out.pets.length; i++) {
      const a = out.pets[i - 1];
      const b = out.pets[i];
      if (a.metrics.installCount === b.metrics.installCount) {
        expect(a.displayName <= b.displayName).toBe(true);
      }
    }
  });

  it("vibes filter only returns pets with that vibe", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ vibes: ["cozy"], limit: 60 });
    if (out.pets.length === 0) return; // skip if dataset has no cozy
    for (const pet of out.pets) {
      expect(pet.vibes).toContain("cozy");
    }
  });

  it("kinds filter only returns pets of that kind", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ kinds: ["creature"], limit: 60 });
    if (out.pets.length === 0) return;
    for (const pet of out.pets) {
      expect(pet.kind).toBe("creature");
    }
  });

  it("batches filter only returns pets from that approval month", async () => {
    const searchPets = await loadSearchPets();
    const initial = await searchPets({ limit: 1 });
    const firstBatch = initial.facets.batches[0]?.key;
    if (!firstBatch) return;
    const out = await searchPets({ batches: [firstBatch], limit: 60 });
    if (out.pets.length === 0) return;
    for (const pet of out.pets) {
      expect(pet.approvedAt?.slice(0, 7)).toBe(firstBatch);
    }
  });

  it("q search hits displayName / description / tags", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ q: "otter", limit: 10 });
    if (out.pets.length === 0) return;
    for (const pet of out.pets) {
      const haystack = [pet.displayName, pet.description, ...pet.tags]
        .join(" ")
        .toLowerCase();
      expect(haystack).toContain("otter");
    }
  });

  it("pagination cursor returns disjoint slices", async () => {
    const searchPets = await loadSearchPets();
    const limit = 5;
    const first = await searchPets({ limit, sort: "alpha" });
    if (first.nextCursor == null) return; // dataset too small
    const second = await searchPets({
      limit,
      sort: "alpha",
      cursor: first.nextCursor,
    });
    const firstSlugs = new Set(first.pets.map((p) => p.slug));
    for (const pet of second.pets) {
      expect(firstSlugs.has(pet.slug)).toBe(false);
    }
  });

  it("limit is clamped to MAX_LIMIT", async () => {
    const searchPets = await loadSearchPets();
    const out = await searchPets({ limit: 9999 });
    expect(out.pets.length).toBeLessThanOrEqual(60);
  });
});

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { neonConfig } from "@neondatabase/serverless";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "./db/schema";

const client = new PGlite();
const fixture = drizzle(client, { schema });
let userId: string | null = "owner";
const invalidations: string[] = [];
mock.module("server-only", () => ({}));
mock.module("@clerk/nextjs/server", () => ({ auth: async () => ({ userId }) }));
mock.module("@/lib/mock/db", () => ({
  getMockDb: () => ({ db: fixture }),
  mockDbReady: async () => {},
}));
mock.module("@/lib/db/cached-aggregates", () => ({
  revalidateCollectionTags: async (slug: string) => {
    invalidations.push(slug);
  },
  invalidateCollectionBacklinks: async () => {},
}));
mock.module("@/lib/profiles", () => ({ validateProfileHandle: () => null }));

if (process.env.PETDEX_TEST_DB === "neon") {
  neonConfig.fetchFunction = async (_url: string, init?: RequestInit) => {
    type Query = { query: string; params: string[] };
    const payload = JSON.parse(String(init?.body)) as Query & {
      queries?: Query[];
    };
    const run = async (tx: Pick<PGlite, "query">, query: Query) => {
      const result = await tx.query<unknown[]>(
        query.query,
        query.params.map((value) =>
          value === "false" ? false : value === "true" ? true : value,
        ),
        { rowMode: "array" },
      );
      return {
        command: "SELECT",
        rowCount: result.affectedRows ?? result.rows.length,
        fields: result.fields,
        rows: result.rows.map((row) =>
          row.map((value, index) => {
            if (value === null) return null;
            if (value instanceof Date) return value.toISOString();
            if (typeof value === "boolean") return value ? "t" : "f";
            if ([114, 3802].includes(result.fields[index].dataTypeID))
              return JSON.stringify(value);
            return String(value);
          }),
        ),
      };
    };
    try {
      const result = payload.queries
        ? await client.transaction(async (tx) => {
            const results = [];
            for (const query of payload.queries ?? [])
              results.push(await run(tx, query));
            return { results };
          })
        : await run(client, payload);
      return Response.json(result);
    } catch (error) {
      return Response.json(
        {
          message: error instanceof Error ? error.message : String(error),
          code: "23514",
        },
        { status: 400 },
      );
    }
  };
}

await client.exec(`CREATE TABLE pet_collections (
  id text PRIMARY KEY, slug text UNIQUE NOT NULL, title text NOT NULL, description text NOT NULL,
  owner_id text, external_url text, cover_pet_slug text, featured boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pet_collection_items (
  collection_id text REFERENCES pet_collections(id) ON DELETE CASCADE, pet_slug text NOT NULL,
  position integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection_id, pet_slug)
);
CREATE TABLE submitted_pets (slug text PRIMARY KEY, owner_id text NOT NULL, status text NOT NULL);
CREATE TABLE user_profiles (
  user_id text PRIMARY KEY, display_name text, handle text, bio text, preferred_locale text DEFAULT 'en',
  featured_pet_slugs jsonb DEFAULT '[]', updated_at timestamptz DEFAULT now()
);`);
const { PATCH: legacyPatch } = await import(
  "@/app/api/profile/collection/route"
);
const { PATCH: personalPatch } = await import(
  "@/app/api/profile/collections/[id]/route"
);
const { POST: create } = await import("@/app/api/profile/collections/route");
const { db } = await import("./db/client");

function request(body: unknown, origin = "https://petdex.dev") {
  return new Request("https://petdex.dev/api/profile/collection", {
    method: "PATCH",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const editors = {
  personal: (body: unknown) =>
    personalPatch(request(body), {
      params: Promise.resolve({ id: "collection" }),
    }),
  legacy: (body: unknown) => legacyPatch(request(body)),
};
async function snapshot() {
  return {
    collections: await fixture
      .select()
      .from(schema.petCollections)
      .orderBy(asc(schema.petCollections.id)),
    members: await fixture
      .select()
      .from(schema.petCollectionItems)
      .orderBy(asc(schema.petCollectionItems.position)),
  };
}
async function seedCollection(petSlugs = ["mochi", "byte"]) {
  await fixture.insert(schema.petCollections).values({
    id: "collection",
    slug: "collection",
    title: "Original",
    description: "Keep me",
    externalUrl: "https://example.com/",
    ownerId: "owner",
    coverPetSlug: petSlugs[0],
  });
  await fixture.insert(schema.petCollectionItems).values(
    petSlugs.map((petSlug, index) => ({
      collectionId: "collection",
      petSlug,
      position: index + 1,
    })),
  );
}
async function expectInsertFailure(action: () => Promise<Response>) {
  let failure = "";
  try {
    await action();
  } catch (error) {
    failure =
      String(error) + (error instanceof Error ? String(error.cause) : "");
  }
  expect(failure).toContain("fail_boba");
}
async function failInsert() {
  await client.exec(
    "ALTER TABLE pet_collection_items ADD CONSTRAINT fail_boba CHECK (pet_slug <> 'boba')",
  );
}
beforeEach(async () => {
  userId = "owner";
  invalidations.length = 0;
  await client.exec(
    "ALTER TABLE pet_collection_items DROP CONSTRAINT IF EXISTS fail_boba; TRUNCATE pet_collection_items, pet_collections, submitted_pets, user_profiles CASCADE; INSERT INTO submitted_pets VALUES ('mochi', 'owner', 'approved'), ('byte', 'owner', 'approved'), ('boba', 'owner', 'approved'), ('pending', 'owner', 'pending'), ('foreign', 'someone-else', 'approved')",
  );
});
afterAll(async () => {
  await client.close();
});

for (const [name, edit] of Object.entries(editors))
  describe(name, () => {
    test("title-only edit preserves every omitted field and membership", async () => {
      await seedCollection();
      await fixture
        .update(schema.petCollections)
        .set({ description: "x".repeat(281) })
        .where(eq(schema.petCollections.id, "collection"));
      const before = await snapshot();
      expect((await edit({ title: "Renamed" })).status).toBe(200);
      const after = await snapshot();
      expect(after.members).toEqual(before.members);
      expect(after.collections[0]).toEqual({
        ...before.collections[0],
        title: "Renamed",
        updatedAt: after.collections[0].updatedAt,
      });
    });
    for (const petSlugs of [
      [],
      null,
      "mochi",
      [null],
      [""],
      ["pending"],
      ["foreign"],
      ["mochi", "missing"],
    ]) {
      test(`rejects invalid membership ${JSON.stringify(petSlugs)}`, async () => {
        await seedCollection();
        const before = await snapshot();
        expect((await edit({ title: "Would change", petSlugs })).status).toBe(
          400,
        );
        expect(await snapshot()).toEqual(before);
        expect(invalidations).toEqual([]);
      });
    }
    test("replacement removes dropped members, keeps order and explicit null cover", async () => {
      await seedCollection();
      expect(
        (
          await edit({
            petSlugs: [" BOBA ", "mochi", "boba"],
            coverPetSlug: null,
          })
        ).status,
      ).toBe(200);
      const state = await snapshot();
      expect(
        state.members.map(({ petSlug, position }) => [petSlug, position]),
      ).toEqual([
        ["boba", 1],
        ["mochi", 2],
      ]);
      expect([
        state.collections[0].title,
        state.collections[0].description,
        state.collections[0].coverPetSlug,
      ]).toEqual(["Original", "Keep me", null]);
    });
    test("failed replacement rolls back metadata and deleted members", async () => {
      await seedCollection();
      await failInsert();
      const before = await snapshot();
      await expectInsertFailure(() =>
        edit({ title: "Lost update", petSlugs: ["boba"] }),
      );
      expect(await snapshot()).toEqual(before);
      expect(invalidations).toEqual([]);
    });
    test("cover must be a member", async () => {
      await seedCollection();
      const before = await snapshot();
      expect((await edit({ coverPetSlug: "boba" })).status).toBe(400);
      expect(
        (await edit({ petSlugs: ["mochi"], coverPetSlug: "boba" })).status,
      ).toBe(400);
      expect(await snapshot()).toEqual(before);
    });
    for (const body of [
      null,
      [],
      { title: 1 },
      { description: null },
      { externalUrl: 1 },
      { coverPetSlug: {} },
    ])
      test(`rejects malformed body ${JSON.stringify(body)}`, async () => {
        await seedCollection();
        const before = await snapshot();
        expect((await edit(body)).status).toBe(400);
        expect(await snapshot()).toEqual(before);
      });
  });

for (const [name, save] of Object.entries({
  create: (body: unknown) => create(request(body)),
  legacy: editors.legacy,
}))
  describe(`${name} creation`, () => {
    test("failed member insert rolls back the new parent", async () => {
      await failInsert();
      await expectInsertFailure(() =>
        save({ title: "New collection", petSlugs: ["boba"] }),
      );
      expect(await snapshot()).toEqual({ collections: [], members: [] });
    });
    test("creates parent and ordered members together", async () => {
      const response = await save({
        title: "New collection",
        petSlugs: ["boba", "mochi"],
      });
      expect(response.status).toBe(200);
      const state = await snapshot();
      expect(state.collections).toHaveLength(1);
      expect([
        state.collections[0].title,
        state.collections[0].coverPetSlug,
        state.collections[0].ownerId,
        state.collections[0].featured,
      ]).toEqual(["New collection", "boba", "owner", false]);
      expect(state.members.map(({ petSlug }) => petSlug)).toEqual([
        "boba",
        "mochi",
      ]);
    });
  });

test("legacy preserves over-cap collections on replacement and refuses growth", async () => {
  const pets = Array.from({ length: 30 }, (_, i) => `pet-${i}`);
  for (const pet of pets)
    await client.query(
      "INSERT INTO submitted_pets VALUES ($1, 'owner', 'approved')",
      [pet],
    );
  await seedCollection(pets);
  expect(
    (await editors.legacy({ title: "Renamed", petSlugs: pets })).status,
  ).toBe(200);
  expect((await snapshot()).members).toHaveLength(30);
  const before = await snapshot();
  expect((await editors.legacy({ petSlugs: [...pets, "boba"] })).status).toBe(
    400,
  );
  expect(await snapshot()).toEqual(before);
  expect((await editors.legacy({ petSlugs: pets.slice(0, 26) })).status).toBe(
    200,
  );
  expect((await snapshot()).members).toHaveLength(26);
});
test("authorization and featured restrictions still precede writes", async () => {
  await seedCollection();
  const before = await snapshot();
  userId = null;
  for (const edit of Object.values(editors))
    expect((await edit({ title: "Denied" })).status).toBe(401);
  userId = "someone-else";
  expect((await editors.personal({ title: "Denied" })).status).toBe(404);
  userId = "owner";
  expect(
    (await legacyPatch(request({ title: "Denied" }, "https://evil.example")))
      .status,
  ).toBe(403);
  expect(await snapshot()).toEqual(before);
  await fixture
    .update(schema.petCollections)
    .set({ featured: true })
    .where(eq(schema.petCollections.id, "collection"));
  expect((await editors.personal({ title: "Denied" })).status).toBe(403);
});
test("uses the expected database adapter", () => {
  expect(typeof db.batch).toBe(
    process.env.PETDEX_TEST_DB === "neon" ? "function" : "undefined",
  );
});

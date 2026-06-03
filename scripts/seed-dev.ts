// Seed the local dev database with ~20 approved pets so the gallery,
// /u/<handle>, and pet detail pages have something to render after a
// fresh `bun run dev:docker`. Idempotent — re-running upserts the same
// rows by slug.
//
// Why we point at production R2 sprite URLs: contributors don't have
// R2 credentials. The sprites we reference are public OSS pets in the
// real bucket (CORS open). The image element happily fetches them and
// the gallery looks like the real thing without anyone copying assets.
//
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import { MOCK_USER } from "@/lib/mock";

type Idea = {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  status?: string;
};

const SPRITE_POOL = [
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/sabo-80c45eea390b/sprite.webp",
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/ghostface-67cb9e80b049/sprite.webp",
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/peri-the-owl-f84579a04c4c/sprite.webp",
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/curated/cash-cuy/spritesheet.webp",
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/xiaobai-6f1e63e04853/sprite.webp",
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/emma-745775f158a3/sprite.webp",
];

const PETJSON_POOL = [
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/sabo-80c45eea390b/petjson.json",
];

const ZIP_POOL = [
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/sabo-80c45eea390b/zip.zip",
];

// Cycle a small kind/vibe palette so the gallery filters render
// counts > 0 without having to call the auto-tag classifier.
const KIND_POOL = ["creature", "object", "character"] as const;
const VIBE_POOL = ["cozy", "playful", "focused", "mystical"];

const SEED_OWNER_ID = "user_seed_dev";
const SEED_OWNER_EMAIL = "seed@petdex.local";
const PERSONAL_SLUG_PREFIX = "my-";

function optionalEnv(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function ownerSlugSuffix(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 8);
}

async function main() {
  const ideasPath = new URL("../pets/ideas.json", import.meta.url);
  const raw = readFileSync(ideasPath, "utf8");
  const ideas = JSON.parse(raw) as Idea[];
  const sliceCount = Math.min(20, ideas.length);
  const slice = ideas.slice(0, sliceCount);

  let inserted = 0;
  let skipped = 0;
  let personalInserted = 0;
  let personalSkipped = 0;
  const now = new Date();

  for (let i = 0; i < slice.length; i++) {
    const idea = slice[i];
    const slug = idea.id.toLowerCase();

    const existing = await db.query.submittedPets.findFirst({
      where: eq(schema.submittedPets.slug, slug),
    });
    if (existing) {
      skipped++;
      continue;
    }

    const id = `pet_seed_${slug.replace(/[^a-z0-9]/g, "").slice(0, 16)}`;
    const sprite = SPRITE_POOL[i % SPRITE_POOL.length];
    const petJson = PETJSON_POOL[i % PETJSON_POOL.length];
    const zip = ZIP_POOL[i % ZIP_POOL.length];

    await db.insert(schema.submittedPets).values({
      id,
      slug,
      displayName: idea.name,
      description: idea.description,
      spritesheetUrl: sprite,
      petJsonUrl: petJson,
      zipUrl: zip,
      kind: KIND_POOL[i % KIND_POOL.length],
      vibes: [VIBE_POOL[i % VIBE_POOL.length]],
      tags: idea.tags ?? [],
      status: "approved",
      source: "discover",
      ownerId: SEED_OWNER_ID,
      ownerEmail: SEED_OWNER_EMAIL,
      creditName: "Petdex seed",
      creditUrl: "https://github.com/crafter-station/petdex",
      creditImage: null,
      approvedAt: now,
      // Stagger createdAt so 'recent' sort has interesting ordering.
      createdAt: new Date(now.getTime() - i * 60_000),
    });
    inserted++;
  }

  // Optional: seed a real Clerk user's profile so /u/me and
  // owner-only surfaces don't start empty in docker mode. The seed
  // script runs before any browser sign-in, so the real user id must be
  // provided explicitly as PETDEX_DEV_SEED_USER_ID.
  const configuredOwnerId = optionalEnv("PETDEX_DEV_SEED_USER_ID");
  const devOwnerId =
    configuredOwnerId ??
    (process.env.PETDEX_MOCK_AUTH === "1" ? MOCK_USER.userId : undefined);
  const usesMockOwner = devOwnerId === MOCK_USER.userId;
  const devOwnerHandle = usesMockOwner ? MOCK_USER.username : "me";
  const devOwnerName = usesMockOwner
    ? [MOCK_USER.firstName, MOCK_USER.lastName].filter(Boolean).join(" ")
    : "Local Developer";
  const hasPersonalPets = devOwnerId
    ? await db.query.submittedPets.findFirst({
        where: and(
          eq(schema.submittedPets.ownerId, devOwnerId),
          eq(schema.submittedPets.status, "approved"),
        ),
      })
    : null;
  const personalSlice =
    devOwnerId && !hasPersonalPets
      ? slice.slice(0, Math.min(6, slice.length))
      : [];
  const personalSlugSuffix = devOwnerId ? ownerSlugSuffix(devOwnerId) : "";
  const personalFeaturedSlugs: string[] = [];
  for (let i = 0; i < personalSlice.length; i++) {
    if (!devOwnerId) break;
    const idea = personalSlice[i];
    const slug = `${PERSONAL_SLUG_PREFIX}${personalSlugSuffix}-${idea.id.toLowerCase()}`;
    personalFeaturedSlugs.push(slug);

    const existing = await db.query.submittedPets.findFirst({
      where: eq(schema.submittedPets.slug, slug),
    });
    if (existing) {
      personalSkipped++;
      continue;
    }

    const id = `pet_personal_${personalSlugSuffix}_${idea.id
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16)}`;
    const sprite = SPRITE_POOL[(i + 2) % SPRITE_POOL.length];
    const petJson = PETJSON_POOL[i % PETJSON_POOL.length];
    const zip = ZIP_POOL[i % ZIP_POOL.length];

    await db.insert(schema.submittedPets).values({
      id,
      slug,
      displayName: idea.name,
      description: idea.description,
      spritesheetUrl: sprite,
      petJsonUrl: petJson,
      zipUrl: zip,
      kind: KIND_POOL[i % KIND_POOL.length],
      vibes: [VIBE_POOL[(i + 1) % VIBE_POOL.length]],
      tags: idea.tags ?? [],
      status: "approved",
      source: "submit",
      ownerId: devOwnerId,
      ownerEmail: null,
      creditName: devOwnerName,
      creditUrl: null,
      creditImage: null,
      approvedAt: now,
      createdAt: new Date(now.getTime() - (i + slice.length) * 60_000),
    });
    personalInserted++;
  }

  // A user_profile row for the seed owner so /u/petdex-seed renders.
  const handle = "petdex-seed";
  const profile = await db.query.userProfiles.findFirst({
    where: eq(schema.userProfiles.userId, SEED_OWNER_ID),
  });
  if (!profile) {
    await db.insert(schema.userProfiles).values({
      userId: SEED_OWNER_ID,
      handle,
      displayName: "Petdex Seed",
      bio: "Demo pets seeded for local dev. Sign in with your own account to submit a real one.",
      preferredLocale: "en",
      featuredPetSlugs: slice.slice(0, 3).map((idea) => idea.id.toLowerCase()),
    });
  }

  if (devOwnerId) {
    let seededProfileHandle = devOwnerHandle;
    const personalProfile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, devOwnerId),
    });
    if (!personalProfile) {
      const handleOwner = await db.query.userProfiles.findFirst({
        columns: { userId: true },
        where: eq(schema.userProfiles.handle, devOwnerHandle),
      });
      const handleForInsert =
        !handleOwner || handleOwner.userId === devOwnerId
          ? devOwnerHandle
          : `${devOwnerHandle}-${personalSlugSuffix}`;

      await db.insert(schema.userProfiles).values({
        userId: devOwnerId,
        handle: handleForInsert,
        displayName: devOwnerName,
        bio: "Local developer profile seeded for docker dev.",
        preferredLocale: "en",
        featuredPetSlugs: personalFeaturedSlugs.slice(0, 3),
      });
      seededProfileHandle = handleForInsert;
    } else if (
      personalFeaturedSlugs.length > 0 &&
      personalProfile.featuredPetSlugs.length === 0
    ) {
      await db
        .update(schema.userProfiles)
        .set({
          featuredPetSlugs: personalFeaturedSlugs.slice(0, 3),
          updatedAt: new Date(),
        })
        .where(eq(schema.userProfiles.userId, devOwnerId));
      seededProfileHandle = personalProfile.handle ?? devOwnerHandle;
    } else {
      seededProfileHandle = personalProfile.handle ?? devOwnerHandle;
    }
    console.log(
      `[seed-dev] personal profile available under /u/${seededProfileHandle}`,
    );
  }

  console.log(
    `[seed-dev] inserted=${inserted} skipped=${skipped} (${slice.length} ideas total)`,
  );
  if (devOwnerId) {
    console.log(
      `[seed-dev] personal inserted=${personalInserted} skipped=${personalSkipped} (${personalSlice.length} real-auth pets total)`,
    );
    if (hasPersonalPets) {
      console.log(
        "[seed-dev] personal seed skipped; real-auth user already has approved pets",
      );
    }
  }
  console.log(`[seed-dev] gallery seeded under /u/${handle}`);
}

main()
  .then(() => {
    // postgres-js keeps the pool open which holds the event loop. Force
    // exit so `bun run dev:docker` can move on to next dev.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

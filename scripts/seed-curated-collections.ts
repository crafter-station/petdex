// Seed ten curated collections owned by the Petdex team. Idempotent —
// re-running upserts the title/description/featured flag and re-syncs
// the item list (drops slugs that aren't approved anymore, preserves
// position order for the rest). Run after a manifest dump:
//
//   bun --env-file=.env.local scripts/seed-curated-collections.ts
//
// Slug picks are hand-curated from /tmp/pets-full.json against the
// regex matchers in our analysis pass, then trimmed to the most visually
// representative subset. When new pets land that fit a collection, add
// their slug to the list and re-run.

import { neon } from "@neondatabase/serverless";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";

import { invalidateCollectionBacklinks } from "../src/lib/db/cached-aggregates";
import * as schema from "../src/lib/db/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}
const db = drizzle(neon(process.env.DATABASE_URL), { schema });

type CuratedCollection = {
  id: string;
  slug: string;
  title: string;
  description: string;
  coverPetSlug: string;
  petSlugs: string[];
};

const COLLECTIONS: CuratedCollection[] = [
  {
    id: "col_graycraft",
    slug: "graycraft",
    title: "GRAYCRAFT",
    description:
      "Original mech IP by Kevin Wu: armored chibi pilots from the GRAYCRAFT series. Featured Creator Spotlight #1.",
    coverPetSlug: "graycraft4",
    petSlugs: [
      "graycraft4",
      "graycraft5",
      "graycraft6",
      "graycraft7",
      "ding-ding",
    ],
  },
  {
    id: "col_crafter_originals",
    slug: "crafter-originals",
    title: "Crafter Originals",
    description:
      "The Petdex foundation set: pets designed by the team behind the platform. Cozy, codex-themed, full of character.",
    coverPetSlug: "cash-cuy",
    petSlugs: [
      "cash-cuy",
      "byte-bunny",
      "cache-capy",
      "socksy",
      "cosmo",
      "prompt-penguin",
      "kebo",
      "nukey",
      "pixel-panda",
      "boxcat",
      "noir-webling",
      "scoop",
      "duo",
      "boba",
      "pedro-lapiz",
      "sunny",
      "canary",
      "chedarini",
      "octohack",
      "eagle",
    ],
  },
  {
    id: "col_coders_club",
    slug: "coders-club",
    title: "Coders Club",
    description:
      "Pets that ship code. Engineers, hackers, mascots of dev tools. Your terminal companions.",
    coverPetSlug: "octohack",
    petSlugs: [
      "octohack",
      "codex",
      "midudev",
      "cogwick",
      "clawdex",
      "byte-bunny",
      "denissexy-itier",
      "codeberg",
      "savage-codex-hacker",
      "macintosh",
      "elon",
      "mini-elon",
      "axel",
      "snoopy",
      "elfie",
      "barry",
      "steve-jobs",
      "bonzibuddy",
      "shrimpy",
    ],
  },
  {
    id: "col_cats_universe",
    slug: "cats-universe",
    title: "Cats Universe",
    description:
      "Felines of every variety. Catch them all, from Boxcat to Doraemon to that one round cat.",
    coverPetSlug: "mochi",
    petSlugs: [
      "mochi",
      "boxcat",
      "doraemon",
      "happy-cat",
      "calico",
      "marmalade",
      "nyami",
      "miso",
      "tilly",
      "foxat",
      "chonk",
      "siam",
      "figaro-2",
      "shrimpy",
      "harry-poptart",
      "ditta",
      "mallow",
      "whip",
      "emma",
      "sima",
    ],
  },
  {
    id: "col_robots_and_mechs",
    slug: "robots-and-mechs",
    title: "Robots & Mechs",
    description:
      "Steel companions. From WALL-E to Gundam to GRAYCRAFT: the synthetic side of the Pokédex.",
    coverPetSlug: "wall-e",
    petSlugs: [
      "wall-e",
      "wall-e-baby",
      "wall-e-2",
      "eve",
      "rx-78-2-gundam",
      "graycraft4",
      "graycraft5",
      "graycraft6",
      "graycraft7",
      "robocop",
      "bumblebee",
      "bolt",
      "clank",
      "bt-buddy",
      "nova-byte",
      "fangbyte",
      "mi-mo",
      "tachi",
    ],
  },
  {
    id: "col_wizards_and_mages",
    slug: "wizards-and-mages",
    title: "Wizards & Mages",
    description:
      "Spellcasters and arcane scholars. Pointy hats, glowing orbs, robes that swish.",
    coverPetSlug: "frieren-3",
    petSlugs: [
      "frieren-3",
      "frieren-4",
      "white-mage",
      "violet-mage",
      "vivi",
      "kiki",
      "elaina-2",
      "noctlet",
      "prism",
      "academicasi",
      "ruri",
      "ruri-2",
      "umbral",
      "lampy",
      "shmutzy",
      "monica",
      "gojo",
    ],
  },
  {
    id: "col_scientific_minds",
    slug: "scientific-minds",
    title: "Scientific Minds",
    description:
      "Great thinkers as tiny pets: Einstein, Ada Lovelace, Feynman, Shannon. Curated set by @daviddao.",
    coverPetSlug: "einstein",
    petSlugs: [
      "einstein",
      "ada-lovelace",
      "feynman",
      "shannon",
      "humboldt",
      "ostrom",
      "buddhist",
      "juergen-habermas",
    ],
  },
  {
    id: "col_anime_heroes",
    slug: "anime-heroes",
    title: "Anime Heroes",
    description:
      "Shonen and beyond: Luffy, Naruto, Goku, Nezuko, Gojo, Frieren. The greatest hits in chibi form.",
    coverPetSlug: "luffy",
    petSlugs: [
      "luffy",
      "luffy-2",
      "zoro",
      "sabo",
      "naruto",
      "itachi",
      "goku",
      "goku-blue",
      "yamcha",
      "nezuko",
      "kyojuro-rengoku",
      "gojo",
      "sukuna",
      "frieren-3",
      "frieren-4",
      "totoro",
    ],
  },
  {
    id: "col_dog_squad",
    slug: "dog-squad",
    title: "Dog Squad",
    description:
      "Good boys and girls. Shibas, retrievers, corgis, and that one suspicious DaoDun.",
    coverPetSlug: "golden-retriever",
    petSlugs: [
      "golden-retriever",
      "retriever",
      "aka-shiba",
      "kibshi",
      "max",
      "max-2",
      "milo",
      "daisy",
      "rio",
      "danny",
      "cinder",
      "jollio",
      "daodun-dog",
      "chedarini",
      "samo",
    ],
  },
  {
    id: "col_meme_lords",
    slug: "meme-lords",
    title: "Meme Lords",
    description:
      "Pepe, Wojak, Doodlebob, and the rest of the timeline turned into pets.",
    coverPetSlug: "pepe",
    petSlugs: [
      "pepe",
      "apupepe",
      "wojak",
      "batmeme",
      "doodlebob",
      "oo-ee-a-e-a-cat",
      "daodun",
      "daodun-dog",
      "mimi-love",
    ],
  },
  {
    id: "col_hunter_x_hunter",
    slug: "hunter-x-hunter",
    title: "Hunter x Hunter",
    description:
      "Heavens Arena to Chimera Ant: Gon, Killua, Hisoka, Netero. Nen-powered chibi companions from Yoshihiro Togashi's universe.",
    coverPetSlug: "killua",
    petSlugs: ["killua", "gon", "hisoka", "netero", "killu"],
  },
];

async function main() {
  console.log(`Seeding ${COLLECTIONS.length} curated collections...`);

  // Validate every petSlug is approved before we wire it up. Drop any
  // missing slugs with a warning so the seed never fails halfway through.
  const allSlugs = Array.from(
    new Set(COLLECTIONS.flatMap((c) => [c.coverPetSlug, ...c.petSlugs])),
  );
  const approved = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.status, "approved"),
        inArray(schema.submittedPets.slug, allSlugs),
      ),
    );
  const approvedSet = new Set(approved.map((r) => r.slug));
  console.log(
    `  ${approvedSet.size}/${allSlugs.length} requested slugs are approved`,
  );

  for (const col of COLLECTIONS) {
    const validPets = col.petSlugs.filter((s) => approvedSet.has(s));
    const missing = col.petSlugs.filter((s) => !approvedSet.has(s));
    const cover = approvedSet.has(col.coverPetSlug)
      ? col.coverPetSlug
      : (validPets[0] ?? null);

    if (validPets.length === 0) {
      console.warn(`  [skip] ${col.slug} — no valid pets`);
      continue;
    }
    if (missing.length > 0) {
      console.warn(
        `  [warn] ${col.slug} — missing slugs: ${missing.join(", ")}`,
      );
    }

    // Conflict on slug rather than id so existing community collections
    // with the same slug get adopted by the petdex team rather than
    // crashing the seed. The id we pick wins on insert and is left
    // alone on update.
    await db
      .insert(schema.petCollections)
      .values({
        id: col.id,
        slug: col.slug,
        title: col.title,
        description: col.description,
        ownerId: null,
        coverPetSlug: cover,
        featured: true,
      })
      .onConflictDoUpdate({
        target: schema.petCollections.slug,
        set: {
          title: col.title,
          description: col.description,
          ownerId: null,
          coverPetSlug: cover,
          featured: true,
          updatedAt: new Date(),
        },
      });

    // Look up the actual id (existing or freshly inserted) so item
    // inserts attach to the right row.
    const [{ id: collectionId }] = await db
      .select({ id: schema.petCollections.id })
      .from(schema.petCollections)
      .where(eq(schema.petCollections.slug, col.slug))
      .limit(1);

    const oldItems = await db
      .select({ slug: schema.petCollectionItems.petSlug })
      .from(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, collectionId));

    // Reset items: delete existing then insert in position order. Simpler
    // than diffing for an idempotent seed.
    await db
      .delete(schema.petCollectionItems)
      .where(eq(schema.petCollectionItems.collectionId, collectionId));

    await db.insert(schema.petCollectionItems).values(
      validPets.map((petSlug, position) => ({
        collectionId,
        petSlug,
        position,
      })),
    );

    await invalidateCollectionBacklinks(
      ...oldItems.map((row) => row.slug),
      ...validPets,
    );

    console.log(
      `  [ok] ${col.slug} (${validPets.length} pets, cover=${cover})`,
    );
  }

  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

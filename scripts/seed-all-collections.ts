// Seeds collections from the merged classification map. Two flavors:
//   - franchise-<slug> : franchises with >= MIN_FRANCHISE pets
//   - category-<slug>  : taxonomy categories with >= MIN_CATEGORY pets
//
// Read by:  scripts/.merged-classifications.json
// Idempotent. Re-run safe.
//
// Run:
//   bun --env-file .env.local scripts/seed-all-collections.ts --dry
//   bun --env-file .env.local scripts/seed-all-collections.ts

import { readFileSync } from "node:fs";

import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));
const dryRun = process.argv.includes("--dry");

const MIN_FRANCHISE = Number(
  process.argv.find((a) => a.startsWith("--min-franchise="))?.split("=")[1] ??
    2,
);
const MIN_CATEGORY = Number(
  process.argv.find((a) => a.startsWith("--min-category="))?.split("=")[1] ??
    8,
);

type Merged = {
  generatedAt: string;
  franchises: Record<string, string[]>;
  categories: Record<string, string[]>;
};

const data = JSON.parse(
  readFileSync("./scripts/.merged-classifications.json", "utf8"),
) as Merged;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Pretty title for category slugs (kebab → Title Case)
const CATEGORY_TITLES: Record<string, string> = {
  cat: "Cats",
  dog: "Dogs",
  bird: "Birds",
  fish: "Fish",
  reptile: "Reptiles",
  dinosaur: "Dinosaurs",
  dragon: "Dragons",
  horse: "Horses",
  bear: "Bears",
  rabbit: "Rabbits",
  fox: "Foxes",
  panda: "Pandas",
  raccoon: "Raccoons",
  hedgehog: "Hedgehogs",
  hamster: "Hamsters",
  frog: "Frogs",
  octopus: "Octopuses",
  monkey: "Monkeys",
  bug: "Bugs",
  "sea-creature": "Sea Creatures",
  "farm-animal": "Farm Animals",
  "exotic-animal": "Exotic Animals",
  witch: "Witches",
  mage: "Mages",
  wizard: "Wizards",
  knight: "Knights",
  warrior: "Warriors",
  elf: "Elves",
  fairy: "Fairies",
  demon: "Demons",
  angel: "Angels",
  ghost: "Ghosts",
  vampire: "Vampires",
  undead: "Undead",
  goblin: "Goblins",
  slime: "Slimes",
  eldritch: "Eldritch Horrors",
  robot: "Robots",
  mecha: "Mecha",
  cyborg: "Cyborgs",
  alien: "Aliens",
  spaceship: "Spaceships",
  ai: "AI Companions",
  hacker: "Hackers",
  terminal: "Terminal Pets",
  hologram: "Holograms",
  glitch: "Glitch Pets",
  coffee: "Coffee Lovers",
  tea: "Tea Time",
  boba: "Boba Pets",
  dessert: "Desserts",
  fruit: "Fruit Pets",
  snack: "Snack Pack",
  ramen: "Ramen Bowl",
  sushi: "Sushi",
  burger: "Burgers",
  pizza: "Pizza Pets",
  candy: "Candy",
  drink: "Drinks",
  developer: "Developers",
  designer: "Designers",
  intern: "Interns",
  manager: "Managers",
  qa: "QA",
  devops: "DevOps",
  "coffee-coder": "Coffee Coders",
  study: "Study Buddies",
  paperwork: "Paperwork Friends",
  "terminal-life": "Terminal Life",
  idol: "Idols",
  vocaloid: "Vocaloid",
  kpop: "K-Pop",
  jpop: "J-Pop",
  "rock-band": "Rock Bands",
  rapper: "Rappers",
  dj: "DJs",
  dancer: "Dancers",
  soccer: "Soccer",
  basketball: "Basketball",
  baseball: "Baseball",
  skateboarding: "Skateboarding",
  gym: "Gym Pets",
  runner: "Runners",
  meme: "Meme Lords",
  vaporwave: "Vaporwave",
  cyberpunk: "Cyberpunk",
  kawaii: "Kawaii",
  lofi: "Lofi",
  retro: "Retro",
  pixel: "Pixel Art",
  "pixel-art": "Pixel Art",
  glitchcore: "Glitchcore",
  y2k: "Y2K",
  gothic: "Gothic",
  punk: "Punk",
  streetwear: "Streetwear",
};

function titleFor(slug: string): string {
  return (
    CATEGORY_TITLES[slug] ??
    slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

async function upsertCollection(opts: {
  slug: string;
  title: string;
  description: string;
  petSlugs: string[];
}) {
  const { slug, title, description, petSlugs } = opts;

  if (dryRun) return;

  const existing = await sql`
    SELECT id FROM pet_collections WHERE slug = ${slug} LIMIT 1
  `;

  let collectionId: string;
  if (existing.length > 0) {
    collectionId = existing[0].id;
    await sql`
      UPDATE pet_collections
      SET title = ${title},
          description = ${description},
          featured = true,
          cover_pet_slug = ${petSlugs[0]},
          updated_at = now()
      WHERE id = ${collectionId}
    `;
  } else {
    collectionId = `col_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
    await sql`
      INSERT INTO pet_collections (
        id, slug, title, description, cover_pet_slug, featured
      ) VALUES (
        ${collectionId}, ${slug}, ${title}, ${description}, ${petSlugs[0]}, true
      )
    `;
  }

  let position = 0;
  for (const petSlug of petSlugs) {
    try {
      await sql`
        INSERT INTO pet_collection_items (
          collection_id, pet_slug, position
        ) VALUES (
          ${collectionId}, ${petSlug}, ${position++}
        )
        ON CONFLICT (collection_id, pet_slug) DO NOTHING
      `;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  skip ${petSlug}: ${msg}`);
    }
  }
}

const franchises = Object.entries(data.franchises)
  .filter(([, slugs]) => slugs.length >= MIN_FRANCHISE)
  .sort(([, a], [, b]) => b.length - a.length);

const categories = Object.entries(data.categories)
  .filter(([, slugs]) => slugs.length >= MIN_CATEGORY)
  .sort(([, a], [, b]) => b.length - a.length);

console.log(
  `\nseeding ${franchises.length} franchise + ${categories.length} category collections (mode=${dryRun ? "DRY" : "APPLY"})\n`,
);

console.log("--- FRANCHISES ---");
for (const [name, petSlugs] of franchises) {
  const slug = `franchise-${slugify(name)}`;
  const desc = `${petSlugs.length} community fan submissions inspired by ${name}. Made by Petdex creators.`;
  console.log(`${slug.padEnd(44)} ${petSlugs.length} pets`);
  await upsertCollection({ slug, title: name, description: desc, petSlugs });
}

console.log("\n--- CATEGORIES ---");
for (const [catSlug, petSlugs] of categories) {
  const slug = `category-${slugify(catSlug)}`;
  const title = titleFor(catSlug);
  const desc = `${petSlugs.length} ${title.toLowerCase()} from across the Petdex catalog.`;
  console.log(`${slug.padEnd(44)} ${petSlugs.length} pets  (${title})`);
  await upsertCollection({ slug, title, description: desc, petSlugs });
}

console.log("\ndone");

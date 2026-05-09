// Extracts franchise mentions from submission_reviews.checks.policy.flags
// where category='copyright_trademark_risk'. The IP review captures the
// franchise in the `evidence` field — we just have to bucket per pet.
//
// Output: scripts/.franchise-buckets.json with { franchise -> [petSlug] }
//
// Run: bun --env-file .env.local scripts/extract-franchises.ts

import { writeFileSync } from "node:fs";

import { neon } from "@neondatabase/serverless";

import { requiredEnv } from "./env";

const sql = neon(requiredEnv("DATABASE_URL"));

type Flag = { category?: string; evidence?: string; severity?: string };
type Checks = { policy?: { flags?: Flag[] } } & Record<string, unknown>;

// Canonical franchise → list of phrases that indicate a match in the
// reviewer's evidence text. Lowercased substring match. Order matters
// only because the first match wins per pet (we tag with one franchise).
const FRANCHISES: { name: string; needles: string[] }[] = [
  {
    name: "Pokemon",
    needles: [
      "pokemon",
      "pokémon",
      "pikachu",
      "charizard",
      "eevee",
      "bulbasaur",
      "squirtle",
      "charmander",
      "snorlax",
      "mewtwo",
      "lucario",
      "gengar",
      "pokeball",
      "ash ketchum",
      "pokémon-style",
    ],
  },
  {
    name: "Hunter x Hunter",
    needles: [
      "hunter x hunter",
      "hunter×hunter",
      "hxh",
      "killua",
      "kurapika",
      "hisoka morow",
      "chrollo lucilfer",
      "zoldyck",
    ],
  },
  {
    name: "South Park",
    needles: [
      "south park",
      "stan marsh",
      "kyle broflovski",
      "cartman",
      "kenny mccormick",
      "butters stotch",
    ],
  },
  {
    name: "Dragon Ball",
    needles: [
      "dragon ball",
      "dragonball",
      "goku",
      "vegeta",
      "saiyan",
      "trunks",
      "gohan",
      "piccolo",
      "frieza",
      "namekian",
    ],
  },
  {
    name: "Naruto",
    needles: [
      "naruto",
      "sasuke",
      "sakura haruno",
      "kakashi",
      "itachi",
      "boruto",
      "akatsuki",
      "hokage",
      "sharingan",
      "uchiha",
      "madara",
    ],
  },
  {
    name: "One Piece",
    needles: [
      "one piece",
      "luffy",
      "monkey d. luffy",
      "roronoa zoro",
      "nami one-piece",
      "sanji",
      "tony chopper",
      "straw hat",
    ],
  },
  {
    name: "Demon Slayer",
    needles: [
      "demon slayer",
      "kimetsu no yaiba",
      "tanjiro",
      "nezuko",
      "zenitsu",
      "inosuke",
      "rengoku",
      "hashira",
    ],
  },
  {
    name: "Jujutsu Kaisen",
    needles: [
      "jujutsu kaisen",
      "jjk",
      "yuji itadori",
      "satoru gojo",
      "gojo satoru",
      "megumi fushiguro",
      "nobara kugisaki",
      "ryomen sukuna",
    ],
  },
  {
    name: "Attack on Titan",
    needles: [
      "attack on titan",
      "shingeki no kyojin",
      "eren yeager",
      "mikasa ackerman",
      "armin arlert",
      "levi ackerman",
    ],
  },
  {
    name: "Genshin Impact",
    needles: [
      "genshin impact",
      "genshin",
      "keqing",
      "ganyu",
      "raiden shogun",
      "venti",
      "zhongli",
      "albedo",
      "klee",
      "paimon",
      "hu tao",
      "ayaka",
      "kazuha",
      "skirk",
    ],
  },
  {
    name: "Studio Ghibli",
    needles: [
      "studio ghibli",
      "ghibli",
      "totoro",
      "no-face",
      "kaonashi",
      "calcifer",
      "ponyo",
      "kiki's delivery",
      "spirited away",
      "howl's moving",
    ],
  },
  {
    name: "Disney",
    needles: [
      "disney",
      "mickey mouse",
      "donald duck",
      "stitch",
      "lilo",
      "elsa frozen",
      "frozen disney",
      "moana",
      "ariel disney",
      "simba",
      "lion king",
      "winnie the pooh",
    ],
  },
  {
    name: "Mario",
    needles: [
      "super mario",
      "nintendo mario",
      "luigi nintendo",
      "princess peach",
      "bowser",
      "yoshi nintendo",
    ],
  },
  {
    name: "Zelda",
    needles: [
      "legend of zelda",
      "zelda link",
      "ganon",
      "hyrule",
      "triforce",
      "sheikah",
    ],
  },
  {
    name: "Sonic",
    needles: [
      "sonic the hedgehog",
      "tails fox",
      "knuckles echidna",
      "shadow hedgehog",
    ],
  },
  { name: "Doraemon", needles: ["doraemon", "nobita", "shizuka minamoto"] },
  {
    name: "Crayon Shin-chan",
    needles: ["crayon shin-chan", "shin-chan", "shinchan", "crayon shinchan"],
  },
  {
    name: "Digimon",
    needles: [
      "digimon",
      "agumon",
      "gabumon",
      "patamon",
      "tailmon",
      "gatomon",
      "veemon",
      "guilmon",
      "imperialdramon",
    ],
  },
  {
    name: "Sanrio",
    needles: [
      "sanrio",
      "hello kitty",
      "kuromi",
      "my melody",
      "cinnamoroll",
      "pompompurin",
      "gudetama",
    ],
  },
  {
    name: "Marvel",
    needles: [
      "marvel",
      "spider-man",
      "iron man",
      "captain america",
      "incredible hulk",
      "thor marvel",
      "deadpool",
      "wolverine",
    ],
  },
  {
    name: "DC",
    needles: [
      "batman",
      "superman",
      "wonder woman",
      "joker dc",
      "harley quinn",
      "aquaman dc",
    ],
  },
  {
    name: "Star Wars",
    needles: [
      "star wars",
      "darth vader",
      "yoda",
      "baby yoda",
      "grogu",
      "jedi",
      "stormtrooper",
      "mandalorian",
    ],
  },
  {
    name: "Minecraft",
    needles: ["minecraft", "creeper minecraft", "enderman"],
  },
  { name: "Among Us", needles: ["among us", "amongus", "impostor among"] },
  {
    name: "Arknights",
    needles: ["arknights", "amiya arknights", "doctor arknights"],
  },
  {
    name: "Frieren",
    needles: ["frieren", "sousou no frieren", "beyond journey"],
  },
  {
    name: "Spy x Family",
    needles: [
      "spy x family",
      "spy family",
      "anya forger",
      "yor forger",
      "loid forger",
    ],
  },
  {
    name: "Chainsaw Man",
    needles: ["chainsaw man", "denji chainsaw", "power chainsaw", "makima"],
  },
  {
    name: "JoJo's Bizarre Adventure",
    needles: [
      "jojo",
      "jojo's bizarre",
      "jotaro",
      "dio brando",
      "dio's",
      "josuke higashikata",
      "giorno",
      "stand user",
      "stardust crusaders",
    ],
  },
  {
    name: "Steins;Gate",
    needles: [
      "steins;gate",
      "steins gate",
      "kurisu makise",
      "okabe rintaro",
      "hououin kyouma",
      "'kurisu'",
    ],
  },
  {
    name: "League of Legends",
    needles: [
      "league of legends",
      "lol champion",
      "shaco",
      "ahri lol",
      "yasuo",
      "garen",
      "jhin",
      "ezreal",
      "akali",
    ],
  },
  {
    name: "WorldEnd / SukaSuka",
    needles: ["chtholly", "worldend", "shuumatsu nani"],
  },
  { name: "System Shock", needles: ["system shock", "shodan"] },
  { name: "Rock Kingdom", needles: ["rock kingdom", "luoke wangguo"] },
  {
    name: "Hololive",
    needles: [
      "hololive",
      "hoshimachi suisei",
      "usada pekora",
      "gawr gura",
      "houshou marine",
      "shirakami fubuki",
    ],
  },
  {
    name: "Vocaloid",
    needles: [
      "vocaloid",
      "hatsune miku",
      "kagamine rin",
      "kagamine len",
      "megurine luka",
    ],
  },
  {
    name: "Konosuba",
    needles: [
      "konosuba",
      "kazuma satou",
      "aqua konosuba",
      "megumin",
      "darkness konosuba",
    ],
  },
  {
    name: "My Hero Academia",
    needles: [
      "my hero academia",
      "boku no hero",
      "deku midoriya",
      "bakugo",
      "all might",
    ],
  },
  {
    name: "Bleach",
    needles: [
      "bleach anime",
      "ichigo kurosaki",
      "rukia kuchiki",
      "soul reaper bleach",
    ],
  },
  {
    name: "Fullmetal Alchemist",
    needles: [
      "fullmetal alchemist",
      "edward elric",
      "alphonse elric",
      "roy mustang",
    ],
  },
  {
    name: "Cowboy Bebop",
    needles: [
      "cowboy bebop",
      "spike spiegel",
      "jet black bebop",
      "faye valentine",
    ],
  },
  {
    name: "Evangelion",
    needles: [
      "evangelion",
      "neon genesis",
      "shinji ikari",
      "rei ayanami",
      "asuka langley",
    ],
  },
  {
    name: "Sailor Moon",
    needles: ["sailor moon", "usagi tsukino", "tuxedo mask"],
  },
  {
    name: "Mob Psycho",
    needles: ["mob psycho", "shigeo kageyama", "reigen arataka"],
  },
  {
    name: "The Office",
    needles: [
      "dwight schrute",
      "michael scott office",
      "office tv show",
      "dunder mifflin",
      "'dwight'",
    ],
  },
  {
    name: "Onimai",
    needles: ["onimai", "mahiro oyama", "oniichan wa oshimai"],
  },
  {
    name: "Gakuen Idolmaster",
    needles: ["gakuen idolmaster", "gakumas", "fujita kotone", "kotone fujita"],
  },
  {
    name: "Microsoft Office",
    needles: ["clippy", "microsoft assistant", "office assistant"],
  },
  {
    name: "Alan Walker",
    needles: ["alan walker", "'aw' logo", "alan walker-style"],
  },
  {
    name: "Real People",
    needles: [
      "public figure",
      "real-person",
      "celebrity likeness",
      "portrait-right",
      "保哥",
    ],
  },
  { name: "Frog & Toad", needles: ["frog and toad", "arnold lobel"] },
  {
    name: "Sponge Bob",
    needles: ["spongebob", "sponge bob", "patrick star", "squidward"],
  },
  {
    name: "Looney Tunes",
    needles: ["looney tunes", "bugs bunny", "daffy duck", "porky pig"],
  },
  {
    name: "Adventure Time",
    needles: [
      "adventure time",
      "finn the human",
      "jake the dog",
      "princess bubblegum",
    ],
  },
  {
    name: "Rick and Morty",
    needles: ["rick and morty", "rick sanchez", "morty smith"],
  },
  {
    name: "Family Guy",
    needles: ["family guy", "peter griffin", "stewie griffin", "brian griffin"],
  },
  {
    name: "Simpsons",
    needles: ["simpsons", "homer simpson", "bart simpson", "lisa simpson"],
  },
  {
    name: "Game of Thrones",
    needles: ["game of thrones", "jon snow", "daenerys", "tyrion lannister"],
  },
  {
    name: "Breaking Bad",
    needles: ["breaking bad", "walter white", "jesse pinkman", "heisenberg"],
  },
  {
    name: "Stranger Things",
    needles: ["stranger things", "eleven hopper", "demogorgon"],
  },
  {
    name: "Arcane",
    needles: ["arcane jinx", "arcane vi", "arcane caitlyn", "arcane silco"],
  },
  {
    name: "Cyberpunk 2077",
    needles: ["cyberpunk 2077", "v cyberpunk", "johnny silverhand"],
  },
  {
    name: "Undertale",
    needles: ["undertale", "sans undertale", "papyrus undertale", "frisk"],
  },
  {
    name: "Code Geass",
    needles: ["code geass", "lelouch lamperouge", "c.c. from code", "'c.c.'"],
  },
  {
    name: "Wuthering Waves",
    needles: ["wuthering waves", "鸣潮", "phrolova", "denia"],
  },
  {
    name: "BanG Dream",
    needles: [
      "bang dream",
      "bandori",
      "wakaba mutsumi",
      "toyokawa sakiko",
      "tomori takamatsu",
      "ave mujica",
      "soyo nagasaki",
      "anon-chan",
      "mygo",
    ],
  },
  {
    name: "Honkai Star Rail",
    needles: [
      "honkai star rail",
      "honkai: star rail",
      "kafka honkai",
      "stelle honkai",
      "march 7th",
      "firefly honkai",
      "firefly hsr",
    ],
  },
  {
    name: "Kamen Rider",
    needles: ["kamen rider", "tokusatsu", "compound eyes belt"],
  },
  {
    name: "Binance",
    needles: ["binance", "cz binance", "yellow diamond logo binance"],
  },
  {
    name: "Korean Webtoons",
    needles: ["solo leveling", "tower of god", "noblesse"],
  },
  { name: "Touhou", needles: ["touhou", "reimu hakurei", "marisa kirisame"] },
  {
    name: "Made in Abyss",
    needles: ["made in abyss", "riko abyss", "reg abyss", "nanachi"],
  },
  {
    name: "Promised Neverland",
    needles: [
      "promised neverland",
      "yakusoku no neverland",
      "emma neverland",
      "norman neverland",
    ],
  },
  {
    name: "Death Note",
    needles: ["death note", "light yagami", "l ryuzaki", "kira death"],
  },
  { name: "K-On!", needles: ["k-on", "houkago tea time", "yui hirasawa"] },
  {
    name: "Re:Zero",
    needles: [
      "re:zero",
      "rezero",
      "subaru natsuki",
      "emilia rezero",
      "rem rezero",
      "ram rezero",
      "雷姆",
      "拉姆",
    ],
  },
  {
    name: "Sword Art Online",
    needles: [
      "sword art online",
      "alo asuna",
      "kirito sao",
      "asuna sao",
      "alfheim",
    ],
  },
  {
    name: "Invincible",
    needles: ["omni-man", "nolan grayson", "invincible mark grayson"],
  },
  {
    name: "Vikings",
    needles: ["viking floki", "floki coin", "ragnar lothbrok"],
  },
  {
    name: "Football / Soccer",
    needles: [
      "argentina-inspired footballer",
      "messi-style",
      "ronaldo footballer",
    ],
  },
  { name: "Android (Tech)", needles: ["android-inspired", "android mascot"] },
  { name: "Apple (Tech)", needles: ["apple logo", "iphone-inspired"] },
];

function classify(evidence: string): string | null {
  const lower = evidence.toLowerCase();
  for (const f of FRANCHISES) {
    for (const n of f.needles) {
      if (lower.includes(n)) return f.name;
    }
  }
  return null;
}

const rows = (await sql`
  SELECT
    sp.slug,
    sp.display_name,
    sp.description,
    sr.checks
  FROM submitted_pets sp
  JOIN LATERAL (
    SELECT checks
    FROM submission_reviews
    WHERE submitted_pet_id = sp.id
    ORDER BY created_at DESC
    LIMIT 1
  ) sr ON true
  WHERE sp.status='approved'
`) as Array<{
  slug: string;
  display_name: string;
  description: string;
  checks: Checks;
}>;

const buckets: Record<string, string[]> = {};
const unknownFlagged: { slug: string; evidence: string }[] = [];

for (const row of rows) {
  const flags = row.checks?.policy?.flags ?? [];
  const ipFlags = flags.filter(
    (f) => f.category === "copyright_trademark_risk",
  );
  if (ipFlags.length === 0) continue;

  let matched: string | null = null;
  for (const flag of ipFlags) {
    const evidence = flag.evidence ?? "";
    matched = classify(evidence);
    if (matched) break;
  }

  if (!matched) {
    // Try the description as a secondary signal — sometimes the
    // reviewer's evidence is vague but the description names it.
    matched = classify(`${row.display_name} ${row.description}`);
  }

  if (matched) {
    (buckets[matched] ??= []).push(row.slug);
  } else {
    const evidence = ipFlags[0]?.evidence ?? "";
    unknownFlagged.push({ slug: row.slug, evidence });
  }
}

const sorted = Object.entries(buckets).sort(
  ([, a], [, b]) => b.length - a.length,
);

console.log("--- FRANCHISE BUCKETS (from IP review evidence) ---");
for (const [name, slugs] of sorted) {
  console.log(`${name.padEnd(22)} ${slugs.length}`);
}
console.log(`\nunknown but flagged: ${unknownFlagged.length}`);
console.log("\nFirst 10 unknown:");
for (const u of unknownFlagged.slice(0, 10)) {
  console.log(`  ${u.slug.padEnd(30)} "${u.evidence.slice(0, 110)}"`);
}

const out = {
  generatedAt: new Date().toISOString(),
  totalApproved: rows.length,
  flaggedCopyright:
    rows.length -
    rows.filter(
      (r) =>
        (r.checks?.policy?.flags ?? []).filter(
          (f) => f.category === "copyright_trademark_risk",
        ).length === 0,
    ).length,
  buckets,
  unknownFlagged,
};
writeFileSync(
  "./scripts/.franchise-buckets.json",
  JSON.stringify(out, null, 2),
);
console.log("\nwrote scripts/.franchise-buckets.json");

// Generate a 16:9 announcement banner with gpt-image-2, then resize to
// the same shape as github-star.webp / vibe-search.webp so it slots into
// the AnnouncementModal hero without layout shifts.
//
// Usage:
//   bun --env-file=.env.local scripts/generate-announcement-banner.ts
//
// Costs ~$0.02 per generation (gpt-image-2 medium). The image lands at
// public/announcements/collections.webp; commit it so the modal works
// without an OpenAI key in production.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";
import sharp from "sharp";

import { generateMiniMaxReferenceImageFromEnv } from "./minimax-image-generation";

const OUTPUT_PATH = path.join(
  process.cwd(),
  "public",
  "announcements",
  "collections.webp",
);

const PROMPT = `A celebratory hero banner for "Petdex Collections" — a Pokédex-style gallery of pixel-art pets for the Codex CLI.

Composition: 8 distinct pixel-art pet characters arranged in a confident squad lineup, hero pose, varied silhouettes — a chibi armored mech, a scholarly cat with glasses, a wizard with a pointed hat, a robot WALL-E-like companion, a cyberpunk netrunner, a coder pet with a tiny laptop, a scientist pet with a clipboard, a cosmic explorer with a helmet. Each pet sized roughly the same, centered horizontally, looking forward.

Background: warm gradient from soft cream to dusty orange, with a subtle isometric pixel grid floor receding to a low horizon. A faint glow behind the squad. Tasteful, not busy.

Style: crisp pixel art, 16-bit era inspired but clean and modern, soft outlines, friendly mascot energy. Cohesive color palette dominated by warm oranges, creams, and a single accent of deep blue.

Mood: collect-them-all energy. Like a Pokémon Red box art reimagined for cute pet companions. Editorial, confident, hopeful. No text, no logos, no watermarks.

Aspect ratio 16:9. Sharp pixel detail. Empty top-left corner area for overlay text.`;

async function main() {
  const miniMaxBuffer = await generateMiniMaxReferenceImageFromEnv(
    PROMPT,
    "16:9",
  );
  if (miniMaxBuffer) {
    console.log(
      `[banner] received ${miniMaxBuffer.length} bytes from MiniMax, transcoding to webp...`,
    );
    const webp = await sharp(miniMaxBuffer)
      .resize(1280, 720, { fit: "cover", kernel: sharp.kernel.lanczos3 })
      .webp({ quality: 88 })
      .toBuffer();
    await writeFile(OUTPUT_PATH, webp);
    console.log(`[banner] wrote ${OUTPUT_PATH} (${webp.length} bytes)`);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const client = new OpenAI({ apiKey });

  console.log("[banner] requesting gpt-image-2 (this takes ~30-60s)...");
  const response = await client.images.generate({
    model: "gpt-image-2",
    prompt: PROMPT,
    size: "1536x1024", // 3:2, sharp downscales nicely to the modal aspect
    quality: "high",
    n: 1,
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    console.error("[banner] no b64_json in response, full payload:");
    console.error(JSON.stringify(response, null, 2));
    throw new Error("gpt-image-2 returned no image data");
  }

  const buffer = Buffer.from(b64, "base64");
  console.log(
    `[banner] received ${buffer.length} bytes, transcoding to webp...`,
  );

  // 16:9 final to match the github-star banner. Sharp's lanczos3 keeps
  // pixel art crisp without ringing. Quality 88 stays under 200KB.
  const webp = await sharp(buffer)
    .resize(1280, 720, { fit: "cover", kernel: sharp.kernel.lanczos3 })
    .webp({ quality: 88 })
    .toBuffer();

  await writeFile(OUTPUT_PATH, webp);
  console.log(`[banner] wrote ${OUTPUT_PATH} (${webp.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

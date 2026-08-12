// Generate the Petdex Discord server icon with gpt-image-2 and ship a
// 1024x1024 PNG to public/brand/discord-icon.png. Used as the avatar
// for the @Petdex bot and the server icon. Square 1:1, soft margins
// because Discord crops to a circle.
//
// Costs ~$0.02 per generation (gpt-image-2 medium).

import { writeFile } from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";
import sharp from "sharp";

import { generateMiniMaxReferenceImageFromEnv } from "./minimax-image-generation";

const OUTPUT_PATH = path.join(
  process.cwd(),
  "public",
  "brand",
  "discord-icon.png",
);

const PROMPT = `A square 1:1 logo for "Petdex" — a Pokédex-inspired CLI for animated pixel-art pets. The icon will be cropped to a circle on Discord, so the subject must sit centered with breathing room from the edges.

Subject: a friendly chibi pixel-art creature peeking out of a soft, glowing rounded square frame that hints at a Pokédex device. The creature shows just its head + paws on the bottom edge of the frame, like it's waving hello. The frame has tiny pixel-grid texture.

Color palette: Petdex brand purple #5266ea as the primary frame color, soft cream off-white #f7f8ff background, a single warm accent like soft orange #f4a261 on the creature's cheeks. No gradient backgrounds. Soft drop shadow under the creature.

Style: 16-bit chibi pixel art, clean outlines, friendly mascot energy, modern flat shading. Looks great at 64x64 and 256x256. Sharp pixels, no blur. Crops cleanly into a circle.

No text, no letters, no watermarks, no UI chrome.`;

async function main() {
  const miniMaxBuffer = await generateMiniMaxReferenceImageFromEnv(PROMPT, "1:1");
  if (miniMaxBuffer) {
    console.log(
      `[icon] received ${miniMaxBuffer.length} bytes from MiniMax, normalizing to PNG...`,
    );
    const png = await sharp(miniMaxBuffer).resize(1024, 1024).png().toBuffer();
    await writeFile(OUTPUT_PATH, png);
    console.log(`[icon] wrote ${OUTPUT_PATH} (${png.length} bytes)`);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const client = new OpenAI({ apiKey });
  console.log("[icon] requesting gpt-image-2...");
  const response = await client.images.generate({
    model: "gpt-image-2",
    prompt: PROMPT,
    size: "1024x1024",
    quality: "high",
    n: 1,
  });

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("gpt-image-2 returned no image data");

  const buffer = Buffer.from(b64, "base64");
  console.log(`[icon] received ${buffer.length} bytes, normalizing to PNG...`);

  // Discord wants PNG/GIF/JPG/WEBP; we ship PNG so transparent
  // backgrounds render cleanly inside the circular crop.
  const png = await sharp(buffer).resize(1024, 1024).png().toBuffer();

  await writeFile(OUTPUT_PATH, png);
  console.log(`[icon] wrote ${OUTPUT_PATH} (${png.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

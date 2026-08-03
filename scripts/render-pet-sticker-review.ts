import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { and, asc, eq } from "drizzle-orm";
import sharp from "sharp";

import { db, schema } from "@/lib/db/client";
import {
  PET_STICKER_STATES,
  PET_STICKER_TREATMENTS,
  petStickerFilename,
  petStickerTrayFilename,
} from "@/lib/pet-sticker-artifacts";
import {
  STICKER_PUBLIC_PROFILES,
  stickerFormatsForProfile,
} from "@/lib/sticker-export-policy";
import {
  fetchSpritesheet,
  renderSticker,
  renderWhatsAppTray,
  STICKER_SIZES,
} from "@/lib/sticker-renderer";
import {
  assertWhatsAppSticker,
  assertWhatsAppTray,
} from "@/lib/whatsapp-sticker";

const slug = readArg("slug");
const collection = readArg("collection");
const outputDir = resolve(readArg("output-dir") ?? "public/sticker-review");
if (!slug && !collection) {
  throw new Error("pass --slug=<slug> or --collection=<slug>");
}

const pets = slug
  ? await db
      .select({
        slug: schema.submittedPets.slug,
        displayName: schema.submittedPets.displayName,
        spritesheetUrl: schema.submittedPets.spritesheetUrl,
      })
      .from(schema.submittedPets)
      .where(
        and(
          eq(schema.submittedPets.slug, slug),
          eq(schema.submittedPets.status, "approved"),
        ),
      )
      .limit(1)
  : await db
      .select({
        slug: schema.submittedPets.slug,
        displayName: schema.submittedPets.displayName,
        spritesheetUrl: schema.submittedPets.spritesheetUrl,
      })
      .from(schema.petCollectionItems)
      .innerJoin(
        schema.petCollections,
        eq(schema.petCollectionItems.collectionId, schema.petCollections.id),
      )
      .innerJoin(
        schema.submittedPets,
        eq(schema.petCollectionItems.petSlug, schema.submittedPets.slug),
      )
      .where(
        and(
          eq(schema.petCollections.slug, collection ?? ""),
          eq(schema.submittedPets.status, "approved"),
        ),
      )
      .orderBy(asc(schema.petCollectionItems.position));

if (pets.length === 0) throw new Error("no approved pets found");
await mkdir(outputDir, { recursive: true });

for (const pet of pets) {
  const petDir = join(outputDir, pet.slug);
  await mkdir(petDir, { recursive: true });
  const source = await fetchSpritesheet(pet.spritesheetUrl);
  const files: Array<{
    state: string;
    treatment: string;
    format: string;
    profile: string;
    filename: string;
    bytes: number;
    sha256: string;
  }> = [];
  const contactTiles: Array<{ input: Buffer; left: number; top: number }> = [];
  let tile = 0;

  for (const profile of STICKER_PUBLIC_PROFILES) {
    for (const treatment of PET_STICKER_TREATMENTS) {
      for (const state of PET_STICKER_STATES) {
        for (const format of stickerFormatsForProfile(profile)) {
          const output = await renderSticker(source, {
            state,
            format,
            treatment,
            size:
              profile === "whatsapp"
                ? STICKER_SIZES.whatsapp
                : STICKER_SIZES.default,
          });
          if (profile === "whatsapp") {
            await assertWhatsAppSticker(output.buffer);
          }
          const filename = petStickerFilename(
            pet.slug,
            state,
            format,
            treatment,
            profile,
          );
          await writeFile(join(petDir, filename), output.buffer);
          files.push({
            state,
            treatment,
            format,
            profile,
            filename,
            bytes: output.buffer.byteLength,
            sha256: createHash("sha256").update(output.buffer).digest("hex"),
          });
          if (profile === "web" && format === "png") {
            contactTiles.push({
              input: output.buffer,
              left: (tile % 6) * 240,
              top: Math.floor(tile / 6) * 240,
            });
            tile += 1;
          }
        }
      }
    }
  }

  const tray = await renderWhatsAppTray(source);
  await assertWhatsAppTray(tray);
  const trayFilename = petStickerTrayFilename(pet.slug);
  await writeFile(join(petDir, trayFilename), tray);

  const contactSheet = await sharp({
    create: {
      width: 1440,
      height: 720,
      channels: 4,
      background: { r: 18, g: 18, b: 18, alpha: 1 },
    },
  })
    .composite(contactTiles)
    .png()
    .toBuffer();
  await writeFile(join(petDir, `${pet.slug}-contact-sheet.png`), contactSheet);
  await writeFile(
    join(petDir, "manifest.json"),
    JSON.stringify(
      {
        slug: pet.slug,
        displayName: pet.displayName,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        generatedAt: new Date().toISOString(),
        files,
        tray: {
          filename: trayFilename,
          bytes: tray.byteLength,
          sha256: createHash("sha256").update(tray).digest("hex"),
        },
      },
      null,
      2,
    ),
  );
  console.log(`rendered ${pet.slug} ${files.length} stickers`);
}

console.log(`output ${outputDir}`);

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  return (
    process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ??
    null
  );
}

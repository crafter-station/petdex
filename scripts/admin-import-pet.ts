// Admin-side import for a pet that the user couldn't upload via the
// web flow (network drop, R2 PUT timeout, etc). Mirrors the path
// /api/r2/presign + /api/submit + admin approve would normally take,
// but skips Clerk session and rate-limits because we run as the admin.
//
// Usage:
//   bun --env-file=.env.local --conditions react-server \
//     scripts/admin-import-pet.ts \
//       --folder /tmp/petdex-uploads/sakura-moon \
//       --credit-name CheshireJCat \
//       --credit-url https://github.com/CheshireJCat \
//       --apply
//
// The folder must contain pet.json and spritesheet.{webp,png}. We
// generate a zip on the fly so the existing zipUrl column has a
// downloadable archive.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";

import { invalidatePetCaches } from "@/lib/db/cached-aggregates";
import { db, schema } from "@/lib/db/client";
import { R2_BUCKET, R2_PUBLIC_BASE, r2 } from "@/lib/r2";

type Args = {
  folder?: string;
  creditName?: string;
  creditUrl?: string;
  ownerId?: string;
  apply: boolean;
  approve: boolean;
};

function parseArgs(): Args {
  const out: Args = { apply: false, approve: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--folder") out.folder = argv[++i];
    else if (a === "--credit-name") out.creditName = argv[++i];
    else if (a === "--credit-url") out.creditUrl = argv[++i];
    else if (a === "--owner-id") out.ownerId = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--approve") out.approve = true;
  }
  if (!out.folder) {
    console.error(
      "usage: --folder <dir> [--credit-name X --credit-url Y] [--owner-id user_xxx] [--apply] [--approve]",
    );
    process.exit(2);
  }
  return out;
}

function pickSpriteFile(folder: string): {
  path: string;
  ext: "webp" | "png";
  contentType: string;
} {
  for (const name of ["spritesheet.webp", "spritesheet.png"]) {
    const p = join(folder, name);
    try {
      statSync(p);
      const ext = name.endsWith(".png") ? "png" : "webp";
      return {
        path: p,
        ext,
        contentType: ext === "png" ? "image/png" : "image/webp",
      };
    } catch {}
  }
  throw new Error(`no spritesheet.{webp,png} in ${folder}`);
}

async function main() {
  const args = parseArgs();
  const folder = args.folder as string;

  const petJsonPath = join(folder, "pet.json");
  const petJsonRaw = readFileSync(petJsonPath, "utf8");
  const petJson = JSON.parse(petJsonRaw) as {
    id: string;
    displayName: string;
    description: string;
  };

  const sprite = pickSpriteFile(folder);
  const spriteBuf = readFileSync(sprite.path);
  const meta = await sharp(sprite.path).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("could not read sprite dimensions");
  }

  const zip = new JSZip();
  zip.file("pet.json", petJsonRaw);
  zip.file(`spritesheet.${sprite.ext}`, spriteBuf);
  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

  const slugHint = petJson.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const baseKey = `pets/${slugHint}-${uploadId}`;
  const spriteKey = `${baseKey}/sprite.${sprite.ext}`;
  const petJsonKey = `${baseKey}/petjson.json`;
  const zipKey = `${baseKey}/zip.zip`;

  console.log("\nImport plan");
  console.log("───────────");
  console.log(`folder       : ${folder}`);
  console.log(`displayName  : ${petJson.displayName}`);
  console.log(`slug (hint)  : ${slugHint}`);
  console.log(`description  : ${petJson.description}`);
  console.log(
    `sprite       : ${sprite.path} (${meta.width}x${meta.height}, ${spriteBuf.byteLength} bytes)`,
  );
  console.log(`zip size     : ${zipBuf.byteLength} bytes`);
  console.log(`R2 keys      :`);
  console.log(`  - ${spriteKey}`);
  console.log(`  - ${petJsonKey}`);
  console.log(`  - ${zipKey}`);
  console.log(`credit name  : ${args.creditName ?? "(none)"}`);
  console.log(`credit url   : ${args.creditUrl ?? "(none)"}`);
  console.log(
    `owner id     : ${args.ownerId ?? process.env.PETDEX_ADMIN_USER_IDS?.split(",")[0]?.trim() ?? "(missing)"}`,
  );
  console.log(`approve      : ${args.approve}`);

  if (!args.apply) {
    console.log("\n(dry run — pass --apply to upload + insert)");
    return;
  }

  const explicitOwnerId = args.ownerId?.trim() ?? "";
  const adminFallbackOwnerId =
    process.env.PETDEX_ADMIN_USER_IDS?.split(",")[0]?.trim() ?? "";
  const ownerId = explicitOwnerId || adminFallbackOwnerId;
  if (!ownerId) {
    throw new Error(
      "no owner id — pass --owner-id or set PETDEX_ADMIN_USER_IDS",
    );
  }
  // When --owner-id points at the actual author the pet is a normal
  // user submission. When we fall back to the admin user, the pet is
  // an admin-imported orphan that the real author claims later via
  // GitHub credit_url match.
  const importedAsRealOwner = Boolean(explicitOwnerId);
  const source: "submit" | "discover" = importedAsRealOwner
    ? "submit"
    : "discover";

  console.log("\nUploading to R2…");
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: spriteKey,
      Body: spriteBuf,
      ContentType: sprite.contentType,
    }),
  );
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: petJsonKey,
      Body: petJsonRaw,
      ContentType: "application/json",
    }),
  );
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: zipKey,
      Body: zipBuf,
      ContentType: "application/zip",
    }),
  );
  console.log("R2: 3 objects uploaded");

  // Resolve a unique slug.
  let slug = slugHint;
  let suffix = 2;
  while (true) {
    const existing = await db.query.submittedPets.findFirst({
      where: eq(schema.submittedPets.slug, slug),
    });
    if (!existing) break;
    slug = `${slugHint}-${suffix}`;
    suffix++;
  }

  const id = `pet_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const spritesheetUrl = `${R2_PUBLIC_BASE}/${spriteKey}`;
  const petJsonUrl = `${R2_PUBLIC_BASE}/${petJsonKey}`;
  const zipUrl = `${R2_PUBLIC_BASE}/${zipKey}`;

  await db.insert(schema.submittedPets).values({
    id,
    slug,
    displayName: petJson.displayName.trim().slice(0, 60),
    description: petJson.description.trim().slice(0, 280),
    spritesheetUrl,
    petJsonUrl,
    zipUrl,
    kind: "creature",
    vibes: [],
    tags: [],
    status: args.approve ? "approved" : "pending",
    source,
    ownerId,
    ownerEmail: null,
    creditName: importedAsRealOwner ? null : (args.creditName ?? null),
    creditUrl: importedAsRealOwner ? null : (args.creditUrl ?? null),
    creditImage: null,
    approvedAt: args.approve ? new Date() : null,
  });
  if (args.approve) {
    await invalidatePetCaches(slug);
  }

  console.log(
    `\nDB row inserted: ${id} (slug=${slug}, status=${args.approve ? "approved" : "pending"})`,
  );
  console.log(
    `URL: ${R2_PUBLIC_BASE.replace("pub-", "petdex.crafter.run").replace(".r2.dev", "")}`,
  );
  console.log(`Public: https://petdex.crafter.run/pets/${slug}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

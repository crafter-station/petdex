// One-shot recovery for the wave of submit failures from #22-#51.
// For each issue with an attached zip:
//   1. download the zip
//   2. extract pet.json + spritesheet
//   3. upload to R2 under community/<slug>/
//   4. INSERT a pending row crediting the original GitHub author
// Idempotent: skips slugs that already exist.

import { execSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { neon } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import JSZip from "jszip";

import * as schema from "../src/lib/db/schema";

const ADMIN_OWNER_ID = "user_3DA3wOYrJh1UNufe2pgQpcF6GJ7";
const ADMIN_OWNER_EMAIL = "railly@clerk.dev";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const sqlite = neon(env("DATABASE_URL"));
const db = drizzle(sqlite, { schema });

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  },
});
const BUCKET = process.env.R2_BUCKET ?? "petdex-pets";
const PUB =
  process.env.R2_PUBLIC_BASE ??
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev";

type IssueRow = {
  number: number;
  title: string;
  body: string;
  author: { login: string };
};

function listIssues(): IssueRow[] {
  const out = execSync(
    "gh issue list --repo crafter-station/petdex --state open --limit 60 --json number,title,author,body",
    { encoding: "utf8" },
  );
  return JSON.parse(out) as IssueRow[];
}

function extractZipUrl(body: string): string | null {
  const m = body.match(
    /\((https:\/\/github\.com\/user-attachments\/files\/[^)]+\.zip)\)/i,
  );
  return m ? m[1] : null;
}

function extractPetIdFromBody(body: string): string | null {
  // "**Pet id:** xxx"
  const m = body.match(/\*\*Pet id:\*\*\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

function extractPetNameFromBody(body: string): string | null {
  const m = body.match(/\*\*Pet name:\*\*\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function r2Put(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return `${PUB}/${key}`;
}

async function processIssue(issue: IssueRow): Promise<{
  ok: boolean;
  reason?: string;
  slug?: string;
}> {
  const zipUrl = extractZipUrl(issue.body);
  if (!zipUrl) {
    return { ok: false, reason: "no_attachment" };
  }
  const petName =
    extractPetNameFromBody(issue.body) ??
    issue.title.replace(/^\[Submit fail\]\s*/i, "").trim();
  const petId = extractPetIdFromBody(issue.body) ?? petName;
  const slug = slugify(petId);
  if (!slug) {
    return { ok: false, reason: "empty_slug_from_petid" };
  }

  // Skip if already exists.
  const existing = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
  });
  if (existing) {
    return { ok: false, reason: "slug_exists", slug };
  }

  // Download + extract.
  const tmp = resolve(tmpdir(), `petdex-rescue-${issue.number}`);
  await mkdir(tmp, { recursive: true });
  const zipPath = resolve(tmp, "submission.zip");
  const res = await fetch(zipUrl, { redirect: "follow" });
  if (!res.ok) {
    return { ok: false, reason: `download_${res.status}` };
  }
  const zipBuf = Buffer.from(await res.arrayBuffer());
  await writeFile(zipPath, zipBuf);

  const zip = await JSZip.loadAsync(zipBuf);
  // Find pet.json + spritesheet anywhere in the archive.
  let petJsonEntry: JSZip.JSZipObject | null = null;
  let spriteEntry: JSZip.JSZipObject | null = null;
  let spriteExt: "webp" | "png" = "webp";
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    if (name.includes("__MACOSX/") || name.startsWith(".")) continue;
    const base = name.split("/").pop() ?? name;
    if (base === "pet.json") petJsonEntry = file;
    else if (base === "spritesheet.webp") {
      spriteEntry = file;
      spriteExt = "webp";
    } else if (base === "spritesheet.png") {
      spriteEntry = file;
      spriteExt = "png";
    }
  }
  if (!petJsonEntry || !spriteEntry) {
    await rm(tmp, { recursive: true, force: true });
    return { ok: false, reason: "missing_files_in_zip" };
  }

  const petJsonBuf = Buffer.from(await petJsonEntry.async("uint8array"));
  const spriteBuf = Buffer.from(await spriteEntry.async("uint8array"));

  // Validate pet.json parses.
  let petJson: { displayName?: string; description?: string } = {};
  try {
    petJson = JSON.parse(petJsonBuf.toString("utf8")) as typeof petJson;
  } catch {
    /* ignore — fall back to issue title */
  }

  // Re-zip without macOS junk.
  const cleanZip = new JSZip();
  cleanZip.file("pet.json", petJsonBuf);
  cleanZip.file(`spritesheet.${spriteExt}`, spriteBuf);
  const cleanZipBuf = await cleanZip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  const prefix = `community/${slug}`;
  const [spritesheetUrl, petJsonUrl, finalZipUrl] = await Promise.all([
    r2Put(
      `${prefix}/spritesheet.${spriteExt}`,
      spriteBuf,
      spriteExt === "png" ? "image/png" : "image/webp",
    ),
    r2Put(`${prefix}/pet.json`, petJsonBuf, "application/json"),
    r2Put(`${prefix}/${slug}.zip`, cleanZipBuf, "application/zip"),
  ]);

  // Insert as pending owned by admin (will surface in /admin queue).
  const id = `pet_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  await db.insert(schema.submittedPets).values({
    id,
    slug,
    displayName: (petJson.displayName ?? petName).slice(0, 60),
    description: (
      petJson.description ?? `Submitted by ${issue.author.login}.`
    ).slice(0, 280),
    spritesheetUrl,
    petJsonUrl,
    zipUrl: finalZipUrl,
    kind: "creature",
    vibes: [],
    tags: [],
    featured: false,
    status: "pending",
    ownerId: ADMIN_OWNER_ID,
    ownerEmail: ADMIN_OWNER_EMAIL,
    creditName: issue.author.login,
    creditUrl: `https://github.com/${issue.author.login}`,
    creditImage: null,
  });

  await rm(tmp, { recursive: true, force: true });
  return { ok: true, slug };
}

async function main() {
  const all = listIssues();
  const submitFails = all.filter((i) =>
    i.title.toLowerCase().includes("[submit fail]"),
  );
  console.log(`found ${submitFails.length} submit-fail issues`);

  const results: Array<{
    number: number;
    title: string;
    ok: boolean;
    reason?: string;
    slug?: string;
  }> = [];
  for (const issue of submitFails) {
    process.stdout.write(`#${issue.number} ${issue.title} ... `);
    try {
      const r = await processIssue(issue);
      console.log(r.ok ? `OK (${r.slug})` : `SKIP (${r.reason})`);
      results.push({ number: issue.number, title: issue.title, ...r });
    } catch (err) {
      console.log(`ERR (${(err as Error).message})`);
      results.push({
        number: issue.number,
        title: issue.title,
        ok: false,
        reason: `error:${(err as Error).message.slice(0, 60)}`,
      });
    }
  }

  console.log("\n=== summary ===");
  const recovered = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok);
  console.log(`recovered: ${recovered.length}`);
  console.log(`skipped:   ${skipped.length}`);
  for (const r of skipped) {
    console.log(`  #${r.number} ${r.reason}`);
  }

  // Emit JSON for the issue-comment script.
  await writeFile(
    resolve(process.cwd(), ".rescue-results.json"),
    JSON.stringify(results, null, 2),
  );
}

await main();

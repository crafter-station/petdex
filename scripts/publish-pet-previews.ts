import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

import {
  PET_PREVIEW_CACHE_HEADER,
  PET_PREVIEW_FRAME_COUNT,
  PET_PREVIEW_FRAME_HEIGHT,
  PET_PREVIEW_FRAME_WIDTH,
  PET_PREVIEW_QUALITY,
  petPreviewKey,
  petPreviewUrl,
} from "@/lib/pet-preview";
import { getAllApprovedPets } from "@/lib/pets";
import { R2_BUCKET, r2 } from "@/lib/r2";
import { keyFromR2PublicUrl } from "@/lib/r2-public-url";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

type Mode = "check" | "apply";

type PreviewTask = {
  slug: string;
  displayName: string;
  spritesheetPath: string;
  spritesheetKey: string;
  key: string;
  url: string;
};

type PublishResult =
  | { ok: true; slug: string; bytes: number; sha256: string }
  | { ok: false; slug: string; reason: string };

const mode = parseMode(process.argv[2]);
const force = process.argv.includes("--force");
const limit = parseLimit(process.argv);
const headConcurrency = parseConcurrency("PETDEX_PREVIEW_HEAD_CONCURRENCY", 24);
const publishConcurrency = parseConcurrency(
  "PETDEX_PREVIEW_PUBLISH_CONCURRENCY",
  4,
);

const allPets = await getAllApprovedPets();
const selectedPets =
  typeof limit === "number" ? allPets.slice(0, limit) : allPets;
const tasks = selectedPets.map((pet) => {
  const spritesheetKey = keyFromR2PublicUrl(pet.spritesheetPath);
  return {
    slug: pet.slug,
    displayName: pet.displayName,
    spritesheetPath: pet.spritesheetPath,
    spritesheetKey: spritesheetKey ?? "",
    key: petPreviewKey(pet.slug),
    url: petPreviewUrl(pet.slug),
  };
});
const validTasks = tasks.filter(
  (task) => isAllowedAssetUrl(task.spritesheetPath) && task.spritesheetKey,
);
const invalidTasks = tasks.filter(
  (task) => !isAllowedAssetUrl(task.spritesheetPath) || !task.spritesheetKey,
);

const existing = force
  ? new Set<string>()
  : new Set(
      (
        await mapLimit(validTasks, headConcurrency, async (task) =>
          (await previewExists(task.key)) ? task.slug : null,
        )
      ).filter((slug): slug is string => Boolean(slug)),
    );
const pending = force
  ? validTasks
  : validTasks.filter((task) => !existing.has(task.slug));

console.log(`pet previews ${mode}`);
console.log(`approved ${allPets.length}`);
console.log(`selected ${selectedPets.length}`);
console.log(`valid ${validTasks.length}`);
console.log(`invalid ${invalidTasks.length}`);
console.log(`existing ${existing.size}`);
console.log(`pending ${pending.length}`);
console.log(`force ${force ? "yes" : "no"}`);

if (pending.length > 0) {
  console.log(
    `pending sample ${pending
      .slice(0, 20)
      .map((task) => task.slug)
      .join(", ")}`,
  );
}

if (invalidTasks.length > 0) {
  console.log(
    `invalid sample ${invalidTasks
      .slice(0, 20)
      .map((task) => task.slug)
      .join(", ")}`,
  );
}

if (mode === "apply") {
  let completed = 0;
  const results = await mapLimit(pending, publishConcurrency, async (task) => {
    const result = await publishPreview(task);
    completed += 1;
    if (completed % 100 === 0 || completed === pending.length) {
      console.log(`progress ${completed}/${pending.length}`);
    }
    return result;
  });
  const uploaded = results.filter(
    (result): result is Extract<PublishResult, { ok: true }> => result.ok,
  );
  const failed = results.filter(
    (result): result is Extract<PublishResult, { ok: false }> => !result.ok,
  );
  const bytes = uploaded.reduce((total, result) => total + result.bytes, 0);
  const hash = createHash("sha256");
  for (const result of uploaded) {
    hash.update(result.slug);
    hash.update("\0");
    hash.update(result.sha256);
    hash.update("\0");
  }

  console.log(`uploaded ${uploaded.length}`);
  console.log(`uploaded bytes ${bytes}`);
  console.log(`uploaded sha256 ${hash.digest("hex")}`);
  console.log(`failed ${failed.length}`);

  for (const result of failed.slice(0, 20)) {
    console.log(`failed ${result.slug} ${result.reason}`);
  }

  if (failed.length > 0) process.exit(1);
}

async function publishPreview(task: PreviewTask): Promise<PublishResult> {
  try {
    const source = await getR2ObjectBuffer(task.spritesheetKey);
    const body = await sharp(source)
      .extract({
        left: 0,
        top: 0,
        width: PET_PREVIEW_FRAME_WIDTH * PET_PREVIEW_FRAME_COUNT,
        height: PET_PREVIEW_FRAME_HEIGHT,
      })
      .webp({ quality: PET_PREVIEW_QUALITY })
      .toBuffer();
    const sha256 = createHash("sha256").update(body).digest("hex");

    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: task.key,
        Body: body,
        ContentType: "image/webp",
        CacheControl: PET_PREVIEW_CACHE_HEADER,
        ContentDisposition: `inline; filename="${task.slug}-preview.webp"`,
        Metadata: {
          "petdex-slug": task.slug,
          "petdex-source-sha256": createHash("sha256")
            .update(source)
            .digest("hex"),
          "petdex-sha256": sha256,
        },
      }),
    );

    return { ok: true, slug: task.slug, bytes: body.byteLength, sha256 };
  } catch (error) {
    return { ok: false, slug: task.slug, reason: errorReason(error) };
  }
}

async function getR2ObjectBuffer(key: string): Promise<Buffer> {
  const response = await r2.send(
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
  );
  if (!response.Body) throw new Error("missing body");
  return Buffer.from(await response.Body.transformToByteArray());
}

async function previewExists(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) return false;
    throw error;
  }
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseMode(raw: string | undefined): Mode {
  if (raw === "check" || raw === "apply") return raw;
  console.error("usage: bun scripts/publish-pet-previews.ts <check|apply>");
  process.exit(2);
}

function parseLimit(args: string[]): number | null {
  const raw = args.find((arg) => arg.startsWith("--limit="));
  if (!raw) return null;
  const value = Number.parseInt(raw.slice("--limit=".length), 10);
  if (Number.isFinite(value) && value > 0) return value;
  console.error("invalid --limit");
  process.exit(2);
}

function parseConcurrency(key: string, fallback: number): number {
  const value = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? (error as { name?: unknown }).name : null;
  const httpStatus =
    "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode
      : null;
  return name === "NotFound" || httpStatus === 404;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

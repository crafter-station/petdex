import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  PET_PREVIEW_CACHE_HEADER,
  petPreviewKey,
  petPreviewUrl,
} from "@/lib/pet-preview";
import {
  publishPetPublicArtifacts,
  renderPreviewStrip,
} from "@/lib/pet-public-artifacts";
import { petStickerKey } from "@/lib/pet-sticker-artifacts";
import { petThumbnailKey } from "@/lib/pet-thumbnail";
import { getAllApprovedPets } from "@/lib/pets";
import { R2_BUCKET, r2 } from "@/lib/r2";
import { keyFromR2PublicUrl, R2_PUBLIC_BASE } from "@/lib/r2-public-url";
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

  await purgeCdnUrls(uploaded.map((result) => petPreviewUrl(result.slug)));

  if (failed.length > 0) process.exit(1);
}

// Thumbs and stickers are emitted at approval time by
// publishPetPublicArtifacts but had no backfill: a pet from a failing
// batch permanently lacked them until someone reran publish (issue #563).
// Reconcile them here with the same skip-if-present semantics. Two HEADs
// per pet act as the sentinel; publishPetPublicArtifacts re-checks each
// key itself before rendering.
const missingArtifacts = (
  await mapLimit(validTasks, headConcurrency, async (task) => {
    const [thumb, sticker] = await Promise.all([
      previewExists(petThumbnailKey(task.slug)),
      previewExists(petStickerKey(task.slug)),
    ]);
    return thumb && sticker ? null : task;
  })
).filter((task): task is PreviewTask => Boolean(task));

console.log(`thumbs/stickers missing ${missingArtifacts.length}`);
if (missingArtifacts.length > 0) {
  console.log(
    `thumbs/stickers sample ${missingArtifacts
      .slice(0, 20)
      .map((task) => task.slug)
      .join(", ")}`,
  );
}

if (mode === "apply" && missingArtifacts.length > 0) {
  const publishedKeys: string[] = [];
  const artifactFailures: Array<{ slug: string; key: string; reason: string }> =
    [];
  await mapLimit(missingArtifacts, publishConcurrency, async (task) => {
    const result = await publishPetPublicArtifacts({
      slug: task.slug,
      spritesheetUrl: task.spritesheetPath,
    });
    publishedKeys.push(...result.published);
    for (const failure of result.failed) {
      artifactFailures.push({ slug: task.slug, ...failure });
    }
  });

  console.log(`artifacts published ${publishedKeys.length}`);
  console.log(`artifacts failed ${artifactFailures.length}`);
  for (const failure of artifactFailures.slice(0, 20)) {
    console.log(
      `artifacts failed ${failure.slug} ${failure.key} ${failure.reason}`,
    );
  }

  await purgeCdnUrls(publishedKeys.map((key) => `${R2_PUBLIC_BASE}/${key}`));

  if (artifactFailures.length > 0) process.exit(1);
}

// The upload above writes straight to R2 over the S3 API, which does NOT
// touch the Cloudflare cache in front of assets.petdex.dev. Any gallery
// request that raced the upload has already cached a 404 for the preview
// URL with a one year TTL, and R2 custom domains do not auto-purge on
// overwrite, so a freshly backfilled preview stays invisible forever
// unless we purge its URL explicitly (issue #553).
async function purgeCdnUrls(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const token = process.env.CLOUDFLARE_PURGE_TOKEN;
  if (!zoneId || !token) {
    console.log(`cloudflare purge skipped (no creds) for ${urls.length} urls`);
    return;
  }
  let purged = 0;
  // The purge endpoint accepts up to 30 files per call.
  for (let i = 0; i < urls.length; i += 30) {
    const batch = urls.slice(i, i + 30);
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ files: batch }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.log(`cloudflare purge failed ${res.status}`);
      return;
    }
    purged += batch.length;
  }
  console.log(`cloudflare purged ${purged}`);
}

async function publishPreview(task: PreviewTask): Promise<PublishResult> {
  try {
    const source = await getR2ObjectBuffer(task.spritesheetKey);
    const body = await renderPreviewStrip(source);
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

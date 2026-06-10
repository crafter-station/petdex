import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import JSZip from "jszip";
import sharp from "sharp";

import type { PetStateId } from "@/lib/pet-states";
import { petStates } from "@/lib/pet-states";
import {
  PET_STICKER_CACHE_HEADER,
  PET_STICKER_STATES,
  type PetStickerFormat,
  petStickerFilename,
  petStickerKey,
  petStickerPackFilename,
  petStickerPackKey,
} from "@/lib/pet-sticker-artifacts";
import { getAllApprovedPets } from "@/lib/pets";
import { R2_BUCKET, r2 } from "@/lib/r2";
import { keyFromR2PublicUrl } from "@/lib/r2-public-url";
import { renderSticker, STICKER_SIZES } from "@/lib/sticker-renderer";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

type Mode = "check" | "apply";
type Artifact = "idle-webp" | "all-webp" | "pack";
type ArtifactRef =
  | {
      kind: "sticker";
      key: string;
      state: PetStateId;
      format: PetStickerFormat;
    }
  | {
      kind: "pack";
      key: string;
    };

type StickerTask = {
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  spritesheetKey: string;
  refs: ArtifactRef[];
};

type PublishResult =
  | { ok: true; slug: string; artifacts: number; bytes: number; sha256: string }
  | { ok: false; slug: string; reason: string };

const mode = parseMode(process.argv[2]);
const force = process.argv.includes("--force");
const limit = parseLimit(process.argv);
const artifacts = parseArtifacts(process.argv);
const headConcurrency = parseConcurrency("PETDEX_STICKER_HEAD_CONCURRENCY", 24);
const publishConcurrency = parseConcurrency(
  "PETDEX_STICKER_PUBLISH_CONCURRENCY",
  2,
);
const progressEvery = parseConcurrency("PETDEX_STICKER_PROGRESS_EVERY", 50);

const allPets = await getAllApprovedPets();
const selectedPets =
  typeof limit === "number" ? allPets.slice(0, limit) : allPets;
const tasks = selectedPets.map((pet) => {
  const spritesheetKey = keyFromR2PublicUrl(pet.spritesheetPath);
  return {
    slug: pet.slug,
    displayName: pet.displayName,
    description: pet.description,
    spritesheetPath: pet.spritesheetPath,
    spritesheetKey: spritesheetKey ?? "",
    refs: refsForArtifacts(pet.slug, artifacts),
  };
});
const validTasks = tasks.filter(
  (task) => isAllowedAssetUrl(task.spritesheetPath) && task.spritesheetKey,
);
const invalidTasks = tasks.filter(
  (task) => !isAllowedAssetUrl(task.spritesheetPath) || !task.spritesheetKey,
);
const requiredRefs = validTasks.flatMap((task) =>
  task.refs.map((ref) => ({ slug: task.slug, key: ref.key })),
);
const existingKeys = force
  ? new Set<string>()
  : new Set(
      (
        await mapLimit(requiredRefs, headConcurrency, async (ref) =>
          (await r2ObjectExists(ref.key)) ? ref.key : null,
        )
      ).filter((key): key is string => Boolean(key)),
    );
const pendingTasks = force
  ? validTasks
  : validTasks
      .map((task) => ({
        ...task,
        refs: task.refs.filter((ref) => !existingKeys.has(ref.key)),
      }))
      .filter((task) => task.refs.length > 0);
const pendingRefs = pendingTasks.reduce(
  (total, task) => total + task.refs.length,
  0,
);

console.log(`pet sticker artifacts ${mode}`);
console.log(`approved ${allPets.length}`);
console.log(`selected ${selectedPets.length}`);
console.log(`artifacts ${artifacts.join(",")}`);
console.log(`valid pets ${validTasks.length}`);
console.log(`invalid pets ${invalidTasks.length}`);
console.log(`required objects ${requiredRefs.length}`);
console.log(`existing objects ${existingKeys.size}`);
console.log(`pending pets ${pendingTasks.length}`);
console.log(`pending objects ${pendingRefs}`);
console.log(`force ${force ? "yes" : "no"}`);

if (pendingTasks.length > 0) {
  console.log(
    `pending sample ${pendingTasks
      .slice(0, 20)
      .map((task) => `${task.slug}:${task.refs.length}`)
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
  const results = await mapLimit(
    pendingTasks,
    publishConcurrency,
    async (task) => {
      const result = await publishTask(task);
      completed += 1;
      if (
        completed % progressEvery === 0 ||
        completed === pendingTasks.length
      ) {
        console.log(`progress ${completed}/${pendingTasks.length}`);
      }
      return result;
    },
  );
  const uploaded = results.filter(
    (result): result is Extract<PublishResult, { ok: true }> => result.ok,
  );
  const failed = results.filter(
    (result): result is Extract<PublishResult, { ok: false }> => !result.ok,
  );
  const bytes = uploaded.reduce((total, result) => total + result.bytes, 0);
  const artifactCount = uploaded.reduce(
    (total, result) => total + result.artifacts,
    0,
  );
  const hash = createHash("sha256");
  for (const result of uploaded) {
    hash.update(result.slug);
    hash.update("\0");
    hash.update(result.sha256);
    hash.update("\0");
  }

  console.log(`uploaded pets ${uploaded.length}`);
  console.log(`uploaded objects ${artifactCount}`);
  console.log(`uploaded bytes ${bytes}`);
  console.log(`uploaded sha256 ${hash.digest("hex")}`);
  console.log(`failed ${failed.length}`);

  for (const result of failed.slice(0, 20)) {
    console.log(`failed ${result.slug} ${result.reason}`);
  }

  if (failed.length > 0) process.exit(1);
}

async function publishTask(task: StickerTask): Promise<PublishResult> {
  try {
    const source = await getR2ObjectBuffer(task.spritesheetKey);
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const hash = createHash("sha256");
    let bytes = 0;
    let artifacts = 0;

    for (const ref of task.refs) {
      const artifact = await buildArtifact(task, ref, source);
      await r2.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: ref.key,
          Body: artifact.body,
          ContentType: artifact.contentType,
          CacheControl: PET_STICKER_CACHE_HEADER,
          ContentDisposition: `attachment; filename="${artifact.filename}"`,
          Metadata: {
            "petdex-slug": task.slug,
            "petdex-source-sha256": sourceSha256,
            "petdex-sha256": artifact.sha256,
          },
        }),
      );
      artifacts += 1;
      bytes += artifact.body.byteLength;
      hash.update(ref.key);
      hash.update("\0");
      hash.update(artifact.sha256);
      hash.update("\0");
    }

    return {
      ok: true,
      slug: task.slug,
      artifacts,
      bytes,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    return { ok: false, slug: task.slug, reason: errorReason(error) };
  }
}

async function buildArtifact(
  task: StickerTask,
  ref: ArtifactRef,
  source: Buffer,
): Promise<{
  body: Buffer;
  contentType: string;
  filename: string;
  sha256: string;
}> {
  if (ref.kind === "pack") {
    const body = await buildPack(task, source);
    return {
      body,
      contentType: "application/zip",
      filename: petStickerPackFilename(task.slug),
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }

  const sticker = await renderStickerWithFallback(source, ref);
  return {
    body: sticker.buffer,
    contentType: sticker.contentType,
    filename: petStickerFilename(task.slug, ref.state, ref.format),
    sha256: createHash("sha256").update(sticker.buffer).digest("hex"),
  };
}

async function renderStickerWithFallback(
  source: Buffer,
  ref: Extract<ArtifactRef, { kind: "sticker" }>,
) {
  try {
    return await renderSticker(source, {
      state: ref.state,
      format: ref.format,
    });
  } catch (error) {
    if (ref.format !== "webp" || !isExtractAreaError(error)) throw error;
    const buffer = await sharp(source)
      .extract({ left: 0, top: 0, width: 192, height: 208 })
      .resize(STICKER_SIZES.default, STICKER_SIZES.default, {
        fit: "contain",
        kernel: "nearest",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
    return {
      buffer,
      contentType: "image/webp" as const,
      isAnimated: false,
      frameCount: 1,
    };
  }
}

async function buildPack(task: StickerTask, source: Buffer): Promise<Buffer> {
  const trayBuf = await buildTrayIcon(source);
  const stickerBufs = await Promise.all(
    petStates.map(async (state) => {
      const out = await renderSticker(source, {
        state: state.id,
        size: STICKER_SIZES.whatsappPack,
      });
      return { id: state.id, buf: out.buffer };
    }),
  );
  const publisherWebsite =
    process.env.PETDEX_URL?.trim() || "https://petdex.dev";
  const stateEmoji: Record<string, string[]> = {
    idle: ["🙂"],
    "running-right": ["🏃"],
    "running-left": ["🏃"],
    waving: ["👋"],
    jumping: ["⬆️"],
    failed: ["😅"],
    waiting: ["⏳"],
    running: ["🏃"],
    review: ["🤔"],
  };
  const manifest = {
    identifier: `petdex.${task.slug}`,
    name: `${task.displayName} - Petdex`,
    publisher: "Petdex",
    tray_image_file: "tray.png",
    publisher_email: "hello@crafter.run",
    publisher_website: publisherWebsite,
    privacy_policy_website: `${publisherWebsite}/legal/privacy`,
    license_agreement_website: `${publisherWebsite}/legal/terms`,
    image_data_version: "1",
    avoid_cache: false,
    animated_sticker_pack: true,
    stickers: stickerBufs.map((sticker) => ({
      image_file: `${sticker.id}.webp`,
      emojis: stateEmoji[sticker.id] ?? ["🙂"],
    })),
  };
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("contents.json", JSON.stringify(manifest, null, 2));
  zip.file("tray.png", trayBuf);
  for (const sticker of stickerBufs) {
    zip.file(`${sticker.id}.webp`, sticker.buf);
  }
  return await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function buildTrayIcon(sheet: Buffer): Promise<Buffer> {
  return await sharp(sheet)
    .extract({ left: 0, top: 0, width: 192, height: 208 })
    .resize(96, 96, {
      fit: "contain",
      kernel: "nearest",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function getR2ObjectBuffer(key: string): Promise<Buffer> {
  const response = await r2.send(
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
  );
  if (!response.Body) throw new Error("missing body");
  return Buffer.from(await response.Body.transformToByteArray());
}

async function r2ObjectExists(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) return false;
    throw error;
  }
}

function refsForArtifacts(slug: string, artifacts: Artifact[]): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  if (artifacts.includes("idle-webp")) {
    const key = petStickerKey(slug, "idle", "webp");
    refs.set(key, { kind: "sticker", key, state: "idle", format: "webp" });
  }
  if (artifacts.includes("all-webp")) {
    for (const state of PET_STICKER_STATES) {
      const key = petStickerKey(slug, state, "webp");
      refs.set(key, { kind: "sticker", key, state, format: "webp" });
    }
  }
  if (artifacts.includes("pack")) {
    const key = petStickerPackKey(slug);
    refs.set(key, { kind: "pack", key });
  }
  return [...refs.values()];
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
  console.error(
    "usage: bun scripts/publish-pet-sticker-artifacts.ts <check|apply>",
  );
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

function parseArtifacts(args: string[]): Artifact[] {
  const raw = args.find((arg) => arg.startsWith("--artifacts="));
  if (!raw) return ["idle-webp"];
  const values = raw
    .slice("--artifacts=".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const valid = new Set<Artifact>(["idle-webp", "all-webp", "pack"]);
  if (
    values.length > 0 &&
    values.every((value) => valid.has(value as Artifact))
  ) {
    return [...new Set(values as Artifact[])];
  }
  console.error("invalid --artifacts");
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

function isExtractAreaError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("extract_area");
}

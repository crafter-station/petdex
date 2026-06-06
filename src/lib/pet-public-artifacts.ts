import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

import {
  PET_STICKER_CACHE_HEADER,
  petStickerFilename,
  petStickerKey,
} from "@/lib/pet-sticker-artifacts";
import {
  PET_THUMBNAIL_CACHE_HEADER,
  PET_THUMBNAIL_FRAME_HEIGHT,
  PET_THUMBNAIL_FRAME_WIDTH,
  PET_THUMBNAIL_SIZE,
  petThumbnailKey,
} from "@/lib/pet-thumbnail";
import { R2_BUCKET, r2 } from "@/lib/r2";
import { keyFromR2PublicUrl } from "@/lib/r2-public-url";
import { renderSticker } from "@/lib/sticker-renderer";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

export type PetPublicArtifactResult = {
  ok: boolean;
  published: string[];
  skipped: string[];
  failed: Array<{ key: string; reason: string }>;
};

export async function publishPetPublicArtifacts(input: {
  slug: string;
  spritesheetUrl: string;
}): Promise<PetPublicArtifactResult> {
  const sourceKey = keyFromR2PublicUrl(input.spritesheetUrl);
  if (!sourceKey || !isAllowedAssetUrl(input.spritesheetUrl)) {
    return {
      ok: false,
      published: [],
      skipped: [],
      failed: [{ key: input.spritesheetUrl, reason: "unsupported_source" }],
    };
  }

  const result: PetPublicArtifactResult = {
    ok: true,
    published: [],
    skipped: [],
    failed: [],
  };
  const refs = [
    { key: petThumbnailKey(input.slug), kind: "thumbnail" as const },
    { key: petStickerKey(input.slug), kind: "sticker" as const },
  ];
  const pending = [];
  for (const ref of refs) {
    if (await r2ObjectExists(ref.key)) {
      result.skipped.push(ref.key);
    } else {
      pending.push(ref);
    }
  }
  if (pending.length === 0) return result;

  const source = await getR2ObjectBuffer(sourceKey);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");

  for (const ref of pending) {
    try {
      const artifact =
        ref.kind === "thumbnail"
          ? await buildThumbnailArtifact(input.slug, source)
          : await buildStickerArtifact(input.slug, source);
      await r2.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: ref.key,
          Body: artifact.body,
          ContentType: artifact.contentType,
          CacheControl: artifact.cacheControl,
          ContentDisposition: artifact.contentDisposition,
          Metadata: {
            "petdex-slug": input.slug,
            "petdex-source-sha256": sourceSha256,
            "petdex-sha256": artifact.sha256,
          },
        }),
      );
      result.published.push(ref.key);
    } catch (error) {
      result.failed.push({ key: ref.key, reason: errorReason(error) });
      result.ok = false;
    }
  }

  return result;
}

async function buildThumbnailArtifact(slug: string, source: Buffer) {
  const body = await sharp(source)
    .extract({
      left: 0,
      top: 0,
      width: PET_THUMBNAIL_FRAME_WIDTH,
      height: PET_THUMBNAIL_FRAME_HEIGHT,
    })
    .resize(PET_THUMBNAIL_SIZE, PET_THUMBNAIL_SIZE, {
      fit: "contain",
      kernel: "nearest",
    })
    .webp({ quality: 70 })
    .toBuffer();
  return {
    body,
    contentType: "image/webp",
    cacheControl: PET_THUMBNAIL_CACHE_HEADER,
    contentDisposition: `inline; filename="${slug}-thumb.webp"`,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function buildStickerArtifact(slug: string, source: Buffer) {
  const sticker = await renderIdleSticker(source);
  return {
    body: sticker.buffer,
    contentType: sticker.contentType,
    cacheControl: PET_STICKER_CACHE_HEADER,
    contentDisposition: `attachment; filename="${petStickerFilename(slug)}"`,
    sha256: createHash("sha256").update(sticker.buffer).digest("hex"),
  };
}

async function renderIdleSticker(source: Buffer) {
  try {
    return await renderSticker(source, { state: "idle", format: "webp" });
  } catch (error) {
    if (!isExtractAreaError(error)) throw error;
    const buffer = await sharp(source)
      .extract({ left: 0, top: 0, width: 192, height: 208 })
      .resize(240, 240, {
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

function isExtractAreaError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("extract_area");
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { keyFromR2PublicUrl, R2_PUBLIC_BASE } from "@/lib/r2-public-url";

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET ?? "petdex-pets";

if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    "[r2] missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY — uploads will fail",
  );
}

export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID ?? "missing"}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID ?? "",
    secretAccessKey: SECRET_ACCESS_KEY ?? "",
  },
});

export const R2_BUCKET = BUCKET;
export { R2_PUBLIC_BASE };

export type PresignedPut = {
  uploadUrl: string;
  publicUrl: string;
  key: string;
};

/** Sign a PUT URL the browser can use to upload a file directly to R2. */
export async function presignPut(
  key: string,
  contentType: string,
  ttlSeconds = 60,
): Promise<PresignedPut> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(r2, command, {
    expiresIn: ttlSeconds,
    // Browser sends Content-Type, signature must match — let SDK include it.
    signableHeaders: new Set(["content-type"]),
  });
  return {
    uploadUrl,
    publicUrl: `${R2_PUBLIC_BASE}/${key}`,
    key,
  };
}

// Map a stored asset URL back to its R2 object key. Submission URLs always
// live under R2_PUBLIC_BASE; anything else (off-host credit images, legacy
// URLs) returns null so callers can skip cleanly.
export function keyFromR2Url(url: string | null | undefined): string | null {
  return keyFromR2PublicUrl(url);
}

// Bulk-delete R2 objects. Silently ignores missing keys; throws only on
// transport-level errors so callers can decide whether the takedown
// should still succeed if the bucket is briefly unreachable.
export async function deleteR2Objects(keys: string[]): Promise<void> {
  const unique = Array.from(new Set(keys.filter((k) => k && k.length > 0)));
  if (unique.length === 0) return;
  await r2.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: {
        Objects: unique.map((Key) => ({ Key })),
        Quiet: true,
      },
    }),
  );
}

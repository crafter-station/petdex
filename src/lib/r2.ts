import {
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
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
  // AWS SDK v3 defaults to adding flexible-checksum query params
  // (x-amz-checksum-crc32, x-amz-sdk-checksum-algorithm) to presigned
  // PutObject URLs. The presign runs with an empty body, so the signed
  // checksum is for zero bytes (AAAAAA==); the browser then PUTs a real
  // pet.json and R2 rejects the mismatch as an opaque CORS network error
  // ("xhr network error"). WHEN_REQUIRED only adds checksums for operations
  // that mandate them, keeping presigned PUTs on UNSIGNED-PAYLOAD as R2
  // expects. See issue #465.
  requestChecksumCalculation: "WHEN_REQUIRED",
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

export type R2DeleteFailure = {
  key: string;
  code: string;
  message: string;
};

export type R2DeleteBatchResult = {
  deletedKeys: string[];
  failures: R2DeleteFailure[];
};

// Convert a non-quiet S3 response into an explicit outcome. Missing keys are
// unconfirmed so callers do not log a deletion that R2 did not acknowledge.
export function summarizeR2DeleteBatch(
  keys: readonly string[],
  result: DeleteObjectsCommandOutput | null,
): R2DeleteBatchResult {
  const requested = Array.from(new Set(keys.filter((key) => key.length > 0)));
  const errorsByKey = new Map<string, { code?: string; message?: string }>();
  for (const error of result?.Errors ?? []) {
    if (typeof error.Key === "string" && error.Key.length > 0) {
      errorsByKey.set(error.Key, {
        code: error.Code,
        message: error.Message,
      });
    }
  }

  const deleted = new Set<string>();
  for (const entry of result?.Deleted ?? []) {
    if (typeof entry.Key === "string") deleted.add(entry.Key);
  }

  const failures = requested
    .filter((key) => !deleted.has(key) || errorsByKey.has(key))
    .map((key) => {
      const error = errorsByKey.get(key);
      return {
        key,
        code: error?.code ?? "not_confirmed",
        message: error?.message ?? "R2 did not confirm deletion",
      };
    });

  return {
    deletedKeys: requested.filter(
      (key) => deleted.has(key) && !errorsByKey.has(key),
    ),
    failures,
  };
}

// Bulk-delete R2 objects. R2 responds with both confirmed deletions and
// per-key errors; transport-level errors are still thrown to the caller.
export async function deleteR2Objects(
  keys: string[],
): Promise<DeleteObjectsCommandOutput | null> {
  const unique = Array.from(new Set(keys.filter((k) => k && k.length > 0)));
  if (unique.length === 0) return null;
  return r2.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: {
        Objects: unique.map((Key) => ({ Key })),
        Quiet: false,
      },
    }),
  );
}

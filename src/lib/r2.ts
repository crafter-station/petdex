import {
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  HeadObjectCommand,
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

export type R2ObjectSizeCheck =
  | { ok: true; bytes: number | null; missing: boolean }
  | { ok: false; bytes: number; maxBytes: number; missing: false };

/**
 * Confirm an already-uploaded object is within `maxBytes` before its URL is
 * written into a row.
 *
 * A presigned PUT pins the key and content-type but NOT the body size, so the
 * `size` a caller declares at presign time is unbound: a submission can
 * declare a small file and PUT a larger one. The bucket is public, so an
 * oversized object is a permanent liability — every later fetch (and the
 * OG/sticker renderers, which pull it into sharp) pays for it. This HEAD
 * reads the size that actually landed.
 *
 * `bytes: null` means R2 returned no ContentLength; the caller lets it
 * through, because every object R2 stores carries a length and refusing on a
 * stripped header would reject an upload the presign already bounded. A
 * missing object (NotFound) is also not oversized, so it answers ok — but
 * it sets `missing`, so a caller whose contract needs the object to exist
 * (a reference image a request row will point at) can refuse it without
 * re-running the HEAD.
 */
export async function checkR2ObjectSize(
  key: string,
  maxBytes: number,
): Promise<R2ObjectSizeCheck> {
  let contentLength: number | null = null;
  try {
    const head = await r2.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    contentLength =
      typeof head.ContentLength === "number" ? head.ContentLength : null;
  } catch (error) {
    if (isR2MissingObjectError(error)) {
      return { ok: true, bytes: null, missing: true };
    }
    throw error;
  }
  if (contentLength !== null && contentLength > maxBytes) {
    return { ok: false, bytes: contentLength, maxBytes, missing: false };
  }
  return { ok: true, bytes: contentLength, missing: false };
}

function isR2MissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? (error as { name?: unknown }).name : null;
  const httpStatus =
    "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode
      : null;
  return name === "NotFound" || httpStatus === 404;
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

// Convert a non-quiet S3 response into an explicit outcome. R2 may omit an
// already-missing object from Deleted without returning an Error; that is an
// idempotent success for garbage collection. Explicit per-key errors remain
// failures.
export function summarizeR2DeleteBatch(
  keys: readonly string[],
  result: DeleteObjectsCommandOutput | null,
): R2DeleteBatchResult {
  const requested = Array.from(new Set(keys.filter((key) => key.length > 0)));
  if (result === null) {
    return {
      deletedKeys: [],
      failures: requested.map((key) => ({
        key,
        code: "not_confirmed",
        message: "R2 did not return a deletion response",
      })),
    };
  }
  const errorsByKey = new Map<string, { code?: string; message?: string }>();
  for (const error of result.Errors ?? []) {
    if (typeof error.Key === "string" && error.Key.length > 0) {
      errorsByKey.set(error.Key, {
        code: error.Code,
        message: error.Message,
      });
    }
  }

  const failures = requested
    .filter((key) => errorsByKey.has(key))
    .map((key) => {
      const error = errorsByKey.get(key);
      return {
        key,
        code: error?.code ?? "delete_failed",
        message: error?.message ?? "R2 reported a deletion error",
      };
    });

  return {
    deletedKeys: requested.filter((key) => !errorsByKey.has(key)),
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

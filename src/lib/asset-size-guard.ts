import { checkR2ObjectSize } from "@/lib/r2";
import { keyFromR2PublicUrl } from "@/lib/r2-public-url";
import { PET_ASSET_MAX_BYTES } from "@/lib/upload-limits";

/** One uploaded asset to measure, named both by its request field and by the
 *  user-facing role so the error reads the same as the presign route's. */
export type GuardedAsset = {
  field: string;
  label: string;
  url: string;
};

export type AssetSizeViolation = {
  field: string;
  label: string;
  bytes: number;
  maxBytes: number;
  message: string;
};

export function formatAssetBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Report the first uploaded asset that landed on the bucket larger than the
 * presign allowed, or null when every one is within the limit.
 *
 * The presign routes check the size a caller *declares*; a presigned PUT does
 * not bind the body to that declaration, so the declared size is advisory and
 * a caller can upload more. Reading the object back is the only server-side
 * way to learn what actually landed, and it is what makes the limit real
 * rather than a header the client may simply not honor.
 *
 * A URL that does not resolve to a bucket key is skipped: `validateSubmission`
 * / `isPendingAssetUrl` have already pinned the host and path namespace, so
 * this only covers a legacy host that `keyFromR2PublicUrl` does not map.
 *
 * A HEAD that fails for a reason other than "object missing" is treated as
 * "not oversized" and logged. Refusing a legitimate submission because R2
 * briefly refused a HEAD is worse than letting one oversized object through,
 * which the pending-asset GC still collects; the limiter takes the same
 * fail-open posture for the same reason.
 */
export async function findOversizedAsset(
  assets: readonly GuardedAsset[],
): Promise<AssetSizeViolation | null> {
  for (const asset of assets) {
    const key = keyFromR2PublicUrl(asset.url);
    if (!key) continue;

    let check: Awaited<ReturnType<typeof checkR2ObjectSize>>;
    try {
      check = await checkR2ObjectSize(key, PET_ASSET_MAX_BYTES);
    } catch (error) {
      console.warn(
        "[asset-size] could not verify uploaded asset:",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    if (check.ok) continue;

    return {
      field: asset.field,
      label: asset.label,
      bytes: check.bytes,
      maxBytes: check.maxBytes,
      message: `Your ${asset.label} is ${formatAssetBytes(check.bytes)}, over the ${formatAssetBytes(check.maxBytes)} limit.`,
    };
  }
  return null;
}

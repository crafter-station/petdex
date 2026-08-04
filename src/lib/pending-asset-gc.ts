import { isPendingAssetKey } from "@/lib/pending-asset";
import { keyFromR2PublicUrl } from "@/lib/r2-public-url";

// Shared by the GC script and the asset-reference update statement. Keeping
// the lock in the database makes separate app and maintenance processes agree.
export const PENDING_ASSET_GC_LOCK_KEY = 1874392011;

export function pendingAssetKeyFromUrl(
  raw: string | null | undefined,
): string | null {
  const key = keyFromR2PublicUrl(raw);
  return key && isPendingAssetKey(key) ? key : null;
}

export function pendingAssetKeysFromUrls(
  urls: readonly (string | null | undefined)[],
): string[] {
  return Array.from(
    new Set(
      urls
        .map((url) => pendingAssetKeyFromUrl(url))
        .filter((key): key is string => key !== null),
    ),
  );
}

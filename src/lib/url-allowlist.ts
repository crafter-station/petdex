// Allowlist for asset URLs we accept from user submissions or render
// server-side. Anything outside this list is treated as untrusted —
// rejected at the validateSubmission boundary and skipped at the OG
// fetch boundary so we never SSRF or echo attacker-controlled URLs.
//
// We allow:
//   - the configured R2 public bucket (and the stable default fallback)
//   - the legacy UploadThing host (rows from before the R2 migration still
//     point here; safe for GET because UT URLs are user-uploaded but
//     namespaced)
//
// Block everything else, including http://, file://, data:, javascript:,
// and lan IPs.

const ALLOWED_HOSTS = (() => {
  const hosts = new Set<string>([
    "pub-94495283df974cfea5e98d6a9e3fa462.r2.dev",
    "yu2vz9gndp.ufs.sh",
  ]);
  const base = process.env.R2_PUBLIC_BASE;
  if (base) {
    try {
      hosts.add(new URL(base).host);
    } catch {
      /* ignore malformed env */
    }
  }
  return hosts;
})();

export function isAllowedAssetUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_HOSTS.has(url.host);
}

export function assertAllowedAssetUrl(
  raw: string | null | undefined,
  field = "url",
): string {
  if (!isAllowedAssetUrl(raw)) {
    throw new AssetUrlError(field, raw);
  }
  return raw as string;
}

export class AssetUrlError extends Error {
  field: string;
  value: string | null | undefined;
  constructor(field: string, value: string | null | undefined) {
    super(`asset url for ${field} is not on the allowlist`);
    this.field = field;
    this.value = value;
  }
}

export function listAllowedHosts(): string[] {
  return [...ALLOWED_HOSTS];
}

// Avatar / credit-image allowlist. Clerk hosts user avatars; google
// storage is the legacy backing store for some old credit_image rows.
const ALLOWED_AVATAR_HOSTS = new Set<string>([
  "img.clerk.com",
  "images.clerk.dev",
  "storage.googleapis.com",
  "avatars.githubusercontent.com",
  "pbs.twimg.com",
]);

export function isAllowedAvatarUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_AVATAR_HOSTS.has(url.host);
}

// Credit URLs are profile links (X, GitHub, etc.). Anything else (random
// website) is allowed but flagged for the admin queue.
const ALLOWED_CREDIT_HOSTS = new Set<string>([
  "github.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "bsky.app",
  "mastodon.social",
  "youtube.com",
]);

export function isWellKnownCreditUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_CREDIT_HOSTS.has(url.host);
}

// Strict format check for any credit_url we accept at all. Refuses
// javascript:, data:, mailto:, custom schemes, http://, IP literals.
export function isSafeExternalUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Block bare IPs.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return false;
  // Block localhost / lan.
  if (url.hostname === "localhost") return false;
  return true;
}

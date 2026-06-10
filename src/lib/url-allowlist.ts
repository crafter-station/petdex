// Allowlist for asset URLs we accept from user submissions or render
// server-side. Anything outside this list is treated as untrusted —
// rejected at the validateSubmission boundary and skipped at the OG
// fetch boundary so we never SSRF or echo attacker-controlled URLs.
//
// We allow only the live canonical R2 public bucket (+ configured override).
// The dead legacy hosts are deliberately NOT trusted here — recognizing them
// for rewrite is r2-public-url's job, not a reason to accept new input.
//
// Block everything else, including http://, file://, data:, javascript:,
// and lan IPs.

import { R2_TRUSTED_HOSTS } from "@/lib/r2-public-url";

// R2_TRUSTED_HOSTS already includes the normalized R2_PUBLIC_BASE host, where
// normalizeBase() has rewritten any legacy/workers override back to the
// canonical host. We intentionally do NOT re-add the raw env host here: a
// deployment with R2_PUBLIC_BASE pointing at a retired host must not re-enter
// the trust set and start accepting new submissions/edits for a dead host.
const ALLOWED_HOSTS = new Set<string>(R2_TRUSTED_HOSTS);

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

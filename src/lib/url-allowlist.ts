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
  // Refuse credentials in the URL. `https://petdex.dev@evil.com/` parses with
  // the host `evil.com` and a username of `petdex.dev`, so the check below sees
  // a public host and accepts it, while a reader skimming the link reads the
  // brand and not the destination. The link is rendered as an href with a
  // generic label, so the impersonation lands on the destination's own URL bar.
  if (url.username !== "" || url.password !== "") return false;
  // Strip every trailing dot, not just one: "localhost.." survives a single
  // strip and then matches none of the private-name suffixes below.
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  // Block IPv4/IPv6 literals. URL normalizes decimal, octal, and hexadecimal
  // IPv4 forms to dotted-decimal hostnames before this check.
  if (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    (hostname.startsWith("[") && hostname.endsWith("]"))
  ) {
    return false;
  }
  // Block names reserved for local networks and service discovery. DNS
  // resolution is intentionally not performed on this hot input path.
  //
  // The suffix and the bare name are separate cases. An earlier version tested
  // only `endsWith(".local")`, which does not match `https://local/` — the
  // suffix itself has no leading dot to match — so each bare name has to be
  // listed as well as its suffix.
  if (hostname === "") return false;
  for (const reserved of RESERVED_PRIVATE_NAMES) {
    if (hostname === reserved || hostname.endsWith(`.${reserved}`)) {
      return false;
    }
  }
  return true;
}

/**
 * Names that resolve to local networks or service discovery, and the suffixes
 * that carry them. Both the bare name and the dotted suffix are refused:
 * `local` and `printer.local` are equally private.
 *
 * `home.arpa` is the one entry with an internal dot, so the suffix test for it
 * reads `.home.arpa` and the bare test `home.arpa` — both are spelled by the
 * same entry.
 */
const RESERVED_PRIVATE_NAMES = [
  "localhost",
  "intranet",
  "local",
  "internal",
  "lan",
  "home.arpa",
];

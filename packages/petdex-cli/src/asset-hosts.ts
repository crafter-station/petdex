/**
 * Host allowlist for pet assets downloaded by `petdex install`.
 *
 * Mirrors src/lib/url-allowlist.ts on the server side. Server-side
 * validation already gates submissions, but a legacy or compromised
 * approved row could still put a non-allowlisted URL into /api/manifest,
 * so the CLI refuses to write those bytes to disk. If the two drift, the
 * CLI either rejects legit installs or accepts attacker bytes.
 */

export const TRUSTED_ASSET_HOSTS: ReadonlySet<string> = new Set<string>([
  "assets.petdex.dev",
]);

export function isTrustedAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return TRUSTED_ASSET_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

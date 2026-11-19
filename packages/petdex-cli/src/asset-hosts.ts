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
    // `host`, not `hostname`: the server checks `url.host` in
    // `src/lib/url-allowlist.ts`, and `hostname` drops the port, so
    // `https://assets.petdex.dev:8443/…` passed here and was refused there.
    // The two lists were compared for membership by `asset-hosts.test.ts`
    // but never for matching logic, so that divergence was invisible to the
    // one test guarding the mirror. Assets are served on 443 only, so
    // refusing every other port is the correct side to be wrong on.
    return TRUSTED_ASSET_HOSTS.has(parsed.host);
  } catch {
    return false;
  }
}

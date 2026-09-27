const DESKTOP_TAG_PREFIX = "desktop-v";
const RELEASES_PAGE = "https://github.com/crafter-station/petdex/releases";
const SAFE_URL_PREFIX = "https://github.com/crafter-station/petdex/";

export type GhAsset = {
  name?: string;
  browser_download_url?: string;
};

export type GhRelease = {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GhAsset[];
};

function isTrustedUrl(url: string): boolean {
  return url.startsWith(SAFE_URL_PREFIX);
}

// Matchers are ordered from the preferred signed DMG to legacy assets.
const PLATFORM_ASSET_PATTERNS: Record<string, RegExp[]> = {
  "darwin-arm64": [
    /^Petdex-arm64\.dmg$/,
    /^petdex-desktop-darwin-arm64(\.zip)?$/,
    /^petdex-desktop-native-darwin-arm64\.zip$/,
  ],
  "darwin-x64": [
    /^Petdex-x64\.dmg$/,
    /^petdex-desktop-darwin-x64(\.zip)?$/,
    /^petdex-desktop-native-darwin-x64\.zip$/,
  ],
  "linux-x64": [
    /^petdex-desktop-linux-x64(\.tar\.gz)?$/,
    /^petdex-desktop-native-linux-x64$/,
  ],
  "linux-arm64": [/^petdex-desktop-linux-arm64(\.tar\.gz)?$/],
  "win32-x64": [
    /^petdex-desktop-win32-x64\.(exe|zip)$/,
    /^petdex-desktop-native-win32-x64\.exe$/,
  ],
};

export function pickAssetForPlatform(
  release: GhRelease,
  platform: string,
): GhAsset | null {
  if (!Array.isArray(release.assets)) return null;
  if (!Object.hasOwn(PLATFORM_ASSET_PATTERNS, platform)) return null;
  const patterns = PLATFORM_ASSET_PATTERNS[platform];
  if (!patterns) return null;
  for (const re of patterns) {
    const hit = release.assets.find(
      (a) =>
        typeof a.name === "string" &&
        re.test(a.name) &&
        typeof a.browser_download_url === "string" &&
        isTrustedUrl(a.browser_download_url),
    );
    if (hit) return hit;
  }
  return null;
}

export function releasePageUrl(release: GhRelease | null): string {
  if (!release) return RELEASES_PAGE;
  if (release.html_url && isTrustedUrl(release.html_url)) {
    return release.html_url;
  }
  if (release.tag_name) {
    return `${SAFE_URL_PREFIX}releases/tag/${encodeURIComponent(release.tag_name)}`;
  }
  return RELEASES_PAGE;
}

export function versionFromTag(tag: string | undefined): string | null {
  if (typeof tag !== "string" || !tag.startsWith(DESKTOP_TAG_PREFIX)) {
    return null;
  }
  const version = tag.slice(DESKTOP_TAG_PREFIX.length);
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

export type LatestReleasePayload = {
  version: string | null;
  tag: string | null;
  releaseUrl: string;
  assets: Record<string, string>;
};

export function buildJsonPayload(
  release: GhRelease | null,
): LatestReleasePayload {
  const assets: Record<string, string> = {};
  if (release) {
    for (const platform of Object.keys(PLATFORM_ASSET_PATTERNS)) {
      const hit = pickAssetForPlatform(release, platform);
      if (hit?.browser_download_url) {
        assets[platform] = hit.browser_download_url;
      }
    }
  }
  return {
    version: versionFromTag(release?.tag_name),
    tag: release?.tag_name ?? null,
    releaseUrl: releasePageUrl(release),
    assets,
  };
}

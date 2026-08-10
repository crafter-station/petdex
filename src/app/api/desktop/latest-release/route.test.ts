import { describe, expect, it } from "bun:test";

import { buildJsonPayload, versionFromTag } from "./route";

describe("versionFromTag", () => {
  it("strips the desktop prefix", () => {
    expect(versionFromTag("desktop-v0.6.0")).toBe("0.6.0");
    expect(versionFromTag("desktop-v1.10.2")).toBe("1.10.2");
  });

  it("keeps a prerelease suffix so clients can compare the full string", () => {
    expect(versionFromTag("desktop-v0.7.0-rc.1")).toBe("0.7.0-rc.1");
  });

  // A client that receives a guessed version can talk itself into
  // "up to date" against a tag that never carried one.
  it("returns null rather than guessing", () => {
    expect(versionFromTag("cli-v1.2.0")).toBeNull();
    expect(versionFromTag("desktop-vnightly")).toBeNull();
    expect(versionFromTag(undefined)).toBeNull();
  });
});

describe("buildJsonPayload", () => {
  const release = {
    tag_name: "desktop-v0.6.0",
    html_url:
      "https://github.com/crafter-station/petdex/releases/tag/desktop-v0.6.0",
    assets: [
      {
        name: "Petdex-arm64.dmg",
        browser_download_url:
          "https://github.com/crafter-station/petdex/releases/download/desktop-v0.6.0/Petdex-arm64.dmg",
      },
      {
        name: "petdex-desktop-native-win32-x64.exe",
        browser_download_url:
          "https://github.com/crafter-station/petdex/releases/download/desktop-v0.6.0/petdex-desktop-native-win32-x64.exe",
      },
    ],
  };

  it("reports the version and the assets it resolved", () => {
    const payload = buildJsonPayload(release);
    expect(payload.version).toBe("0.6.0");
    expect(payload.tag).toBe("desktop-v0.6.0");
    expect(payload.assets["darwin-arm64"]).toBe(
      "https://github.com/crafter-station/petdex/releases/download/desktop-v0.6.0/Petdex-arm64.dmg",
    );
    expect(payload.assets["win32-x64"]).toBe(
      "https://github.com/crafter-station/petdex/releases/download/desktop-v0.6.0/petdex-desktop-native-win32-x64.exe",
    );
  });

  it("omits platforms with no asset instead of emitting an empty string", () => {
    const payload = buildJsonPayload(release);
    expect(payload.assets["linux-arm64"]).toBeUndefined();
    expect(Object.values(payload.assets).every((url) => url.length > 0)).toBe(
      true,
    );
  });

  // Same open-redirect guard the redirect path applies. A compromised
  // or reshaped GitHub response must not hand the desktop app a
  // download URL off github.com.
  it("drops assets that are not on the petdex repo", () => {
    const payload = buildJsonPayload({
      tag_name: "desktop-v0.6.0",
      assets: [
        {
          name: "Petdex-arm64.dmg",
          browser_download_url: "https://evil.example.com/Petdex-arm64.dmg",
        },
      ],
    });
    expect(payload.assets["darwin-arm64"]).toBeUndefined();
  });

  // Offline must read as "unknown", never as "you are current".
  it("returns a null version when the release could not be resolved", () => {
    const payload = buildJsonPayload(null);
    expect(payload.version).toBeNull();
    expect(payload.tag).toBeNull();
    expect(payload.assets).toEqual({});
    expect(payload.releaseUrl).toBe(
      "https://github.com/crafter-station/petdex/releases",
    );
  });
});

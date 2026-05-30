import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DESKTOP_PREFERENCES,
  downloadToFile,
  findDmgAsset,
  findEnclosingAppBundle,
  installStagedAppBundle,
  parseDesktopPreferences,
  parseHdiutilMount,
} from "./update-utils";

function dataUrl(bytes: Uint8Array): string {
  return `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("desktop update utils", () => {
  test("parses desktop preferences with safe defaults", () => {
    expect(parseDesktopPreferences('{"autoInstallUpdates":false}')).toEqual({
      autoInstallUpdates: false,
    });
    expect(parseDesktopPreferences('{"autoInstallUpdates":"no"}')).toEqual(
      DEFAULT_DESKTOP_PREFERENCES,
    );
    expect(parseDesktopPreferences("not json")).toEqual(
      DEFAULT_DESKTOP_PREFERENCES,
    );
  });

  test("finds the enclosing macOS app bundle", () => {
    expect(
      findEnclosingAppBundle(
        "/Applications/Petdex.app/Contents/Resources/sidecar/server.js",
      ),
    ).toBe("/Applications/Petdex.app");
    expect(findEnclosingAppBundle("/tmp/petdex/sidecar/server.js")).toBeNull();
  });

  test("selects the DMG asset for the current architecture label", () => {
    const release = {
      tag_name: "desktop-v0.2.2",
      assets: [
        {
          name: "Petdex-x64.dmg",
          browser_download_url: "https://example.com/x64.dmg",
          size: 1,
        },
        {
          name: "Petdex-arm64.dmg",
          browser_download_url: "https://example.com/arm64.dmg",
          size: 1,
        },
      ],
    };
    expect(findDmgAsset(release, "arm64")?.name).toBe("Petdex-arm64.dmg");
    expect(findDmgAsset(release, "x64")?.name).toBe("Petdex-x64.dmg");
    expect(findDmgAsset(release, "riscv64")).toBeNull();
  });

  test("parses hdiutil mount output with volume names that contain spaces", () => {
    expect(
      parseHdiutilMount("/dev/disk4s1\tApple_HFS\t/Volumes/Petdex 0.2.2\n"),
    ).toBe("/Volumes/Petdex 0.2.2");
    expect(parseHdiutilMount("no mounted volume")).toBeNull();
  });

  test("downloadToFile rejects digest mismatches and removes temp files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petdex-update-"));
    try {
      const bytes = new TextEncoder().encode("petdex");
      const dest = join(dir, "Petdex-arm64.dmg");
      await expect(
        downloadToFile(dataUrl(bytes), dest, "0".repeat(64), bytes.length),
      ).rejects.toThrow("download digest mismatch");
      expect(existsSync(dest)).toBe(false);
      expect(existsSync(`${dest}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloadToFile rejects size mismatches and removes temp files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petdex-update-"));
    try {
      const bytes = new TextEncoder().encode("petdex");
      const dest = join(dir, "Petdex-arm64.dmg");
      await expect(
        downloadToFile(dataUrl(bytes), dest, sha256(bytes), bytes.length - 1),
      ).rejects.toThrow("download size mismatch");
      expect(existsSync(dest)).toBe(false);
      expect(existsSync(`${dest}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installStagedAppBundle rolls back when installed verification fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "petdex-app-"));
    try {
      const app = join(dir, "Petdex.app");
      const staged = join(dir, ".Petdex.app.update");
      const backup = join(dir, ".Petdex.app.previous");
      mkdirSync(app, { recursive: true });
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(app, "marker"), "old");
      writeFileSync(join(staged, "marker"), "new");

      await expect(
        installStagedAppBundle(app, staged, backup, async () => {
          throw new Error("bad signature");
        }),
      ).rejects.toThrow("bad signature");

      expect(readFileSync(join(app, "marker"), "utf8")).toBe("old");
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(backup)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

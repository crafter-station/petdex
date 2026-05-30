/**
 * Windows-compatibility tests for process.ts and install.ts
 *
 * These tests run on any platform (CI is Linux/Windows) but validate the
 * Windows code paths added in Packet 007–011:
 *   - isPetdexPidAlive() — WMI exe-path check on win32, ps-based on POSIX
 *   - desktopBinPath() — .exe suffix on win32
 *   - detectTarget() — assetSuffix shape and win32-x64 on Windows x64
 *
 * Run from packages/petdex-cli:
 *   bun test src/desktop/process.win32.test.ts
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";

import { desktopBinPath, detectTarget } from "./install.js";
import { isPetdexPidAlive } from "./process.js";

// ---------------------------------------------------------------------------
// isPetdexPidAlive
// ---------------------------------------------------------------------------

describe("isPetdexPidAlive", () => {
  test("returns true for the current process (self)", () => {
    // On win32 this exercises the WMI ExecutablePath path.
    // On POSIX it exercises `ps -p`.
    expect(isPetdexPidAlive(process.pid)).toBe(true);
  });

  test("returns false for a pid that is almost certainly dead", () => {
    // 2147483646 (INT_MAX − 1) is beyond typical OS pid limits on both
    // Windows (default max 32768) and Linux (default max 4194304), so
    // this pid should never be alive in any normal environment.
    expect(isPetdexPidAlive(2_147_483_646)).toBe(false);
  });

  test("win32: tasklist finds a running exe name for the current process", () => {
    // This test is win32-only. On POSIX it is a no-op.
    if (process.platform !== "win32") return;
    // isPetdexPidAlive(self) uses tasklist to retrieve the exe name.
    // Returning true confirms that the CSV parser found a match —
    // tasklist.exe is always present on Windows targets.
    expect(isPetdexPidAlive(process.pid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// desktopBinPath
// ---------------------------------------------------------------------------

describe("desktopBinPath", () => {
  test("adds .exe suffix exactly on win32", () => {
    const p = desktopBinPath();
    if (process.platform === "win32") {
      expect(p.endsWith(".exe")).toBe(true);
    } else {
      expect(p.endsWith(".exe")).toBe(false);
    }
  });

  test("returns a string that includes 'petdex-desktop'", () => {
    expect(desktopBinPath()).toContain("petdex-desktop");
  });

  test("returns a path under the OS home directory", () => {
    const binPath = desktopBinPath();
    if (process.platform === "darwin" && binPath.includes("Petdex.app")) {
      expect(binPath.endsWith("Petdex.app/Contents/MacOS/petdex-desktop")).toBe(
        true,
      );
      return;
    }
    expect(binPath.startsWith(homedir())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectTarget
// ---------------------------------------------------------------------------

describe("detectTarget", () => {
  test("returns an object with assetSuffix, osLabel, and archLabel", () => {
    const t = detectTarget();
    expect(typeof t.assetSuffix).toBe("string");
    expect(typeof t.osLabel).toBe("string");
    expect(typeof t.archLabel).toBe("string");
    expect(t.assetSuffix.length).toBeGreaterThan(0);
  });

  test("assetSuffix matches the expected platform-arch pattern", () => {
    const t = detectTarget();
    // Pattern: "<os>-<arch>" where os ∈ {darwin, linux, win32} and
    // arch ∈ {arm64, x64} (other arches pass through as-is).
    expect(t.assetSuffix).toMatch(/^[a-z0-9]+-[a-z0-9_]+$/);
    expect(t.assetSuffix.length).toBeGreaterThanOrEqual(6);
  });

  test("assetSuffix equals win32-x64 when running on Windows x64", () => {
    if (process.platform !== "win32" || process.arch !== "x64") return;
    expect(detectTarget().assetSuffix).toBe("win32-x64");
  });

  test("osLabel is darwin on macOS", () => {
    if (process.platform !== "darwin") return;
    expect(detectTarget().osLabel).toBe("darwin");
  });

  test("osLabel is linux on Linux", () => {
    if (process.platform !== "linux") return;
    expect(detectTarget().osLabel).toBe("linux");
  });

  test("osLabel is win32 on Windows", () => {
    if (process.platform !== "win32") return;
    expect(detectTarget().osLabel).toBe("win32");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _runInstallFromPathForTest,
  type RunInstallFromPathDeps,
} from "./install.js";

// ─── shared fixtures ────────────────────────────────────────────────────────

const realHome = process.env.HOME;
let tmpHome: string;
let tmpSrcDir: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "petdex-fp-home-"));
  tmpSrcDir = mkdtempSync(join(tmpdir(), "petdex-fp-src-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpSrcDir, { recursive: true, force: true });
});

/** Write a file at tmpSrcDir/name with mode 0o755 and return its path. */
function makeExecFile(name = "petdex-desktop"): string {
  const p = join(tmpSrcDir, name);
  writeFileSync(p, "ELF-STUB");
  chmodSync(p, 0o755);
  return p;
}

/** Partial deps — only what the test cares about; rest are no-ops. */
function nopDeps(overrides: Partial<RunInstallFromPathDeps> = {}): Partial<RunInstallFromPathDeps> {
  return {
    lstat: lstatSync,
    copyFile: async () => {},
    rename: async () => {},
    chmod: async () => {},
    rm: async () => {},
    mkdir: async () => {},
    writeFile: async () => {},
    stripQuarantine: () => {},
    stopDesktop: async () => {},
    startDesktop: async () => {},
    hookRefresh: async () => {},
    platform: () => "linux",
    ...overrides,
  };
}

// ─── lstat validation ───────────────────────────────────────────────────────

describe("runInstallDesktopFromPath – lstat validation", () => {
  test("1. rejects a path that does not exist", async () => {
    const missing = join(tmpSrcDir, "nonexistent");
    await expect(
      _runInstallFromPathForTest(missing, {}, nopDeps()),
    ).rejects.toThrow();
  });

  test("2. rejects a symlink", async () => {
    const real = makeExecFile();
    const link = join(tmpSrcDir, "link");
    symlinkSync(real, link);
    await expect(
      _runInstallFromPathForTest(link, {}, nopDeps()),
    ).rejects.toThrow(/symlink/i);
  });

  test("3. rejects a directory", async () => {
    await expect(
      _runInstallFromPathForTest(tmpSrcDir, {}, nopDeps()),
    ).rejects.toThrow(/directory/i);
  });

  test("4. rejects a non-executable file on linux", async () => {
    const f = join(tmpSrcDir, "noexec");
    writeFileSync(f, "data");
    chmodSync(f, 0o644);
    await expect(
      _runInstallFromPathForTest(f, {}, nopDeps({ platform: () => "linux" })),
    ).rejects.toThrow(/executable/i);
  });

  test("5. accepts a non-executable file on win32 (no mode-bits check)", async () => {
    const f = join(tmpSrcDir, "noexec.exe");
    writeFileSync(f, "data");
    chmodSync(f, 0o644);
    // .resolves.not.toThrow() is broken in bun 1.3.x — use resolves.toBeDefined() instead
    await expect(
      _runInstallFromPathForTest(f, {}, nopDeps({ platform: () => "win32" })),
    ).resolves.toBeDefined();
  });

  test("6. accepts a regular executable file (smoke)", async () => {
    const p = makeExecFile();
    const result = await _runInstallFromPathForTest(p, {}, nopDeps());
    expect(result).toEqual({ tag: "local-build" });
  });
});

// ─── staging and commit ─────────────────────────────────────────────────────

describe("runInstallDesktopFromPath – staging and commit", () => {
  test("7. copies binary to destPath + '.tmp' then renames into place", async () => {
    const src = makeExecFile();
    const copyArgs: string[] = [];
    const renameArgs: string[] = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        copyFile: async (_s, d) => { copyArgs.push(d); },
        rename: async (s, d) => { renameArgs.push(s); renameArgs.push(d); },
      }),
    );
    expect(copyArgs[0]).toMatch(/\.tmp$/);
    expect(renameArgs[0]).toMatch(/\.tmp$/);
    expect(renameArgs[1]).not.toMatch(/\.tmp$/);
  });

  test("8. chmods destination to 0o755 after rename", async () => {
    const src = makeExecFile();
    const order: string[] = [];
    const chmodArgs: [string, number][] = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        rename: async () => { order.push("rename"); },
        chmod: async (p, m) => { order.push("chmod"); chmodArgs.push([p, m]); },
      }),
    );
    const renameIdx = order.lastIndexOf("rename");
    const chmodIdx = order.lastIndexOf("chmod");
    expect(chmodIdx).toBeGreaterThan(renameIdx);
    expect(chmodArgs[0][1]).toBe(0o755);
    expect(chmodArgs[0][0]).not.toMatch(/\.tmp$/);
  });

  test("9. .tmp file is not left on disk after success", async () => {
    const src = makeExecFile();
    const destDir = join(tmpHome, ".petdex", "bin");
    mkdirSync(destDir, { recursive: true });
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        copyFile: async (s, d) => {
          const { copyFile: fsCopyFile } = await import("node:fs/promises");
          await fsCopyFile(s, d);
        },
        rename: async (s, d) => {
          const { rename: fsRename } = await import("node:fs/promises");
          await fsRename(s, d);
        },
        mkdir: async (p, opts) => {
          const { mkdir: fsMkdir } = await import("node:fs/promises");
          await fsMkdir(p, opts);
        },
      }),
    );
    const destPath = join(tmpHome, ".petdex", "bin", "petdex-desktop");
    const tmpPath = destPath + ".tmp";
    const { existsSync } = await import("node:fs");
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("10. rolls back (.tmp deleted) when rename fails", async () => {
    const src = makeExecFile();
    const rmArgs: string[] = [];
    await expect(
      _runInstallFromPathForTest(
        src, {},
        nopDeps({
          copyFile: async () => {},
          rename: async () => { throw new Error("EXDEV"); },
          rm: async (p) => { rmArgs.push(p); },
        }),
      ),
    ).rejects.toThrow("EXDEV");
    expect(rmArgs.some((p) => p.endsWith(".tmp"))).toBe(true);
  });
});

// ─── sidecar copy ───────────────────────────────────────────────────────────

describe("runInstallDesktopFromPath – sidecar copy", () => {
  test("11. copies server.js sibling to ~/.petdex/sidecar/server.js when present", async () => {
    const src = makeExecFile();
    writeFileSync(join(tmpSrcDir, "server.js"), "SERVER");
    const copyArgs: Array<[string, string]> = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        copyFile: async (s, d) => { copyArgs.push([s, d]); },
      }),
    );
    const sidecarCopy = copyArgs.find(([, d]) => d.includes("sidecar/server.js") || d.includes("sidecar\\server.js"));
    expect(sidecarCopy).toBeDefined();
  });

  test("12. skips sidecar copy when no server.js sibling exists", async () => {
    const src = makeExecFile();
    const copyArgs: Array<[string, string]> = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        copyFile: async (s, d) => { copyArgs.push([s, d]); },
      }),
    );
    const sidecarCopy = copyArgs.find(([, d]) => d.includes("sidecar"));
    expect(sidecarCopy).toBeUndefined();
    expect(copyArgs.length).toBe(1);
  });
});

// ─── quarantine strip ───────────────────────────────────────────────────────

describe("runInstallDesktopFromPath – quarantine strip", () => {
  test("13. calls stripQuarantine on dest binary on darwin", async () => {
    const src = makeExecFile();
    const stripped: string[] = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        platform: () => "darwin",
        stripQuarantine: (p) => { stripped.push(p); },
      }),
    );
    expect(stripped.length).toBe(1);
    expect(stripped[0]).not.toMatch(/\.tmp$/);
  });

  test("14. does not call stripQuarantine on linux", async () => {
    const src = makeExecFile();
    const stripped: string[] = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        platform: () => "linux",
        stripQuarantine: (p) => { stripped.push(p); },
      }),
    );
    expect(stripped.length).toBe(0);
  });
});

// ─── version file ───────────────────────────────────────────────────────────

describe("runInstallDesktopFromPath – version file", () => {
  test("15. writes 'local-build' to ~/.petdex/version when versionLabel is omitted", async () => {
    const src = makeExecFile();
    const written: Array<[string, string]> = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        writeFile: async (p, d) => { written.push([p, d]); },
      }),
    );
    const versionEntry = written.find(([p]) => p.endsWith("version"));
    expect(versionEntry).toBeDefined();
    expect(versionEntry![1]).toBe("local-build\n");
  });

  test("16. writes the supplied versionLabel to ~/.petdex/version", async () => {
    const src = makeExecFile();
    const written: Array<[string, string]> = [];
    await _runInstallFromPathForTest(
      src, { versionLabel: "my-tag" },
      nopDeps({
        writeFile: async (p, d) => { written.push([p, d]); },
      }),
    );
    const versionEntry = written.find(([p]) => p.endsWith("version"));
    expect(versionEntry![1]).toBe("my-tag\n");
  });

  test("17. rejects a versionLabel that fails the allowlist regex", async () => {
    const src = makeExecFile();
    const copyArgs: string[] = [];
    await expect(
      _runInstallFromPathForTest(
        src, { versionLabel: "bad label!" },
        nopDeps({ copyFile: async (_, d) => { copyArgs.push(d); } }),
      ),
    ).rejects.toThrow(/invalid/i);
    expect(copyArgs.length).toBe(0);
  });

  test("18. rejects a versionLabel longer than 80 characters", async () => {
    const src = makeExecFile();
    const copyArgs: string[] = [];
    await expect(
      _runInstallFromPathForTest(
        src, { versionLabel: "a".repeat(81) },
        nopDeps({ copyFile: async (_, d) => { copyArgs.push(d); } }),
      ),
    ).rejects.toThrow();
    expect(copyArgs.length).toBe(0);
  });
});

// ─── return value ───────────────────────────────────────────────────────────

describe("runInstallDesktopFromPath – return value", () => {
  test("19. returns { tag: 'local-build' } when no versionLabel is given", async () => {
    const src = makeExecFile();
    const result = await _runInstallFromPathForTest(src, {}, nopDeps());
    expect(result).toEqual({ tag: "local-build" });
  });

  test("20. returns { tag: versionLabel } when a valid custom label is given", async () => {
    const src = makeExecFile();
    const result = await _runInstallFromPathForTest(
      src, { versionLabel: "zig-main" }, nopDeps(),
    );
    expect(result).toEqual({ tag: "zig-main" });
  });
});

// ─── stopDesktop / startDesktop ─────────────────────────────────────────────

describe("runInstallDesktopFromPath – stopDesktop / startDesktop", () => {
  test("21. calls stopDesktop before the file copy", async () => {
    const src = makeExecFile();
    const order: string[] = [];
    await _runInstallFromPathForTest(
      src, {},
      nopDeps({
        stopDesktop: async () => { order.push("stop"); },
        copyFile: async () => { order.push("copy"); },
      }),
    );
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("copy"));
  });

  test("22. does not throw when startDesktop rejects (non-fatal)", async () => {
    const src = makeExecFile();
    await expect(
      _runInstallFromPathForTest(
        src, {},
        nopDeps({
          startDesktop: async () => { throw new Error("cannot start"); },
        }),
      ),
    ).resolves.toBeDefined();
  });
});

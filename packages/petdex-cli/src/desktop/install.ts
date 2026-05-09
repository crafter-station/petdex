/**
 * `petdex install desktop` — downloads the petdex-desktop binary AND the
 * Node sidecar (`server.js`) for the current platform from GitHub Releases
 * and drops them under ~/.petdex/.
 *
 * Layout after install:
 *   ~/.petdex/bin/petdex-desktop          (platform-specific binary, executable)
 *   ~/.petdex/sidecar/server.js           (cross-platform Node script)
 *   ~/.petdex/version                     (tag name of the installed release)
 *
 * The desktop binary at runtime resolves the sidecar via
 * resolveSidecarDir() in main.zig, which falls back to ~/.petdex/sidecar.
 *
 * Released from .github/workflows/desktop-release.yml on tag desktop-v*.
 * Asset names: `petdex-desktop-{darwin|linux|win32}-{arm64|x64}` and
 * `petdex-desktop-sidecar.js`.
 */
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, arch as nodeArch, platform as nodePlatform } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as p from "@clack/prompts";
import pc from "picocolors";

const RELEASE_API =
  "https://api.github.com/repos/crafter-station/petdex/releases/latest";
const SIDECAR_ASSET_NAME = "petdex-desktop-sidecar.js";

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

export type Release = {
  tag_name: string;
  assets: ReleaseAsset[];
};

type Target = {
  osLabel: string;
  archLabel: string;
  assetSuffix: string;
};

function detectTarget(): Target {
  const os = nodePlatform();
  const arch = nodeArch();
  const osLabel =
    os === "darwin"
      ? "darwin"
      : os === "linux"
        ? "linux"
        : os === "win32"
          ? "win32"
          : os;
  const archLabel = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
  return {
    osLabel,
    archLabel,
    assetSuffix: `${osLabel}-${archLabel}`,
  };
}

export function desktopBinPath(): string {
  const ext = nodePlatform() === "win32" ? ".exe" : "";
  return path.join(homedir(), ".petdex", "bin", `petdex-desktop${ext}`);
}

export function sidecarPath(): string {
  return path.join(homedir(), ".petdex", "sidecar", "server.js");
}

export async function fetchLatestRelease(): Promise<Release> {
  const res = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return (await res.json()) as Release;
}

export function findBinaryAsset(
  release: Release,
  assetSuffix: string,
): ReleaseAsset {
  const wantedSuffix = `petdex-desktop-${assetSuffix}`;
  const asset = release.assets.find((a) => a.name.startsWith(wantedSuffix));
  if (!asset) {
    const available = release.assets.map((a) => `      ${a.name}`).join("\n");
    throw new Error(
      `No binary for ${assetSuffix} in ${release.tag_name}.\n   Available:\n${available}`,
    );
  }
  return asset;
}

export function findSidecarAsset(release: Release): ReleaseAsset | null {
  return release.assets.find((a) => a.name === SIDECAR_ASSET_NAME) ?? null;
}

type StagedFile = { tmpPath: string; destPath: string };

/**
 * Stage: download URL to {dest}.tmp, set mode/xattr if needed. Returns the
 * tmp path so a caller can commit (rename) several files together once all
 * downloads succeed. If staging fails the .tmp is cleaned up.
 */
async function stageDownload(
  url: string,
  destPath: string,
  mode?: number,
): Promise<StagedFile> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download ${url} → ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpPath = `${destPath}.tmp`;
  try {
    await writeFile(tmpPath, buffer);
    if (mode !== undefined) {
      await chmod(tmpPath, mode);
    }
    if (nodePlatform() === "darwin") {
      try {
        const { spawnSync } = await import("node:child_process");
        spawnSync("xattr", ["-d", "com.apple.quarantine", tmpPath], {
          stdio: "ignore",
        });
      } catch {
        // quarantine xattr may not exist on locally-built binaries; ignore
      }
    }
    return { tmpPath, destPath };
  } catch (err) {
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Commit: rename all staged files into place. Best-effort rollback on the
 * already-renamed entries if a later rename fails — at worst the user ends
 * up with the previous coherent state.
 */
async function commitStaged(staged: StagedFile[]): Promise<void> {
  const renamed: { from: string; backup: string }[] = [];
  for (const file of staged) {
    // backup tracks the current iteration's snapshot before the catch
    // block runs. Critical: if rename(tmp, dest) fails AFTER we moved
    // dest -> dest.prev, the in-progress backup is NOT in `renamed`
    // yet. The catch must restore it explicitly or we lose the file.
    let backup: string | null = null;
    try {
      const prevPath = `${file.destPath}.prev`;
      try {
        await rename(file.destPath, prevPath);
        backup = prevPath;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
      await rename(file.tmpPath, file.destPath);
      renamed.push({ from: file.destPath, backup: backup ?? "" });
    } catch (err) {
      // 1. Restore the in-progress backup first (before the failed rename
      //    finished pushing to `renamed`). Without this, the existing
      //    binary or sidecar is gone and the all-or-nothing guarantee
      //    is broken.
      if (backup) {
        try {
          await rm(file.destPath, { force: true });
          await rename(backup, file.destPath);
        } catch {
          // best-effort
        }
      }
      // 2. Roll back already-committed renames using their .prev snapshots.
      for (const r of renamed.reverse()) {
        if (!r.backup) continue;
        try {
          await rm(r.from, { force: true });
          await rename(r.backup, r.from);
        } catch {
          // best-effort
        }
      }
      // 3. Clean up remaining .tmp files.
      for (const f of staged) {
        try {
          await rm(f.tmpPath, { force: true });
        } catch {
          // best-effort
        }
      }
      throw err;
    }
  }
  // All renames succeeded — drop the .prev snapshots.
  for (const r of renamed) {
    if (!r.backup) continue;
    try {
      await rm(r.backup, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Download binary AND sidecar to staging, then commit (rename) them
 * together. Either both files end up updated or none do — a failed sidecar
 * download never leaves a new binary paired with an old/missing sidecar.
 */
export async function downloadDesktopAssets(release: Release): Promise<{
  binAsset: ReleaseAsset;
  sidecarAsset: ReleaseAsset | null;
}> {
  const target = detectTarget();
  const binAsset = findBinaryAsset(release, target.assetSuffix);
  const sidecarAsset = findSidecarAsset(release);

  const binPath = desktopBinPath();
  const sidecar = sidecarPath();
  await mkdir(path.dirname(binPath), { recursive: true });
  await mkdir(path.dirname(sidecar), { recursive: true });

  // Phase 1: stage all downloads. If any fails, .tmp files are cleaned up
  // and nothing on disk has changed.
  const staged: StagedFile[] = [];
  try {
    staged.push(
      await stageDownload(binAsset.browser_download_url, binPath, 0o755),
    );
    if (sidecarAsset) {
      staged.push(
        await stageDownload(sidecarAsset.browser_download_url, sidecar),
      );
    }
  } catch (err) {
    // Clean up any tmp files from earlier successful stages.
    for (const f of staged) {
      try {
        await rm(f.tmpPath, { force: true });
      } catch {
        // best-effort
      }
    }
    throw err;
  }

  // Phase 2: commit (rename) all staged files. Rolls back on failure.
  await commitStaged(staged);

  return { binAsset, sidecarAsset };
}

export async function runInstallDesktop(): Promise<void> {
  p.intro(pc.bgMagenta(pc.white(" petdex install desktop ")));

  const target = detectTarget();
  p.log.info(`Platform: ${pc.cyan(`${target.osLabel} ${target.archLabel}`)}`);

  const s = p.spinner();
  s.start("Looking up the latest release");
  let release: Release;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    s.stop(pc.red("failed"));
    throw new Error(
      `Could not reach GitHub. Check your connection.\n   ${(err as Error).message}`,
    );
  }
  s.stop(`${pc.green("✓")} Latest: ${pc.bold(release.tag_name)}`);

  const dl = p.spinner();
  dl.start("Downloading desktop binary and sidecar");
  let result: Awaited<ReturnType<typeof downloadDesktopAssets>>;
  try {
    result = await downloadDesktopAssets(release);
  } catch (err) {
    dl.stop(pc.red("failed"));
    throw err;
  }

  const binPath = desktopBinPath();
  const versionFile = path.join(homedir(), ".petdex", "version");
  await writeFile(versionFile, `${release.tag_name}\n`);

  const sidecarMsg = result.sidecarAsset
    ? `\n${pc.dim("•")} Sidecar at ${pc.cyan(tildeify(sidecarPath()))} (${formatBytes(result.sidecarAsset.size)})`
    : `\n${pc.yellow("!")} No sidecar in this release. Hooks won't reach the mascot until a release ships ${SIDECAR_ASSET_NAME}.`;
  dl.stop(
    `${pc.green("✓")} Binary at ${pc.cyan(tildeify(binPath))} (${formatBytes(result.binAsset.size)})${sidecarMsg}`,
  );

  p.note(
    [
      `Run it with:`,
      `  ${pc.cyan("petdex desktop start")}`,
      "",
      `Or wire it into your coding agents:`,
      `  ${pc.cyan("petdex hooks install")}`,
    ].join("\n"),
    "Next",
  );

  p.outro(`${pc.green("✓")} ${release.tag_name}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function tildeify(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

// Stream pipeline kept around in case we switch to streaming downloads later
// for very large binaries. For ~3MB the buffer approach above is simpler.
export async function _streamDownload(
  url: string,
  destPath: string,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${url} → ${res.status}`);
  const reader = Readable.fromWeb(res.body as never);
  const { createWriteStream } = await import("node:fs");
  await pipeline(reader, createWriteStream(destPath));
}

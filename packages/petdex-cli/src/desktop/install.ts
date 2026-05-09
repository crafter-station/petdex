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

/**
 * Atomic download: stream to {dest}.tmp, fsync via writeFile-buffer, rename
 * over dest. A failed download leaves a stale .tmp behind (we clean up) but
 * never corrupts the existing dest.
 */
async function downloadAtomic(
  url: string,
  destPath: string,
  mode?: number,
): Promise<void> {
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
    await rename(tmpPath, destPath);
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
 * Download both the binary and the sidecar to a staging area, then move
 * them into place atomically. Used by both `install desktop` and `update`.
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

  await downloadAtomic(binAsset.browser_download_url, binPath, 0o755);

  if (sidecarAsset) {
    await downloadAtomic(sidecarAsset.browser_download_url, sidecar);
  }

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

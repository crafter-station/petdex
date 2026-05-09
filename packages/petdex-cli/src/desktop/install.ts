/**
 * `petdex install desktop` — downloads the petdex-desktop binary for the
 * current platform from GitHub Releases and drops it under ~/.petdex/bin/.
 *
 * The binary is published from the petdex repo via .github/workflows/
 * desktop-release.yml when a tag matching `desktop-v*` is pushed. Asset
 * naming convention is `petdex-desktop-{darwin|linux|win32}-{arm64|x64}`.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, arch as nodeArch, platform as nodePlatform } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as p from "@clack/prompts";
import pc from "picocolors";

const RELEASE_API =
  "https://api.github.com/repos/crafter-station/petdex/releases/latest";

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type Release = {
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

export async function runInstallDesktop(): Promise<void> {
  p.intro(pc.bgMagenta(pc.white(" petdex install desktop ")));

  const target = detectTarget();
  p.log.info(`Platform: ${pc.cyan(`${target.osLabel} ${target.archLabel}`)}`);

  const s = p.spinner();
  s.start("Looking up the latest release");

  let release: Release;
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      s.stop(pc.red("failed"));
      throw new Error(`GitHub API ${res.status}`);
    }
    release = (await res.json()) as Release;
  } catch (err) {
    s.stop(pc.red("failed"));
    throw new Error(
      `Could not reach GitHub. Check your connection.\n   ${(err as Error).message}`,
    );
  }

  const wantedSuffix = `petdex-desktop-${target.assetSuffix}`;
  const asset = release.assets.find((a) => a.name.startsWith(wantedSuffix));
  if (!asset) {
    s.stop(pc.red("no binary"));
    const available = release.assets.map((a) => `      ${a.name}`).join("\n");
    throw new Error(
      `No binary found for ${target.assetSuffix} in release ${release.tag_name}.\n   Available:\n${available}`,
    );
  }

  s.stop(
    `${pc.green("✓")} Found ${pc.bold(asset.name)} (${formatBytes(asset.size)})`,
  );

  const binPath = desktopBinPath();
  await mkdir(path.dirname(binPath), { recursive: true });

  const dl = p.spinner();
  dl.start(`Downloading ${asset.name}`);
  try {
    const res = await fetch(asset.browser_download_url);
    if (!res.ok || !res.body) {
      dl.stop(pc.red("failed"));
      throw new Error(`Download ${asset.browser_download_url} → ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(binPath, buffer);
    await chmod(binPath, 0o755);
    // Strip macOS quarantine attribute so the binary opens without the
    // "cannot be opened because the developer cannot be verified" prompt.
    if (nodePlatform() === "darwin") {
      try {
        const { spawnSync } = await import("node:child_process");
        spawnSync("xattr", ["-d", "com.apple.quarantine", binPath], {
          stdio: "ignore",
        });
      } catch {
        // quarantine xattr may not exist on locally-built binaries; ignore
      }
    }
    // Record the installed version so `petdex update` knows what we have.
    const versionFile = path.join(homedir(), ".petdex", "version");
    await writeFile(versionFile, release.tag_name + "\n");
    dl.stop(`${pc.green("✓")} Installed at ${pc.cyan(tildeify(binPath))}`);
  } catch (err) {
    dl.stop(pc.red("failed"));
    throw err;
  }

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

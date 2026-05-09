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
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, arch as nodeArch, platform as nodePlatform } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as p from "@clack/prompts";
import pc from "picocolors";

// Listing recent releases instead of /releases/latest because the
// petdex repo publishes multiple lineages (desktop-v*, web-v*,
// sidecar-v*) under the same tag namespace. /releases/latest returns
// whichever was published last regardless of prefix; pulling 20 and
// filtering to desktop-v* guarantees the user gets a tag with desktop
// assets attached.
const RELEASE_API =
  "https://api.github.com/repos/crafter-station/petdex/releases?per_page=20";
const DESKTOP_TAG_PREFIX = "desktop-v";
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
  const releases = (await res.json()) as Array<
    Release & { draft?: boolean; prerelease?: boolean }
  >;
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error("GitHub API returned no releases");
  }
  // GH lists newest-first by published_at. Skip drafts (not visible
  // anyway) and prereleases (we don't ship those for desktop yet).
  const hit = releases.find(
    (r) =>
      !r.draft &&
      !r.prerelease &&
      typeof r.tag_name === "string" &&
      r.tag_name.startsWith(DESKTOP_TAG_PREFIX),
  );
  if (!hit) {
    throw new Error(
      `No ${DESKTOP_TAG_PREFIX}* release found in the last ${releases.length} releases`,
    );
  }
  return hit;
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

export type StagedFile = { tmpPath: string; destPath: string };

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
// Exported for tests so we can exercise the rollback branches
// without mocking GitHub Releases or the network layer.
export async function _commitStagedForTest(
  staged: StagedFile[],
): Promise<void> {
  return commitStaged(staged);
}

async function commitStaged(staged: StagedFile[]): Promise<void> {
  // Each renamed entry tracks whether there was a previous file at
  // dest. If yes, rollback restores from .prev. If no (fresh install),
  // rollback deletes the newly-renamed file so a partial first
  // install doesn't leave the user with only the binary or only the
  // sidecar — the previous loop skipped no-backup entries entirely
  // and broke the all-or-nothing contract for first-time installs.
  type RenamedEntry = {
    dest: string;
    backup: string | null;
  };
  const renamed: RenamedEntry[] = [];
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
      renamed.push({ dest: file.destPath, backup });
    } catch (err) {
      // 1. Restore the in-progress backup first (before the failed
      //    rename finished pushing to `renamed`). Without this the
      //    existing binary or sidecar is gone and the all-or-nothing
      //    guarantee is broken.
      if (backup) {
        try {
          await rm(file.destPath, { force: true });
          await rename(backup, file.destPath);
        } catch {
          // best-effort
        }
      }
      // 2. Roll back already-committed renames in reverse order.
      //    Two cases:
      //    - backup is set: there was a previous file, restore it.
      //    - backup is null: this was a fresh install with no prior
      //      file. Delete the new dest so we don't leave the user
      //      with a partial install (e.g. only the binary, no sidecar).
      for (const r of renamed.reverse()) {
        try {
          if (r.backup) {
            await rm(r.dest, { force: true });
            await rename(r.backup, r.dest);
          } else {
            await rm(r.dest, { force: true });
          }
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
  // All renames succeeded — drop the .prev snapshots that exist.
  for (const r of renamed) {
    if (!r.backup) continue;
    try {
      await rm(r.backup, { force: true });
    } catch {
      // best-effort
    }
  }
}

export type StagedDesktopAssets = {
  binAsset: ReleaseAsset;
  sidecarAsset: ReleaseAsset | null;
  staged: StagedFile[];
};

/**
 * Download binary + sidecar to .tmp staging files. NOTHING has been
 * renamed yet — the .tmp files live next to their final destinations
 * but the live binary on disk is untouched. Exists separately from
 * commit so a caller can stop the running desktop between stage and
 * commit on platforms (Windows, some Linux setups) that lock running
 * executables and would otherwise refuse the rename.
 */
export async function stageDesktopAssets(
  release: Release,
): Promise<StagedDesktopAssets> {
  const target = detectTarget();
  const binAsset = findBinaryAsset(release, target.assetSuffix);
  const sidecarAsset = findSidecarAsset(release);

  const binPath = desktopBinPath();
  const sidecar = sidecarPath();
  await mkdir(path.dirname(binPath), { recursive: true });
  await mkdir(path.dirname(sidecar), { recursive: true });

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

  return { binAsset, sidecarAsset, staged };
}

/**
 * Rename the staged .tmp files into their final paths. All-or-nothing:
 * if any rename fails the previously committed entries roll back from
 * their .prev snapshots. Exists separately from stage so the caller
 * can stop the running desktop first.
 */
export async function commitDesktopAssets(
  assets: Pick<StagedDesktopAssets, "staged">,
): Promise<void> {
  await commitStaged(assets.staged);
}

/**
 * Convenience wrapper for first-time installs (no running desktop to
 * worry about): stage, then immediately commit. Update flows should
 * call stageDesktopAssets + commitDesktopAssets separately so they
 * can stopDesktop() between the two phases.
 */
export async function downloadDesktopAssets(release: Release): Promise<{
  binAsset: ReleaseAsset;
  sidecarAsset: ReleaseAsset | null;
}> {
  const result = await stageDesktopAssets(release);
  await commitDesktopAssets(result);
  return { binAsset: result.binAsset, sidecarAsset: result.sidecarAsset };
}

export type RunInstallDesktopResult = {
  /**
   * GitHub Release tag of the binary that landed on disk. Caller can
   * forward it to telemetry so the dashboard's version-adoption chart
   * actually populates.
   */
  tag: string;
};

// Slug we install when the user has no pets at all and ran
// `petdex install desktop` from the default /download flow (no
// ?next=install/<slug> hint). Without this fallback the desktop
// binary exits at startup with "No pets found", and the
// happy-path setup (install desktop / hooks install / desktop
// start) silently dead-ends.
//
// "boba" is the canonical example slug used elsewhere in the app
// (404 page, facet pages). Easy to swap if we later want to make
// this configurable per-release.
const DEFAULT_PET_SLUG = "boba";
const PETDEX_URL =
  process.env.PETDEX_URL ?? "https://petdex.crafter.run";

function petsRoot(): string {
  return path.join(homedir(), ".petdex", "pets");
}

function codexPetsRoot(): string {
  return path.join(homedir(), ".codex", "pets");
}

// True only if at least one pet directory under either canonical
// pets root has a usable spritesheet. Mirrors what the desktop
// binary's listPets() filter accepts (see main.zig hasSpritesheet).
async function hasAnyInstalledPet(): Promise<boolean> {
  for (const root of [petsRoot(), codexPetsRoot()]) {
    let entries: string[];
    try {
      const { readdir } = await import("node:fs/promises");
      entries = await readdir(root);
    } catch {
      continue; // root doesn't exist yet
    }
    for (const slug of entries) {
      const dir = path.join(root, slug);
      const webp = path.join(dir, "spritesheet.webp");
      const png = path.join(dir, "spritesheet.png");
      if (existsSync(webp) || existsSync(png)) return true;
    }
  }
  return false;
}

// Best-effort install of the canonical starter pet. Called at the
// tail of `petdex install desktop` so the user gets something to
// see when they run `petdex desktop start`. Failures are non-fatal
// — the binary still landed on disk and the user can install a pet
// manually. Returns the slug it installed, or null if it skipped
// or failed.
async function installStarterPet(): Promise<string | null> {
  type Pet = {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
    petJsonUrl: string;
  };
  let pet: Pet | null = null;
  try {
    const res = await fetch(`${PETDEX_URL}/api/manifest`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pets: Pet[] };
    pet =
      data.pets.find((p) => p.slug === DEFAULT_PET_SLUG) ??
      // Fall back to the first pet in the manifest if our preferred
      // default isn't approved. Better to ship SOMETHING than to
      // leave the user with an empty collection.
      data.pets[0] ??
      null;
  } catch {
    return null;
  }
  if (!pet) return null;

  const ext = pet.spritesheetUrl.endsWith(".png") ? "png" : "webp";
  const targets = [
    path.join(petsRoot(), pet.slug),
    path.join(codexPetsRoot(), pet.slug),
  ];
  try {
    for (const t of targets) {
      await mkdir(t, { recursive: true });
    }
    const fetchOrThrow = async (url: string): Promise<ArrayBuffer> => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
      return res.arrayBuffer();
    };
    const [petJson, spritesheet] = await Promise.all([
      fetchOrThrow(pet.petJsonUrl),
      fetchOrThrow(pet.spritesheetUrl),
    ]);
    await Promise.all(
      targets.flatMap((t) => [
        writeFile(path.join(t, "pet.json"), Buffer.from(petJson)),
        writeFile(path.join(t, `spritesheet.${ext}`), Buffer.from(spritesheet)),
      ]),
    );
    return pet.slug;
  } catch {
    return null;
  }
}

export async function runInstallDesktop(): Promise<RunInstallDesktopResult> {
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

  // Make sure the user has at least one pet to look at when they
  // run `petdex desktop start`. Without this, a fresh install (no
  // ?next=install/<slug> hint, no manual `petdex install <slug>`)
  // exits at startup with "No pets found, install one with..." —
  // the documented happy path silently dead-ends.
  let starterSlug: string | null = null;
  if (!(await hasAnyInstalledPet())) {
    const ps = p.spinner();
    ps.start("Installing a starter pet so the desktop has something to show");
    starterSlug = await installStarterPet();
    if (starterSlug) {
      ps.stop(`${pc.green("✓")} Starter pet: ${pc.bold(starterSlug)}`);
    } else {
      // Non-fatal: binary still landed. Tell the user how to recover
      // so they don't hit a confusing "No pets found" later.
      ps.stop(
        `${pc.yellow("!")} Could not download a starter pet. Run \`petdex install <slug>\` before \`petdex desktop start\`.`,
      );
    }
  }

  const nextLines = [
    `Run it with:`,
    `  ${pc.cyan("petdex desktop start")}`,
    "",
    `Or wire it into your coding agents:`,
    `  ${pc.cyan("petdex hooks install")}`,
  ];
  p.note(nextLines.join("\n"), "Next");

  p.outro(`${pc.green("✓")} ${release.tag_name}`);

  return { tag: release.tag_name };
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

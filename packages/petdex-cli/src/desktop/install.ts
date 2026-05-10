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
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
// whichever was published last regardless of prefix; we filter to
// desktop-v* explicitly. We paginate through the list because a long
// streak of web/sidecar releases between desktop tags would otherwise
// hide the latest desktop release behind page 1.
const RELEASES_API_BASE =
  "https://api.github.com/repos/crafter-station/petdex/releases";
const RELEASES_PAGE_SIZE = 30;
// Cap the search at 5 pages = 150 releases. Anything older than that
// is almost certainly stale anyway, and searching forever would burn
// the GitHub API rate limit if the repo state ever loses every
// desktop tag.
const RELEASES_MAX_PAGES = 5;
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

export async function fetchLatestRelease(
  options: { fetchOverride?: typeof fetch; maxPages?: number } = {},
): Promise<Release> {
  const fetchImpl = options.fetchOverride ?? fetch;
  const maxPages = options.maxPages ?? RELEASES_MAX_PAGES;

  // Walk pages newest-first until we hit a desktop-v* release or
  // exhaust the cap. Most repos will resolve on page 1; the loop
  // exists so a long run of web-v*/sidecar-v* releases doesn't
  // make us return "no desktop release" when one is just on page 2.
  let scanned = 0;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${RELEASES_API_BASE}?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
    const res = await fetchImpl(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const releases = (await res.json()) as Array<
      Release & { draft?: boolean; prerelease?: boolean }
    >;
    if (!Array.isArray(releases) || releases.length === 0) {
      // Empty page = end of list. If we've never found a desktop
      // release, fall through to the throw below.
      break;
    }
    scanned += releases.length;
    const hit = releases.find(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        typeof r.tag_name === "string" &&
        r.tag_name.startsWith(DESKTOP_TAG_PREFIX),
    );
    if (hit) return hit;
    // Short page = end of list reached, no point asking for the next.
    if (releases.length < RELEASES_PAGE_SIZE) break;
  }
  throw new Error(
    `No ${DESKTOP_TAG_PREFIX}* release found in the last ${scanned} releases (scanned ${maxPages} page(s))`,
  );
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

// Hosts we trust for serving pet assets (spritesheet + pet.json).
// Mirrored from src/lib/url-allowlist.ts (the server-side validation
// for /api/submit). The manifest API is itself trusted (we control
// PETDEX_URL), but the URLs IT returns are still data — if the
// manifest were ever compromised, or PETDEX_URL got pointed at a
// malicious origin in CI/dev, an unrestricted fetch would write
// attacker-controlled bytes to ~/.petdex/pets and ~/.codex/pets.
// Keep this list in sync with the server-side allowlist.
const TRUSTED_ASSET_HOSTS = new Set<string>([
  // R2 public bucket (current asset origin).
  "pub-94495283df974cfea5e98d6a9e3fa462.r2.dev",
  // Legacy UploadThing host. Rows from before the R2 migration still
  // point here; safe for GET because UT URLs are user-uploaded but
  // namespaced. Drop when no manifest entries reference UT anymore.
  "yu2vz9gndp.ufs.sh",
]);

export function isTrustedAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return TRUSTED_ASSET_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

// Lazy HOME lookup so tests can swap process.env.HOME and have the
// pets dirs land in their tmpdir. os.homedir() ignores HOME on
// macOS — we prefer process.env.HOME, falling back to homedir() when
// unset (e.g. in real CLI usage).
function homeDir(): string {
  return process.env.HOME ?? homedir();
}

function petsRoot(): string {
  return path.join(homeDir(), ".petdex", "pets");
}

function codexPetsRoot(): string {
  return path.join(homeDir(), ".codex", "pets");
}

// Same size cap as MAX_PET_BYTES in main.zig. Spritesheets larger
// than this fail loadSpritesheet and crash the desktop on startup,
// so they don't count as a "usable" pet from the CLI's perspective
// either — `petdex install desktop` should treat that user as
// having no pets and download the starter.
const MAX_PET_BYTES = 16 * 1024 * 1024;

// Returns true iff the slug directory contains a spritesheet that
// the desktop binary would actually accept: present, openable,
// stat-able, and within the size cap. Mirrors the validation in
// main.zig's hasSpritesheet/checkSpritesheetVariant.
function isPetUsable(slugDir: string): boolean {
  for (const name of ["spritesheet.webp", "spritesheet.png"]) {
    const file = path.join(slugDir, name);
    try {
      const stat = statSync(file);
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_PET_BYTES) {
        return true;
      }
    } catch {
      // missing or unreadable — try the other extension
    }
  }
  return false;
}

// True only if at least one pet directory under either canonical
// pets root has a usable spritesheet under MAX_PET_BYTES. The
// previous "any path exists" check let a stale/oversized sprite
// count as "installed" — `petdex install desktop` would then skip
// the starter download, and `petdex desktop start` would crash on
// the unreadable file.
export async function _hasAnyInstalledPetForTest(): Promise<boolean> {
  return hasAnyInstalledPet();
}

async function hasAnyInstalledPet(): Promise<boolean> {
  const { readdir } = await import("node:fs/promises");
  for (const root of [petsRoot(), codexPetsRoot()]) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue; // root doesn't exist yet
    }
    for (const slug of entries) {
      if (isPetUsable(path.join(root, slug))) return true;
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
export async function _installStarterPetForTest(
  options: { fetchOverride?: typeof fetch; petdexUrl?: string } = {},
): Promise<string | null> {
  return installStarterPet(options);
}

async function installStarterPet(
  options: { fetchOverride?: typeof fetch; petdexUrl?: string } = {},
): Promise<string | null> {
  const fetchImpl = options.fetchOverride ?? fetch;
  const baseUrl = options.petdexUrl ?? PETDEX_URL;
  type Pet = {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
    petJsonUrl: string;
  };
  let manifestPets: Pet[];
  try {
    const res = await fetchImpl(`${baseUrl}/api/manifest`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pets: Pet[] };
    manifestPets = Array.isArray(data?.pets) ? data.pets : [];
  } catch {
    return null;
  }
  if (manifestPets.length === 0) return null;

  // Build a candidate ordering: preferred default first, then the
  // manifest as-is. We dedupe so DEFAULT_PET_SLUG isn't tried twice.
  const ordered: Pet[] = [];
  const seen = new Set<string>();
  const preferred = manifestPets.find((p) => p.slug === DEFAULT_PET_SLUG);
  if (preferred) {
    ordered.push(preferred);
    seen.add(preferred.slug);
  }
  for (const p of manifestPets) {
    if (!seen.has(p.slug)) {
      ordered.push(p);
      seen.add(p.slug);
    }
  }

  // Walk the candidates and install the first one whose:
  //   - asset URLs both pass the host allowlist (anti-SSRF)
  //   - target directories are FREE in both pets roots (we never
  //     overwrite a pre-existing slug dir, even if it's broken)
  // If every candidate is taken or untrusted we give up — the
  // caller will surface a recoverable hint to the user.
  for (const candidate of ordered) {
    const installed = await tryInstallStarterCandidate(candidate, fetchImpl);
    if (installed) return installed;
  }
  return null;
}

async function tryInstallStarterCandidate(
  pet: {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
    petJsonUrl: string;
  },
  fetchImpl: typeof fetch,
): Promise<string | null> {
  // Belt-and-braces: the server-side /api/manifest already filters
  // submissions through the same allowlist, but a CLI installing
  // bytes into the user's HOME shouldn't trust that boundary alone.
  // If either URL fails the host check, skip this candidate and
  // try the next one — better than aborting the starter flow
  // entirely if just one row is misconfigured.
  if (
    !isTrustedAssetUrl(pet.spritesheetUrl) ||
    !isTrustedAssetUrl(pet.petJsonUrl)
  ) {
    return null;
  }

  const ext = pet.spritesheetUrl.endsWith(".png") ? "png" : "webp";
  const targets = [
    path.join(petsRoot(), pet.slug),
    path.join(codexPetsRoot(), pet.slug),
  ];

  // Refuse to touch a pet directory that already exists. The user
  // could have a partial/custom install at ~/.petdex/pets/boba.
  // We don't repair: skip this slug and try the next manifest
  // candidate. The starter flow's whole point is to give the user
  // SOMETHING to render, and another pet is a strictly better
  // outcome than racing a write against existing files.
  for (const t of targets) {
    if (existsSync(t)) return null;
  }

  const fetchOrThrow = async (url: string): Promise<ArrayBuffer> => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
    return res.arrayBuffer();
  };

  // Download to memory FIRST so we don't even create a dir on the
  // user's disk if the network fails. Writes happen only after both
  // assets are fully buffered.
  let petJson: ArrayBuffer;
  let spritesheet: ArrayBuffer;
  try {
    [petJson, spritesheet] = await Promise.all([
      fetchOrThrow(pet.petJsonUrl),
      fetchOrThrow(pet.spritesheetUrl),
    ]);
  } catch {
    return null;
  }

  // Stage each target into a sibling temp dir, then rename atomically
  // into place. If the rename fails on one target we clean up only
  // the temp dirs WE created — a pre-existing target dir is never
  // touched (the existsSync check above ensured none existed at the
  // time we started, but rm is path-pinned anyway).
  const stagedDirs: string[] = [];
  const renamedDirs: string[] = [];
  try {
    for (const t of targets) {
      const stage = `${t}.partial-${randomBytes(6).toString("hex")}`;
      await mkdir(stage, { recursive: true });
      stagedDirs.push(stage);
      await Promise.all([
        writeFile(path.join(stage, "pet.json"), Buffer.from(petJson)),
        writeFile(
          path.join(stage, `spritesheet.${ext}`),
          Buffer.from(spritesheet),
        ),
      ]);
      // Ensure the parent (e.g. ~/.petdex/pets) exists; rename
      // would otherwise fail if this is the user's first install.
      await mkdir(path.dirname(t), { recursive: true });
      await rename(stage, t);
      // Once renamed, the path no longer belongs to the staging
      // bucket — we drop it from stagedDirs and add it to
      // renamedDirs in case a LATER target fails and we have to
      // unwind.
      stagedDirs.pop();
      renamedDirs.push(t);
    }
    return pet.slug;
  } catch {
    // Best-effort cleanup. Only remove paths we created in this
    // call: the staged temp dirs (always safe — random suffix), and
    // the freshly-renamed targets (safe because existsSync(t) was
    // false before we started; anything at that path now is ours).
    await Promise.all([
      ...stagedDirs.map((d) => rm(d, { recursive: true, force: true })),
      ...renamedDirs.map((d) => rm(d, { recursive: true, force: true })),
    ]);
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

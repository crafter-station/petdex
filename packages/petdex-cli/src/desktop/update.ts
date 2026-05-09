/**
 * `petdex update` — checks GitHub Releases for a newer petdex-desktop binary,
 * downloads it (and the sidecar) atomically, then restarts the running
 * process so the user picks up the new version without manual steps.
 *
 * Tracks the installed version at ~/.petdex/version. If the file is missing
 * (first time on this machine) it just downloads the latest, treating it
 * as a clean install.
 *
 * Atomic flow (so a failed download never leaves the user without a mascot):
 *   1. Fetch GH release metadata
 *   2. Download binary + sidecar to {dest}.tmp
 *   3. Stop the running desktop (if any)
 *   4. Rename tmp files into place
 *   5. Restart desktop
 *
 * If step 2 fails: nothing on disk has changed and the running mascot keeps
 * working. If step 4 fails after stop: the user can restart manually.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import { downloadDesktopAssets, fetchLatestRelease } from "./install.js";
import { desktopStatus, startDesktop, stopDesktop } from "./process.js";

const VERSION_FILE = path.join(homedir(), ".petdex", "version");

function readInstalledVersion(): string | null {
  if (!existsSync(VERSION_FILE)) return null;
  try {
    return readFileSync(VERSION_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export async function runUpdate(args: string[] = []): Promise<void> {
  const force = args.includes("--force");
  p.intro(pc.bgMagenta(pc.white(" petdex update ")));

  const installed = readInstalledVersion();
  if (installed) {
    p.log.info(`Installed: ${pc.cyan(installed)}`);
  } else {
    p.log.info("No installed version recorded - treating as fresh install.");
  }

  const s = p.spinner();
  s.start("Checking GitHub for the latest release");
  let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    s.stop(pc.red("failed"));
    throw new Error(
      `Could not reach GitHub. Check your connection.\n   ${(err as Error).message}`,
    );
  }
  s.stop(`${pc.green("✓")} Latest: ${pc.bold(release.tag_name)}`);

  if (!force && installed && installed === release.tag_name) {
    p.outro(`${pc.green("✓")} Already up to date.`);
    return;
  }

  // Phase 1: download to .tmp staging files. Safe to bail at any point.
  const dl = p.spinner();
  dl.start(`Downloading ${release.tag_name}`);
  let result: Awaited<ReturnType<typeof downloadDesktopAssets>>;
  try {
    // downloadDesktopAssets writes via {dest}.tmp + atomic rename. After
    // this returns successfully, both the binary and sidecar are in place.
    result = await downloadDesktopAssets(release);
  } catch (err) {
    dl.stop(pc.red("failed"));
    throw err;
  }
  dl.stop(
    `${pc.green("✓")} Downloaded ${pc.bold(release.tag_name)} (${formatBytes(result.binAsset.size)})`,
  );

  // Phase 2: stop running desktop AFTER download succeeded. The window where
  // the mascot is offline is now bounded by stop + start, not by network.
  const wasRunning = desktopStatus().state === "running";
  if (wasRunning) {
    p.log.info(`${pc.dim("•")} Stopping running petdex-desktop`);
    stopDesktop();
  }

  await writeFile(VERSION_FILE, `${release.tag_name}\n`);

  // Phase 3: restart so the user picks up the new binary + sidecar.
  if (wasRunning) {
    p.log.info(`${pc.dim("•")} Restarting petdex-desktop`);
    const startResult = await startDesktop();
    if (startResult.ok) {
      p.log.info(`${pc.green("✓")} Restarted (pid ${startResult.pid})`);
    } else {
      p.log.warn(
        `${pc.yellow("!")} Could not restart: ${startResult.reason}. Run \`petdex desktop start\` manually.`,
      );
    }
  }

  const note = installed
    ? `${installed}  →  ${release.tag_name}`
    : release.tag_name;
  p.outro(`${pc.green("✓")} ${note}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

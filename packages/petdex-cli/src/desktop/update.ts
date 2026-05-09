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
  // --silent skips the @clack/prompts UI (intro/spinner/outro) and uses
  // plain console.log instead. Designed to be invoked by the desktop
  // sidecar's POST /update endpoint; the sidecar pipes stdout/stderr
  // into ~/.petdex/runtime/update.log.
  const silent = args.includes("--silent");

  // Logging shims. In silent mode the spinner becomes a no-op so we
  // don't render terminal escape sequences into the sidecar's log file.
  const intro = (label: string) => {
    if (silent) console.log(`[petdex update] ${label}`);
    else p.intro(pc.bgMagenta(pc.white(` ${label} `)));
  };
  const info = (msg: string) => {
    if (silent) console.log(msg);
    else p.log.info(msg);
  };
  const warn = (msg: string) => {
    if (silent) console.warn(msg);
    else p.log.warn(msg);
  };
  const outro = (msg: string) => {
    if (silent) console.log(msg);
    else p.outro(msg);
  };
  type Spinner = { start: (msg: string) => void; stop: (msg: string) => void };
  const makeSpinner = (): Spinner => {
    if (silent) {
      return {
        start: (m) => console.log(m),
        stop: (m) => console.log(m),
      };
    }
    const s = p.spinner();
    return {
      start: (m) => s.start(m),
      stop: (m) => s.stop(m),
    };
  };

  intro("petdex update");

  const installed = readInstalledVersion();
  info(
    installed
      ? `Installed: ${silent ? installed : pc.cyan(installed)}`
      : "No installed version recorded - treating as fresh install.",
  );

  const s = makeSpinner();
  s.start("Checking GitHub for the latest release");
  let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    s.stop(silent ? "failed" : pc.red("failed"));
    throw new Error(
      `Could not reach GitHub. Check your connection.\n   ${(err as Error).message}`,
    );
  }
  s.stop(
    silent
      ? `Latest: ${release.tag_name}`
      : `${pc.green("✓")} Latest: ${pc.bold(release.tag_name)}`,
  );

  if (!force && installed && installed === release.tag_name) {
    outro(
      silent ? "Already up to date." : `${pc.green("✓")} Already up to date.`,
    );
    return;
  }

  // Phase 1: download to .tmp staging files. Safe to bail at any point.
  const dl = makeSpinner();
  dl.start(`Downloading ${release.tag_name}`);
  let result: Awaited<ReturnType<typeof downloadDesktopAssets>>;
  try {
    // downloadDesktopAssets writes via {dest}.tmp + atomic rename. After
    // this returns successfully, both the binary and sidecar are in place.
    result = await downloadDesktopAssets(release);
  } catch (err) {
    dl.stop(silent ? "failed" : pc.red("failed"));
    throw err;
  }
  dl.stop(
    silent
      ? `Downloaded ${release.tag_name} (${formatBytes(result.binAsset.size)})`
      : `${pc.green("✓")} Downloaded ${pc.bold(release.tag_name)} (${formatBytes(result.binAsset.size)})`,
  );

  // Phase 2: stop running desktop AFTER download succeeded. The window where
  // the mascot is offline is now bounded by stop + start, not by network.
  const wasRunning = desktopStatus().state === "running";
  if (wasRunning) {
    info(
      silent
        ? "Stopping running petdex-desktop"
        : `${pc.dim("•")} Stopping running petdex-desktop`,
    );
    stopDesktop();
  }

  await writeFile(VERSION_FILE, `${release.tag_name}\n`);

  // Phase 3: restart so the user picks up the new binary + sidecar.
  // In --silent mode we skip the restart: when the sidecar that
  // triggered this update gets killed by stopDesktop, child npm
  // processes also get reaped if the user ran us under the desktop
  // process tree. Leaving restart to the user (or to a follow-up
  // notification) keeps the update predictable.
  if (wasRunning && !silent) {
    info(`${pc.dim("•")} Restarting petdex-desktop`);
    const startResult = await startDesktop();
    if (startResult.ok) {
      info(`${pc.green("✓")} Restarted (pid ${startResult.pid})`);
    } else {
      warn(
        `${pc.yellow("!")} Could not restart: ${startResult.reason}. Run \`petdex desktop start\` manually.`,
      );
    }
  } else if (wasRunning && silent) {
    info(
      "Desktop was running; restart manually after the next launch notification.",
    );
  }

  const note = installed
    ? `${installed}  →  ${release.tag_name}`
    : release.tag_name;
  outro(silent ? note : `${pc.green("✓")} ${note}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

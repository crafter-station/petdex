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

import {
  commitDesktopAssets,
  fetchLatestRelease,
  stageDesktopAssets,
} from "./install.js";
import {
  desktopStatus,
  startDesktop,
  stopDesktop,
  waitForPortRelease,
} from "./process.js";

const SIDECAR_PORT = 7777;
const UPDATE_TOKEN_HEADER = "x-petdex-update-token";
const UPDATE_TOKEN_PATH = path.join(
  homedir(),
  ".petdex",
  "runtime",
  "update-token",
);

const VERSION_FILE = path.join(homedir(), ".petdex", "version");

/**
 * Ask the running sidecar to release :7777 before we restart. Without
 * this signal we'd deadlock: the sidecar holds the port until we exit,
 * and we wait on the port before exiting. Reading the token from
 * ~/.petdex/runtime/update-token is the same auth path the WebView
 * curl uses.
 *
 * Best-effort. If the token file is missing, the sidecar isn't
 * actually running, the request 401s/404s (older sidecar that
 * predates this endpoint), or anything else fails, we return false so
 * the caller falls back to waitForPortRelease — that's the safety
 * net for any case the handoff can't cover.
 */
export async function requestSidecarHandoff(options: {
  port?: number;
  timeoutMs?: number;
  tokenPath?: string;
} = {}): Promise<boolean> {
  const port = options.port ?? SIDECAR_PORT;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const tokenPath = options.tokenPath ?? UPDATE_TOKEN_PATH;
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    return false;
  }
  if (!token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/update/handoff`,
      {
        method: "POST",
        headers: { [UPDATE_TOKEN_HEADER]: token },
        signal: controller.signal,
      },
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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

  // Phase 1: download into .tmp staging files. NOTHING has been
  // renamed into place yet — the running desktop binary on disk is
  // untouched. Safe to bail at any point.
  const dl = makeSpinner();
  dl.start(`Downloading ${release.tag_name}`);
  let staged: Awaited<ReturnType<typeof stageDesktopAssets>>;
  try {
    staged = await stageDesktopAssets(release);
  } catch (err) {
    dl.stop(silent ? "failed" : pc.red("failed"));
    throw err;
  }
  dl.stop(
    silent
      ? `Downloaded ${release.tag_name} (${formatBytes(staged.binAsset.size)})`
      : `${pc.green("✓")} Downloaded ${pc.bold(release.tag_name)} (${formatBytes(staged.binAsset.size)})`,
  );

  // Phase 2: stop running desktop BEFORE the rename. On Windows and
  // some Linux setups, renaming over a running executable fails with
  // EBUSY/ETXTBSY; the previous flow committed first and could fail
  // before stopDesktop() ever ran. Stopping here also bounds the
  // mascot-offline window to (rename + restart), not (download +
  // rename + restart).
  const wasRunning = desktopStatus().state === "running";
  if (wasRunning) {
    info(
      silent
        ? "Stopping running petdex-desktop"
        : `${pc.dim("•")} Stopping running petdex-desktop`,
    );
    await stopDesktop();
  }

  // Phase 3: commit. commitDesktopAssets rolls back from .prev
  // snapshots if any rename fails; we still have the previous
  // coherent install on disk. We let the throw bubble up as-is so
  // the caller's outer error handler reports it.
  await commitDesktopAssets(staged);

  await writeFile(VERSION_FILE, `${release.tag_name}\n`);

  // Phase 4: restart so the user picks up the new binary + sidecar.
  //
  // In --silent mode the sidecar that spawned us deliberately keeps
  // serving until its updater child (this process) exits. That means
  // when we hit startDesktop() the old sidecar still owns :7777, the
  // new desktop spawns a new sidecar, and the new sidecar bombs out
  // on EADDRINUSE. Then the old sidecar finally exits, leaves the
  // port free, and the user has a desktop with no hook listener.
  //
  // Wait for the port to actually free up before we restart. We wait
  // up to 10s; if the old sidecar is still holding it past that,
  // surface the failure with a remediation rather than fire-and-
  // pray.
  if (wasRunning) {
    // Ask the sidecar to release :7777 first. The sidecar deliberately
    // keeps serving while this updater child is running; without an
    // explicit handoff it never lets go, the port wait below would
    // time out, and we'd return without restarting (deadlock from
    // opencode-bot review). The handoff is best-effort — older
    // sidecars without the endpoint, missing token files, etc. — so
    // we always still call waitForPortRelease as a safety net.
    info(
      silent
        ? "Asking sidecar to release port"
        : `${pc.dim("•")} Asking sidecar to release port`,
    );
    const handedOff = await requestSidecarHandoff();
    info(
      silent
        ? handedOff
          ? "Sidecar acknowledged handoff"
          : "Sidecar handoff unavailable, falling back to port wait"
        : handedOff
          ? `${pc.dim("•")} Sidecar acknowledged handoff`
          : `${pc.dim("•")} Sidecar handoff unavailable, falling back to port wait`,
    );
    const portFree = await waitForPortRelease(SIDECAR_PORT, {
      timeoutMs: 10_000,
    });
    if (!portFree) {
      warn(
        silent
          ? `Port ${SIDECAR_PORT} still in use after 10s. Run 'petdex desktop stop && petdex desktop start' to recover.`
          : `${pc.yellow("!")} Port ${SIDECAR_PORT} still in use after 10s. Run \`petdex desktop stop && petdex desktop start\` to recover.`,
      );
      // Don't restart — we'd just spawn a desktop whose sidecar
      // immediately crashes. Better to leave the user with the
      // version-file already updated and an explicit recovery
      // command than to silently produce a broken state.
      return;
    }
    info(
      silent
        ? "Restarting petdex-desktop"
        : `${pc.dim("•")} Restarting petdex-desktop`,
    );
    const startResult = await startDesktop();
    if (startResult.ok) {
      info(
        silent
          ? `Restarted (pid ${startResult.pid})`
          : `${pc.green("✓")} Restarted (pid ${startResult.pid})`,
      );
    } else {
      warn(
        silent
          ? `Could not restart: ${startResult.reason}. Run 'petdex desktop start' manually.`
          : `${pc.yellow("!")} Could not restart: ${startResult.reason}. Run \`petdex desktop start\` manually.`,
      );
    }
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

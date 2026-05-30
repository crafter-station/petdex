/**
 * `petdex desktop {start|stop|status}` — manages the petdex-desktop process.
 *
 * Stores the current PID at ~/.petdex/desktop.pid so subsequent runs can
 * detect a previous instance and avoid spawning duplicates.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import pc from "picocolors";

import { desktopBinPath, homeDir } from "./install.js";

function pidFile(): string {
  return path.join(homeDir(), ".petdex", "desktop.pid");
}
function logFile(): string {
  return path.join(homeDir(), ".petdex", "desktop.log");
}

// On-disk pid file shape. We store BOTH the pid and the process
// start-time string so that `desktop stop` can refuse to signal a
// pid that the OS recycled to an unrelated user process. Without
// the start-time check, a long-uptime macOS box that reused the
// pid for vim or ssh-agent would let `petdex desktop stop` SIGTERM
// somebody else's session.
//
// `ps -p <pid> -o lstart=` is the cross-platform (POSIX) source of
// truth. We don't parse it — just store the raw string and compare
// for equality. macOS doesn't expose start-time anywhere cheaper.
type PidRecord = { pid: number; lstart: string };

function readPidFile(): PidRecord | null {
  if (!existsSync(pidFile())) return null;
  let txt: string;
  try {
    txt = readFileSync(pidFile(), "utf8").trim();
  } catch {
    return null;
  }
  // New format: JSON with pid + lstart.
  if (txt.startsWith("{")) {
    try {
      const parsed = JSON.parse(txt) as Partial<PidRecord>;
      if (
        typeof parsed.pid === "number" &&
        Number.isFinite(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.lstart === "string" &&
        parsed.lstart.length > 0
      ) {
        return { pid: parsed.pid, lstart: parsed.lstart };
      }
    } catch {
      // fall through
    }
    return null;
  }
  // Legacy format: bare pid number from older versions. We can't
  // verify identity, so treat it as stale on first read; the next
  // start writes the new format and we recover.
  const pid = Number(txt);
  if (Number.isFinite(pid) && pid > 0) {
    return { pid, lstart: "" }; // empty lstart triggers stale path
  }
  return null;
}

// `ps -p <pid> -o lstart=` is the POSIX-portable way to get a
// process's start time as a stable string ("Sat May  9 18:32:02 2026").
// Exit code is non-zero when pid doesn't exist, so we return null.
// We use execFileSync (no shell) to avoid quoting bugs.
// Windows does not have ps; all callers already guard on platform,
// but the early return makes the POSIX-only contract self-documenting.
function processStartTime(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// Return the lowercase exe basename of a running Windows process via tasklist.
// Returns null if the process does not exist.
// Output format: "petdex-desktop-win32-x64.exe","12345",...
// wmic is absent on Windows 11 22H2+; tasklist is always present.
function processExeName(pid: number): string | null {
  try {
    const out = execFileSync(
      "tasklist",
      ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    // First CSV field is the exe name (double-quoted). No match means the
    // process was not found ("INFO: No tasks are running...").
    const match = out.match(/^"([^"]+)"/m);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

// Returns the identity token to store alongside the pid.
// On Windows: the lowercase exe basename so pidMatchesRecord() can detect
// PID reuse by comparing the live name with the stored one.
// On POSIX: the process start-time string from `ps -p … -o lstart=`.
function recordLstart(pid: number): string {
  if (process.platform === "win32") {
    // We just spawned this process; the basename is known from the binary
    // path rather than re-queried, which avoids a race where tasklist hasn't
    // yet registered the process.
    return path.basename(desktopBinPath()).toLowerCase();
  }
  return processStartTime(pid) ?? "";
}

/**
 * Check whether a petdex-desktop process is alive at the given pid.
 *
 * On Windows: `tasklist` retrieves the exe name for the pid — this proves
 * the process is running without relying on ps or wmic.
 * On POSIX: `ps -p <pid>` exits 0 when the process exists.
 *
 * Exported so tests can verify the platform-specific branch.
 */
export function isPetdexPidAlive(pid: number): boolean {
  if (process.platform === "win32") {
    return processExeName(pid) !== null;
  }
  try {
    execFileSync("ps", ["-p", String(pid)], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// True only if the live process at `pid` matches the identity we recorded.
// On Windows: compares the live tasklist exe name with the stored exe name,
// preventing false positives from OS pid reuse.
// On POSIX: compares the live start-time string from `ps -o lstart=`.
// Empty stored lstart (legacy pid file) is treated as failure — we never
// blindly signal an unverified pid.
function pidMatchesRecord(record: PidRecord): boolean {
  if (record.lstart.length === 0) return false;
  if (process.platform === "win32") {
    const live = processExeName(record.pid);
    return live !== null && live === record.lstart;
  }
  const live = processStartTime(record.pid);
  return live !== null && live === record.lstart;
}

function clearPidFile(): void {
  try {
    unlinkSync(pidFile());
  } catch {
    // not present, fine
  }
}

export type DesktopStatus =
  | { state: "running"; pid: number }
  | { state: "stopped" }
  | { state: "stale"; pid: number };

export function desktopStatus(): DesktopStatus {
  const record = readPidFile();
  if (record == null) return { state: "stopped" };
  // pid + start-time match → it's still our process.
  if (pidMatchesRecord(record)) return { state: "running", pid: record.pid };
  // pid is dead OR alive-but-recycled. Both are "stale" for our
  // purposes; the difference doesn't matter to the caller (we won't
  // signal it either way) and we'd rather err on the side of NOT
  // killing somebody else's process.
  return { state: "stale", pid: record.pid };
}

export type StartResult =
  | { ok: true; pid: number; alreadyRunning: boolean }
  | { ok: false; reason: string };

export async function startDesktop(): Promise<StartResult> {
  const status = desktopStatus();
  if (status.state === "running") {
    return { ok: true, pid: status.pid, alreadyRunning: true };
  }
  if (status.state === "stale") clearPidFile();

  const bin = desktopBinPath();
  if (!existsSync(bin)) {
    return {
      ok: false,
      reason: `petdex-desktop binary not found at ${bin}. Run \`petdex install desktop\` first.`,
    };
  }

  await mkdir(path.dirname(logFile()), { recursive: true });

  const out = await import("node:fs").then((fs) => fs.openSync(logFile(), "a"));
  const err = await import("node:fs").then((fs) => fs.openSync(logFile(), "a"));

  // If the binary is inside an .app bundle, launch via `open -a` so
  // macOS treats it as a proper application (Dock icon, LaunchServices
  // registration, correct menubar title from CFBundleName, app
  // activation policy). Spawning the bare executable directly skips
  // all of that and the user sees an unstyled raw process.
  //
  // Trade-off: `open` returns immediately and doesn't give us the
  // child's pid. We grep for it via pgrep right after launch. A few
  // ms of delay is fine because petdex-desktop binds :7777 quickly
  // anyway and pgrep is cheap.
  const appBundle = findEnclosingAppBundle(bin);
  if (appBundle) {
    return startViaOpen(appBundle);
  }

  const child = spawn(bin, [], {
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();

  if (!child.pid) {
    return { ok: false, reason: "Failed to spawn petdex-desktop" };
  }

  // Capture the start-time so a future `petdex desktop stop` can
  // verify identity before signalling. recordLstart() handles the
  // POSIX (ps) and Windows (sentinel) cases.
  const record: PidRecord = { pid: child.pid, lstart: recordLstart(child.pid) };
  await writeFile(pidFile(), JSON.stringify(record));
  return { ok: true, pid: child.pid, alreadyRunning: false };
}

// Walks up from /…/Petdex.app/Contents/MacOS/petdex-desktop and returns
// the .app path if found. Returns null for bare-binary installs (e.g.
// ~/.petdex/bin/petdex-desktop).
function findEnclosingAppBundle(binPath: string): string | null {
  // The binary always lives at <bundle>/Contents/MacOS/<name>.
  const macosDir = path.dirname(binPath);
  if (path.basename(macosDir) !== "MacOS") return null;
  const contentsDir = path.dirname(macosDir);
  if (path.basename(contentsDir) !== "Contents") return null;
  const bundle = path.dirname(contentsDir);
  if (!bundle.endsWith(".app")) return null;
  return bundle;
}

async function startViaOpen(appBundle: string): Promise<StartResult> {
  // `open -gj` keeps Petdex from stealing focus from the user's
  // terminal/agent. -W would wait for the app to exit, which we
  // don't want; we want fire-and-forget. -n forces a new instance
  // (we already verified state was stopped above, so this is just
  // belt-and-braces).
  const result = spawn("open", ["-gj", appBundle], {
    stdio: "ignore",
    detached: true,
  });
  result.unref();

  // Poll for the child process — open returns immediately so we
  // need to discover the pid LaunchServices spawned. Cap at 3s so
  // a misconfigured bundle doesn't hang the CLI.
  const deadline = Date.now() + 3_000;
  let pid: number | null = null;
  while (Date.now() < deadline) {
    pid = pgrepPetdexDesktop();
    if (pid) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!pid) {
    return {
      ok: false,
      reason: `Launched ${appBundle} but couldn't find the resulting process. Check ${logFile()}.`,
    };
  }

  const record: PidRecord = { pid, lstart: recordLstart(pid) };
  await writeFile(pidFile(), JSON.stringify(record));
  return { ok: true, pid, alreadyRunning: false };
}

function pgrepPetdexDesktop(): number | null {
  try {
    // Match the executable name inside the bundle (Contents/MacOS/petdex-desktop).
    // -f matches against the full command line so the path inside the bundle counts.
    const out = execFileSync("pgrep", ["-f", "petdex-desktop"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    // pgrep returns one pid per line; take the most recent (last).
    const lines = out.split("\n").filter((l) => l.length > 0);
    const pid = Number(lines[lines.length - 1]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export type StopResult =
  | { ok: true; pid: number; portReleased: boolean }
  | { ok: false; reason: string };

const SIDECAR_PORT = 7777;

export async function stopDesktop(
  options: { sidecarPort?: number; portWaitTimeoutMs?: number } = {},
): Promise<StopResult> {
  const sidecarPort = options.sidecarPort ?? SIDECAR_PORT;
  const portWaitTimeoutMs = options.portWaitTimeoutMs ?? 5_000;
  const status = desktopStatus();
  if (status.state === "stopped") {
    return { ok: false, reason: "petdex-desktop is not running" };
  }
  if (status.state === "stale") {
    // Either the desktop is dead, or the OS recycled the pid for an
    // unrelated process. Either way we MUST NOT signal it. Drop the
    // stale record and tell the caller we have nothing to stop.
    clearPidFile();
    return {
      ok: false,
      reason: `petdex-desktop is not running (stale pid ${status.pid} cleared)`,
    };
  }
  const pid = status.pid;
  // TOCTOU shrink: re-verify identity right before signalling. The
  // window between desktopStatus() and process.kill() is ~ms; a pid
  // recycle in that window is essentially impossible on macOS, but
  // re-checking is microseconds and removes the residual race. We
  // re-read the pid file so we're comparing against the record we
  // believed in, not state from a stale closure.
  const recheckRecord = readPidFile();
  if (recheckRecord === null || !pidMatchesRecord(recheckRecord)) {
    clearPidFile();
    return {
      ok: false,
      reason: `petdex-desktop exited before stop (pid ${pid} no longer alive)`,
    };
  }
  if (process.platform === "win32") {
    // SIGTERM via process.kill() maps to TerminateProcess() on Windows,
    // which does not give the child a chance to clean up (no WM_QUIT).
    // taskkill /t /f sends TerminateProcess to the whole process tree,
    // which also kills the sidecar child — the desired behaviour.
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // taskkill can fail if the process exited between our liveness
      // recheck and the kill call (tiny race window). Mirror POSIX ESRCH:
      // if the process is already gone, that is success.
      if (!isPetdexPidAlive(pid)) {
        clearPidFile();
        const released = await waitForPortRelease(sidecarPort, {
          timeoutMs: portWaitTimeoutMs,
        });
        return { ok: true, pid, portReleased: released };
      }
      return {
        ok: false,
        reason: `taskkill failed and pid ${pid} is still alive`,
      };
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      clearPidFile();
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH means the process exited between our re-check and this
      // kill (microsecond window). From the user's perspective "stop"
      // succeeded — the process is gone.
      if (code === "ESRCH") {
        // Try the port wait anyway — the sidecar may still be alive
        // because the desktop binary is its parent, not us.
        const released = await waitForPortRelease(sidecarPort, {
          timeoutMs: portWaitTimeoutMs,
        });
        return { ok: true, pid, portReleased: released };
      }
      return {
        ok: false,
        reason: `Failed to signal pid ${pid}: ${(err as Error).message}`,
      };
    }
  }
  clearPidFile();
  // Wait for the sidecar to actually release :7777 before we tell
  // the caller "stopped". Without this wait `petdex desktop stop &&
  // petdex desktop start` races: the new desktop spawns its own
  // sidecar before the old one has noticed its parent is gone (the
  // sidecar's parent watchdog polls every 2s), and the new sidecar
  // crashes on EADDRINUSE. The cap is 5s — well above the 2s
  // watchdog interval plus the HTTP server's drain time.
  const portReleased = await waitForPortRelease(sidecarPort, {
    timeoutMs: portWaitTimeoutMs,
  });
  return { ok: true, pid, portReleased };
}

export async function cmdDesktopStart(): Promise<void> {
  const result = await startDesktop();
  if (!result.ok) {
    console.error(`${pc.red("✗")} ${result.reason}`);
    process.exit(1);
  }
  if (result.alreadyRunning) {
    console.log(
      `${pc.dim("•")} petdex-desktop already running (pid ${result.pid})`,
    );
  } else {
    console.log(`${pc.green("✓")} petdex-desktop started (pid ${result.pid})`);
    console.log(pc.dim(`  log: ${logFile()}`));
  }
}

export async function cmdDesktopStop(): Promise<void> {
  const result = await stopDesktop();
  if (!result.ok) {
    console.error(`${pc.dim("•")} ${result.reason}`);
    process.exit(result.reason.includes("not running") ? 0 : 1);
  }
  // If the sidecar is still holding :7777 after our 5s cap, warn
  // the user — the next `petdex desktop start` could fail with
  // EADDRINUSE. Better to surface it now than have the next start
  // command produce a confusing error.
  if (result.portReleased) {
    console.log(`${pc.green("✓")} stopped pid ${result.pid}`);
  } else {
    console.log(
      `${pc.yellow("!")} stopped pid ${result.pid}, but :${SIDECAR_PORT} still busy`,
    );
    console.log(
      pc.dim(
        `  if 'petdex desktop start' fails with EADDRINUSE, wait a moment and retry`,
      ),
    );
  }
}

/**
 * Poll-and-wait for whoever is bound to 127.0.0.1:<port> to release
 * it. Returns true once the port is free, false if `timeoutMs`
 * elapses first. Used by the update flow to ensure the old sidecar
 * has actually exited before we spawn a new desktop, which would
 * otherwise spawn its own sidecar and crash on EADDRINUSE while the
 * old one was still draining its updater child.
 */
export async function waitForPortRelease(
  port: number,
  options: { timeoutMs?: number; intervalMs?: number; host?: string } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const host = options.host ?? "127.0.0.1";
  const { createConnection } = await import("node:net");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      const cleanup = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => cleanup(false));
      socket.once("error", (err: NodeJS.ErrnoException) => {
        // ECONNREFUSED means nothing is listening — port is free.
        // Any other error (host unreachable, etc.) we treat as
        // "no sidecar here" and let the caller proceed; if the
        // port really is held, startDesktop will fail loudly later.
        cleanup(err.code === "ECONNREFUSED");
      });
      socket.setTimeout(intervalMs, () => cleanup(false));
    });
    if (free) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export function cmdDesktopStatus(): void {
  const status = desktopStatus();
  switch (status.state) {
    case "running":
      console.log(`${pc.green("●")} running (pid ${status.pid})`);
      break;
    case "stopped":
      console.log(`${pc.dim("○")} stopped`);
      break;
    case "stale":
      console.log(
        `${pc.yellow("?")} pid ${status.pid} written but not alive (run \`petdex desktop start\` to restart)`,
      );
      break;
  }
}

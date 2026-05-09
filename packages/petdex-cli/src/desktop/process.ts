/**
 * `petdex desktop {start|stop|status}` — manages the petdex-desktop process.
 *
 * Stores the current PID at ~/.petdex/desktop.pid so subsequent runs can
 * detect a previous instance and avoid spawning duplicates.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import pc from "picocolors";

import { desktopBinPath } from "./install.js";

// Lazy resolution so tests can swap HOME and have the pid file
// land in their tmpdir. os.homedir() ignores HOME on macOS (it
// goes through getpwuid()), so we prefer process.env.HOME when
// set — same trick the telemetry module uses.
function pidFile(): string {
  const home = process.env.HOME ?? homedir();
  return path.join(home, ".petdex", "desktop.pid");
}
function logFile(): string {
  const home = process.env.HOME ?? homedir();
  return path.join(home, ".petdex", "desktop.log");
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
function processStartTime(pid: number): string | null {
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

// True only if the live process at `pid` started at the same time as
// the one we recorded. Pid recycle gives us either no live process
// (lstart === null) or a different lstart, both of which fail this
// check. Empty stored lstart (legacy pid file) is treated as failure
// so we never blindly SIGTERM an unverified pid.
function pidMatchesRecord(record: PidRecord): boolean {
  if (record.lstart.length === 0) return false;
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

  const child = spawn(bin, [], {
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();

  if (!child.pid) {
    return { ok: false, reason: "Failed to spawn petdex-desktop" };
  }

  // Capture the start-time NOW so a future `petdex desktop stop` can
  // verify identity. The child has already been spawned, so `ps`
  // will see it. If `ps` fails for some reason (sandbox, missing PATH)
  // we still write the pid so legacy-path identity checks fail safe
  // (status() returns stale rather than running, no signal is sent).
  const lstart = processStartTime(child.pid) ?? "";
  const record: PidRecord = { pid: child.pid, lstart };
  await writeFile(pidFile(), JSON.stringify(record));
  return { ok: true, pid: child.pid, alreadyRunning: false };
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

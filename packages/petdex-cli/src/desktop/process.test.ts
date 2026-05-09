import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { desktopStatus, stopDesktop, waitForPortRelease } from "./process";

// Pick high ports so we don't fight the real sidecar at :7777 if a
// dev happens to have it running. These tests open a TCP listener,
// confirm waitForPortRelease blocks on it, then close the listener
// and confirm the helper returns.

const PROBE_HOST = "127.0.0.1";
const PROBE_PORT = 47731;

async function listenOn(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, PROBE_HOST, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
  return server;
}

describe("waitForPortRelease", () => {
  let server: Server | null = null;

  beforeEach(() => {
    server = null;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  test("returns true immediately when nothing is bound", async () => {
    const start = Date.now();
    const free = await waitForPortRelease(PROBE_PORT, {
      timeoutMs: 5_000,
      intervalMs: 50,
      host: PROBE_HOST,
    });
    const elapsed = Date.now() - start;
    expect(free).toBe(true);
    // Should resolve well before the timeout — give it 1s margin
    // for slow CI but it should normally be sub-100ms.
    expect(elapsed).toBeLessThan(1_000);
  });

  test("returns true after a held port is released", async () => {
    server = await listenOn(PROBE_PORT);

    // Schedule the close just before the helper would time out so we
    // exercise the polling path, not just the immediate-success
    // branch.
    setTimeout(() => {
      if (server?.listening) {
        server.close();
      }
    }, 300);

    const free = await waitForPortRelease(PROBE_PORT, {
      timeoutMs: 5_000,
      intervalMs: 50,
      host: PROBE_HOST,
    });

    expect(free).toBe(true);
  });

  test("returns false when the port stays busy past the deadline", async () => {
    server = await listenOn(PROBE_PORT);
    const start = Date.now();

    const free = await waitForPortRelease(PROBE_PORT, {
      timeoutMs: 400,
      intervalMs: 50,
      host: PROBE_HOST,
    });

    const elapsed = Date.now() - start;
    expect(free).toBe(false);
    // Confirm it actually waited for roughly the timeout, not
    // shorter (otherwise update.ts would race the sidecar even
    // when it shouldn't).
    expect(elapsed).toBeGreaterThanOrEqual(350);
  });
});

// ---- pid-identity (Finding 2: PID reuse race) -----------------------
//
// These pin the fix that prevents `petdex desktop stop` from SIGTERM-ing
// an unrelated user process after the OS recycled the pid. The defense
// is: pid file stores `{ pid, lstart }`; before signalling we re-read
// `ps -p <pid> -o lstart=` and bail if it doesn't match. Tests exercise
// each branch — running, stale (legacy bare-pid format, dead pid,
// recycled pid), stopped — without ever signalling another process.

function lstartOf(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
}

describe("desktopStatus / stopDesktop pid-identity", () => {
  let realHome: string | undefined;
  let tmpHome: string;
  let pidPath: string;
  // A long-lived child we can target with our own `desktop stop` —
  // it pretends to be petdex-desktop. Spawned with `node -e
  // 'setInterval(...)'` so it stays alive until we kill it.
  let proxyChild: ReturnType<typeof spawn> | null = null;

  function spawnProxy(): { pid: number; lstart: string } {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1e9);"],
      { stdio: "ignore", detached: false },
    );
    child.unref();
    proxyChild = child;
    if (!child.pid) throw new Error("could not spawn proxy");
    // ps is racy right after spawn — wait until it shows up.
    const deadline = Date.now() + 2_000;
    let lstart = "";
    while (Date.now() < deadline) {
      try {
        lstart = lstartOf(child.pid);
        if (lstart.length > 0) break;
      } catch {
        // not visible yet
      }
    }
    if (!lstart) throw new Error("proxy never appeared in ps output");
    return { pid: child.pid, lstart };
  }

  beforeEach(() => {
    realHome = process.env.HOME;
    tmpHome = join(
      tmpdir(),
      `petdex-pid-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tmpHome, ".petdex"), { recursive: true });
    pidPath = join(tmpHome, ".petdex", "desktop.pid");
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (proxyChild?.pid) {
      try {
        process.kill(proxyChild.pid, "SIGKILL");
      } catch {
        // already dead
      }
      proxyChild = null;
    }
    if (realHome !== undefined) process.env.HOME = realHome;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  test("missing pid file -> stopped", () => {
    expect(desktopStatus()).toEqual({ state: "stopped" });
  });

  test("legacy bare-pid format is treated as stale, never as running", async () => {
    // Old version of the CLI wrote just the integer. We must NOT
    // trust those records — without lstart we can't verify identity,
    // and if the OS reused that pid, signalling it would hit an
    // unrelated process.
    writeFileSync(pidPath, String(process.pid), "utf8");
    const status = desktopStatus();
    expect(status.state).toBe("stale");
    if (status.state === "stale") expect(status.pid).toBe(process.pid);

    // stop() must refuse to signal — and must clear the legacy file
    // so future runs start clean.
    const stopRes = await stopDesktop({
      sidecarPort: 47891, // unused port in tests
      portWaitTimeoutMs: 200,
    });
    expect(stopRes.ok).toBe(false);
    if (!stopRes.ok) {
      expect(stopRes.reason).toMatch(/not running/);
    }
    expect(existsSync(pidPath)).toBe(false);
  });

  test("matching pid + lstart -> running, stop signals the right process", async () => {
    const { pid, lstart } = spawnProxy();
    writeFileSync(pidPath, JSON.stringify({ pid, lstart }), "utf8");

    const status = desktopStatus();
    expect(status.state).toBe("running");
    if (status.state === "running") expect(status.pid).toBe(pid);

    const stopRes = await stopDesktop({
      sidecarPort: 47891, // unused port in tests
      portWaitTimeoutMs: 200,
    });
    expect(stopRes.ok).toBe(true);
    if (stopRes.ok) expect(stopRes.pid).toBe(pid);

    // Give the proxy a moment to die from SIGTERM, then confirm.
    // Poll every 50ms so the loop yields back to the event loop —
    // a tight while() never lets the proxy's exit notification
    // process and we'd time out even when it's already dead.
    const deadline = Date.now() + 3_000;
    let stillAlive = true;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        process.kill(pid, 0);
      } catch {
        stillAlive = false;
        break;
      }
    }
    expect(stillAlive).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("recycled pid (wrong lstart) -> stale, stop refuses to signal", async () => {
    // Spawn a proxy and grab its real lstart. Then write a record
    // with the SAME pid but a different lstart string — this models
    // "pid file says 12345 started Mon, but the live 12345 actually
    // started Wed because the OS recycled it for somebody else's
    // process".
    const { pid } = spawnProxy();

    writeFileSync(
      pidPath,
      JSON.stringify({
        pid,
        lstart: "Mon Jan  1 00:00:00 1970", // wrong on purpose
      }),
      "utf8",
    );

    const status = desktopStatus();
    expect(status.state).toBe("stale");

    const stopRes = await stopDesktop({
      sidecarPort: 47891, // unused port in tests
      portWaitTimeoutMs: 200,
    });
    expect(stopRes.ok).toBe(false);
    if (!stopRes.ok) expect(stopRes.reason).toMatch(/not running/);

    // The proxy must STILL be alive — we refused to signal it.
    let stillAlive = true;
    try {
      process.kill(pid, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(true);

    // And the stale file must be gone so the next start writes fresh.
    expect(existsSync(pidPath)).toBe(false);
  });

  test("dead pid (no live process) -> stale, stop refuses to signal", async () => {
    // Spawn, capture, kill — leaves a pid file referencing a dead pid.
    // The next `ps` call will exit non-zero, processStartTime returns
    // null, pidMatchesRecord returns false, status === "stale".
    const { pid, lstart } = spawnProxy();
    writeFileSync(pidPath, JSON.stringify({ pid, lstart }), "utf8");
    if (proxyChild?.pid) {
      try {
        process.kill(proxyChild.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    // Wait until ps no longer sees it. Poll with sleep — a tight
    // execFileSync loop blocks the event loop and reaper signals
    // can't be processed.
    const deadline = Date.now() + 3_000;
    let dead = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        dead = true;
        break;
      }
    }
    expect(dead).toBe(true);

    const status = desktopStatus();
    expect(status.state).toBe("stale");

    const stopRes = await stopDesktop({
      sidecarPort: 47891, // unused port in tests
      portWaitTimeoutMs: 200,
    });
    expect(stopRes.ok).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("malformed pid file -> stopped (not stale, not running)", () => {
    writeFileSync(pidPath, "not a pid", "utf8");
    expect(desktopStatus()).toEqual({ state: "stopped" });
  });
});

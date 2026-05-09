import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";

import { waitForPortRelease } from "./process";

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

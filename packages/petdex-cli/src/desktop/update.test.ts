import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestSidecarHandoff } from "./update";

// These tests pin the deadlock fix from opencode-bot review:
// requestSidecarHandoff must POST to /update/handoff with the token
// header so the running sidecar can release :7777 before
// waitForPortRelease blocks. Without it, the sidecar holds the port
// (because currentUpdateChild != null) while the updater holds itself
// blocked on the port — circular wait, 10s timeout, no restart.
//
// We stand up a tiny http server that mimics the relevant slice of
// the real sidecar protocol: token header gate, JSON 200 on accept,
// 401 on missing/wrong token. Then we assert the helper drives it
// correctly and degrades to false (so waitForPortRelease can take
// over) when anything's off.

const HOST = "127.0.0.1";
const PROBE_PORT = 47821;
const TOKEN_HEADER = "x-petdex-update-token";

type FakeSidecarOptions = {
  expectedToken: string;
  // Force a particular response shape — the helper's contract is
  // "boolean res.ok", so we test 401, 404, and a hang.
  mode?: "accept" | "unauthorized" | "not_found" | "hang";
};

async function startFakeSidecar(opts: FakeSidecarOptions): Promise<{
  server: Server;
  hits: { method: string; url: string; token: string | undefined }[];
}> {
  const hits: { method: string; url: string; token: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const headerVal = req.headers[TOKEN_HEADER];
    const token = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    hits.push({ method: req.method ?? "?", url: req.url ?? "?", token });

    if (opts.mode === "hang") {
      // Never respond — let the AbortController fire.
      return;
    }
    if (req.url !== "/update/handoff") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    if (opts.mode === "not_found") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    if (
      opts.mode === "unauthorized" ||
      !token ||
      token !== opts.expectedToken
    ) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PROBE_PORT, HOST, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
  return { server, hits };
}

async function stopFakeSidecar(server: Server | null) {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("requestSidecarHandoff", () => {
  let dir: string;
  let tokenPath: string;
  let server: Server | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petdex-handoff-"));
    tokenPath = join(dir, "update-token");
    server = null;
  });

  afterEach(async () => {
    await stopFakeSidecar(server);
    rmSync(dir, { recursive: true, force: true });
  });

  test("POSTs /update/handoff with the token and returns true on 200", async () => {
    writeFileSync(tokenPath, "deadbeefcafef00d", "utf8");
    const fake = await startFakeSidecar({
      expectedToken: "deadbeefcafef00d",
      mode: "accept",
    });
    server = fake.server;

    const ok = await requestSidecarHandoff({
      port: PROBE_PORT,
      tokenPath,
      timeoutMs: 2_000,
    });

    expect(ok).toBe(true);
    expect(fake.hits).toHaveLength(1);
    expect(fake.hits[0]?.method).toBe("POST");
    expect(fake.hits[0]?.url).toBe("/update/handoff");
    expect(fake.hits[0]?.token).toBe("deadbeefcafef00d");
  });

  test("returns false (not throws) when the sidecar replies 401", async () => {
    writeFileSync(tokenPath, "wrongtoken", "utf8");
    const fake = await startFakeSidecar({
      expectedToken: "righttoken",
      mode: "unauthorized",
    });
    server = fake.server;

    const ok = await requestSidecarHandoff({
      port: PROBE_PORT,
      tokenPath,
      timeoutMs: 2_000,
    });

    expect(ok).toBe(false);
    expect(fake.hits).toHaveLength(1);
  });

  test("returns false when an older sidecar lacks the endpoint (404)", async () => {
    writeFileSync(tokenPath, "anytoken", "utf8");
    const fake = await startFakeSidecar({
      expectedToken: "anytoken",
      mode: "not_found",
    });
    server = fake.server;

    const ok = await requestSidecarHandoff({
      port: PROBE_PORT,
      tokenPath,
      timeoutMs: 2_000,
    });

    expect(ok).toBe(false);
  });

  test("returns false when the token file is missing — falls back to port wait", async () => {
    // Don't write tokenPath. The helper must NOT throw — it should
    // degrade to false so the caller's waitForPortRelease takes over.
    const fake = await startFakeSidecar({
      expectedToken: "tokendoesntmatter",
      mode: "accept",
    });
    server = fake.server;

    const ok = await requestSidecarHandoff({
      port: PROBE_PORT,
      tokenPath,
      timeoutMs: 2_000,
    });

    expect(ok).toBe(false);
    // No request should have been issued — we never read a token.
    expect(fake.hits).toHaveLength(0);
  });

  test("returns false when no sidecar is listening", async () => {
    writeFileSync(tokenPath, "anytoken", "utf8");
    // Don't start a server at all.

    const ok = await requestSidecarHandoff({
      port: PROBE_PORT,
      tokenPath,
      timeoutMs: 2_000,
    });

    expect(ok).toBe(false);
  });

  test("aborts on timeout when the sidecar hangs", async () => {
    writeFileSync(tokenPath, "anytoken", "utf8");
    const fake = await startFakeSidecar({
      expectedToken: "anytoken",
      mode: "hang",
    });
    server = fake.server;

    const start = Date.now();
    const ok = await requestSidecarHandoff({
      port: PROBE_PORT,
      tokenPath,
      timeoutMs: 300,
    });
    const elapsed = Date.now() - start;

    expect(ok).toBe(false);
    // Should have given up around the timeout, not hung indefinitely.
    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });
});

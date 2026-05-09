#!/usr/bin/env node
/**
 * Petdex Desktop sidecar HTTP server.
 *
 * Listens on POST /state with { state, duration? } and writes the requested
 * state to ~/.petdex/runtime/state.json. The WebView polls that file every
 * ~200ms and applies the state to the mascot animation.
 *
 * Spawned by petdex-desktop at startup. Talks the same `state` vocabulary
 * as the spritesheet rows: idle, running, running-left, running-right,
 * waving, jumping, failed, review, waiting.
 *
 * Runs on Node ≥ 18 — no third-party deps. Devs using coding agents have
 * Node available almost universally; that's a much safer assumption than
 * requiring Bun.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PETDEX_PORT ?? 7777);
const RUNTIME_DIR = join(homedir(), ".petdex", "runtime");
const STATE_PATH = join(RUNTIME_DIR, "state.json");
const LOG_PATH = join(RUNTIME_DIR, "sidecar.log");
const MAX_BODY_BYTES = 64 * 1024;

const VALID_STATES = new Set([
  "idle",
  "running",
  "running-left",
  "running-right",
  "waving",
  "jumping",
  "failed",
  "review",
  "waiting",
]);

mkdirSync(RUNTIME_DIR, { recursive: true });

function log(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    appendFileSync(LOG_PATH, stamped);
  } catch {
    // best-effort logging; never crash the server because of log io
  }
  process.stderr.write(stamped);
}

let resetTimer: NodeJS.Timeout | null = null;
let counter = 0;

function writeState(state: string, duration?: number) {
  counter += 1;
  const payload = {
    state,
    duration: duration ?? null,
    updatedAt: Date.now(),
    counter,
  };
  writeFileSync(STATE_PATH, JSON.stringify(payload));
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  if (typeof duration === "number" && duration > 0 && state !== "idle") {
    resetTimer = setTimeout(() => {
      writeState("idle");
      resetTimer = null;
    }, duration);
  }
}

writeState("idle");

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse(res, 200, { ok: true, port: PORT });
    }

    if (req.method === "GET" && url.pathname === "/state") {
      try {
        const { readFileSync } = await import("node:fs");
        const text = readFileSync(STATE_PATH, "utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(text);
        return;
      } catch {
        return jsonResponse(res, 200, { state: "idle", counter: 0 });
      }
    }

    if (req.method === "POST" && url.pathname === "/state") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        return jsonResponse(res, 400, { ok: false, error: "invalid_json" });
      }
      const data = body as { state?: unknown; duration?: unknown };
      const state = typeof data.state === "string" ? data.state : null;
      if (!state || !VALID_STATES.has(state)) {
        return jsonResponse(res, 400, {
          ok: false,
          error: "invalid_state",
          valid: [...VALID_STATES],
        });
      }
      const duration =
        typeof data.duration === "number" && data.duration > 0
          ? Math.min(data.duration, 30_000)
          : undefined;
      writeState(state, duration);
      log(`state=${state} duration=${duration ?? "-"}`);
      return jsonResponse(res, 200, {
        ok: true,
        state,
        duration: duration ?? null,
      });
    }

    jsonResponse(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    log(`server error: ${(err as Error).message}`);
    jsonResponse(res, 500, { ok: false, error: "internal" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`petdex sidecar listening on http://127.0.0.1:${PORT}`);
});

server.on("error", (err) => {
  log(`server.error: ${err.message}`);
  process.exit(1);
});

function shutdown(signal: string) {
  log(`sidecar received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // hard-exit if close hangs
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Parent watchdog: if petdex-desktop spawned us with PETDEX_PARENT_PID,
// poll the parent every 2s and exit cleanly when it disappears. This
// prevents zombie sidecars after `petdex desktop stop` or a desktop crash.
const parentPid = Number(process.env.PETDEX_PARENT_PID);
if (Number.isFinite(parentPid) && parentPid > 0) {
  log(`sidecar watching parent pid ${parentPid}`);
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log(`parent ${parentPid} gone, exiting`);
      clearInterval(timer);
      shutdown("parent-gone");
    }
  }, 2000);
  timer.unref();
}

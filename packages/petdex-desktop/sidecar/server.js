#!/usr/bin/env node
import { createRequire as M } from "node:module";
var b = M(import.meta.url);
import {
  appendFileSync as D,
  mkdirSync as f,
  writeFileSync as w,
} from "node:fs";
import O from "node:http";
import { homedir as k } from "node:os";
import { join as Y } from "node:path";
var X = Number(process.env.PETDEX_PORT ?? 7777),
  B = Y(k(), ".petdex", "runtime"),
  U = Y(B, "state.json"),
  v = Y(B, "sidecar.log"),
  P = 65536,
  L = new Set([
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
f(B, { recursive: !0 });
function J(z) {
  const C = `[${new Date().toISOString()}] ${z}
`;
  try {
    D(v, C);
  } catch {}
  process.stderr.write(C);
}
var G = null,
  N = 0;
function F(z, C) {
  N += 1;
  const Q = {
    state: z,
    duration: C ?? null,
    updatedAt: Date.now(),
    counter: N,
  };
  if ((w(U, JSON.stringify(Q)), G)) clearTimeout(G), (G = null);
  if (typeof C === "number" && C > 0 && z !== "idle")
    G = setTimeout(() => {
      F("idle"), (G = null);
    }, C);
}
F("idle");
function $(z, C, Q) {
  const W = JSON.stringify(Q);
  z.writeHead(C, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(W),
  }),
    z.end(W);
}
async function E(z) {
  return new Promise((C, Q) => {
    let W = [],
      Z = 0;
    z.on("data", (K) => {
      if (((Z += K.length), Z > P)) {
        z.destroy(Error("payload_too_large"));
        return;
      }
      W.push(K);
    }),
      z.on("end", () => {
        try {
          const K = Buffer.concat(W).toString("utf8");
          C(K.length === 0 ? {} : JSON.parse(K));
        } catch (K) {
          Q(K);
        }
      }),
      z.on("error", Q);
  });
}
var H = O.createServer(async (z, C) => {
  try {
    const Q = new URL(z.url ?? "/", `http://127.0.0.1:${X}`);
    if (z.method === "GET" && Q.pathname === "/health")
      return $(C, 200, { ok: !0, port: X });
    if (z.method === "GET" && Q.pathname === "/state")
      try {
        const { readFileSync: W } = await import("node:fs"),
          Z = W(U, "utf8");
        C.writeHead(200, { "content-type": "application/json" }), C.end(Z);
        return;
      } catch {
        return $(C, 200, { state: "idle", counter: 0 });
      }
    if (z.method === "POST" && Q.pathname === "/state") {
      let W;
      try {
        W = await E(z);
      } catch {
        return $(C, 400, { ok: !1, error: "invalid_json" });
      }
      const Z = W,
        K = typeof Z.state === "string" ? Z.state : null;
      if (!K || !L.has(K))
        return $(C, 400, { ok: !1, error: "invalid_state", valid: [...L] });
      const V =
        typeof Z.duration === "number" && Z.duration > 0
          ? Math.min(Z.duration, 30000)
          : void 0;
      return (
        F(K, V),
        J(`state=${K} duration=${V ?? "-"}`),
        $(C, 200, { ok: !0, state: K, duration: V ?? null })
      );
    }
    $(C, 404, { ok: !1, error: "not_found" });
  } catch (Q) {
    J(`server error: ${Q.message}`), $(C, 500, { ok: !1, error: "internal" });
  }
});
H.listen(X, "127.0.0.1", () => {
  J(`petdex sidecar listening on http://127.0.0.1:${X}`);
});
H.on("error", (z) => {
  J(`server.error: ${z.message}`), process.exit(1);
});
function x(z) {
  J(`sidecar received ${z}, shutting down`),
    H.close(() => process.exit(0)),
    setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", () => x("SIGTERM"));
process.on("SIGINT", () => x("SIGINT"));

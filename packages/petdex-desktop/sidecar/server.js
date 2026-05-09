#!/usr/bin/env node
var i = Object.create;
var { getPrototypeOf: d, defineProperty: f, getOwnPropertyNames: s } = Object;
var a = Object.prototype.hasOwnProperty;
function o(z) {
  return this[z];
}
var n,
  t,
  r = (z, Q, W) => {
    var Z = z != null && typeof z === "object";
    if (Z) {
      var B = Q ? (n ??= new WeakMap()) : (t ??= new WeakMap()),
        $ = B.get(z);
      if ($) return $;
    }
    W = z != null ? i(d(z)) : {};
    const X =
      Q || !z || !z.__esModule
        ? f(W, "default", { value: z, enumerable: !0 })
        : W;
    for (const x of s(z))
      if (!a.call(X, x)) f(X, x, { get: o.bind(z, x), enumerable: !0 });
    if (Z) B.set(z, X);
    return X;
  };
var c = require("node:child_process"),
  N = require("node:crypto"),
  J = require("node:fs"),
  E = r(require("node:http")),
  w = require("node:os"),
  K = require("node:path"),
  C = Number(process.env.PETDEX_PORT ?? 7777),
  H = K.join(w.homedir(), ".petdex", "runtime"),
  T = K.join(H, "state.json"),
  j = K.join(H, "update.json"),
  p = K.join(H, "update.log"),
  g = K.join(H, "update-token"),
  P = K.join(w.homedir(), ".petdex", "version"),
  e = K.join(H, "sidecar.log"),
  zz = 65536,
  Qz = "https://api.github.com/repos/crafter-station/petdex/releases/latest",
  Wz = 21600000,
  Zz = 30000,
  h = "x-petdex-update-token",
  I = new Set([
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
J.mkdirSync(H, { recursive: !0 });
var y = N.randomBytes(32).toString("hex");
try {
  J.writeFileSync(g, y, { mode: 384 }), J.chmodSync(g, 384);
} catch (z) {
  process.stderr.write(`petdex sidecar: could not persist update token: ${z.message}
`);
}
var R = K.join(w.homedir(), ".petdex", "telemetry.json"),
  $z =
    process.env.PETDEX_TELEMETRY_URL ??
    "https://petdex.crafter.run/api/telemetry/event",
  A = !1;
function Jz() {
  if (process.env.PETDEX_TELEMETRY === "0") return null;
  if (!J.existsSync(R)) return null;
  try {
    const z = JSON.parse(J.readFileSync(R, "utf8"));
    if (typeof z.install_id !== "string") return null;
    if (z.enabled === !1) return null;
    return { install_id: z.install_id, enabled: !0 };
  } catch {
    return null;
  }
}
function Xz(z, Q) {
  if (A) return;
  A = !0;
  const W = Jz();
  if (!W) return;
  const Z = JSON.stringify({
    install_id: W.install_id,
    event: "desktop_first_state_received",
    state: z,
    agent_source: Q,
  });
  fetch($z, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Z,
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}
function S(z, Q) {
  const W = Buffer.from(z),
    Z = Buffer.from(Q);
  if (W.length !== Z.length) return N.timingSafeEqual(W, W), !1;
  return N.timingSafeEqual(W, Z);
}
function G(z) {
  const Q = `[${new Date().toISOString()}] ${z}
`;
  try {
    J.appendFileSync(e, Q);
  } catch {}
  process.stderr.write(Q);
}
var b = null,
  U = 0;
function q(z, Q) {
  U += 1;
  const W = {
    state: z,
    duration: Q ?? null,
    updatedAt: Date.now(),
    counter: U,
  };
  if ((J.writeFileSync(T, JSON.stringify(W)), b)) clearTimeout(b), (b = null);
  if (typeof Q === "number" && Q > 0 && z !== "idle")
    b = setTimeout(() => {
      q("idle"), (b = null);
    }, Q);
}
q("idle");
function Y(z, Q, W) {
  const Z = JSON.stringify(W);
  z.writeHead(Q, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(Z),
  }),
    z.end(Z);
}
async function Bz(z) {
  return new Promise((Q, W) => {
    let Z = [],
      B = 0;
    z.on("data", ($) => {
      if (((B += $.length), B > zz)) {
        z.destroy(Error("payload_too_large"));
        return;
      }
      Z.push($);
    }),
      z.on("end", () => {
        try {
          const $ = Buffer.concat(Z).toString("utf8");
          Q($.length === 0 ? {} : JSON.parse($));
        } catch ($) {
          W($);
        }
      }),
      z.on("error", W);
  });
}
function v() {
  if (!J.existsSync(P)) return null;
  try {
    return J.readFileSync(P, "utf8").trim() || null;
  } catch {
    return null;
  }
}
function F() {
  if (!J.existsSync(j))
    return {
      available: !1,
      current: v(),
      latest: null,
      status: "idle",
      checkedAt: 0,
    };
  try {
    return JSON.parse(J.readFileSync(j, "utf8"));
  } catch {
    return {
      available: !1,
      current: v(),
      latest: null,
      status: "idle",
      checkedAt: 0,
    };
  }
}
function k(z) {
  try {
    J.writeFileSync(j, JSON.stringify(z));
  } catch (Q) {
    G(`update.json write failed: ${Q.message}`);
  }
}
async function _() {
  let z = v(),
    Q = null;
  try {
    const $ = await fetch(Qz, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!$.ok) {
      G(`update check: GH API ${$.status}`);
      return;
    }
    const X = await $.json();
    Q = typeof X.tag_name === "string" ? X.tag_name : null;
  } catch ($) {
    G(`update check failed: ${$.message}`);
    return;
  }
  if (F().status === "running") return;
  const Z = !!Q && !!z && Q !== z,
    B = {
      available: Z,
      current: z,
      latest: Q,
      status: Z ? "available" : "idle",
      checkedAt: Date.now(),
    };
  k(B),
    G(`update check: current=${z ?? "?"} latest=${Q ?? "?"} available=${Z}`);
}
function V(z) {
  try {
    J.appendFileSync(
      p,
      `[${new Date().toISOString()}] ${z}
`,
    );
  } catch {}
}
var M = null;
function Gz() {
  const z = c.spawn("npx", ["-y", "petdex@latest", "update", "--silent"], {
    detached: !0,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  (M = z),
    z.stdout?.on("data", (Q) => {
      V(Q.toString("utf8").trimEnd());
    }),
    z.stderr?.on("data", (Q) => {
      V(`stderr: ${Q.toString("utf8").trimEnd()}`);
    }),
    z.on("exit", (Q) => {
      M = null;
      const W = F();
      if (Q === 0) {
        const Z = v();
        k({
          ...W,
          current: Z,
          status: "done",
          message: "Update installed. Restart the desktop to use it.",
          checkedAt: Date.now(),
        }),
          V(`exit 0 (installed ${Z ?? "?"})`);
      } else
        k({
          ...W,
          status: "error",
          message: `petdex update exited with code ${Q ?? "null"}. See ${p}.`,
          checkedAt: Date.now(),
        }),
          V(`exit ${Q}`);
    }),
    z.on("error", (Q) => {
      M = null;
      const W = F();
      k({
        ...W,
        status: "error",
        message: `Could not spawn npx: ${Q.message}`,
        checkedAt: Date.now(),
      }),
        V(`spawn error: ${Q.message}`);
    });
}
var O = E.default.createServer(async (z, Q) => {
  try {
    const W = new URL(z.url ?? "/", `http://127.0.0.1:${C}`);
    if (z.method === "GET" && W.pathname === "/health")
      return Y(Q, 200, { ok: !0, port: C });
    if (z.method === "GET" && W.pathname === "/state")
      try {
        const { readFileSync: Z } = await import("node:fs"),
          B = Z(T, "utf8");
        Q.writeHead(200, { "content-type": "application/json" }), Q.end(B);
        return;
      } catch {
        return Y(Q, 200, { state: "idle", counter: 0 });
      }
    if (z.method === "POST" && W.pathname === "/state") {
      const Z = z.headers[h],
        B = Array.isArray(Z) ? Z[0] : Z;
      if (!B || !S(B, y)) return Y(Q, 401, { ok: !1, error: "unauthorized" });
      let $;
      try {
        $ = await Bz(z);
      } catch {
        return Y(Q, 400, { ok: !1, error: "invalid_json" });
      }
      const X = $,
        x = typeof X.state === "string" ? X.state : null;
      if (!x || !I.has(x))
        return Y(Q, 400, { ok: !1, error: "invalid_state", valid: [...I] });
      const m =
          typeof X.duration === "number" && X.duration > 0
            ? Math.min(X.duration, 30000)
            : void 0,
        l =
          typeof X.agent_source === "string"
            ? X.agent_source.slice(0, 64)
            : null;
      return (
        q(x, m),
        G(`state=${x} duration=${m ?? "-"}`),
        Xz(x, l),
        Y(Q, 200, { ok: !0, state: x, duration: m ?? null })
      );
    }
    if (z.method === "GET" && W.pathname === "/update") return Y(Q, 200, F());
    if (z.method === "POST" && W.pathname === "/update") {
      const Z = z.headers[h],
        B = Array.isArray(Z) ? Z[0] : Z;
      if (!B || !S(B, y)) return Y(Q, 401, { ok: !1, error: "unauthorized" });
      const $ = F();
      if ($.status === "running") return Y(Q, 200, $);
      if (!$.available && $.status !== "error") return Y(Q, 200, $);
      const X = {
        ...$,
        status: "running",
        message: "Downloading the latest release...",
        checkedAt: Date.now(),
      };
      return k(X), V("triggered by webview click"), Gz(), Y(Q, 202, X);
    }
    Y(Q, 404, { ok: !1, error: "not_found" });
  } catch (W) {
    G(`server error: ${W.message}`), Y(Q, 500, { ok: !1, error: "internal" });
  }
});
O.listen(C, "127.0.0.1", () => {
  G(`petdex sidecar listening on http://127.0.0.1:${C}`);
});
O.on("error", (z) => {
  G(`server.error: ${z.message}`), process.exit(1);
});
var u = 60000;
function D(z) {
  if (M) {
    G(`sidecar received ${z}; waiting for updater child to exit`);
    const Q = Date.now(),
      W = setTimeout(() => {
        G(`updater child still running after ${u}ms; forcing exit`);
        const Z = F();
        if (Z.status === "running")
          k({
            ...Z,
            status: "error",
            message:
              "Sidecar shut down before update finished. Re-launch Petdex and try again.",
            checkedAt: Date.now(),
          });
        O.close(() => process.exit(0)),
          setTimeout(() => process.exit(0), 1000).unref();
      }, u);
    M.on("exit", () => {
      clearTimeout(W),
        G(`updater child exited after ${Date.now() - Q}ms; shutting down`),
        O.close(() => process.exit(0)),
        setTimeout(() => process.exit(0), 1000).unref();
    });
    return;
  }
  G(`sidecar received ${z}, shutting down`),
    O.close(() => process.exit(0)),
    setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", () => D("SIGTERM"));
process.on("SIGINT", () => D("SIGINT"));
var Yz = setTimeout(() => {
  _(), setInterval(() => void _(), Wz).unref();
}, Zz);
Yz.unref();
var L = Number(process.env.PETDEX_PARENT_PID);
if (Number.isFinite(L) && L > 0) {
  G(`sidecar watching parent pid ${L}`);
  const z = setInterval(() => {
    try {
      process.kill(L, 0);
    } catch {
      if (M) return;
      G(`parent ${L} gone, exiting`), clearInterval(z), D("parent-gone");
    }
  }, 2000);
  z.unref();
}

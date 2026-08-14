import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createNormalizer } from "./normalize.js";

export const name = "petdex-dsh-bridge";
export const inject = ["sessions"];

const INTEGRATION_VERSION = "0.1.0";
const HOOK_SERVER = "http://127.0.0.1:7777";
const MAX_PENDING = 64;
const REQUEST_TIMEOUT_MS = 300;

function isCritical(projection) {
  return (
    projection.kind.startsWith("intervention.") ||
    projection.kind === "turn.completed" ||
    projection.kind === "turn.failed" ||
    projection.kind === "turn.blocked"
  );
}

export function projectionToRequests(projection, token) {
  const headers = { "x-petdex-update-token": token };
  return [
    {
      path: "/state",
      headers,
      body: { state: projection.state, agent_source: "dsh" },
    },
    {
      path: "/bubble",
      headers,
      body: {
        text: projection.text,
        title: "DeepSeek Harness",
        busy: projection.busy,
        agent_source: "dsh",
        session_id: projection.rootSessionId,
        source_app: "default_browser",
        integration_version: INTEGRATION_VERSION,
        source_session_id: projection.sourceSessionId,
        source_seq: projection.sourceSeq,
        event_kind: projection.kind,
      },
    },
  ];
}

async function postRequest(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${HOOK_SERVER}${request.path}`, {
      method: "POST",
      headers: {
        ...request.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Petdex hook returned ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverToPetdex(projection) {
  const tokenPath = join(homedir(), ".petdex", "runtime", "update-token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) return;
  await Promise.all(
    projectionToRequests(projection, token).map((request) =>
      postRequest(request),
    ),
  );
}

export function createBridge(options = {}) {
  const normalizer = createNormalizer();
  const deliver = options.deliver ?? deliverToPetdex;
  const pending = [];
  let draining = null;

  async function drain() {
    while (pending.length > 0) {
      const projection = pending.shift();
      try {
        await deliver(projection);
      } catch {
        // Petdex is optional UI. Its absence must never affect DSH.
      }
    }
  }

  function ensureDrain() {
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
      if (pending.length > 0) ensureDrain();
    });
  }

  function enqueue(projection) {
    if (!isCritical(projection)) {
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const queued = pending[index];
        if (
          queued.rootSessionId === projection.rootSessionId &&
          !isCritical(queued)
        ) {
          pending[index] = projection;
          ensureDrain();
          return;
        }
      }
    }

    if (pending.length >= MAX_PENDING) {
      const replaceable = pending.findIndex((event) => !isCritical(event));
      if (replaceable >= 0) pending.splice(replaceable, 1);
      else if (!isCritical(projection)) return;
      else pending.shift();
    }
    pending.push(projection);
    ensureDrain();
  }

  function onEvent(session, event) {
    try {
      const projection = normalizer.normalize(session, event);
      if (projection) enqueue(projection);
    } catch {
      // Projection is fail-open for the same reason as delivery.
    }
  }

  return {
    onCreated: normalizer.rememberSession,
    onDisposed: normalizer.forgetSession,
    onEvent,
    async idle() {
      while (draining) await draining;
    },
  };
}

export function apply(ctx, config = {}) {
  const bridge = createBridge(config);
  for (const session of ctx.sessions.list()) bridge.onCreated(session);
  const global = { global: true };
  ctx.on("session/created", (session) => bridge.onCreated(session), global);
  ctx.on("session/disposed", (session) => bridge.onDisposed(session), global);
  ctx.on(
    "session/event",
    (session, event) => bridge.onEvent(session, event),
    global,
  );
}

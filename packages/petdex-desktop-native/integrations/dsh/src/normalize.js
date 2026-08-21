const MAX_PARENT_DEPTH = 16;

const FIXED_EVENTS = new Map([
  ["turn/start", ["turn.started", "jumping", "Starting", true]],
  ["step/start", ["step.started", "running", "Working", true]],
  ["step/end", ["step.completed", "running", "Working", true]],
  ["tool/call", ["tool.started", "running", "Using a tool", true]],
  ["tool/result", ["tool.completed", "running", "Working", true]],
  [
    "tool-workflow/run-start",
    ["workflow.started", "running", "Workflow running", true],
  ],
  [
    "tool-workflow/agent-start",
    ["workflow.updated", "running", "Subagent working", true],
  ],
  [
    "tool-workflow/agent-end",
    ["workflow.updated", "running", "Workflow running", true],
  ],
  [
    "tool-workflow/run-end",
    ["workflow.completed", "running", "Workflow finished", true],
  ],
  ["goal/change", ["goal.changed", "running", "Goal updated", true]],
  [
    "compaction/start",
    ["compaction.started", "running", "Optimizing context", true],
  ],
  ["compaction/end", ["compaction.completed", "running", "Working", true]],
]);

function safeId(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function approvalId(event) {
  return safeId(event.data?.id) ?? `seq-${event.seq}`;
}

export function createNormalizer() {
  const sessions = new Map();
  const highWater = new Map();
  const approvals = new Map();

  function rememberSession(session) {
    const id = safeId(session?.id);
    if (!id) return;
    const previous = sessions.get(id);
    const parentSession =
      safeId(session?.header?.parentSession) ?? previous?.parentSession ?? null;
    const origin = safeId(session?.header?.origin) ?? previous?.origin ?? null;
    sessions.set(id, { parentSession, origin });
  }

  function forgetSession(session) {
    const id = safeId(session?.id);
    if (!id) return;
    sessions.delete(id);
    highWater.delete(id);
  }

  function rootFor(sourceSessionId) {
    let current = sourceSessionId;
    const seen = new Set([current]);
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
      const info = sessions.get(current);
      if (info?.origin !== "subagent" || !info.parentSession) return current;
      if (seen.has(info.parentSession)) return null;
      current = info.parentSession;
      seen.add(current);
    }
    return null;
  }

  function baseProjection(session, event) {
    rememberSession(session);
    const sourceSessionId = safeId(session?.id);
    if (!sourceSessionId || !Number.isSafeInteger(event?.seq)) return null;
    const previousSeq = highWater.get(sourceSessionId);
    if (previousSeq !== undefined && event.seq <= previousSeq) return null;
    highWater.set(sourceSessionId, event.seq);

    const rootSessionId = rootFor(sourceSessionId);
    if (!rootSessionId) return null;
    return {
      rootSessionId,
      sourceSessionId,
      sourceSeq: event.seq,
      occurredAt: Number.isFinite(event.time) ? event.time : Date.now(),
    };
  }

  function normalize(session, event) {
    if (!safeId(event?.type)) return null;
    const base = baseProjection(session, event);
    if (!base) return null;

    if (event.type === "approval/asked") {
      const open = approvals.get(base.rootSessionId) ?? new Set();
      open.add(`${base.sourceSessionId}:${approvalId(event)}`);
      approvals.set(base.rootSessionId, open);
      return {
        kind: "intervention.requested",
        ...base,
        state: "waiting",
        text: "Needs your attention",
        busy: true,
      };
    }

    if (event.type === "approval/decided") {
      const open = approvals.get(base.rootSessionId) ?? new Set();
      open.delete(`${base.sourceSessionId}:${approvalId(event)}`);
      if (open.size === 0) approvals.delete(base.rootSessionId);
      return {
        kind:
          open.size === 0 ? "intervention.resolved" : "intervention.requested",
        ...base,
        state: open.size === 0 ? "running" : "waiting",
        text: open.size === 0 ? "Working" : "Needs your attention",
        busy: true,
      };
    }

    if (event.type === "turn/end") {
      if (base.sourceSessionId !== base.rootSessionId) {
        return {
          kind: "subagent.updated",
          ...base,
          state: "running",
          text: "Subagent finished",
          busy: true,
        };
      }
      const reason = safeId(event.data?.reason?.kind) ?? "error";
      if (reason === "completed") {
        return {
          kind: "turn.completed",
          ...base,
          state: "waving",
          text: "Done",
          busy: false,
        };
      }
      if (reason === "blocked" || reason === "max-tokens") {
        return {
          kind: "turn.blocked",
          ...base,
          state: "waiting",
          text: "Needs your attention",
          busy: true,
        };
      }
      return {
        kind: "turn.failed",
        ...base,
        state: "failed",
        text: "Stopped",
        busy: false,
      };
    }

    const fixed = FIXED_EVENTS.get(event.type);
    if (!fixed) return null;
    const [kind, state, text, busy] = fixed;
    return { kind, ...base, state, text, busy };
  }

  return { rememberSession, forgetSession, normalize };
}

import { describe, expect, test } from "bun:test";

import {
  apply,
  createBridge,
  inject,
  projectionToRequests,
} from "./src/index.js";

function session(id: string, parentSession?: string) {
  return {
    id,
    header: parentSession
      ? { parentSession, origin: "subagent" }
      : { origin: "user" },
  };
}

describe("DSH Petdex plugin", () => {
  test("declares the session service it reads", () => {
    expect(inject).toEqual(["sessions"]);
  });

  test("registers only observational session lifecycle listeners", () => {
    const registrations: Array<{ name: string; options: unknown }> = [];
    const root = session("root");
    const ctx = {
      sessions: { list: () => [root] },
      on(
        name: string,
        _listener: (...args: unknown[]) => void,
        options?: unknown,
      ) {
        registrations.push({ name, options });
      },
    };

    apply(ctx, { deliver: async () => {} });

    expect(registrations).toEqual([
      { name: "session/created", options: { global: true } },
      { name: "session/disposed", options: { global: true } },
      { name: "session/event", options: { global: true } },
    ]);
    expect(registrations.map(({ name }) => name)).not.toContain(
      "approval/request",
    );
  });

  test("delivers one content-free projection for a child event", async () => {
    const delivered: unknown[] = [];
    const bridge = createBridge({
      deliver: async (projection) => {
        delivered.push(projection);
      },
    });
    const child = session("child", "root");
    bridge.onCreated(session("root"));
    bridge.onCreated(child);

    bridge.onEvent(child, {
      type: "goal/change",
      seq: 11,
      time: 42,
      data: { objective: "private launch plan", revision: 8 },
    });
    await bridge.idle();

    expect(delivered).toEqual([
      {
        kind: "goal.changed",
        rootSessionId: "root",
        sourceSessionId: "child",
        sourceSeq: 11,
        occurredAt: 42,
        state: "running",
        text: "Goal updated",
        busy: true,
      },
    ]);
    expect(JSON.stringify(delivered)).not.toContain("private launch plan");
  });

  test("coalesces replaceable progress without dropping intervention", async () => {
    const delivered: Array<{ kind: string }> = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const bridge = createBridge({
      deliver: async (projection) => {
        calls += 1;
        if (calls === 1) await first;
        delivered.push(projection);
      },
    });
    const root = session("root");
    bridge.onCreated(root);

    bridge.onEvent(root, {
      type: "turn/start",
      seq: 1,
      time: 1,
      data: {},
    });
    bridge.onEvent(root, {
      type: "step/start",
      seq: 2,
      time: 2,
      data: {},
    });
    bridge.onEvent(root, {
      type: "tool/call",
      seq: 3,
      time: 3,
      data: { arguments: { secret: true } },
    });
    bridge.onEvent(root, {
      type: "approval/asked",
      seq: 4,
      time: 4,
      data: { approvalId: "a" },
    });
    releaseFirst?.();
    await bridge.idle();

    expect(delivered.map((event) => event.kind)).toEqual([
      "turn.started",
      "tool.started",
      "intervention.requested",
    ]);
  });

  test("builds only token-gated loopback state and bubble requests", () => {
    const requests = projectionToRequests(
      {
        kind: "intervention.requested",
        rootSessionId: "root",
        sourceSessionId: "child",
        sourceSeq: 4,
        occurredAt: 5,
        state: "waiting",
        text: "Needs your attention",
        busy: true,
      },
      "token",
    );

    expect(requests).toEqual([
      {
        path: "/state",
        headers: { "x-petdex-update-token": "token" },
        body: { state: "waiting", agent_source: "dsh" },
      },
      {
        path: "/bubble",
        headers: { "x-petdex-update-token": "token" },
        body: {
          text: "Needs your attention",
          title: "DeepSeek Harness",
          busy: true,
          agent_source: "dsh",
          session_id: "root",
          source_app: "default_browser",
          integration_version: "0.1.0",
          source_session_id: "child",
          source_seq: 4,
          event_kind: "intervention.requested",
        },
      },
    ]);
  });
});

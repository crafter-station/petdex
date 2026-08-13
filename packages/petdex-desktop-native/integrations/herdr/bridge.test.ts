import { describe, expect, test } from "bun:test";

import {
  aggregateState,
  type HerdrAgent,
  type HerdrEvent,
  herdrAgents,
  parseCliAgents,
  postUpdate,
  safePaneId,
  safeText,
  shouldBridge,
  statusState,
  updateFromEvent,
} from "./bridge";

const agent: HerdrAgent = {
  agent: "claude",
  agent_session: { value: "session-1" },
  agent_status: "blocked",
  foreground_cwd: "/repo",
  pane_id: "w1:p5",
  terminal_title_stripped: "Fix auth",
};

const event: HerdrEvent = {
  data: {
    agent: "claude",
    agent_status: "blocked",
    pane_id: "w1:p5",
    state_labels: { blocked: "Needs approval" },
  },
};

describe("Herdr Petdex bridge", () => {
  test("defaults to agents without direct Petdex hooks", () => {
    expect(shouldBridge("claude", {})).toBeFalse();
    expect(shouldBridge("cursor", {})).toBeTrue();
    expect(shouldBridge("claude", { includeAgents: ["claude"] })).toBeTrue();
    expect(shouldBridge("cursor", { excludeAgents: ["cursor"] })).toBeFalse();
    expect(shouldBridge("qodercli", {})).toBeFalse();
    expect(shouldBridge("open_code", {})).toBeFalse();
  });

  test("maps semantic states without treating done as completion", () => {
    expect(statusState("working")).toBe("running");
    expect(statusState("blocked")).toBe("waiting");
    expect(statusState("done")).toBe("idle");
    expect(statusState("unknown")).toBeNull();
  });

  test("builds a token-gated Petdex update with exact pane metadata", () => {
    const update = updateFromEvent(event, agent, "waiting", {
      includeAgents: ["claude"],
    });
    expect(update).toEqual({
      bubble: {
        agent_source: "claude",
        busy: false,
        herdr_pane_id: "w1:p5",
        session_id: "session-1",
        source_cwd: "/repo",
        text: "Needs approval",
        title: "Fix auth",
      },
      state: "waiting",
    });
  });

  test("aggregates blocked before working and idle", () => {
    expect(
      aggregateState([
        { agent: "cursor", agent_status: "working" },
        { agent: "kilo", agent_status: "blocked" },
      ]),
    ).toBe("waiting");
    expect(aggregateState([{ agent: "cursor", agent_status: "working" }])).toBe(
      "running",
    );
    expect(aggregateState([{ agent: "cursor", agent_status: "done" }])).toBe(
      "idle",
    );
  });

  test("keeps direct agent activity in the global state and falls back to the event", () => {
    expect(
      aggregateState(
        [{ agent: "claude", agent_status: "working", pane_id: "w1:p1" }],
        { agent_status: "idle", pane_id: "w1:p2" },
      ),
    ).toBe("running");
    expect(
      aggregateState([], { agent_status: "blocked", pane_id: "w1:p2" }),
    ).toBe("waiting");
    expect(
      aggregateState(
        [{ agent: "cursor", agent_status: "blocked", pane_id: "w1:p2" }],
        { agent_status: "idle", pane_id: "w1:p2" },
      ),
    ).toBe("idle");
  });

  test("rejects malformed pane ids and sanitizes Petdex flat JSON text", () => {
    expect(safePaneId("w1:p5")).toBe("w1:p5");
    expect(safePaneId("w1:p5;open")).toBe("");
    expect(safeText('a\\b"c\n')).toBe("a b c");
  });

  test("parses Herdr CLI envelopes", () => {
    expect(
      parseCliAgents('{"result":{"agents":[{"agent":"cursor"}]}}'),
    ).toEqual([{ agent: "cursor" }]);
    expect(parseCliAgents("bad")).toEqual([]);
  });

  test("falls back cleanly when the Herdr CLI cannot spawn", () => {
    const previous = process.env.HERDR_BIN_PATH;
    try {
      process.env.HERDR_BIN_PATH = "/does/not/exist";
      expect(herdrAgents()).toEqual([]);
    } finally {
      if (previous) process.env.HERDR_BIN_PATH = previous;
      else delete process.env.HERDR_BIN_PATH;
    }
  });

  test("posts the token-gated bubble and aggregate state", async () => {
    const update = updateFromEvent(event, agent, "waiting", {
      includeAgents: ["claude"],
    });
    expect(update).not.toBeNull();
    if (!update) throw new Error("expected bridge update");
    const requests: Array<{ body: string; token: string; url: string }> = [];
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      requests.push({
        body: String(init?.body),
        token: headers.get("x-petdex-update-token") ?? "",
        url: String(input),
      });
      return new Response("{}", { status: 200 });
    };
    await postUpdate(update, "secret", fetcher as typeof fetch);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:7777/bubble",
      "http://127.0.0.1:7777/state",
    ]);
    expect(requests.every((request) => request.token === "secret")).toBeTrue();
    expect(JSON.parse(requests[1].body)).toEqual({
      agent_source: "claude",
      state: "waiting",
    });
  });
});

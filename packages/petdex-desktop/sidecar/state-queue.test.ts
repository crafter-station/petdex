import { describe, expect, test } from "bun:test";

import { StateQueue, type StateEvent } from "./state-queue";

// All tests use a fixed `now` counter so we don't depend on
// timing or sleep. The queue is pure — receivedAt and tick(now)
// are the only two clocks it knows about.

function ev(state: string, receivedAt: number, duration?: number): StateEvent {
  return { state, receivedAt, duration };
}

describe("StateQueue", () => {
  test("first event tick advances and becomes the displayed state", () => {
    const q = new StateQueue({ minDwellMs: 100 });
    expect(q.enqueue(ev("running", 0))).toBe(true);
    const out = q.tick(0);
    expect(out?.state).toBe("running");
    expect(q.currentDisplayed()?.state).toBe("running");
  });

  test("tick returns null while displayed event is still in dwell", () => {
    const q = new StateQueue({ minDwellMs: 100 });
    q.enqueue(ev("running", 0));
    q.tick(0);
    // Same state queued again — coalesces, queue stays empty.
    expect(q.enqueue(ev("running", 10))).toBe(false);
    expect(q.pendingLength()).toBe(0);
    // Still inside the 100ms dwell.
    expect(q.tick(50)).toBeNull();
  });

  test("dwell expires, next event in queue is consumed", () => {
    const q = new StateQueue({ minDwellMs: 100 });
    q.enqueue(ev("running", 0));
    q.tick(0); // start running
    q.enqueue(ev("idle", 50));
    expect(q.tick(50)).toBeNull(); // running still on display
    expect(q.tick(101)).toEqual(
      expect.objectContaining({ state: "idle" }) as StateEvent,
    );
  });

  test("coalesces same-state into the head of the pending queue", () => {
    const q = new StateQueue({ minDwellMs: 100 });
    q.enqueue(ev("running", 0));
    q.tick(0);
    q.enqueue(ev("idle", 10));
    // Three more identical idle events arrive while running is
    // still showing. They should all collapse onto the one idle
    // already in the queue.
    expect(q.enqueue(ev("idle", 20))).toBe(false);
    expect(q.enqueue(ev("idle", 30))).toBe(false);
    expect(q.enqueue(ev("idle", 40))).toBe(false);
    expect(q.pendingLength()).toBe(1);
  });

  test("alternating same-state pairs (running/idle/running/idle) are not collapsed", () => {
    // Coalesce only kills CONSECUTIVE same-state events. The
    // running -> idle -> running -> idle sequence under heavy
    // tool-call activity is not noise — each transition matters.
    const q = new StateQueue({ minDwellMs: 100 });
    expect(q.enqueue(ev("running", 0))).toBe(true);
    expect(q.enqueue(ev("idle", 1))).toBe(true);
    expect(q.enqueue(ev("running", 2))).toBe(true);
    expect(q.enqueue(ev("idle", 3))).toBe(true);
    expect(q.pendingLength()).toBe(4);
  });

  test("transient state respects its full duration before yielding", () => {
    // A "waving" with duration 1500 must show for at least
    // 1500ms even if the next event arrives 50ms after. Otherwise
    // the user never sees the wave finish.
    const q = new StateQueue({ minDwellMs: 100 });
    q.enqueue(ev("waving", 0, 1500));
    q.tick(0);
    q.enqueue(ev("idle", 100));
    expect(q.tick(500)).toBeNull(); // waving still playing
    expect(q.tick(1499)).toBeNull(); // still waving
    const out = q.tick(1500);
    expect(out?.state).toBe("idle");
  });

  test("overflow drops oldest pending events", () => {
    // 100 alternating events with maxQueueSize=10. The 90 oldest
    // must be evicted; the 10 newest survive.
    const q = new StateQueue({ minDwellMs: 100, maxQueueSize: 10 });
    q.enqueue(ev("running", 0));
    q.tick(0); // displayed = running

    // We need to bypass coalesce so each event is a different
    // state. We alternate two states the queue treats as distinct.
    for (let i = 0; i < 100; i++) {
      q.enqueue(ev(i % 2 === 0 ? "running-left" : "running-right", i + 1));
    }
    expect(q.pendingLength()).toBe(10);
  });

  test("overflow keeps the most recent events", () => {
    const q = new StateQueue({ minDwellMs: 100, maxQueueSize: 3 });
    q.enqueue(ev("running", 0));
    q.tick(0); // displayed
    q.enqueue(ev("running-left", 1));
    q.enqueue(ev("running-right", 2));
    q.enqueue(ev("waving", 3, 100));
    q.enqueue(ev("jumping", 4, 100));
    // Cap is 3 — the oldest (running-left) must have been dropped.
    expect(q.pendingLength()).toBe(3);
    const drained: string[] = [];
    let now = 100;
    while (q.pendingLength() > 0 || q.currentDisplayed()) {
      const out = q.tick(now);
      if (out) drained.push(out.state);
      now += 200;
      if (now > 100_000) throw new Error("infinite loop");
    }
    // running-left was dropped at enqueue. Remaining in order:
    // running-right, waving, jumping.
    expect(drained).toEqual(["running-right", "waving", "jumping"]);
  });

  test("empty queue, tick returns null indefinitely", () => {
    const q = new StateQueue();
    expect(q.tick(0)).toBeNull();
    expect(q.tick(1000)).toBeNull();
    expect(q.tick(99999)).toBeNull();
  });

  test("displayed state with same-state event during dwell is coalesced", () => {
    // While running is on screen, another running arrives. The
    // queue should silently drop it instead of showing running →
    // running with a 100ms gap (visually pointless).
    const q = new StateQueue({ minDwellMs: 100 });
    q.enqueue(ev("running", 0));
    q.tick(0);
    expect(q.enqueue(ev("running", 50))).toBe(false);
    expect(q.pendingLength()).toBe(0);
  });

  test("displayed state with same-state event AFTER dwell is accepted (re-show)", () => {
    // If the dwell has fully expired and the queue is empty, the
    // displayed state slot is cleared on the next tick. A later
    // identical event should be accepted because nothing is
    // currently showing.
    const q = new StateQueue({ minDwellMs: 100 });
    q.enqueue(ev("running", 0));
    q.tick(0);
    expect(q.tick(150)).toBeNull(); // dwell expired, slot cleared
    expect(q.enqueue(ev("running", 200))).toBe(true);
    expect(q.tick(200)?.state).toBe("running");
  });
});

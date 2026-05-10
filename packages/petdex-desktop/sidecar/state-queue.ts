/**
 * State queue for the desktop mascot.
 *
 * Each /state POST from an agent hook becomes a StateEvent that the
 * worker drains in order. The queue does three things the old
 * "write last value to disk" path didn't:
 *
 *   1. Enforces a minimum dwell time per event so the mascot
 *      doesn't pinball when an agent fires PreToolUse → PostToolUse
 *      back-to-back (which is normal under heavy tool-call loops).
 *      Each "frame" the user actually perceives lasts >= MIN_DWELL_MS.
 *
 *   2. Coalesces same-state runs at enqueue time. If the head of
 *      the pending queue is the same state as the new event, we
 *      drop the new event — the mascot is already going to play
 *      that animation, no need to queue it twice. Same applies to
 *      the currently-displayed state.
 *
 *   3. Bounds the queue. Under burst (10+ tool calls/sec for
 *      seconds), the queue would otherwise grow unbounded and the
 *      animation would lag minutes behind the actual agent state.
 *      MAX_QUEUE_SIZE caps the length; overflow drops oldest.
 *
 * This module is pure — no I/O, no fetch, no setTimeout. The
 * sidecar's HTTP handler enqueues; a separate setInterval in
 * server.ts ticks the worker. That split makes the queue
 * unit-testable end-to-end without standing up a real server.
 */

export type StateEvent = {
  state: string;
  duration?: number;
  receivedAt: number;
};

export type QueueOptions = {
  minDwellMs?: number;
  maxQueueSize?: number;
  /**
   * The "transient" states whose duration is intrinsic to the
   * animation (waving 1.5s, failed 2.5s). When the worker pops one
   * of these it must not advance until min(duration, dwell) elapses,
   * otherwise the user never sees the wave finish.
   */
  durationStates?: ReadonlySet<string>;
};

const DEFAULTS: Required<QueueOptions> = {
  minDwellMs: 250,
  maxQueueSize: 50,
  durationStates: new Set([
    "waving",
    "failed",
    "review",
    "jumping",
  ]),
};

export type DisplayedState = {
  state: string;
  duration: number;
  shownAt: number;
};

export class StateQueue {
  private readonly opts: Required<QueueOptions>;
  private readonly pending: StateEvent[] = [];
  private displayed: DisplayedState | null = null;

  constructor(options: QueueOptions = {}) {
    this.opts = { ...DEFAULTS, ...options } as Required<QueueOptions>;
  }

  /**
   * Push a new event onto the queue. Returns true if the event was
   * accepted, false if it was coalesced into an existing entry.
   * Coalesce rules:
   *   - same-state as currently displayed AND that display hasn't
   *     finished yet → drop (it's already showing)
   *   - same-state as the head of the pending queue → drop
   *   - same-state as the tail of the pending queue → drop
   *
   * Overflow: if accepting this event would push the queue past
   * maxQueueSize, the OLDEST pending event is dropped first.
   * Newest event always wins because that's what the user
   * actually wants to see.
   */
  enqueue(event: StateEvent): boolean {
    if (this.coalesces(event)) return false;
    this.pending.push(event);
    while (this.pending.length > this.opts.maxQueueSize) {
      this.pending.shift();
    }
    return true;
  }

  private coalesces(event: StateEvent): boolean {
    // Same as currently displayed and the display is still active
    // (within its dwell or duration). The user is already seeing
    // this state — queueing it again just adds delay later.
    if (this.displayed && this.displayed.state === event.state) {
      const elapsed = event.receivedAt - this.displayed.shownAt;
      if (elapsed < this.displayed.duration) return true;
    }
    if (this.pending.length === 0) return false;
    // Same as the most recent pending entry.
    const tail = this.pending[this.pending.length - 1];
    if (tail.state === event.state) return true;
    return false;
  }

  /**
   * Advance the queue. Called by the worker at a regular interval
   * (e.g. every 100ms). If the currently displayed state is still
   * within its dwell/duration window, returns null. Otherwise pops
   * the next pending event (or null if queue is empty).
   *
   * The caller is responsible for actually rendering the popped
   * event (writing state.json, etc).
   */
  tick(now: number): StateEvent | null {
    if (this.displayed) {
      const elapsed = now - this.displayed.shownAt;
      if (elapsed < this.displayed.duration) return null;
      // Display window over.
      this.displayed = null;
    }
    const next = this.pending.shift();
    if (!next) return null;
    this.displayed = {
      state: next.state,
      duration: this.dwellFor(next),
      shownAt: now,
    };
    return next;
  }

  private dwellFor(event: StateEvent): number {
    // Transient states (waving, failed) want their full duration to
    // play. Steady states (running, idle) only need the minimum
    // dwell — they'd otherwise hold the queue forever waiting for
    // a "natural" end.
    if (this.opts.durationStates.has(event.state) && event.duration) {
      return Math.max(event.duration, this.opts.minDwellMs);
    }
    if (event.duration && event.duration > this.opts.minDwellMs) {
      return event.duration;
    }
    return this.opts.minDwellMs;
  }

  // --- introspection (used by tests + /state GET diagnostics) ---

  pendingLength(): number {
    return this.pending.length;
  }

  currentDisplayed(): DisplayedState | null {
    return this.displayed ? { ...this.displayed } : null;
  }
}

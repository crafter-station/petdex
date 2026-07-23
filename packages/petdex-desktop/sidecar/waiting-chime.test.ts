import { describe, expect, test } from "bun:test";

import {
  playWaitingChime,
  shouldChime,
  WAITING_CHIME_PATH,
} from "./waiting-chime";

describe("waiting chime", () => {
  test("chimes only on the transition into waiting", () => {
    expect(shouldChime("running", "waiting")).toBe(true);
    expect(shouldChime("idle", "waiting")).toBe(true);
    // First state ever applied (sidecar just booted).
    expect(shouldChime(null, "waiting")).toBe(true);
    // Re-posted waiting while the prompt is still up: stay quiet.
    expect(shouldChime("waiting", "waiting")).toBe(false);
    // Leaving waiting never chimes.
    expect(shouldChime("waiting", "idle")).toBe(false);
    expect(shouldChime("running", "idle")).toBe(false);
  });

  test("plays through afplay on macOS", () => {
    const calls: { command: string; args: string[] }[] = [];
    const played = playWaitingChime("darwin", WAITING_CHIME_PATH, (c, a) =>
      calls.push({ command: c, args: a }),
    );
    expect(played).toBe(true);
    expect(calls).toEqual([
      { command: "/usr/bin/afplay", args: [WAITING_CHIME_PATH] },
    ]);
  });

  test("no-ops on other platforms", () => {
    const calls: string[] = [];
    const played = playWaitingChime("linux", WAITING_CHIME_PATH, (c) =>
      calls.push(c),
    );
    expect(played).toBe(false);
    expect(calls).toEqual([]);
  });

  test("swallows a spawner that throws synchronously", () => {
    const played = playWaitingChime("darwin", WAITING_CHIME_PATH, () => {
      throw new Error("spawn EPERM");
    });
    expect(played).toBe(false);
  });
});

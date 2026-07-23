/**
 * Waiting chime — an optional audible ping when the mascot enters the
 * "waiting" state (permission prompts, idle alerts: the agent is
 * blocked on the user). Off by default: a desk pet that starts
 * beeping unprompted after an update is a jump scare, not a feature.
 * Users opt in from the desktop settings window, which persists
 * `waitingSound` in ~/.petdex/preferences.json.
 *
 * Playback shells out to `afplay` with a stock macOS system sound —
 * no dependencies, no bundled asset, and the sidecar already assumes
 * macOS everywhere else (hdiutil mounts, .app bundle installs).
 * Other platforms no-op. afplay children are reaped by libuv's
 * SIGCHLD handling like any Node spawn, so this can't reproduce the
 * Zig-side zombie accumulation from #569.
 */

import { spawn } from "node:child_process";

export const WAITING_CHIME_PATH = "/System/Library/Sounds/Glass.aiff";

/**
 * Chime on the edge, not the level: "waiting" is often re-posted
 * (one Notification hook per permission prompt while the same prompt
 * sits unanswered, multiple agents, queue re-application), and a ping
 * per re-post would train users to turn the feature straight back
 * off. Once the user responds the state leaves "waiting", so the next
 * prompt is a fresh edge and chimes again.
 */
export function shouldChime(
  previousState: string | null,
  nextState: string,
): boolean {
  return nextState === "waiting" && previousState !== "waiting";
}

export type ChimeSpawner = (command: string, args: string[]) => void;

const defaultSpawner: ChimeSpawner = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  // A missing binary or unreadable sound file surfaces as an async
  // "error" event; without a listener it would crash the sidecar.
  child.on("error", () => {});
  child.unref();
};

/**
 * Fire-and-forget playback. Returns whether a play was attempted so
 * the caller can log it; never throws and never blocks on the child.
 */
export function playWaitingChime(
  platform: NodeJS.Platform = process.platform,
  soundPath: string = WAITING_CHIME_PATH,
  spawner: ChimeSpawner = defaultSpawner,
): boolean {
  if (platform !== "darwin") return false;
  try {
    spawner("/usr/bin/afplay", [soundPath]);
    return true;
  } catch {
    return false;
  }
}

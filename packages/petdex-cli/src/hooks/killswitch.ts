/**
 * Hook killswitch — `~/.petdex/runtime/hooks-disabled`.
 *
 * When this file exists, the curl hook installed in agent settings
 * exits 0 immediately, before any token read or network attempt.
 * Users toggle it from inside their agent via /petdex, or from a
 * shell via `petdex hooks toggle|on|off|status`.
 *
 * Why a flag file instead of an env var or a CLI-side mutation:
 *   - Hooks are POSIX shell snippets in agent JSON; they have no
 *     access to anything but $HOME and what's on disk.
 *   - The file is what the hook actually checks at run time, so
 *     toggling it from any process (the slash command via
 *     `petdex hooks toggle`, or a manual `touch`) takes effect
 *     instantly without restarting the agent.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function homeDir(): string {
  return process.env.HOME ?? homedir();
}

export function killswitchPath(): string {
  return path.join(homeDir(), ".petdex", "runtime", "hooks-disabled");
}

export function tokenPath(): string {
  return path.join(homeDir(), ".petdex", "runtime", "update-token");
}

export type KillswitchState = "on" | "off";

export function getKillswitchState(): KillswitchState {
  return existsSync(killswitchPath()) ? "off" : "on";
}

export function setKillswitchState(next: KillswitchState): KillswitchState {
  const file = killswitchPath();
  if (next === "off") {
    mkdirSync(path.dirname(file), { recursive: true });
    // Body is informational — the hook checks for existence only.
    // We write a small note so a user who finds the file can grep
    // their way back to the toggle command.
    writeFileSync(
      file,
      `# Petdex hook killswitch.\n# Hooks are DISABLED while this file exists.\n# Re-enable: petdex hooks on (or /petdex from inside your agent).\n`,
      { mode: 0o600 },
    );
  } else {
    try {
      unlinkSync(file);
    } catch {
      // Already absent — that's the desired state.
    }
  }
  return next;
}

export function toggleKillswitch(): KillswitchState {
  return setKillswitchState(getKillswitchState() === "on" ? "off" : "on");
}

/**
 * /petdex slash command — installable across every supported agent.
 *
 * The slash command body is identical for all four agents because
 * each of them shares the same "frontmatter + markdown + $ARGUMENTS"
 * convention. We just drop the file at the right path per agent
 * (see Agent.slashCommandPath) and the agent surfaces /petdex in
 * its picker.
 *
 * The command tells the agent to run a shell out to
 * `petdex hooks toggle|on|off|status`. We do NOT want the agent to
 * "interpret" or "explain" anything — it should just run the CLI
 * and surface the output. A flag-file killswitch is the source of
 * truth, the CLI is just a thin frontend over it.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Agent } from "./agents.js";

const SLASH_COMMAND_BODY = `---
description: Wake or sleep the petdex mascot — toggles the floating pet on/off
---

The user wants to control the petdex mascot from inside the agent. The mascot is a floating macOS window driven by hooks installed in agent settings. /petdex is a one-shot toggle that flips the entire state in a single command:

- \`/petdex\` (no args) → run \`petdex toggle\` (if mascot is awake, send to sleep; otherwise wake it up)
- \`/petdex up\` → run \`petdex up\` (force-wake: enables hooks AND starts the desktop)
- \`/petdex down\` → run \`petdex down\` (force-sleep: disables hooks AND stops the desktop)
- \`/petdex status\` → run \`petdex hooks status\`
- \`/petdex doctor\` → run \`petdex doctor\` (diagnose install + agents)

Show the command output verbatim to the user. Don't reinterpret, don't explain — the CLI's output is already user-facing.

If the \`petdex\` binary isn't on PATH, suggest \`npx petdex <subcommand>\` instead.

Arguments: \`$ARGUMENTS\`
`;

/**
 * Drop the /petdex slash command file at the agent's slash-command
 * path. Called from `petdex hooks install` for each selected agent.
 * Idempotent — if the file already exists we just overwrite it
 * (this is OUR file, not user-authored, and the body never depends
 * on user state).
 */
export async function installSlashCommand(agent: Agent): Promise<void> {
  await mkdir(path.dirname(agent.slashCommandPath), { recursive: true });
  await writeFile(agent.slashCommandPath, SLASH_COMMAND_BODY, "utf8");
}

/**
 * Remove the /petdex slash command file. Best-effort — missing file
 * is fine, that's the desired post-state.
 */
export async function uninstallSlashCommand(agent: Agent): Promise<void> {
  try {
    await rm(agent.slashCommandPath, { force: true });
  } catch {
    // Already absent — that's the desired state.
  }
}

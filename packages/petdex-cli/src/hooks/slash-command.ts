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
import { homedir } from "node:os";
import path from "node:path";

import type { Agent } from "./agents.js";

// Resolve the petdex CLI invocation at install time. We always have
// a persisted snapshot at ~/.petdex/bin/petdex.js (written by
// persistRunningBinary during hooks install), so the slash command
// uses that absolute path. This avoids the "petdex: command not
// found" failure in agents whose shell doesn't have npm globals on
// PATH (common when users install via `npx petdex init`).
const PETDEX_INVOKE = `node "$HOME/.petdex/bin/petdex.js"`;

const SLASH_COMMAND_BODY = `---
description: Wake or sleep the petdex mascot. Toggles the floating pet on/off
---

The user wants to control the petdex mascot from inside the agent. The mascot is a floating macOS window driven by hooks installed in agent settings. /petdex is a one-shot toggle that flips the entire state in a single command.

Run the matching command using the persisted petdex binary at \`$HOME/.petdex/bin/petdex.js\` (always present after \`petdex hooks install\`):

- \`/petdex\` (no args) → run \`${PETDEX_INVOKE} toggle\`
- \`/petdex up\` → run \`${PETDEX_INVOKE} up\`
- \`/petdex down\` → run \`${PETDEX_INVOKE} down\`
- \`/petdex status\` → run \`${PETDEX_INVOKE} hooks status\`
- \`/petdex doctor\` → run \`${PETDEX_INVOKE} doctor\`

Show the command output verbatim to the user. Don't reinterpret, don't explain. The CLI's output is already user-facing.

If \`$HOME/.petdex/bin/petdex.js\` doesn't exist, the user hasn't run \`petdex hooks install\` yet. Tell them to run \`npx petdex@latest init\` first, then retry.

Arguments: \`$ARGUMENTS\`
`;

const GEMINI_COMMAND_BODY = `description = "Wake or sleep the petdex mascot. Toggles the floating pet on/off"

prompt = """
The user wants to control the petdex mascot from inside the agent. The mascot is a floating macOS window driven by hooks installed in agent settings. /petdex is a one-shot toggle that flips the entire state in a single command.

Run the matching command using the persisted petdex binary at \`$HOME/.petdex/bin/petdex.js\` (always present after \`petdex hooks install\`):

- \`/petdex\` (no args) -> run \`${PETDEX_INVOKE} toggle\`
- \`/petdex up\` -> run \`${PETDEX_INVOKE} up\`
- \`/petdex down\` -> run \`${PETDEX_INVOKE} down\`
- \`/petdex status\` -> run \`${PETDEX_INVOKE} hooks status\`
- \`/petdex doctor\` -> run \`${PETDEX_INVOKE} doctor\`

Show the command output verbatim to the user. Don't reinterpret, don't explain. The CLI's output is already user-facing.

If \`$HOME/.petdex/bin/petdex.js\` doesn't exist, the user hasn't run \`petdex hooks install\` yet. Tell them to run \`npx petdex@latest init\` first, then retry.

Arguments: \`{{args}}\`
"""
`;

const LEGACY_GEMINI_ANTIGRAVITY_WORKFLOW = path.join(
  homedir(),
  ".gemini",
  "antigravity",
  "global_workflows",
  "petdex.md",
);

/**
 * Drop the /petdex slash command file at the agent's slash-command
 * path. Called from `petdex hooks install` for each selected agent.
 * Idempotent — if the file already exists we just overwrite it
 * (this is OUR file, not user-authored, and the body never depends
 * on user state).
 */
export async function installSlashCommand(agent: Agent): Promise<void> {
  await mkdir(path.dirname(agent.slashCommandPath), { recursive: true });
  await writeFile(
    agent.slashCommandPath,
    agent.id === "gemini" ? GEMINI_COMMAND_BODY : SLASH_COMMAND_BODY,
    "utf8",
  );
  if (agent.id === "gemini") {
    await rm(LEGACY_GEMINI_ANTIGRAVITY_WORKFLOW, { force: true });
  }
}

/**
 * Remove the /petdex slash command file. Best-effort — missing file
 * is fine, that's the desired post-state.
 */
export async function uninstallSlashCommand(agent: Agent): Promise<void> {
  try {
    await rm(agent.slashCommandPath, { force: true });
    if (agent.id === "gemini") {
      await rm(LEGACY_GEMINI_ANTIGRAVITY_WORKFLOW, { force: true });
    }
  } catch {
    // Already absent — that's the desired state.
  }
}

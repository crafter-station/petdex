/**
 * `petdex hooks uninstall` — reverses `petdex hooks install`.
 *
 * For each agent:
 *   - JSON-config agents (Claude, Codex, Gemini): read settings,
 *     filter out the entries we wrote (anything containing the
 *     sidecar URL or :7777/state), and rewrite. Backup first.
 *   - OpenCode plugin: delete the plugin file we wrote.
 *
 * Always removes the /petdex slash command file alongside.
 *
 * Optional --remove-token flag also deletes
 * ~/.petdex/runtime/update-token so a future re-install issues a
 * fresh token (handy after a security-relevant uninstall).
 */
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import {
  AGENTS,
  type Agent,
  PETDEX_PORT,
  SIDECAR_URL,
} from "./agents.js";
import { tokenPath } from "./killswitch.js";
import { uninstallSlashCommand } from "./slash-command.js";

export type HooksUninstallOptions = {
  removeToken?: boolean;
};

export type HooksUninstallResult = {
  uninstalledAgents: Agent["id"][];
};

export async function runUninstall(
  options: HooksUninstallOptions = {},
): Promise<HooksUninstallResult> {
  p.intro(pc.bgMagenta(pc.white(" petdex hooks uninstall ")));

  const detections = await detectAgents();
  const installed = detections.filter((d) => d.installed);

  if (installed.length === 0) {
    p.outro(pc.dim("No agent configs found — nothing to uninstall."));
    return { uninstalledAgents: [] };
  }

  const summary: string[] = [];
  const uninstalledAgents: Agent["id"][] = [];

  for (const { agent } of installed) {
    try {
      const result = await uninstallForAgent(agent);
      if (result.removed) {
        uninstalledAgents.push(agent.id);
        const backupNote = result.backupPath
          ? ` ${pc.dim(`(backup: ${path.basename(result.backupPath)})`)}`
          : "";
        summary.push(
          `  ${pc.green("✓")} ${pc.bold(agent.displayName)}${backupNote}`,
        );
      } else {
        summary.push(
          `  ${pc.dim("•")} ${pc.bold(agent.displayName)} ${pc.dim("(no petdex entries found)")}`,
        );
      }
      // Always try to clean up the slash command file even if the
      // hook config had no petdex entries — the user might have run
      // an older version that wrote one without writing hooks.
      await uninstallSlashCommand(agent);
    } catch (err) {
      summary.push(
        `  ${pc.red("✗")} ${pc.bold(agent.displayName)} ${pc.red(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  p.note(summary.join("\n"), "Done");

  if (options.removeToken) {
    try {
      await rm(tokenPath(), { force: true });
      p.log.info(`${pc.green("✓")} Removed ${tokenPath()}`);
    } catch {
      // not present, fine
    }
  } else {
    if (existsSync(tokenPath())) {
      p.log.info(
        pc.dim(
          `Token file at ${tokenPath()} kept. Pass --remove-token to delete it.`,
        ),
      );
    }
  }

  p.outro(
    `${pc.green("✓")} Done. Run ${pc.cyan("petdex hooks install")} to wire petdex back in.`,
  );

  return { uninstalledAgents };
}

type Detection = { agent: Agent; installed: boolean };

async function detectAgents(): Promise<Detection[]> {
  return Promise.all(
    AGENTS.map(async (agent) => ({
      agent,
      installed: existsSync(agent.configDir),
    })),
  );
}

type UninstallResult = {
  removed: boolean;
  backupPath: string | null;
};

async function uninstallForAgent(agent: Agent): Promise<UninstallResult> {
  // OpenCode: just delete the plugin file we wrote. The plugin file
  // path is OURS (we created it under plugins/petdex.js); it's safe
  // to remove without parsing.
  if (agent.id === "opencode") {
    if (!existsSync(agent.configFile)) return { removed: false, backupPath: null };
    const backupPath = await maybeBackup(agent.configFile);
    await rm(agent.configFile, { force: true });
    return { removed: true, backupPath };
  }

  // JSON-config agents: read, strip our entries, rewrite.
  if (!existsSync(agent.configFile)) return { removed: false, backupPath: null };

  let text: string;
  try {
    text = await readFile(agent.configFile, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read ${agent.configFile}: ${(err as Error).message}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Refusing to overwrite ${agent.configFile}: invalid JSON (${(err as Error).message}). Hand-edit the file to remove petdex entries.`,
    );
  }

  const stripped = stripPetdexHooks(parsed);
  if (!stripped.changed) {
    return { removed: false, backupPath: null };
  }

  const backupPath = await maybeBackup(agent.configFile);
  await writeFile(
    agent.configFile,
    `${JSON.stringify(stripped.value, null, 2)}\n`,
    "utf8",
  );
  return { removed: true, backupPath };
}

/**
 * Walk a parsed agent settings object, remove every hook entry whose
 * embedded shell command references the petdex sidecar URL/port.
 * Empty event arrays AND an empty `hooks` object are removed too so
 * we don't leave stub keys behind.
 */
export function stripPetdexHooks(
  parsed: Record<string, unknown>,
): { value: Record<string, unknown>; changed: boolean } {
  const out = { ...parsed };
  const hooks = out.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return { value: out, changed: false };
  }

  let changed = false;
  const nextHooks: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(
    hooks as Record<string, unknown>,
  )) {
    if (!Array.isArray(entries)) {
      // Pass through anything we don't recognize.
      nextHooks[event] = entries as unknown[];
      continue;
    }
    const filtered = entries.filter((entry) => !isPetdexEntry(entry));
    if (filtered.length !== entries.length) changed = true;
    if (filtered.length > 0) nextHooks[event] = filtered;
  }

  if (!changed) return { value: out, changed: false };

  // Drop the `hooks` key entirely if we emptied every event under
  // it. That leaves the file as if petdex had never touched it.
  if (Object.keys(nextHooks).length === 0) {
    const { hooks: _drop, ...rest } = out;
    return { value: rest, changed: true };
  }
  out.hooks = nextHooks;
  return { value: out, changed: true };
}

function isPetdexEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry == null) return false;
  const cmds = collectCommands(entry);
  return cmds.some(
    (c) =>
      c.includes(`localhost:${PETDEX_PORT}/state`) || c.includes(SIDECAR_URL),
  );
}

function collectCommands(entry: unknown): string[] {
  const acc: string[] = [];
  function walk(value: unknown) {
    if (typeof value === "string") {
      acc.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (typeof value === "object" && value != null) {
      for (const v of Object.values(value)) walk(v);
    }
  }
  walk(entry);
  return acc;
}

async function maybeBackup(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.${stamp}.bak`;
  const content = await readFile(file);
  await writeFile(backup, content);
  return backup;
}


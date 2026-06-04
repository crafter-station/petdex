import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { homeDir, isPetUsable } from "./install.js";
import {
  startDesktop,
  stopDesktop,
  type StartResult,
  type StopResult,
} from "./process.js";

export type DesktopReloadDeps = {
  stopDesktop: () => Promise<StopResult>;
  startDesktop: () => Promise<StartResult>;
};

export type DesktopReloadResult =
  | { status: "reloaded" }
  | { status: "manual_restart_required"; reason: string };

export function defaultPetRoots(home = homeDir()): string[] {
  return [path.join(home, ".petdex", "pets"), path.join(home, ".codex", "pets")];
}

export function defaultActiveJsonPath(home = homeDir()): string {
  return path.join(home, ".petdex", "active.json");
}

export async function collectSelectableSlugs(
  roots = defaultPetRoots(),
): Promise<string[]> {
  const slugSet = new Set<string>();
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (isPetUsable(path.join(root, entry.name))) slugSet.add(entry.name);
      }
    } catch {
      continue;
    }
  }
  return [...slugSet].sort();
}

export async function setActivePet(
  slug: string,
  activeJsonPath = defaultActiveJsonPath(),
): Promise<void> {
  await mkdir(path.dirname(activeJsonPath), { recursive: true });
  await writeFile(activeJsonPath, JSON.stringify({ slug }) + "\n", "utf8");
}

export async function reloadDesktopAfterSelect(
  deps: DesktopReloadDeps = { stopDesktop, startDesktop },
): Promise<DesktopReloadResult> {
  const stopResult = await deps.stopDesktop();
  if (!stopResult.ok && !stopResult.reason.includes("not running")) {
    return {
      status: "manual_restart_required",
      reason: stopResult.reason,
    };
  }
  if (stopResult.ok && !stopResult.portReleased) {
    return {
      status: "manual_restart_required",
      reason: "desktop sidecar port is still busy",
    };
  }

  const startResult = await deps.startDesktop();
  if (!startResult.ok) {
    return {
      status: "manual_restart_required",
      reason: startResult.reason,
    };
  }

  return { status: "reloaded" };
}

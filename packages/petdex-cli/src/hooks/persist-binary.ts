/**
 * Persist the currently-running petdex CLI binary to a stable
 * location (~/.petdex/bin/petdex.js) so agent hooks can invoke it
 * with an absolute path.
 *
 * Why: hooks fire from the agent's shell, which doesn't necessarily
 * have `petdex` in PATH. Users who run `npx petdex init` have a
 * temporary binary that won't exist when the agent actually fires
 * the hook. We solve this by copying the running binary to a known
 * location at install time.
 *
 * The persisted copy is a SNAPSHOT: it doesn't auto-update. Users who
 * upgrade petdex (npx petdex@latest) just re-run `petdex init` (or
 * `petdex hooks install`) to refresh the snapshot. Worse outcomes —
 * silently using a stale snapshot on `petdex update` — would surprise
 * us when behavior diverges between the running CLI and the hooks.
 */

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PERSIST_DIR = join(homedir(), ".petdex", "bin");
export const PERSIST_PATH = join(PERSIST_DIR, "petdex.js");
export const PERSIST_HOOK_VBS_PATH = join(PERSIST_DIR, "petdex-hook.vbs");

/**
 * Best-effort copy. Returns the persisted path on success, null if
 * we couldn't snapshot (e.g. process.argv[1] points at something that
 * isn't a copyable file). Failures are logged via the caller.
 */
export async function persistRunningBinary(): Promise<{
  ok: boolean;
  path: string;
  reason?: string;
}> {
  // process.argv[1] is the entry script. For petdex CLI this is the
  // bundled JS at .../dist/petdex.js (compiled by `bun build`). We
  // copy it as-is — the shebang is already present.
  const source = process.argv[1];
  if (!source) {
    return { ok: false, path: PERSIST_PATH, reason: "no argv[1]" };
  }
  try {
    await mkdir(PERSIST_DIR, { recursive: true });
    await copyFile(source, PERSIST_PATH);
    if (process.platform === "win32") {
      await writeFile(
        PERSIST_HOOK_VBS_PATH,
        windowsHookLauncher(process.execPath),
      );
    }
    // chmod is best-effort; copyFile preserves perms on most
    // platforms but we want exec bits unconditionally.
    const { chmod } = await import("node:fs/promises");
    try {
      await chmod(PERSIST_PATH, 0o755);
    } catch {}
    return { ok: true, path: PERSIST_PATH };
  } catch (err) {
    return {
      ok: false,
      path: PERSIST_PATH,
      reason: (err as Error).message,
    };
  }
}

function windowsHookLauncher(nodePath: string): string {
  const escapedNodePath = nodePath.replace(/"/g, '""');
  return `Option Explicit

Dim shell, fso, scriptDir, petdexPath, nodePath, cmd, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
petdexPath = fso.BuildPath(scriptDir, "petdex.js")
nodePath = "${escapedNodePath}"
If Not fso.FileExists(nodePath) Then
  nodePath = "node.exe"
End If

cmd = Quote(nodePath) & " " & Quote(petdexPath)
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " " & Quote(WScript.Arguments(i))
Next

shell.Run cmd, 0, True

Function Quote(value)
  Quote = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
`;
}

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";

export type DesktopPreferences = {
  autoInstallUpdates: boolean;
};

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string;
};

export type DesktopRelease = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  autoInstallUpdates: true,
};

export function parseDesktopPreferences(text: string): DesktopPreferences {
  try {
    const parsed = JSON.parse(text) as { autoInstallUpdates?: unknown };
    return {
      autoInstallUpdates:
        typeof parsed.autoInstallUpdates === "boolean"
          ? parsed.autoInstallUpdates
          : DEFAULT_DESKTOP_PREFERENCES.autoInstallUpdates,
    };
  } catch {
    return DEFAULT_DESKTOP_PREFERENCES;
  }
}

export function findEnclosingAppBundle(startPath: string): string | null {
  let current = resolve(startPath);
  while (true) {
    if (basename(current).endsWith(".app")) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findDmgAsset(
  release: DesktopRelease,
  arch: string,
): ReleaseAsset | null {
  const archLabel = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
  const wanted = `Petdex-${archLabel}.dmg`;
  return release.assets.find((asset) => asset.name === wanted) ?? null;
}

export function parseHdiutilMount(stdout: string): string | null {
  let best: string | null = null;
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("/Volumes/");
    if (idx === -1) continue;
    const candidate = line.slice(idx).trim();
    if (!best || candidate.length > best.length) best = candidate;
  }
  return best;
}

function waitForFileEvent(
  file: ReturnType<typeof createWriteStream>,
  event: "drain",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      file.off(event, onEvent);
      file.off("error", onError);
    };
    file.once(event, onEvent);
    file.once("error", onError);
  });
}

export async function downloadToFile(
  url: string,
  destPath: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error(`release asset has invalid size: ${expectedSize}`);
  }
  const tmpPath = `${destPath}.tmp`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    if (!res.body) throw new Error("download response has no body");
    const file = createWriteStream(tmpPath);
    const finishedPromise = finished(file);
    const reader = res.body.getReader();
    const hash = createHash("sha256");
    let bytes = 0;
    let fileError: Error | null = null;
    file.on("error", (err) => {
      fileError = err;
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > expectedSize) {
          throw new Error(
            `download size mismatch: expected ${expectedSize}, got more than ${bytes}`,
          );
        }
        hash.update(chunk);
        if (fileError) throw fileError;
        if (!file.write(chunk)) {
          await Promise.race([
            waitForFileEvent(file, "drain"),
            finishedPromise,
          ]);
        }
        if (fileError) throw fileError;
      }
      if (fileError) throw fileError;
      file.end();
      await finishedPromise;
    } catch (err) {
      file.destroy();
      await finishedPromise.catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }
    if (bytes !== expectedSize) {
      throw new Error(
        `download size mismatch: expected ${expectedSize}, got ${bytes}`,
      );
    }
    const actual = hash.digest("hex");
    if (actual !== expectedSha256) {
      throw new Error(
        `download digest mismatch: expected ${expectedSha256}, got ${actual}`,
      );
    }
    renameSync(tmpPath, destPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export async function installStagedAppBundle(
  appBundleRoot: string,
  stagedApp: string,
  backupApp: string,
  verifyInstalled: () => Promise<void>,
): Promise<void> {
  rmSync(backupApp, { recursive: true, force: true });
  renameSync(appBundleRoot, backupApp);
  let installed = false;
  try {
    renameSync(stagedApp, appBundleRoot);
    installed = true;
    await verifyInstalled();
    rmSync(backupApp, { recursive: true, force: true });
  } catch (err) {
    if (installed) {
      rmSync(appBundleRoot, { recursive: true, force: true });
    }
    if (existsSync(backupApp)) {
      renameSync(backupApp, appBundleRoot);
    }
    throw err;
  }
}

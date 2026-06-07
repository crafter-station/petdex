import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type BuildVersionInfo = {
  builtAt: string;
  version: string;
};

export function createBuildVersionInfo(
  root = process.cwd(),
  now = new Date(),
): BuildVersionInfo {
  const version = resolveBuildVersion(root);
  const builtAt = now.toISOString();

  return { builtAt, version };
}

export function writeBuildVersionFile(
  root = process.cwd(),
  versionInfo = createBuildVersionInfo(root),
) {
  const paths = getBuildVersionPaths(root);

  mkdirSync(paths.publicDir, { recursive: true });
  writeFileSync(
    paths.versionPath,
    `${JSON.stringify(
      {
        version: versionInfo.version,
        builtAt: versionInfo.builtAt,
      },
      null,
      2,
    )}\n`,
  );

  return versionInfo;
}

export function ensureBuildVersionFiles(root = process.cwd()) {
  const paths = getBuildVersionPaths(root);

  if (existsSync(paths.versionPath)) {
    return;
  }

  writeBuildVersionFile(root);
}

function getBuildVersionPaths(root: string) {
  const publicDir = path.join(root, "public");

  return {
    publicDir,
    versionPath: path.join(publicDir, "version.json"),
  };
}

function resolveBuildVersion(root: string) {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return `local-${Date.now().toString()}`;
  }
}

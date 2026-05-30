import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createBuildVersionToken } from "../src/lib/build-version-token";

export type BuildVersionInfo = {
  buildKey: string;
  builtAt: string;
  version: string;
};

export function createBuildVersionInfo(
  root = process.cwd(),
  now = new Date(),
): BuildVersionInfo {
  const version = resolveBuildVersion(root);
  const builtAt = now.toISOString();
  const buildKey = createBuildVersionToken({ builtAt, version }) ?? version;

  return { buildKey, builtAt, version };
}

export function writeBuildVersionFile(
  root = process.cwd(),
  versionInfo = createBuildVersionInfo(root),
) {
  const paths = getBuildVersionPaths(root);

  mkdirSync(paths.publicDir, { recursive: true });
  mkdirSync(paths.generatedDir, { recursive: true });
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
  writeFileSync(
    paths.currentBuildPath,
    `export const CURRENT_BUILD_KEY = ${JSON.stringify(versionInfo.buildKey)};\n`,
  );

  return versionInfo;
}

export function ensureBuildVersionFiles(root = process.cwd()) {
  const paths = getBuildVersionPaths(root);

  if (existsSync(paths.versionPath) && existsSync(paths.currentBuildPath)) {
    return;
  }

  writeBuildVersionFile(root);
}

function getBuildVersionPaths(root: string) {
  const publicDir = path.join(root, "public");
  const generatedDir = path.join(root, "src", "generated");

  return {
    currentBuildPath: path.join(generatedDir, "current-build.ts"),
    generatedDir,
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

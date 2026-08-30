#!/usr/bin/env bun

// Cut a desktop release end-to-end: bump verification, build, sign,
// notarize, tag, and upload to GitHub releases.
//
// Usage:
//   bun scripts/release-desktop.ts <version> --notes "release notes"
//   bun scripts/release-desktop.ts 0.1.7 --notes "self-healing update + install errors"
//   bun scripts/release-desktop.ts 0.1.7 --notes-file release-notes.md
//   bun scripts/release-desktop.ts 0.1.7 --notes "..." --skip-build  # reuse existing artifacts
//   bun scripts/release-desktop.ts 0.1.7 --notes "..." --draft       # don't publish, draft only
//
// Required env (or auto-detected):
//   APPLE_API_KEY         path to AuthKey_*.p8
//   APPLE_API_KEY_ID      e.g. 8FN535ATJ5
//   APPLE_API_ISSUER      issuer UUID
//   SIGN_IDENTITY         e.g. "Developer ID Application: NAME (TEAM)"
//   NATIVE_CLI            native CLI built from the pinned SDK
//   NATIVE_SDK_PATH       pinned Native SDK checkout used to build the CLI
//
// What it does:
//   1. Validate version arg (semver, optionally prefixed with v or desktop-v) + ensure tag doesn't exist
//   2. Verify clean working tree on packages/petdex-desktop-native/ paths
//   3. Run scripts/sign-macos.sh for arm64 and x64
//   4. Verify all macOS artifacts exist
//   5. Create annotated tag desktop-vX.Y.Z, push to origin
//   6. gh release create with notes + macOS assets
//   7. Verify /api/desktop/latest-release picks it up (probe production)
//
// All steps are idempotent on retry except the tag push and gh release create.
// On failure mid-flight, fix the underlying issue and re-run with --skip-build
// to skip the slow notarization step if artifacts are already on disk.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const MACOS_OUT_DIR = path.join(REPO_ROOT, "dist", "macos");
const RELEASE_ARTIFACT_NAMES = [
  "Petdex-arm64.dmg",
  "Petdex-x64.dmg",
  "petdex-desktop-native-darwin-arm64.zip",
  "petdex-desktop-native-darwin-x64.zip",
  "petdex-desktop-darwin-arm64.zip",
  "petdex-desktop-darwin-x64.zip",
] as const;
const BUILD_MANIFEST_PATH = path.join(
  MACOS_OUT_DIR,
  "petdex-desktop-build-manifest.json",
);

type BuildManifest = {
  format: 3;
  version: string;
  commit: string;
  sdkCommit: string;
  cliCommit: string;
  packagerSdkCommit: string;
  packagerCliCommit: string;
  artifacts: Record<string, { size: number; sha256: string }>;
};

type NativeToolchain = {
  env: Record<string, string>;
  sdkPath: string;
  sdkCommit: string;
  cliPath: string;
  cliCommit: string;
  packagerSdkPath: string;
  packagerSdkCommit: string;
  packagerCliPath: string;
  packagerCliCommit: string;
};

type Args = {
  version: string;
  notes: string;
  skipBuild: boolean;
  draft: boolean;
  prerelease: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let notes = "";
  let notesFile = "";
  let skipBuild = false;
  let draft = false;
  let prerelease = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--notes") notes = argv[++i] ?? "";
    else if (a === "--notes-file") notesFile = argv[++i] ?? "";
    else if (a === "--skip-build") skipBuild = true;
    else if (a === "--draft") draft = true;
    else if (a === "--prerelease") prerelease = true;
    else if (a.startsWith("--")) die(`unknown flag: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) {
    die(
      'usage: bun scripts/release-desktop.ts <version> --notes "..." [--skip-build] [--draft]',
    );
  }
  let version = positional[0];
  if (version.startsWith("v")) version = version.slice(1);
  if (version.startsWith("desktop-v"))
    version = version.slice("desktop-v".length);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    die(`invalid version: ${version} (expected semver like 0.1.7)`);
  }
  if (notesFile) {
    if (!existsSync(notesFile)) die(`notes file not found: ${notesFile}`);
    notes = readFileSync(notesFile, "utf8").trim();
  }
  if (!notes) die("--notes or --notes-file is required");
  return { version, notes, skipBuild, draft, prerelease };
}

function die(msg: string): never {
  console.error(`release-desktop: ${msg}`);
  process.exit(1);
}

function step(label: string) {
  console.log(`\n=== ${label} ===`);
}

function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    allowFail?: boolean;
  } = {},
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0 && !opts.allowFail) {
    die(`command failed (exit ${r.status}): ${cmd} ${args.join(" ")}`);
  }
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    status: r.status ?? -1,
  };
}

function pinnedNativeSdkRef(): string {
  const workflowPaths = [
    path.join(REPO_ROOT, ".github", "workflows", "desktop-native-ci.yml"),
    path.join(REPO_ROOT, ".github", "workflows", "desktop-release.yml"),
  ];
  const refs = workflowPaths.flatMap((workflowPath) => {
    const source = readFileSync(workflowPath, "utf8");
    return [...source.matchAll(/NATIVE_SDK_REF:\s*"([0-9a-f]{40})"/g)].map(
      (match) => match[1],
    );
  });
  if (refs.length !== 2 || refs.some((ref) => ref !== refs[0])) {
    die("desktop workflows do not agree on one Native SDK commit");
  }
  return refs[0];
}

function resolveNativeToolchain(): NativeToolchain {
  if (!process.env.NATIVE_CLI)
    die("NATIVE_CLI is required (build it from the pinned Native SDK)");
  if (!process.env.NATIVE_SDK_PATH)
    die("NATIVE_SDK_PATH is required (use the same SDK as NATIVE_CLI)");
  if (!process.env.NATIVE_PACKAGER_CLI)
    die("NATIVE_PACKAGER_CLI is required (build it from Native SDK 0.10.1)");
  if (!process.env.NATIVE_PACKAGER_SDK_PATH)
    die("NATIVE_PACKAGER_SDK_PATH is required");

  const cliInput = path.isAbsolute(process.env.NATIVE_CLI)
    ? process.env.NATIVE_CLI
    : path.resolve(process.cwd(), process.env.NATIVE_CLI);
  const sdkInput = path.isAbsolute(process.env.NATIVE_SDK_PATH)
    ? process.env.NATIVE_SDK_PATH
    : path.resolve(process.cwd(), process.env.NATIVE_SDK_PATH);
  try {
    accessSync(cliInput, fsConstants.X_OK);
  } catch {
    die(`NATIVE_CLI is not executable: ${cliInput}`);
  }
  if (!existsSync(sdkInput) || !statSync(sdkInput).isDirectory()) {
    die(`NATIVE_SDK_PATH is not a directory: ${sdkInput}`);
  }

  const cliPath = realpathSync(cliInput);
  const sdkPath = realpathSync(sdkInput);
  const relativeCli = path.relative(sdkPath, cliPath);
  const expectedCliDir = path.join("zig-out", "bin");
  const relativeCliDir = path.dirname(relativeCli);
  const cliName = path.basename(relativeCli);
  if (
    relativeCli.startsWith("..") ||
    path.isAbsolute(relativeCli) ||
    relativeCliDir !== expectedCliDir ||
    (cliName !== "native" && cliName !== "native.exe")
  ) {
    die("NATIVE_CLI must be zig-out/bin/native from NATIVE_SDK_PATH");
  }

  const expectedCommit = pinnedNativeSdkRef();
  const sdkResult = spawnSync("git", ["-C", sdkPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const sdkCommit = (sdkResult.stdout || "").trim();
  if (sdkResult.status !== 0 || !/^[0-9a-f]{40}$/.test(sdkCommit)) {
    die("unable to read the Native SDK commit");
  }
  if (sdkCommit !== expectedCommit) {
    die("NATIVE_SDK_PATH is not at the commit pinned by the desktop workflows");
  }

  const cliResult = spawnSync(cliPath, ["version"], {
    cwd: sdkPath,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cliOutput = cliResult.stdout || "";
  const cliCommit =
    cliOutput.match(/\bcommit\s+([0-9a-f]{7,40})\b/i)?.[1] ?? "";
  if (
    cliResult.status !== 0 ||
    cliResult.signal ||
    !/^[0-9a-f]{7,40}$/.test(cliCommit)
  ) {
    die("NATIVE_CLI does not report a verifiable build commit");
  }
  if (!sdkCommit.startsWith(cliCommit)) {
    die("NATIVE_CLI was built from a different Native SDK commit");
  }

  const packagerCliInput = path.isAbsolute(process.env.NATIVE_PACKAGER_CLI)
    ? process.env.NATIVE_PACKAGER_CLI
    : path.resolve(process.cwd(), process.env.NATIVE_PACKAGER_CLI);
  const packagerSdkInput = path.isAbsolute(process.env.NATIVE_PACKAGER_SDK_PATH)
    ? process.env.NATIVE_PACKAGER_SDK_PATH
    : path.resolve(process.cwd(), process.env.NATIVE_PACKAGER_SDK_PATH);
  try {
    accessSync(packagerCliInput, fsConstants.X_OK);
  } catch {
    die(`NATIVE_PACKAGER_CLI is not executable: ${packagerCliInput}`);
  }
  if (
    !existsSync(packagerSdkInput) ||
    !statSync(packagerSdkInput).isDirectory()
  ) {
    die(`NATIVE_PACKAGER_SDK_PATH is not a directory: ${packagerSdkInput}`);
  }
  const packagerCliPath = realpathSync(packagerCliInput);
  const packagerSdkPath = realpathSync(packagerSdkInput);
  const relativePackagerCli = path.relative(packagerSdkPath, packagerCliPath);
  if (
    relativePackagerCli !== path.join("zig-out", "bin", "native") &&
    relativePackagerCli !== path.join("zig-out", "bin", "native.exe")
  ) {
    die(
      "NATIVE_PACKAGER_CLI must be zig-out/bin/native from NATIVE_PACKAGER_SDK_PATH",
    );
  }
  const packagerCommitResult = spawnSync(
    "git",
    ["-C", packagerSdkPath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  const packagerSdkCommit = (packagerCommitResult.stdout || "").trim();
  const expectedPackagerCommit = "064ca9890cc0cf8adc198215bd0ddaeb586c220a";
  if (packagerSdkCommit !== expectedPackagerCommit) {
    die("NATIVE_PACKAGER_SDK_PATH must be at Native SDK v0.10.1");
  }
  const packagerCliResult = spawnSync(packagerCliPath, ["version"], {
    cwd: packagerSdkPath,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packagerCliCommit =
    (packagerCliResult.stdout || "").match(
      /\bcommit\s+([0-9a-f]{7,40})\b/i,
    )?.[1] ?? "";
  if (
    packagerCliResult.status !== 0 ||
    !packagerSdkCommit.startsWith(packagerCliCommit)
  ) {
    die("NATIVE_PACKAGER_CLI was built from a different Native SDK commit");
  }
  const packagerStrings = spawnSync("strings", [packagerCliPath], {
    encoding: "utf8",
  });
  if (
    packagerStrings.status !== 0 ||
    !packagerStrings.stdout.includes("set sidebar width of dmgWindow to 0") ||
    !packagerStrings.stdout.includes("set toolbar visible of dmgWindow to true")
  ) {
    die(
      "NATIVE_PACKAGER_CLI is missing patches/native-sdk-modern-dmg-window.patch",
    );
  }

  return {
    env: {
      NATIVE_CLI: cliPath,
      NATIVE_SDK_PATH: sdkPath,
      NATIVE_PACKAGER_CLI: packagerCliPath,
      NATIVE_PACKAGER_SDK_PATH: packagerSdkPath,
    },
    sdkPath,
    sdkCommit,
    cliPath,
    cliCommit,
    packagerSdkPath,
    packagerSdkCommit,
    packagerCliPath,
    packagerCliCommit,
  };
}

function resolveAppleEnv(toolchain: NativeToolchain): Record<string, string> {
  // Resolve APPLE_API_KEY to absolute path. The notarytool requires
  // an absolute path; relative paths from the user's home shell
  // session won't survive the cwd change inside sign-macos.sh.
  const env: Record<string, string> = {};
  const key = process.env.APPLE_API_KEY;
  if (key) {
    const candidates = [
      path.isAbsolute(key) ? key : null,
      path.join(process.cwd(), key),
      path.join(homedir(), key.replace(/^~\//, "")),
      path.join(homedir(), "Downloads", path.basename(key)),
      path.join(homedir(), ".appleconnect", path.basename(key)),
    ].filter((p): p is string => !!p);
    const resolved = candidates.find((p) => existsSync(p));
    if (!resolved)
      die(`APPLE_API_KEY=${key} not found in any of: ${candidates.join(", ")}`);
    env.APPLE_API_KEY = resolved;
  }
  if (!process.env.APPLE_API_KEY_ID) die("APPLE_API_KEY_ID is required");
  if (!process.env.APPLE_API_ISSUER) die("APPLE_API_ISSUER is required");
  // SIGN_IDENTITY: if not provided, try to find the only Developer ID
  // Application identity in the keychain.
  if (!process.env.SIGN_IDENTITY) {
    const r = spawnSync(
      "security",
      ["find-identity", "-v", "-p", "codesigning"],
      {
        encoding: "utf8",
      },
    );
    const matches = (r.stdout || "")
      .split("\n")
      .filter((l) => l.includes("Developer ID Application"))
      .map((l) => l.match(/"([^"]+)"/)?.[1])
      .filter((s): s is string => !!s);
    if (matches.length === 1) {
      env.SIGN_IDENTITY = matches[0];
      console.log(`auto-detected SIGN_IDENTITY: ${matches[0]}`);
    } else if (matches.length === 0) {
      die(
        "SIGN_IDENTITY not set and no 'Developer ID Application' identity in keychain",
      );
    } else {
      die(
        `SIGN_IDENTITY not set and multiple Developer ID identities found: ${matches.join("; ")}. Set SIGN_IDENTITY explicitly.`,
      );
    }
  }
  Object.assign(env, toolchain.env);
  return env;
}

function preflightTag(version: string): string {
  const tag = `desktop-v${version}`;
  // Local tag check
  const local = run("git", ["tag", "-l", tag], { allowFail: true });
  if (local.stdout.trim() === tag)
    die(`local tag ${tag} already exists. Delete with: git tag -d ${tag}`);
  // Remote tag check
  const remote = run("git", ["ls-remote", "--tags", "origin", tag], {
    allowFail: true,
  });
  if (remote.stdout.includes(tag)) die(`remote tag ${tag} already exists`);
  // Existing GH release check
  const release = run(
    "gh",
    ["release", "view", tag, "--repo", "crafter-station/petdex"],
    { allowFail: true },
  );
  if (release.status === 0) die(`GH release ${tag} already exists`);
  return tag;
}

function preflightTree(): void {
  // Confirm the desktop sources we're about to ship are committed.
  // Build artifacts are outputs, not inputs. Check the native source,
  // manifest, and bundled assets specifically.
  const r = run(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "packages/petdex-desktop-native/src",
      "packages/petdex-desktop-native/app.zon",
      "packages/petdex-desktop-native/app.package.json",
      "packages/petdex-desktop-native/packaging",
      "patches/native-sdk-macos-headerpad.patch",
      "patches/native-sdk-macos-accessibility-element.patch",
      "patches/native-sdk-linux-popup-surface.patch",
      "patches/native-sdk-secondary-window-generation.patch",
      "patches/native-sdk-windows-canvas-drag.patch",
      "patches/native-sdk-modern-dmg-window.patch",
      "packages/petdex-desktop-native/assets",
      "scripts/patch-native-sdk.sh",
      "scripts/patch-native-packager.sh",
      "scripts/release-desktop.ts",
      "scripts/sign-macos.sh",
    ],
    { allowFail: true },
  );
  const dirty = r.stdout.trim();
  if (dirty) {
    console.warn("\n!!! Uncommitted changes in desktop sources:");
    console.warn(dirty);
    console.warn(
      "!!! Commit these before tagging or the release will ship from a state nobody can reproduce.\n",
    );
    if (!process.env.RELEASE_DESKTOP_ALLOW_DIRTY) {
      die("re-run with RELEASE_DESKTOP_ALLOW_DIRTY=1 to override");
    }
  }
}

function preflightDesktopVersion(version: string): void {
  const appZon = readFileSync(
    path.join(REPO_ROOT, "packages/petdex-desktop-native/app.zon"),
    "utf8",
  );
  const appZonVersion = appZon.match(/\.version\s*=\s*"([^"]+)"/)?.[1];
  const packageManifest = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "packages/petdex-desktop-native/app.package.json"),
      "utf8",
    ),
  ) as { version?: string };
  if (appZonVersion !== version || packageManifest.version !== version) {
    die(
      `desktop manifests must both declare ${version}; app.zon=${appZonVersion ?? "missing"}, app.package.json=${packageManifest.version ?? "missing"}`,
    );
  }
}

function preflightDetachDmgVolumes(): void {
  // hdiutil create fails with "Resource busy" when there's already a
  // /Volumes/Petdex* mount (from a previous build that didn't unmount
  // cleanly, or the user double-clicking the DMG to test the .app).
  // Hunter hit this on the v0.1.10 build: leftover "/Volumes/Petdex 1"
  // and "/Volumes/Petdex 10" from manual DMG opens blocked the new
  // build. Detach anything matching the Petdex volume pattern before
  // we touch hdiutil.
  step("Detach lingering Petdex DMG mounts");
  const r = spawnSync("mount", [], { encoding: "utf8" });
  if (r.status !== 0) {
    console.log(`  ! could not list mounts, skipping (mount exit ${r.status})`);
    return;
  }
  const mountPoints = (r.stdout || "")
    .split("\n")
    .map((line) => {
      // mount output: /dev/diskNsM on /Volumes/Petdex 1 (hfs, ...)
      const m = line.match(/ on (\/Volumes\/Petdex[^()]*?) \(/);
      return m ? m[1].trim() : null;
    })
    .filter((p): p is string => !!p);
  if (mountPoints.length === 0) {
    console.log("  ✓ no lingering Petdex mounts");
    return;
  }
  for (const mp of mountPoints) {
    console.log(`  • detaching ${mp}`);
    spawnSync("hdiutil", ["detach", "-quiet", mp], { encoding: "utf8" });
  }
}

function gitCommit(): string {
  const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) die(`invalid HEAD commit: ${commit}`);
  return commit;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeBuildManifest(version: string, toolchain: NativeToolchain): void {
  const artifacts: BuildManifest["artifacts"] = {};
  for (const name of RELEASE_ARTIFACT_NAMES) {
    const filePath = path.join(MACOS_OUT_DIR, name);
    if (!existsSync(filePath)) die(`cannot manifest missing artifact: ${name}`);
    artifacts[name] = {
      size: statSync(filePath).size,
      sha256: sha256(filePath),
    };
  }
  const manifest: BuildManifest = {
    format: 3,
    version,
    commit: gitCommit(),
    sdkCommit: toolchain.sdkCommit,
    cliCommit: toolchain.cliCommit,
    packagerSdkCommit: toolchain.packagerSdkCommit,
    packagerCliCommit: toolchain.packagerCliCommit,
    artifacts,
  };
  writeFileSync(BUILD_MANIFEST_PATH, `${JSON.stringify(manifest)}\n`, "utf8");
}

function buildRelease(
  env: Record<string, string>,
  version: string,
  toolchain: NativeToolchain,
): void {
  step("Build, sign, and notarize macOS arm64 + x64");
  mkdirSync(MACOS_OUT_DIR, { recursive: true });
  for (const arch of ["arm64", "x64"]) {
    run(
      "bash",
      [path.join(REPO_ROOT, "scripts", "sign-macos.sh"), MACOS_OUT_DIR, arch],
      {
        cwd: REPO_ROOT,
        env,
      },
    );
  }
  writeBuildManifest(version, toolchain);
}

function verifyArtifacts(
  version: string,
  toolchain: NativeToolchain,
): string[] {
  step("Verify artifacts");
  const missing: string[] = [];
  const present: string[] = [];
  for (const name of RELEASE_ARTIFACT_NAMES) {
    const p = path.join(MACOS_OUT_DIR, name);
    if (existsSync(p)) {
      present.push(p);
      console.log(`  ✓ ${name}`);
    } else {
      missing.push(name);
      console.error(`  ✗ ${name} MISSING`);
    }
  }
  if (missing.length > 0) {
    die(
      `missing artifacts: ${missing.join(", ")}. Re-run without --skip-build.`,
    );
  }

  if (!existsSync(BUILD_MANIFEST_PATH)) {
    die(
      "build manifest missing; run without --skip-build to create verified artifacts",
    );
  }
  let manifest: BuildManifest;
  try {
    manifest = JSON.parse(
      readFileSync(BUILD_MANIFEST_PATH, "utf8"),
    ) as BuildManifest;
  } catch {
    die("build manifest is not valid JSON");
  }
  if (
    manifest.format !== 3 ||
    manifest.version !== version ||
    manifest.sdkCommit !== toolchain.sdkCommit ||
    manifest.cliCommit !== toolchain.cliCommit ||
    manifest.packagerSdkCommit !== toolchain.packagerSdkCommit ||
    manifest.packagerCliCommit !== toolchain.packagerCliCommit
  ) {
    die(`build manifest does not match requested version ${version}`);
  }
  if (manifest.commit !== gitCommit()) {
    die(
      "build manifest was produced from a different commit; rebuild before release",
    );
  }
  for (const name of RELEASE_ARTIFACT_NAMES) {
    const record = manifest.artifacts?.[name];
    const filePath = path.join(MACOS_OUT_DIR, name);
    if (
      !record ||
      record.size !== statSync(filePath).size ||
      record.sha256 !== sha256(filePath)
    ) {
      die(
        `artifact changed after build or is not bound to the manifest: ${name}`,
      );
    }
  }
  console.log("  verified build manifest, commit, sizes, and SHA-256 hashes");
  return present;
}

function tagAndPush(version: string, tag: string): void {
  step(`Create + push tag ${tag}`);
  run("git", ["tag", "-a", tag, "-m", `petdex-desktop v${version}`]);
  run("git", ["push", "origin", tag]);
}

function ghRelease(
  tag: string,
  version: string,
  notes: string,
  assets: string[],
  draft: boolean,
  prerelease: boolean,
): void {
  step(`Create GH release ${tag} with ${assets.length} assets`);
  const ghArgs = [
    "release",
    "create",
    tag,
    ...assets,
    "--repo",
    "crafter-station/petdex",
    "--title",
    `petdex-desktop v${version}`,
    "--notes",
    notes,
  ];
  if (draft) ghArgs.push("--draft");
  if (prerelease) ghArgs.push("--prerelease");
  run("gh", ghArgs);
}

async function probeProduction(tag: string): Promise<void> {
  step("Probe https://petdex.dev/api/desktop/latest-release");
  // 5-minute SWR cache means the prod endpoint may serve stale for a
  // bit. We hit the GH API directly first to confirm the release is
  // live, then probe the proxy with a short retry.
  const ghUrl = `https://api.github.com/repos/crafter-station/petdex/releases/tags/${tag}`;
  const ghRes = await fetch(ghUrl);
  if (!ghRes.ok) {
    console.warn(
      `  ! GH API didn't have ${tag} yet (status ${ghRes.status}). Replication delay; check in a minute.`,
    );
    return;
  }
  console.log(`  ✓ GH API has ${tag}`);
  // Probe proxy — informational only, don't fail the run.
  for (let i = 0; i < 3; i++) {
    const r = await fetch("https://petdex.dev/api/desktop/latest-release", {
      redirect: "manual",
    });
    const loc = r.headers.get("location") ?? "";
    if (loc.includes(tag)) {
      console.log(`  ✓ proxy resolved to ${loc}`);
      return;
    }
    if (i < 2) {
      console.log(
        `  ... proxy still serving ${loc || "no redirect"}, retrying in 30s`,
      );
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  console.warn(
    `  ! proxy hasn't picked up ${tag} after 60s. SWR cache will refresh soon.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`release-desktop: cutting v${args.version}`);
  if (args.draft) console.log("  mode: DRAFT (will not publish)");

  preflightTree();
  preflightDesktopVersion(args.version);
  const tag = preflightTag(args.version);
  const toolchain = resolveNativeToolchain();

  if (!args.skipBuild) {
    const env = resolveAppleEnv(toolchain);
    preflightDetachDmgVolumes();
    buildRelease(env, args.version, toolchain);
  } else {
    console.log("\n--skip-build: skipping zig build + notarize");
  }
  const assets = verifyArtifacts(args.version, toolchain);

  tagAndPush(args.version, tag);
  ghRelease(tag, args.version, args.notes, assets, args.draft, args.prerelease);

  if (!args.draft) {
    await probeProduction(tag);
  }

  console.log(`\n✓ Released ${tag}`);
  console.log(
    `  https://github.com/crafter-station/petdex/releases/tag/${tag}`,
  );
  console.log(`  https://petdex.dev/download`);
}

main().catch((err) => {
  console.error("release-desktop: fatal:", err);
  process.exit(1);
});

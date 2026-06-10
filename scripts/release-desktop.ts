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
//   ZERO_NATIVE_PATH      path to zero-native checkout (defaults: ../railly/zero-native)
//
// What it does:
//   1. Validate version arg (semver, no leading 'v') + ensure tag doesn't exist
//   2. Verify clean working tree on packages/petdex-desktop/ paths
//   3. Build sidecar bundle (server.ts -> server.js, CJS minified)
//   4. Run scripts/build-release.sh (zig build + sign + notarize for arm64+x64)
//   5. Verify all 5 artifacts exist
//   6. Create annotated tag desktop-vX.Y.Z, push to origin
//   7. gh release create with notes + 5 assets
//   8. Verify /api/desktop/latest-release picks it up (probe production)
//
// All steps are idempotent on retry except the tag push and gh release create.
// On failure mid-flight, fix the underlying issue and re-run with --skip-build
// to skip the slow notarization step if artifacts are already on disk.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const DESKTOP_DIR = path.join(REPO_ROOT, "packages", "petdex-desktop");
const SIDECAR_DIR = path.join(DESKTOP_DIR, "sidecar");

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

function resolveAppleEnv(): Record<string, string> {
  // Resolve APPLE_API_KEY to absolute path. The notarytool requires
  // an absolute path; relative paths from the user's home shell
  // session won't survive the cwd change inside build-release.sh.
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
  // ZERO_NATIVE_PATH default — sibling layout is the dev convention.
  if (!process.env.ZERO_NATIVE_PATH) {
    const guesses = [
      path.join(homedir(), "Programming", "railly", "zero-native"),
      path.resolve(REPO_ROOT, "..", "..", "..", "railly", "zero-native"),
    ];
    const found = guesses.find((p) => existsSync(p));
    if (found) {
      env.ZERO_NATIVE_PATH = found;
      console.log(`auto-detected ZERO_NATIVE_PATH: ${found}`);
    } else {
      die(
        `ZERO_NATIVE_PATH not set and no checkout found in ${guesses.join(", ")}`,
      );
    }
  }
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
  // build artifacts (DMGs, bare binaries) and sidecar/server.js are
  // OK to be uncommitted — those are outputs, not inputs. We check
  // src/, sidecar/server.ts, build.zig, and assets/ specifically.
  const r = run(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "packages/petdex-desktop/src",
      "packages/petdex-desktop/sidecar/server.ts",
      "packages/petdex-desktop/sidecar/state-queue.ts",
      "packages/petdex-desktop/sidecar/running-variant.ts",
      "packages/petdex-desktop/build.zig",
      "packages/petdex-desktop/assets",
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

function buildSidecar(): void {
  step("Build sidecar bundle (server.ts -> server.js, CJS minified)");
  run("bun", ["run", "build"], { cwd: SIDECAR_DIR });
  if (!existsSync(path.join(SIDECAR_DIR, "server.js"))) {
    die("sidecar build did not produce server.js");
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

function buildRelease(env: Record<string, string>): void {
  step("Build, sign, notarize for arm64 + x64 (this takes 5-10 min)");
  run("bash", [path.join("scripts", "build-release.sh")], {
    cwd: DESKTOP_DIR,
    env,
  });
}

function verifyArtifacts(): string[] {
  step("Verify artifacts");
  const required = [
    "Petdex-arm64.dmg",
    "Petdex-x64.dmg",
    "petdex-desktop-darwin-arm64",
    "petdex-desktop-darwin-x64",
  ];
  const missing: string[] = [];
  const present: string[] = [];
  for (const name of required) {
    const p = path.join(DESKTOP_DIR, name);
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
  // Sidecar lives at sidecar/server.js but uploads as petdex-desktop-sidecar.js.
  const sidecarSrc = path.join(SIDECAR_DIR, "server.js");
  if (!existsSync(sidecarSrc)) die(`sidecar bundle missing at ${sidecarSrc}`);
  const sidecarUploadName = path.join(DESKTOP_DIR, "petdex-desktop-sidecar.js");
  // Copy via cp so we don't overwrite the source if the build doesn't
  // produce this filename directly.
  run("cp", [sidecarSrc, sidecarUploadName]);
  present.push(sidecarUploadName);
  console.log(`  ✓ petdex-desktop-sidecar.js (copied from sidecar/server.js)`);
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
  const tag = preflightTag(args.version);
  const env = resolveAppleEnv();

  buildSidecar();
  if (!args.skipBuild) {
    preflightDetachDmgVolumes();
    buildRelease(env);
  } else {
    console.log("\n--skip-build: skipping zig build + notarize");
  }
  const assets = verifyArtifacts();

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

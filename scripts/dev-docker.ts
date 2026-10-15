// Boots the docker-backed dev path:
//   1. Detect docker compose vs podman compose
//   2. Bring up the local Postgres + Redis (+ srh) stack
//   3. Wait for Postgres to accept connections
//   4. Push the drizzle schema (no migrations folder hassle)
//   5. Seed ~20 approved pets so the gallery isn't empty
//   6. Hand off to next dev (turbopack, since there's no PGlite to break it)
//
// Usage:
//   bun run dev:docker
//
// .env.dev is the shared committed defaults. If .env.local has Clerk
// credentials, we lift only the Clerk key pair into the dev overlay so
// production DATABASE_URL/R2/etc. values can't leak into the
// docker-backed path. .env.dev.local can still override other dev-only
// settings and is created automatically on first docker boot. If no Clerk
// secret is available, this script falls back to mock auth while keeping
// the docker database and Redis.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Engine = {
  cmd: string;
  args: string[];
  label: string;
  diagnostics: string[];
};

type CommandCheck = {
  ok: boolean;
  missing: boolean;
  output: string;
  status: number;
};

type EngineFailure = {
  engine: Engine;
  result: CommandCheck;
};

function checkCommand(cmd: string, args: string[]): CommandCheck {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  return {
    ok: r.status === 0,
    missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
    output,
    status: r.status ?? 1,
  };
}

function checkEngineReady(engine: Engine, composeArgs: string[]): CommandCheck {
  return checkCommand(engine.cmd, [...engine.args, ...composeArgs, "ps"]);
}

function startHintFor(engine: Engine): string {
  return engine.cmd === "podman"
    ? "If you use Podman on macOS, start its VM first:\n" +
        "  podman machine start\n\n" +
        "If this is your first Podman setup, initialize it once, then start it:\n" +
        "  podman machine init\n" +
        "  podman machine start\n\n"
    : "Start Docker Desktop or OrbStack, then wait until Docker reports it is running.\n\n";
}

function failEngineReady(engine: Engine, r: CommandCheck): never {
  console.error(
    `[dev:docker] ${engine.label} is installed but cannot connect to a running container service.`,
  );
  if (r.output) console.error(`\n${r.output}\n`);
  if (engine.diagnostics.length > 0) {
    console.error(
      `[dev:docker] earlier engine probes also failed:\n${engine.diagnostics.join("\n\n")}\n`,
    );
  }
  console.error(
    `${startHintFor(engine)}After that, rerun:\n  bun run dev:docker`,
  );
  process.exit(r.status ?? 1);
}

function failNoReadyEngine(failures: EngineFailure[]): never {
  console.error(
    "[dev:docker] container engines are installed but none can connect to a running container service.",
  );
  for (const { engine, result } of failures) {
    console.error(`\n[dev:docker] ${engine.label} failed:`);
    if (result.output) console.error(result.output);
  }
  console.error(
    "\nDocker: start Docker Desktop or OrbStack, then wait until Docker reports it is running.\n\n" +
      "Podman: start its VM with:\n" +
      "  podman machine start\n\n" +
      "After that, rerun:\n" +
      "  bun run dev:docker",
  );
  process.exit(failures[0]?.result.status ?? 1);
}

function detectEngine(composeArgs: string[]): Engine {
  // Prefer docker, fall back to podman. Both expose the same compose v2
  // subcommand surface for our use case. A CLI with a stopped daemon does
  // not count as ready; keep probing so Podman can rescue a stopped Docker.
  const diagnostics: string[] = [];
  const failures: EngineFailure[] = [];
  for (const cmd of ["docker", "podman"]) {
    const r = checkCommand(cmd, ["compose", "version"]);
    if (r.ok) {
      const engine = {
        cmd,
        args: ["compose"],
        label: `${cmd} compose`,
        diagnostics: [...diagnostics],
      };
      const ready = checkEngineReady(engine, composeArgs);
      if (ready.ok) return engine;
      failures.push({ engine, result: ready });
      diagnostics.push(`${engine.label} ps failed:\n${ready.output}`);
      continue;
    }
    if (!r.missing) {
      diagnostics.push(`${cmd} compose version failed:\n${r.output}`);
    }
  }
  // Some users only have docker-compose v1 (still common on Linux).
  const v1 = checkCommand("docker-compose", ["version"]);
  if (v1.ok) {
    const engine = {
      cmd: "docker-compose",
      args: [],
      label: "docker-compose",
      diagnostics: [...diagnostics],
    };
    const ready = checkEngineReady(engine, composeArgs);
    if (ready.ok) return engine;
    failures.push({ engine, result: ready });
    diagnostics.push(`${engine.label} ps failed:\n${ready.output}`);
  }
  if (!v1.missing) {
    diagnostics.push(`docker-compose version failed:\n${v1.output}`);
  }
  if (failures.length === 1) {
    failEngineReady(failures[0].engine, failures[0].result);
  }
  if (failures.length > 1) {
    failNoReadyEngine(failures);
  }
  console.error(
    "[dev:docker] no container engine found.\n" +
      "  Install Docker Desktop, OrbStack, or Podman, then rerun:\n" +
      "    https://docs.docker.com/get-docker/  (Docker)\n" +
      "    https://orbstack.dev                  (Mac, lightweight Docker drop-in)\n" +
      "    https://podman.io/docs/installation   (Podman)\n",
  );
  process.exit(1);
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function ensureDevLocalFile(path: string) {
  if (existsSync(path)) return false;
  const lines = [
    "# Local overrides for `bun run dev:docker`.",
    "# This file is ignored by git and is safe for personal dev values.",
    "",
    "# Optional: Clerk user id to receive seeded personal pets on docker boot.",
    "# Use the Clerk Dashboard User ID, not the username/handle.",
    "PETDEX_DEV_SEED_USER_ID=",
    "",
  ];
  writeFileSync(path, lines.join("\n"));
  return true;
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function pickClerkEnv(
  envDev: Record<string, string>,
  envDevLocal: Record<string, string>,
  envLocal: Record<string, string>,
): {
  publishableKey?: string;
  secretKey?: string;
  source: "env.local" | "process.env" | "env.dev.local" | "env.dev";
} {
  if (firstNonEmpty(process.env.CLERK_SECRET_KEY)) {
    return {
      publishableKey: firstNonEmpty(
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
        envDev.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      ),
      secretKey: process.env.CLERK_SECRET_KEY,
      source: "process.env",
    };
  }
  if (firstNonEmpty(envLocal.CLERK_SECRET_KEY)) {
    return {
      publishableKey: firstNonEmpty(
        envLocal.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
        envDev.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      ),
      secretKey: envLocal.CLERK_SECRET_KEY,
      source: "env.local",
    };
  }
  if (firstNonEmpty(envDevLocal.CLERK_SECRET_KEY)) {
    return {
      publishableKey: firstNonEmpty(
        envDevLocal.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
        envDev.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      ),
      secretKey: envDevLocal.CLERK_SECRET_KEY,
      source: "env.dev.local",
    };
  }
  return {
    publishableKey: envDev.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    source: "env.dev",
  };
}

function compose(engine: Engine, ...rest: string[]): number {
  const r = spawnSync(engine.cmd, [...engine.args, ...rest], {
    stdio: "inherit",
  });
  return r.status ?? 1;
}

async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync("nc", ["-z", "127.0.0.1", "54320"], {
      stdio: "ignore",
    });
    if (r.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Postgres did not become reachable on 127.0.0.1:54320");
}

async function main() {
  const root = process.cwd();
  const envDevLocalPath = join(root, ".env.dev.local");
  if (ensureDevLocalFile(envDevLocalPath)) {
    console.log(
      "[dev:docker] created .env.dev.local; set PETDEX_DEV_SEED_USER_ID there to seed your profile",
    );
  }

  const composeArgs = ["-f", "docker-compose.dev.yml"];
  const engine = detectEngine(composeArgs);
  const engineCommand = [engine.cmd, ...engine.args].join(" ");
  console.log(`[dev:docker] using ${engineCommand} for compose`);

  // Next loads env files in this order (dev, highest priority first):
  //   .env.development.local   <- we own this one
  //   .env.local               <- the maintainer's personal file
  //   .env.development
  //   .env
  // Anything in .env.development.local wins, which lets us override
  // the maintainer's `.env.local` (usually pointed at production)
  // without touching it. We rewrite this file on every dev:docker
  // launch and remove it on clean exit.
  const overlayPath = join(root, ".env.development.local");

  const envDev = loadEnvFile(join(root, ".env.dev"));
  const envLocal = loadEnvFile(join(root, ".env.local"));
  const envDevLocal = loadEnvFile(envDevLocalPath);
  const merged = { ...envDev, ...envDevLocal };
  const clerkEnv = pickClerkEnv(envDev, envDevLocal, envLocal);
  const publishableKey = firstNonEmpty(clerkEnv.publishableKey);
  if (publishableKey) {
    merged.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = publishableKey;
  }
  const secretKey = firstNonEmpty(clerkEnv.secretKey);
  if (secretKey) {
    merged.CLERK_SECRET_KEY = secretKey;
  }
  const seedUserId = firstNonEmpty(
    envDevLocal.PETDEX_DEV_SEED_USER_ID,
    envLocal.PETDEX_DEV_SEED_USER_ID,
  );
  if (seedUserId) {
    merged.PETDEX_DEV_SEED_USER_ID = seedUserId;
  }
  const useMockAuth = !firstNonEmpty(merged.CLERK_SECRET_KEY);
  merged.PETDEX_MOCK_AUTH = useMockAuth ? "1" : "";
  if (useMockAuth) {
    console.log(
      "[dev:docker] CLERK_SECRET_KEY not set; using mock auth with docker Postgres/Redis",
    );
  } else {
    console.log(`[dev:docker] using Clerk credentials from ${clerkEnv.source}`);
  }

  const lines = [
    "# Auto-generated by `bun run dev:docker`. Do not edit by hand.",
    "# Source: .env.dev + .env.dev.local, with Clerk key pair override from .env.local.",
    "# Removed on clean exit; safe to delete by hand if it sticks around.",
    "",
    ...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(overlayPath, `${lines.join("\n")}\n`);
  console.log("[dev:docker] wrote .env.development.local (Next overlay)");

  const cleanupOverlay = () => {
    try {
      if (existsSync(overlayPath)) unlinkSync(overlayPath);
    } catch {
      /* best effort */
    }
  };
  process.on("exit", cleanupOverlay);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanupOverlay();
      process.exit(0);
    });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...merged,
    // Full mock mode and the docker path are mutually exclusive. Auth-only
    // mock stays controlled by PETDEX_MOCK_AUTH above.
    PETDEX_MOCK: "",
    PETDEX_MOCK_AUTH: useMockAuth ? "1" : "",
  };

  console.log("[dev:docker] bringing up postgres + redis");
  const upStatus = compose(engine, ...composeArgs, "up", "-d");
  if (upStatus !== 0) {
    console.error("[dev:docker] compose up failed");
    process.exit(upStatus);
  }

  console.log("[dev:docker] waiting for postgres on 127.0.0.1:54320");
  try {
    await waitForPostgres();
  } catch (err) {
    console.error(`[dev:docker] ${(err as Error).message}`);
    process.exit(1);
  }

  console.log("[dev:docker] pushing schema with drizzle-kit");
  const push = spawnSync("bun", ["x", "drizzle-kit", "push", "--force"], {
    stdio: "inherit",
    env,
  });
  if (push.status !== 0) {
    console.error("[dev:docker] drizzle-kit push failed");
    process.exit(push.status ?? 1);
  }

  console.log("[dev:docker] seeding ~20 approved pets");
  const seed = spawnSync(
    "bun",
    ["--conditions", "react-server", "scripts/seed-dev.ts"],
    { stdio: "inherit", env },
  );
  if (seed.status !== 0) {
    console.error("[dev:docker] seed failed");
    process.exit(seed.status ?? 1);
  }

  console.log("[dev:docker] starting next dev (turbopack)");
  const child = spawn("bun", ["x", "next", "dev", ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
  });

  // Forward signals to the child and remove the generated Next overlay.
  // Containers stay up by default — they're cheap and the next dev:docker
  // boot is faster.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }

  child.on("exit", (code) => {
    cleanupOverlay();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

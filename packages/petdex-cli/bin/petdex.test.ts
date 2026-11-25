import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function runCli(...args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/petdex.ts`, ...args],
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * Run with an isolated HOME so ~/.petdex/telemetry.json does not exist yet.
 * That is the only state in which the first-run notice prints, and the notice
 * is exactly what a --json caller must not receive on stdout.
 */
function runCliWithFreshHome(...args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const home = mkdtempSync(path.join(tmpdir(), "petdex-cli-test-"));
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/petdex.ts`, ...args],
      env: { ...process.env, NO_COLOR: "1", HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function normalizeCommand(output: string, command: string): string {
  return output.replace(`petdex ${command}`, "petdex <command>");
}

describe("retired command aliases", () => {
  test.each([
    ["start", "up"],
    ["restart", "up"],
    ["stop", "down"],
  ])("%s shows the same redirect as %s", (alias, canonical) => {
    const actual = runCli(alias);
    const expected = runCli(canonical);

    expect(actual.exitCode).toBe(0);
    expect(actual.stderr).not.toContain("Unknown command");
    expect(normalizeCommand(actual.stderr, alias)).toBe(
      normalizeCommand(expected.stderr, canonical),
    );
  });

  test("select points legacy users to the desktop app", () => {
    const result = runCli("select");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.stderr).toContain("desktop app");
  });
});

describe("submit --license", () => {
  // main() used to run before LICENSE_CHOICES was initialized, so every
  // `petdex submit` crashed on startup, before any auth or network call.
  test("rejects an unknown license id and lists the valid ones", () => {
    const result = runCli("submit", "./some-pet", "--license", "bogus");
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).not.toContain("Cannot read properties of undefined");
    expect(output).not.toContain("before initialization");
    expect(output).toContain("Unknown --license bogus");
    expect(output).toContain("cc0");
    expect(output).toContain("all-rights-reserved");
  });
});

describe("collection --json error output", () => {
  // A failing request used to throw out of cmdCollection into main().catch(),
  // which prints through clack to stdout — the stream a --json caller parses.
  // The failure must reach stderr so stdout stays valid JSON (or empty).
  test("reports an unknown collection action on stderr, not stdout", () => {
    const result = runCli("collection", "bogus-action", "--json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: petdex collection");
    expect(result.stdout.trim()).toBe("");
  });

  test("keeps stdout empty when delete is missing --yes in json mode", () => {
    const result = runCli("collection", "delete", "c1", "--json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Deletion requires --yes.");
    expect(result.stdout.trim()).toBe("");
  });

  test("keeps the first-run notice off stdout for --json and --json=true", () => {
    // A fresh HOME is the only state where the notice prints. Reading the raw
    // args at the entrypoint would let `--json=true` slip past the
    // suppression and put the notice on the stream a caller is parsing.
    for (const flag of ["--json", "--json=true"]) {
      const result = runCliWithFreshHome("collection", "bogus-action", flag);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Usage: petdex collection");
      expect(result.stdout).not.toContain(
        "petdex collects anonymous usage stats",
      );
      expect(result.stdout.trim()).toBe("");
    }
  });
});

/**
 * The no-terminal paths of `submit`, spawned for real.
 *
 * `cmdSubmit` asks for a license, the duplicate decision and the batch
 * confirmation through clack. With stdin at EOF those prompts never settle:
 * the CLI used to drain the event loop and exit 0 having submitted nothing.
 * Each of them must instead fail fast, name the flag that avoids the prompt,
 * and send no submission.
 */
describe("submit without a terminal", () => {
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGP4z8DwHwwZ/v8HIwYQ6////wCgeQ3zoUQgUwAAAABJRU5ErkJggg==",
    "base64",
  );

  /** A pet folder `collectCandidates` accepts. */
  function writePet(folder: string, id: string): void {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "pet.json"), JSON.stringify({ id }));
    writeFileSync(path.join(folder, "spritesheet.png"), TINY_PNG);
  }

  /**
   * A HOME that already holds a live session in the CLI's file fallback.
   * The keychain cannot be reached under a redirected HOME, so the store
   * reads this file — exactly the environment the no-terminal cases run in.
   */
  function seedSession(home: string): void {
    const dir = path.join(home, ".config", "clerk-cli-auth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "default.json"),
      JSON.stringify({
        tokens: JSON.stringify({
          accessToken: "tok-test",
          expiresAt: Date.now() + 3_600_000,
        }),
        user: JSON.stringify({
          sub: "user_test",
          email: "tester@example.test",
        }),
      }),
    );
  }

  /** A local Petdex that answers the dedup lookup and records any submit. */
  function startStub(existing: Array<{ slug: string; status: string }>) {
    const submissions: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/cli/submit/check") {
          return Response.json({ existing });
        }
        if (url.pathname.startsWith("/api/cli/submit")) {
          submissions.push(`${request.method} ${url.pathname}`);
          return new Response("unexpected submit", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return {
      origin: `http://127.0.0.1:${server.port}`,
      submissions,
      stop: () => server.stop(true),
    };
  }

  async function runSubmitNoTty(options: {
    args: string[];
    env: Record<string, string>;
  }): Promise<{ exitCode: number | null; output: string }> {
    // Async on purpose: the stub server runs in this process, so a
    // synchronous spawn would block the event loop and its requests would
    // never be answered. The kill timer is the anti-hang assertion — a
    // prompt that never settles must not end with the expected exit code.
    const child = Bun.spawn({
      cmd: [process.execPath, `${import.meta.dir}/petdex.ts`, ...options.args],
      env: {
        ...process.env,
        NO_COLOR: "1",
        PETDEX_TELEMETRY: "0",
        ...options.env,
      },
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return {
      exitCode: child.exitCode,
      output: stdout + stderr,
    };
  }

  test("a missing --license fails instead of waiting on a prompt", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "petdex-notty-"));
    try {
      const pet = path.join(home, "pet");
      writePet(pet, "license-pet");
      const result = await runSubmitNoTty({
        args: ["submit", pet],
        env: { HOME: home },
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("needs --license");
      expect(result.output).toContain("--license <id>");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("duplicates with no terminal name --force and send nothing", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "petdex-notty-"));
    const stub = startStub([{ slug: "dup-pet", status: "approved" }]);
    try {
      seedSession(home);
      const pet = path.join(home, "dup-pet");
      writePet(pet, "dup-pet");
      const result = await runSubmitNoTty({
        args: ["submit", pet, "--license=cc0"],
        env: {
          HOME: home,
          PETDEX_URL: stub.origin,
          CLERK_ISSUER: stub.origin,
          CLERK_OAUTH_CLIENT_ID: "client-test",
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("already submitted");
      expect(result.output).toContain("--force");
      // The duplicate decision was never answered, so nothing was uploaded.
      expect(stub.submissions).toEqual([]);
    } finally {
      stub.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a batch with no terminal points at single submissions and sends nothing", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "petdex-notty-"));
    const stub = startStub([]);
    try {
      seedSession(home);
      const parent = path.join(home, "pets");
      writePet(path.join(parent, "pet-one"), "pet-one");
      writePet(path.join(parent, "pet-two"), "pet-two");
      const result = await runSubmitNoTty({
        args: ["submit", parent, "--license=cc0"],
        env: {
          HOME: home,
          PETDEX_URL: stub.origin,
          CLERK_ISSUER: stub.origin,
          CLERK_OAUTH_CLIENT_ID: "client-test",
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("one pet at a time");
      expect(stub.submissions).toEqual([]);
    } finally {
      stub.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * `submit` resolves its bearer again after the interactive prompts.
 *
 * The prompts are clack's, and the batch loop talks to the network — a
 * spawned CLI cannot drive either. So each scenario runs in a child `bun
 * test` process whose module registry is its own: the auth class, the auth
 * config and clack are stubbed there, `fetch` answers a local script, and the
 * child prints what was actually sent. Nothing is mocked in this process.
 */
describe("submit token resolution", () => {
  const ROOT = path.resolve(import.meta.dir, "..");
  const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGP4z8DwHwwZ/v8HIwYQ6////wCgeQ3zoUQgUwAAAABJRU5ErkJggg==";

  /**
   * Run one scenario in a child test process and return the JSON it printed.
   *
   * `promptChoice` is what the duplicate prompt answers; `afterPrompt` is the
   * token that becomes available once it does (modelling an access token that
   * lived out its life while the prompt sat open).
   */
  async function runScenario(options: {
    pets: string[];
    duplicateSlugs: string[];
    promptChoice: string;
    tokens: Array<string | null>;
    /** Submit the folder holding every pet instead of the first one. */
    useParent?: boolean;
  }): Promise<{
    resolutions: number;
    sent: string[];
    presigns: number;
    notes: string[];
    exits: number[];
  }> {
    const directory = mkdtempSync(path.join(tmpdir(), "petdex-submit-token-"));
    try {
      for (const id of options.pets) {
        const folder = path.join(directory, id);
        mkdirSync(folder, { recursive: true });
        writeFileSync(
          path.join(folder, "pet.json"),
          JSON.stringify({ id, displayName: id }),
        );
        writeFileSync(
          path.join(folder, "spritesheet.png"),
          Buffer.from(TINY_PNG, "base64"),
        );
      }
      const target = options.useParent
        ? directory
        : path.join(directory, options.pets[0]);
      const childPath = path.join(directory, "submit-token.test.ts");
      writeFileSync(
        childPath,
        `
import { expect, mock, test } from "bun:test";

const ROOT = ${JSON.stringify(ROOT)};
const TARGET = ${JSON.stringify(target)};
const TOKENS = ${JSON.stringify(options.tokens)};
const DUPLICATES = ${JSON.stringify(options.duplicateSlugs)};
const PROMPT_CHOICE = ${JSON.stringify(options.promptChoice)};

let resolutions = 0;
const sent: string[] = [];
const notes: string[] = [];
let presigns = 0;

mock.module(ROOT + "/src/cli-auth/index.js", () => ({
  ClerkCliAuth: class {
    async getAccessToken() {
      const token = TOKENS[Math.min(resolutions, TOKENS.length - 1)];
      resolutions++;
      return token ?? null;
    }
    async whoami() {
      return { sub: "user", email: "u@example.test" };
    }
  },
}));
mock.module(ROOT + "/src/auth-config.js", () => ({
  resolveAuthConfig: async () => ({ clientId: "c", issuer: "https://clerk.test" }),
}));
mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: (value) => notes.push(String(value)),
  note: (value) => notes.push(String(value)),
  cancel: (value) => notes.push(String(value)),
  isCancel: () => false,
  spinner: () => ({ start: () => {}, stop: () => {} }),
  select: async () => PROMPT_CHOICE,
  confirm: async () => true,
}));

globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.endsWith("/api/cli/submit/check")) {
    return Response.json({
      existing: DUPLICATES.map((slug) => ({ slug, status: "approved" })),
    });
  }
  if (url.endsWith("/api/cli/submit")) {
    presigns++;
    sent.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response("expired", { status: 401 });
  }
  return new Response("unused", { status: 500 });
});

process.argv = ["bun", ROOT + "/bin/petdex.ts", "submit", TARGET, "--license=cc0"];
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
process.env.PETDEX_TELEMETRY = "0";
// The command ends with process.exit(1) when a submission failed. Record
// the code instead of ending the child, so the scenario can be asserted.
const exits: number[] = [];
process.exit = ((code?: number) => {
  exits.push(code ?? 0);
  return undefined as never;
}) as typeof process.exit;

test("submit scenario", async () => {
  await import(ROOT + "/bin/petdex.ts");
  for (let i = 0; i < 300 && sent.length === 0 && notes.length === 0; i++) {
    await Bun.sleep(10);
  }
  await Bun.sleep(100);
  console.log(
    "SUBMIT-RESULT " +
      JSON.stringify({ resolutions, sent, presigns, notes, exits }),
  );
  expect(sent.length).toBeGreaterThan(0);
});
`,
      );

      const child = Bun.spawn({
        cmd: [process.execPath, "test", childPath, "--timeout", "30000"],
        cwd: ROOT,
        env: { ...process.env, NO_COLOR: "1", HOME: directory },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(timer);
      // On failure the child's own output is the only explanation there is.
      expect(child.exitCode, `${stdout}\n${stderr}`).toBe(0);
      const line = stdout
        .split("\n")
        .find((entry) => entry.startsWith("SUBMIT-RESULT "));
      expect(line).toBeDefined();
      return JSON.parse((line as string).slice("SUBMIT-RESULT ".length));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test("the batch re-resolves after the duplicate prompt before the first upload", async () => {
    // The token resolved before the prompts is what the dedup lookup used.
    // The duplicate decision can sit open past its lifetime, so the presign
    // must use a token resolved *after* the prompt — not the stale one.
    const result = await runScenario({
      pets: ["pet"],
      duplicateSlugs: ["pet"],
      promptChoice: "resubmit",
      tokens: ["initial-token", "fresh-token"],
    });

    expect(result.sent).toEqual(["Bearer fresh-token"]);
    expect(result.resolutions).toBeGreaterThanOrEqual(2);
  });

  test("an auth failure mid-batch stops the rest and reports once", async () => {
    // The server refused the bearer and the store cannot produce a new one.
    // Repeating that per pet is noise: the batch stops, and the pets after it
    // are reported once as "not attempted", not as failures.
    const result = await runScenario({
      pets: ["pet-one", "pet-two"],
      duplicateSlugs: [],
      promptChoice: "skip",
      tokens: ["tok-1", "tok-1", null],
      useParent: true,
    });

    // Only the first pet was ever presigned.
    expect(result.presigns).toBe(1);
    expect(result.sent).toEqual(["Bearer tok-1"]);
    expect(result.notes.join("\n")).toContain("not attempted");
  });
});

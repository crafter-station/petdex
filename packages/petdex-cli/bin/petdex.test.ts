import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startFakeClerk } from "../test/local-env/fake-clerk";

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
    // are reported once as "not attempted", not as failures. The pet whose
    // presign was actually refused is a failure of its own — calling it "not
    // attempted" would undercount what happened.
    const result = await runScenario({
      pets: ["pet-one", "pet-two"],
      duplicateSlugs: [],
      promptChoice: "skip",
      tokens: ["tok-1", "tok-2", null],
      useParent: true,
    });

    // Only the first pet was ever presigned.
    expect(result.presigns).toBe(1);
    expect(result.sent).toEqual(["Bearer tok-2"]);
    const notes = result.notes.join("\n");
    expect(notes).toContain("pet-one");
    // One pet was attempted (and failed); exactly one was left unsent.
    expect(notes).toContain("1 not attempted");
    expect(notes).not.toContain("2 not attempted");
  });

  test("a retry refused with a fresh token stops the batch too", async () => {
    // The first 401 triggered a re-resolve and the store produced a *new*
    // token — but the server refused that one as well. The session itself is
    // unusable, so every remaining pet would spend one presign to learn the
    // same thing. One retry, then the rest is reported once as not attempted
    // instead of as N raw 401 failures.
    const result = await runScenario({
      pets: ["pet-one", "pet-two"],
      duplicateSlugs: [],
      promptChoice: "skip",
      tokens: ["tok-1", "tok-2", "tok-3"],
      useParent: true,
    });

    // The first pet only: one refused presign, one retry, and nothing after.
    // (`tok-1` was spent before the prompts; the batch resolves again after
    // them, so its first presign already carries `tok-2`.)
    expect(result.sent).toEqual(["Bearer tok-2", "Bearer tok-3"]);
    expect(result.presigns).toBe(2);
    // The second pet was never sent.
    expect(result.notes.join("\n")).toContain("not attempted");
    expect(result.notes.join("\n")).toContain(
      "rejected again after refreshing",
    );
  });

  test("a one-pet batch stopped by the retried refusal has no '0 not attempted' line", async () => {
    // The aborting pet is already in the failure list with its own cause.
    // There is nothing left over, and a line labelled "0 not attempted"
    // contradicts the failure above it — in a script it reads as an extra
    // failed item.
    const result = await runScenario({
      pets: ["only-pet"],
      duplicateSlugs: [],
      promptChoice: "skip",
      tokens: ["tok-1", "tok-2", "tok-3"],
    });

    const notes = result.notes.join("\n");
    expect(notes).toContain("rejected again after refreshing");
    expect(notes).not.toContain("not attempted");
    expect(notes).not.toContain("0 not attempted");
  });

  test("a store that keeps handing back the refused bearer stops the batch", async () => {
    // The re-resolve answered with the very token the server just refused.
    // The session exists but this bearer is not accepted, so no later pet can
    // fix it: each one would spend a presign to learn the same refusal.
    const result = await runScenario({
      pets: ["pet-one", "pet-two"],
      duplicateSlugs: [],
      promptChoice: "skip",
      tokens: ["tok-1", "tok-1", "tok-1", "tok-1"],
      useParent: true,
    });

    // The first pet only.
    expect(result.presigns).toBe(1);
    const notes = result.notes.join("\n");
    expect(notes).toContain("stored session did not change");
    expect(notes).toContain("1 not attempted");
    expect(notes).not.toContain("2 not attempted");
  });
});

/**
 * `whoami` renders claims the provider never promised to type.
 *
 * `parseStoredProfile` and `fetchUserInfo` both require `sub` to be a
 * non-empty string, so that line is printed as-is. Everything else is
 * whatever the userinfo answer carried — the shape rule deliberately does
 * not inspect `email` — so the panel formats those claims itself. Reading
 * an object claim with string interpolation printed `[object Object]`, a
 * boolean printed `true`, and `""` or `[]` printed a blank line that reads
 * like a label whose value went missing. `--` is the panel's own answer for
 * "not set", and it is the same answer the sibling `name`/`username` lines
 * give for the same values.
 *
 * The claim reaches the CLI through the store, so each value is seeded as a
 * real saved profile in a redirected HOME and rendered by the real command
 * with the real clack note. No module is mocked here.
 */
describe("whoami profile panel", () => {
  const ROOT = path.resolve(import.meta.dir, "..");

  /**
   * Run the real `whoami` against a saved profile.
   *
   * The CLI's file store is used because the keychain is unreachable under a
   * redirected HOME; the seeded token is live, so `whoami` answers from the
   * cached profile without a network call.
   */
  async function renderProfile(
    profile: Record<string, unknown>,
  ): Promise<string> {
    const home = mkdtempSync(path.join(tmpdir(), "petdex-whoami-"));
    try {
      const dir = path.join(home, ".config", "clerk-cli-auth");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "default.json"),
        JSON.stringify({
          tokens: JSON.stringify({
            accessToken: "tok-test",
            expiresAt: Date.now() + 3_600_000,
          }),
          user: JSON.stringify(profile),
        }),
      );
      const child = Bun.spawn({
        cmd: [process.execPath, `${ROOT}/bin/petdex.ts`, "whoami"],
        env: {
          ...process.env,
          NO_COLOR: "1",
          HOME: home,
          PETDEX_TELEMETRY: "0",
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
      expect(child.exitCode, stdout + stderr).toBe(0);
      return stdout;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  function renderWhoami(email: unknown): Promise<string> {
    return renderProfile({
      sub: "user_test",
      given_name: "Alice",
      family_name: "Smith",
      preferred_username: "alice",
      email,
    });
  }

  test.each([
    ["an object", {}],
    ["an array", []],
    ["a boolean", true],
    ["an empty string", ""],
    ["null", null],
    ["a number", 123],
  ])("renders %s email as a dash, not the raw value", async (_name, email) => {
    const stdout = await renderWhoami(email);

    // clack pads every note line to the box width, so match the prefix only.
    expect(stdout).toContain("email:   —");
    expect(stdout).not.toContain("[object Object]");
    expect(stdout).not.toContain("email:   true");
    expect(stdout).not.toContain("email:   123");
  });

  test("still shows a real email", async () => {
    const stdout = await renderWhoami("a@b.test");

    expect(stdout).toContain("email:   a@b.test");
  });

  test("strips ANSI escapes from every claim it prints", async () => {
    // Claims are whatever the provider sent. ESC starts a sequence the
    // terminal obeys — recolouring the line, moving the cursor, erasing what
    // is above it — so `NO_COLOR` cannot help: it governs the CLI's own
    // colouring, not bytes echoed back from a claim. Every line of the panel
    // is cleaned, not only `email`.
    const stdout = await renderProfile({
      sub: "\u001b[31muser_test\u001b[0m",
      given_name: "\u001b[1mAlice\u001b[0m",
      family_name: "\u001b[32mSmith\u001b[0m",
      preferred_username: "\u001b[35malice\u001b[0m",
      email: "\u001b[31mred@example.test\u001b[0m",
    });

    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC that must not survive is the assertion.
    expect(stdout).not.toMatch(/\u001b\[[0-9;]*m/);
    expect(stdout).toContain("user:    user_test");
    expect(stdout).toContain("email:   red@example.test");
    expect(stdout).toContain("name:    Alice Smith");
    expect(stdout).toContain("username:alice");
  });

  test("strips bare C0 controls, not only escape sequences", async () => {
    // A carriage return can overwrite the line the reader just saw, and a
    // BEL is noise; neither needs an ESC to reach the terminal.
    const stdout = await renderProfile({
      sub: "user_test",
      email: "red\r@example.test\u0007",
    });

    expect(stdout).toContain("email:   red@example.test");
    expect(stdout).not.toContain("red\r@");
    expect(stdout).not.toContain("\u0007");
  });

  test("renders a claim made only of control characters as not set", async () => {
    // Stripping can leave nothing. `—` is the panel's existing answer for a
    // claim that is present but has nothing to show.
    const stdout = await renderProfile({
      sub: "user_test",
      email: "\u001b[31m\u001b[0m",
    });

    expect(stdout).toContain("email:   —");
  });
});

/**
 * `login` against a local issuer, run as a real child process.
 *
 * These drive `cmdLogin` itself: the summary of what a failed sign-in left
 * behind is read by the real command, not by a unit test of
 * `describeLoginFailure`. The `open` shim fetches the authorize URL so the
 * loopback callback completes without a browser window.
 */
describe("login against a local issuer", () => {
  const ROOT = path.resolve(import.meta.dir, "..");

  /** A HOME whose `open` shim follows the authorize redirect with curl. */
  function loginHome(): { home: string; pathEnv: string } {
    const home = mkdtempSync(path.join(tmpdir(), "petdex-login-"));
    const bin = path.join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const opener = path.join(bin, "open");
    writeFileSync(
      opener,
      '#!/bin/sh\nnohup curl -sL "$1" -o /dev/null >/dev/null 2>&1 &\nexit 0\n',
    );
    chmodSync(opener, 0o755);
    return { home, pathEnv: `${bin}:${process.env.PATH ?? ""}` };
  }

  /** What a previous CLI invocation left in the file store. */
  function seedSession(
    home: string,
    session: { tokens: unknown; user: unknown },
  ): void {
    const dir = path.join(home, ".config", "clerk-cli-auth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "default.json"),
      JSON.stringify({
        tokens: JSON.stringify(session.tokens),
        user: JSON.stringify(session.user),
      }),
    );
  }

  /** Spawn the real CLI against the fake issuer; answer its combined output. */
  async function runLogin(
    home: string,
    pathEnv: string,
    issuer: { issuer: string; clientId: string },
  ): Promise<{ code: number | null; output: string }> {
    const child = Bun.spawn({
      cmd: [process.execPath, `${ROOT}/bin/petdex.ts`, "login"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        PETDEX_TELEMETRY: "0",
        HOME: home,
        PATH: pathEnv,
        PETDEX_URL: issuer.issuer,
        CLERK_ISSUER: issuer.issuer,
        CLERK_OAUTH_CLIENT_ID: issuer.clientId,
      },
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    return { code: child.exitCode, output: stdout + stderr };
  }

  test("a failed re-login names the session that is still saved", async () => {
    // The wiring behind `describeLoginFailure(err, previous)`: the command
    // reads the store after the failure. Removing that read left the gate
    // green, because no test drove the real `cmdLogin` failure path — the
    // message then says only that what was saved could not be checked, while
    // the terminal can name the account every command is still using.
    const clerk = await startFakeClerk({
      accounts: [
        { sub: "user_A", email: "old@example.test" },
        { sub: "user_B", email: "new@example.test", userinfoStatus: 503 },
      ],
      defaultSub: "user_B",
    });
    const { home, pathEnv } = loginHome();
    try {
      seedSession(home, {
        tokens: {
          accessToken: "tok-A",
          refreshToken: "refresh-A",
          expiresAt: Date.now() + 3_600_000,
        },
        user: { sub: "user_A", email: "old@example.test" },
      });

      const result = await runLogin(home, pathEnv, clerk);
      expect(result.code).toBe(1);
      expect(result.output).toContain(
        "Your previous sign-in (old@example.test) is still saved",
      );
      expect(result.output).not.toContain("could not be checked");
    } finally {
      await clerk.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("the signed-in label strips control characters from a provider email", async () => {
    // The success path prints the same claim the panel does. `NO_COLOR` was
    // already set for the child, and it does not strip an ESC that came from
    // the provider — only the CLI's own colouring.
    const clerk = await startFakeClerk({
      accounts: [
        {
          sub: "user_A",
          email: "\u001b[31mred@example.test\u001b[0m",
          name: "Red",
        },
      ],
      defaultSub: "user_A",
    });
    const { home, pathEnv } = loginHome();
    try {
      const result = await runLogin(home, pathEnv, clerk);
      expect(result.code).toBe(0);
      expect(result.output).toContain("Signed in as red@example.test");
      expect(result.output).not.toContain("\u001b[31mred");
    } finally {
      await clerk.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
});

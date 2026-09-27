import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

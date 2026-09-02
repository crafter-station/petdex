import { describe, expect, test } from "bun:test";

function runCli(...args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync({
    cmd: [process.execPath, import.meta.dir + "/petdex.ts", ...args],
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

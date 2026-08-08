import { describe, expect, test } from "bun:test";

function runCli(command: string): { exitCode: number; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, import.meta.dir + "/petdex.ts", command],
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: result.exitCode,
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
});

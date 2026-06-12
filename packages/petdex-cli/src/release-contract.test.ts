import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);
const cliSourcePath = new URL("../bin/petdex.ts", import.meta.url);

describe("CLI release contract", () => {
  test("keeps package version and CLI version in sync", async () => {
    const [packageJsonRaw, cliSource] = await Promise.all([
      readFile(packageJsonPath, "utf8"),
      readFile(cliSourcePath, "utf8"),
    ]);
    const packageJson = JSON.parse(packageJsonRaw) as { version?: string };
    const versionMatch = cliSource.match(/const VERSION = "([^"]+)";/);

    expect(versionMatch?.[1]).toBe(packageJson.version);
  });

  test("defaults production traffic to petdex.dev", async () => {
    const cliSource = await readFile(cliSourcePath, "utf8");

    expect(cliSource).toContain(
      'const PETDEX_URL = process.env.PETDEX_URL ?? "https://petdex.dev";',
    );
    expect(cliSource).not.toContain("petdex.crafter.run");
  });
});

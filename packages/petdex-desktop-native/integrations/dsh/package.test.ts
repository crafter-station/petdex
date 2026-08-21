import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = import.meta.dir;
const archive = join(root, "../../src/assets/petdex-dsh-plugin-0.1.0.tgz");
const packagedFiles = [
  "LICENSE",
  "cordis.patch.yml",
  "package.json",
  "src/index.js",
  "src/normalize.js",
];

function tar(...args: string[]) {
  const result = Bun.spawnSync(["tar", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

describe("embedded DSH plugin archive", () => {
  test("contains only the declared runtime files", () => {
    const entries = tar("-tzf", archive)
      .trim()
      .split("\n")
      .map((entry) => entry.replace(/^package\//, ""))
      .sort();
    expect(entries).toEqual([...packagedFiles].sort());
  });

  for (const file of packagedFiles) {
    test(`keeps ${file} in sync with source`, async () => {
      const packed = tar("-xOzf", archive, `package/${file}`);
      const source = await Bun.file(join(root, file)).text();
      expect(packed).toBe(source);
    });
  }
});

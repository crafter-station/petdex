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

function normalizeNewlines(value: string) {
  return value.replaceAll("\r\n", "\n");
}

function tar(...args: string[]) {
  const result = Bun.spawnSync(["tar", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  // bsdtar follows the host text convention for listings and git may check
  // source fixtures out with CRLF on Windows. The archive contract is textual
  // content, not a platform-specific newline encoding.
  return normalizeNewlines(result.stdout.toString());
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
      const source = normalizeNewlines(await Bun.file(join(root, file)).text());
      expect(packed).toBe(source);
    });
  }
});

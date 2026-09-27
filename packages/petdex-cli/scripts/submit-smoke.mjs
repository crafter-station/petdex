import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const binary =
  process.argv[2] ??
  fileURLToPath(new URL("../dist/petdex.js", import.meta.url));

function run(...args) {
  const result = spawnSync(
    process.execPath,
    [binary, "submit", "./some-pet", ...args],
    {
      env: { ...process.env, NO_COLOR: "1", DO_NOT_TRACK: "1" },
      encoding: "utf8",
      input: "",
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(
    output,
    /Cannot read properties of undefined|before initialization/,
  );
  return { status: result.status, output };
}

for (const args of [["--license", "bogus"], ["--license=bogus"]]) {
  const result = run(...args);
  assert.equal(result.status, 1);
  assert.match(result.output, /Unknown --license bogus/);
  assert.match(
    result.output,
    /cc0, cc-by, cc-by-sa, cc-by-nc, all-rights-reserved/,
  );
}

const interactive = run();
assert.equal(interactive.status, 0);
assert.match(interactive.output, /License for this pet's artwork/);
assert.match(interactive.output, /CC0/);
assert.match(interactive.output, /All rights reserved/);
console.log("Packaged submit startup passed: flag and interactive paths.");

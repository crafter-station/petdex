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
      // A pipe already at EOF is not a terminal: this is the stdin a script,
      // a CI job, or `xargs` hands `submit`.
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
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output,
  };
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

// No terminal and no `--license`: the CLI must refuse instead of picking a
// license on the user's behalf, and must not exit 0 having submitted nothing.
// The reason has to reach stderr — stdout carries the successful-submission
// summary — and it has to name the flag and the options, or a scripted caller
// cannot tell what to fix.
const noTerminal = run();
assert.equal(noTerminal.status, 1);
assert.match(noTerminal.stderr, /needs --license when there is no terminal/);
assert.match(
  noTerminal.stderr,
  /cc0, cc-by, cc-by-sa, cc-by-nc, all-rights-reserved/,
);
assert.doesNotMatch(noTerminal.stdout, /needs --license/);

// The same command with a valid flag has to clear that gate, or the check
// above would also pass on a rule that rejects `--license` itself. This run
// still ends nonzero: there is no session and no such path here, so it stops
// at "Not signed in" in a clean environment, or at the missing path on a
// signed-in machine. Either is a stop past the license gate, not at it.
const licensed = run("--license", "cc0");
assert.equal(licensed.status, 1);
assert.doesNotMatch(licensed.output, /needs --license|Unknown --license/);
assert.match(
  licensed.output,
  /Not signed in|petdex login|No such file or directory/,
);

console.log(
  "Packaged submit startup passed: flag validation and the no-terminal path.",
);

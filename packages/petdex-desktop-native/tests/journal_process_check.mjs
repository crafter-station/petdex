import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { journalStem as ompJournalStem } from "../src/assets/omp-extension.ts";
import { journalStem as opencodeJournalStem } from "../src/assets/opencode-plugin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, ".zig-cache", `journal-process-${process.pid}`);
const executable = join(
  fixture,
  process.platform === "win32" ? "journal-writer.exe" : "journal-writer",
);
const journal = join(fixture, "journal.jsonl");

const stemCases = [
  [
    "team/a",
    "65f838a2fbff37d81a09242f44268f116e339d56e03dec44785d0badda4b1341",
  ],
  [
    "team:a",
    "5752fddeb3d6826d1281d4ecd54493c1eca7c0d93bf64bae0ff098c833f1fee3",
  ],
  ["", "d43eaed1b24b2617fb850c9c81dd86891d3b64edbb62712c94f08b8b32279ebf"],
];
for (const stem of [ompJournalStem, opencodeJournalStem]) {
  for (const [value, expected] of stemCases) {
    const actual = stem(value, "unkeyed");
    if (actual !== expected)
      throw new Error(
        `journal stem mismatch for ${JSON.stringify(value)}: ${actual}`,
      );
  }
  if (stem("team/a", "unkeyed") === stem("team:a", "unkeyed"))
    throw new Error("punctuation-distinct journal identities collided");
}

function run(argv) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolveExit(signal ? 128 : (code ?? 1)),
    );
  });
}

rmSync(fixture, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });

try {
  const buildCode = await run([
    "zig",
    "build-exe",
    "-ODebug",
    "--dep",
    "plat",
    `-Mroot=${join(root, "tests", "journal_process_writer.zig")}`,
    `-Mplat=${join(root, "src", "plat.zig")}`,
    `-femit-bin=${executable}`,
  ]);
  if (buildCode !== 0)
    throw new Error("journal writer helper failed to compile");

  const writers = ["a", "b", "c", "d"];
  const exits = await Promise.all(
    writers.map((writer) => run([executable, journal, writer])),
  );
  if (exits.some((code) => code !== 0))
    throw new Error(`journal writer exited unsuccessfully: ${exits.join(",")}`);

  const current = readFileSync(journal, "utf8");
  const previous = readFileSync(`${journal}.1`, "utf8");
  if (current.length + previous.length !== 72)
    throw new Error("rotated generations did not retain all 72 bytes");
  const ordered = previous + current;
  for (const writer of writers) {
    let last = -1;
    for (let sequence = 0; sequence < 3; sequence++) {
      const record = `${writer}:${sequence}xx\n`;
      const first = ordered.indexOf(record);
      const second = ordered.indexOf(record, first + 1);
      if (first < 0 || second >= 0)
        throw new Error(`${record.trim()} was not present exactly once`);
      if (first <= last)
        throw new Error(
          `${writer} records were reordered across processes/rotation`,
        );
      last = first;
    }
  }
  console.log(
    "journal process test: 12/12 records exactly once and ordered across one rotation",
  );
} finally {
  if (existsSync(fixture)) rmSync(fixture, { recursive: true, force: true });
}

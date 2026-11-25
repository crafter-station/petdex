/**
 * The quarantine race, in its own file.
 *
 * The interleaving needs the reader paused *after* it read the torn bytes and
 * *before* its quarantine runs. Nothing in the store can be made to pause
 * there from outside, so this file wraps `readFile` for one call: the reader's
 * first read of the credential path completes normally (it still sees the
 * torn bytes, because the writer only starts afterwards) and the wrapper then
 * holds it at a gate. The discount store imported *after* the mock — a
 * statically imported module would keep the real `readFile` it was bound to.
 *
 * The wrapper is disarmed by the first call it gates, so the rest of the
 * process (including later test files, since `mock.module` is process-wide)
 * sees a faithful `readFile`.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFs = await import("node:fs/promises");
const realReadFile = realFs.readFile;

/** Path whose next `readFile` call is held until the test opens the gate. */
let gatedPath: string | null = null;
let openGate: () => void = () => {};
const gate = new Promise<void>((resolve) => {
  openGate = resolve;
});

mock.module("node:fs/promises", () => ({
  ...realFs,
  readFile: async (
    file: Parameters<typeof realReadFile>[0],
    options?: Parameters<typeof realReadFile>[1],
  ) => {
    // Claim the gate synchronously, at call entry: whichever call arrives
    // first is the reader's, and later reads are never caught by it.
    const gated = gatedPath !== null && String(file) === gatedPath;
    if (gated) gatedPath = null;
    const result = await realReadFile(file, options);
    if (gated) await gate;
    return result;
  },
}));

const { createCredentialStore } = await import("./credential-store");

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "petdex-quarantine-race-"));
});

afterAll(async () => {
  gatedPath = null;
  openGate();
  await rm(directory, { recursive: true, force: true });
});

test("a reader holding a torn snapshot cannot move a record written after it", async () => {
  // The reviewer's P1: `get()` reads the file, and if it does not parse it
  // renames it aside. Between that read and the rename a login can take the
  // lock, see the same torn bytes, replace them with a complete session and
  // release. The rename then moves the *new* credential to a `.corrupt-*`
  // name, leaving the path empty and a good login "lost".
  const filePath = join(directory, "credentials.json");
  const torn = '{ "tokens": { "accessTok';
  await writeFile(filePath, torn);

  const reader = createCredentialStore("file", { filePath });
  const writer = createCredentialStore("file", { filePath });

  gatedPath = filePath;
  // Reads the torn bytes, then waits at the gate — before its quarantine.
  const reading = reader.get("tokens");

  // The writer runs entirely while the reader is paused: it takes the lock,
  // reads (the torn snapshot call is claimed, so this one is not gated),
  // overwrites the file with a valid record and releases.
  await writer.set("tokens", JSON.stringify({ accessToken: "fresh" }));

  openGate();
  expect(await reading).toBeNull();

  // The writer's record is still at the credential path...
  expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
    tokens: JSON.stringify({ accessToken: "fresh" }),
  });
  // ...and nothing the reader moved aside is the fresh record. (The writer's
  // own read did quarantine the torn bytes it replaced — that evidence is
  // expected, and is the only evidence that may exist.)
  const evidence = (await readdir(directory)).filter((name) =>
    name.includes(".corrupt-"),
  );
  for (const name of evidence) {
    expect(await readFile(join(directory, name), "utf8")).toBe(torn);
  }
});

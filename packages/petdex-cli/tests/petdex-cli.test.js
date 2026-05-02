import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "petdex.js",
);

test("list auto-detects ready characters from a pets directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "petdex-cli-"));
  const petDir = path.join(root, "paperclip");
  await mkdir(petDir);
  await writePet(petDir, {
    id: "paperclip",
    displayName: "Paperclip",
    description: "A small helpful paperclip.",
  });

  const { stdout } = await runCli(["list", "--dir", root]);

  expect(stdout).toContain("Found 1 character(s)");
  expect(stdout).toContain("Paperclip (paperclip) - 1536x1872 - ready");
});

test("list blocks spritesheet paths that escape the character folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "petdex-cli-"));
  const petDir = path.join(root, "pet");
  const escapeDir = path.join(root, "pet-escape");
  await mkdir(petDir);
  await mkdir(escapeDir);
  await writeFile(path.join(escapeDir, "spritesheet.webp"), webpBytes());
  await writePet(petDir, {
    id: "pet",
    displayName: "Escaping Pet",
    description: "This manifest points outside its folder.",
    spritesheetPath: "../pet-escape/spritesheet.webp",
  });

  const { stdout } = await runCli(["list", "--dir", root]);

  expect(stdout).toContain("Escaping Pet (pet)");
  expect(stdout).toContain(
    "blocked: spritesheetPath must stay inside the character folder",
  );
});

async function writePet(dir, manifest) {
  await writeFile(
    path.join(dir, "pet.json"),
    `${JSON.stringify(
      {
        spritesheetPath: "spritesheet.webp",
        ...manifest,
      },
      null,
      2,
    )}\n`,
  );
  if (manifest.spritesheetPath?.startsWith("..")) return;
  await writeFile(path.join(dir, "spritesheet.webp"), webpBytes());
}

async function runCli(args) {
  const proc = Bun.spawn(["node", cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return { stdout };
}

function webpBytes() {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  writeUint24Le(bytes, 24, 1535);
  writeUint24Le(bytes, 27, 1871);
  return bytes;
}

function writeUint24Le(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

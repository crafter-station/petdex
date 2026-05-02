import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

test("upload asks for browser login when no token is available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "petdex-cli-"));
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "petdex-config-"));
  const petDir = path.join(root, "paperclip");
  await mkdir(petDir);
  await writePet(petDir, {
    id: "paperclip",
    displayName: "Paperclip",
    description: "A small helpful paperclip.",
  });

  const result = await runCliRaw(
    ["upload", "--dir", root, "--pet", "paperclip"],
    {
      XDG_CONFIG_HOME: configRoot,
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Run `petdex login`");
});

test("upload uses the stored browser login token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "petdex-cli-"));
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "petdex-config-"));
  const petDir = path.join(root, "paperclip");
  await mkdir(petDir);
  await writePet(petDir, {
    id: "paperclip",
    displayName: "Paperclip",
    description: "A small helpful paperclip.",
  });

  const received = {};
  const server = createServer((req, res) => {
    received.authorization = req.headers.authorization;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, slug: "paperclip" }));
  });
  await listen(server);
  const address = server.address();
  const siteUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(path.join(configRoot, "petdex"), { recursive: true });
  await writeFile(
    path.join(configRoot, "petdex", "config.json"),
    `${JSON.stringify({
      siteUrl,
      token: "stored-token",
      ownerEmail: "user@example.com",
    })}\n`,
  );

  try {
    const result = await runCliRaw(
      ["upload", "--dir", root, "--pet", "paperclip", "--url", siteUrl],
      { XDG_CONFIG_HOME: configRoot },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Submitted Paperclip for review");
    expect(received.authorization).toBe("Bearer stored-token");
  } finally {
    server.close();
  }
});

test("install runs the Petdex install script for a slug", async () => {
  const requested = {};
  const server = createServer((req, res) => {
    requested.url = req.url;
    if (req.url === "/install/boba") {
      res.writeHead(200, { "Content-Type": "text/x-shellscript" });
      res.end('#!/bin/sh\necho "Installed Boba"\n');
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  await listen(server);
  const address = server.address();
  const siteUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await runCliRaw(["install", "boba", "--url", siteUrl]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Installed Boba");
    expect(requested.url).toBe("/install/boba");
  } finally {
    server.close();
  }
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
  const { exitCode, stderr, stdout } = await runCliRaw(args);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return { stdout };
}

async function runCliRaw(args, env = {}) {
  const proc = Bun.spawn(["node", cliPath, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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

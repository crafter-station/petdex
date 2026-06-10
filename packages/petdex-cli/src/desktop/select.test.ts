import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectSelectableSlugs,
  reloadDesktopAfterSelect,
  setActivePet,
} from "./select.js";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "petdex-select-test-"));
  tmpRoots.push(root);
  return root;
}

function makePet(
  root: string,
  slug: string,
  spriteName: string,
  bytes: Buffer,
) {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, spriteName), bytes);
}

describe("collectSelectableSlugs", () => {
  test("returns sorted loadable slugs from both roots", async () => {
    const petdexRoot = await tempRoot();
    const codexRoot = await tempRoot();
    makePet(petdexRoot, "zeta", "spritesheet.webp", Buffer.from("webp"));
    makePet(codexRoot, "alpha", "spritesheet.png", Buffer.from("png"));
    makePet(codexRoot, "zeta", "spritesheet.webp", Buffer.from("dupe"));

    expect(await collectSelectableSlugs([petdexRoot, codexRoot])).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  test("skips missing, empty, and oversized pet directories", async () => {
    const root = await tempRoot();
    mkdirSync(path.join(root, "missing-sprite"), { recursive: true });
    makePet(root, "empty", "spritesheet.webp", Buffer.alloc(0));
    makePet(
      root,
      "huge",
      "spritesheet.webp",
      Buffer.alloc(16 * 1024 * 1024 + 1),
    );
    makePet(root, "good", "spritesheet.webp", Buffer.from("ok"));

    expect(await collectSelectableSlugs([root])).toEqual(["good"]);
  });
});

describe("setActivePet", () => {
  test("creates active.json parent directory", async () => {
    const root = await tempRoot();
    const activePath = path.join(root, ".petdex", "active.json");

    await setActivePet("alpha", activePath);

    expect(readFileSync(activePath, "utf8")).toBe('{"slug":"alpha"}\n');
  });
});

describe("reloadDesktopAfterSelect", () => {
  test("starts the desktop when stop reports it was not running", async () => {
    let started = false;
    const result = await reloadDesktopAfterSelect({
      stopDesktop: async () => ({
        ok: false,
        reason: "petdex-desktop is not running",
      }),
      startDesktop: async () => {
        started = true;
        return { ok: true, pid: 123, alreadyRunning: false };
      },
    });

    expect(result).toEqual({ status: "reloaded" });
    expect(started).toBe(true);
  });

  test("does not start after a real stop failure", async () => {
    let started = false;
    const result = await reloadDesktopAfterSelect({
      stopDesktop: async () => ({
        ok: false,
        reason: "failed to signal pid 7",
      }),
      startDesktop: async () => {
        started = true;
        return { ok: true, pid: 123, alreadyRunning: false };
      },
    });

    expect(result).toEqual({
      status: "manual_restart_required",
      reason: "failed to signal pid 7",
    });
    expect(started).toBe(false);
  });

  test("does not start while the old sidecar port is still busy", async () => {
    let started = false;
    const result = await reloadDesktopAfterSelect({
      stopDesktop: async () => ({ ok: true, pid: 99, portReleased: false }),
      startDesktop: async () => {
        started = true;
        return { ok: true, pid: 123, alreadyRunning: false };
      },
    });

    expect(result).toEqual({
      status: "manual_restart_required",
      reason: "desktop sidecar port is still busy",
    });
    expect(started).toBe(false);
  });

  test("reports start failures instead of claiming reload success", async () => {
    const result = await reloadDesktopAfterSelect({
      stopDesktop: async () => ({ ok: true, pid: 99, portReleased: true }),
      startDesktop: async () => ({
        ok: false,
        reason: "petdex-desktop binary not found",
      }),
    });

    expect(result).toEqual({
      status: "manual_restart_required",
      reason: "petdex-desktop binary not found",
    });
  });
});

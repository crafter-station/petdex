import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _commitStagedForTest, type StagedFile } from "./install";

// Tests focus on the all-or-nothing rollback contract for
// commitStaged. The previous implementation skipped no-backup
// entries during rollback, which left first-time installs in a
// half-committed state. These cases pin both happy paths and the
// two failure modes that almost shipped broken.

describe("commitStaged rollback", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petdex-staged-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function staged(name: string, contents: string): StagedFile {
    const tmpPath = join(dir, `${name}.tmp`);
    writeFileSync(tmpPath, contents);
    return { tmpPath, destPath: join(dir, name) };
  }

  test("commits two files when both renames succeed", async () => {
    const a = staged("binary", "BINARY-NEW");
    const b = staged("sidecar.js", "SIDECAR-NEW");

    await _commitStagedForTest([a, b]);

    expect(readFileSync(a.destPath, "utf8")).toBe("BINARY-NEW");
    expect(readFileSync(b.destPath, "utf8")).toBe("SIDECAR-NEW");
    // .tmp paths got consumed by the rename; .prev shouldn't exist
    // because there were no previous files.
    expect(existsSync(a.tmpPath)).toBe(false);
    expect(existsSync(b.tmpPath)).toBe(false);
    expect(existsSync(`${a.destPath}.prev`)).toBe(false);
    expect(existsSync(`${b.destPath}.prev`)).toBe(false);
  });

  test("rollback restores the previous file when an upgrade fails mid-flight", async () => {
    // Pre-existing files — this simulates an upgrade rather than a
    // first-time install.
    writeFileSync(join(dir, "binary"), "BINARY-OLD");
    writeFileSync(join(dir, "sidecar.js"), "SIDECAR-OLD");

    const a = staged("binary", "BINARY-NEW");
    // Second entry is sabotaged: tmpPath points at a non-existent
    // file so the rename throws. `dir` exists, but the file inside
    // doesn't, which makes rename fail with ENOENT.
    const b: StagedFile = {
      tmpPath: join(dir, "does-not-exist.tmp"),
      destPath: join(dir, "sidecar.js"),
    };

    await expect(_commitStagedForTest([a, b])).rejects.toThrow();

    // After the rollback we should be back at the original state:
    // both originals readable, no .prev or .tmp leftovers for
    // anything we touched.
    expect(readFileSync(join(dir, "binary"), "utf8")).toBe("BINARY-OLD");
    expect(readFileSync(join(dir, "sidecar.js"), "utf8")).toBe("SIDECAR-OLD");
    expect(existsSync(`${a.destPath}.prev`)).toBe(false);
  });

  test("rollback deletes a fresh-install no-backup entry when a later rename fails", async () => {
    // No pre-existing files in `dir`. This is the scenario the
    // reviewer flagged: backup === null on the first entry, and the
    // old code's `if (!r.backup) continue` left the new file
    // stranded after rollback.
    const a = staged("binary", "BINARY-NEW");
    const b: StagedFile = {
      tmpPath: join(dir, "does-not-exist.tmp"),
      destPath: join(dir, "sidecar.js"),
    };

    await expect(_commitStagedForTest([a, b])).rejects.toThrow();

    // The rollback must have removed the freshly-renamed binary —
    // otherwise we'd ship the user a partial install (binary
    // present, sidecar missing).
    expect(existsSync(a.destPath)).toBe(false);
    expect(existsSync(b.destPath)).toBe(false);
  });
});

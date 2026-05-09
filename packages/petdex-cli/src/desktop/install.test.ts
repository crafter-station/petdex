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

import {
  _commitStagedForTest,
  fetchLatestRelease,
  type StagedFile,
} from "./install";

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

// ---- fetchLatestRelease (Finding 3: tag namespace pollution) -----
//
// The petdex repo publishes desktop-v*, web-v*, and sidecar-v*
// releases under the same tag namespace. /releases/latest returned
// whichever was published last regardless of prefix, so a web release
// could trigger a bogus "update available" prompt or send users to a
// release without desktop assets. We now list /releases?per_page=20
// and pick the newest desktop-v* explicitly.
//
// We stub global fetch with a tiny mock that returns a fixture array
// — much cleaner than mocking via msw for one endpoint.

describe("fetchLatestRelease", () => {
  const realFetch = globalThis.fetch;
  let lastUrl: string | null;
  let mockBody: unknown;
  let mockOk: boolean;
  let mockStatus: number;

  beforeEach(() => {
    lastUrl = null;
    mockBody = [];
    mockOk = true;
    mockStatus = 200;
    globalThis.fetch = (async (url: string | URL) => {
      lastUrl = url.toString();
      return new Response(JSON.stringify(mockBody), {
        status: mockStatus,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    if (!mockOk) {
      // bun-test glitch sentinel; the assignment above already covers it
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("queries the list endpoint, not /releases/latest", async () => {
    mockBody = [
      {
        tag_name: "desktop-v1.0.0",
        assets: [],
        draft: false,
        prerelease: false,
      },
    ];
    await fetchLatestRelease();
    expect(lastUrl).toMatch(/\/releases\?per_page=\d+/);
    expect(lastUrl).not.toMatch(/\/releases\/latest/);
  });

  test("picks the newest desktop-v* even when a non-desktop release is at the top", async () => {
    // GH lists newest-first. A web-v* release shipped most recently;
    // /releases/latest would have returned that, but we want the
    // older-but-correct desktop-v0.1.4.
    mockBody = [
      { tag_name: "web-v2.0.0", assets: [], draft: false, prerelease: false },
      {
        tag_name: "sidecar-v0.5.0",
        assets: [],
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "desktop-v0.1.4",
        assets: [],
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "desktop-v0.1.3",
        assets: [],
        draft: false,
        prerelease: false,
      },
    ];
    const release = await fetchLatestRelease();
    expect(release.tag_name).toBe("desktop-v0.1.4");
  });

  test("skips drafts even if they're newer", async () => {
    mockBody = [
      {
        tag_name: "desktop-v1.0.0-draft",
        assets: [],
        draft: true,
        prerelease: false,
      },
      {
        tag_name: "desktop-v0.9.0",
        assets: [],
        draft: false,
        prerelease: false,
      },
    ];
    const release = await fetchLatestRelease();
    expect(release.tag_name).toBe("desktop-v0.9.0");
  });

  test("skips prereleases (we don't ship those for desktop yet)", async () => {
    mockBody = [
      {
        tag_name: "desktop-v1.0.0-rc.1",
        assets: [],
        draft: false,
        prerelease: true,
      },
      {
        tag_name: "desktop-v0.9.0",
        assets: [],
        draft: false,
        prerelease: false,
      },
    ];
    const release = await fetchLatestRelease();
    expect(release.tag_name).toBe("desktop-v0.9.0");
  });

  test("throws when no desktop-v* release exists in the recent slice", async () => {
    // Web-only repo state: should fail loudly, not silently install
    // a non-desktop release.
    mockBody = [
      { tag_name: "web-v2.0.0", assets: [], draft: false, prerelease: false },
      {
        tag_name: "sidecar-v0.5.0",
        assets: [],
        draft: false,
        prerelease: false,
      },
    ];
    await expect(fetchLatestRelease()).rejects.toThrow(/desktop-v/);
  });

  test("throws when GitHub returns an empty array", async () => {
    mockBody = [];
    await expect(fetchLatestRelease()).rejects.toThrow(/no releases/);
  });

  test("throws on non-200 from GitHub", async () => {
    mockBody = { message: "rate limited" };
    mockStatus = 403;
    // Re-stub since mockStatus changed after beforeEach
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 403 })) as typeof fetch;
    await expect(fetchLatestRelease()).rejects.toThrow(/403/);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _commitStagedForTest,
  _hasAnyInstalledPetForTest,
  _installStarterPetForTest,
  fetchLatestRelease,
  isTrustedAssetUrl,
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
    expect(lastUrl).toMatch(/page=1/);
    expect(lastUrl).not.toMatch(/\/releases\/latest/);
  });

  test("paginates when desktop-v* is not on page 1", async () => {
    // Simulate a long run of web-v* releases on page 1 followed by
    // a desktop release on page 2. Without pagination this would
    // throw "no desktop release found".
    const calls: string[] = [];
    const page1 = Array.from({ length: 30 }, (_, i) => ({
      tag_name: `web-v${i}.0.0`,
      assets: [],
      draft: false,
      prerelease: false,
    }));
    const page2 = [
      { tag_name: "desktop-v0.1.4", assets: [], draft: false, prerelease: false },
    ];
    globalThis.fetch = (async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      const body = u.includes("page=1") ? page1 : page2;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const release = await fetchLatestRelease({ maxPages: 5 });
    expect(release.tag_name).toBe("desktop-v0.1.4");
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatch(/page=1/);
    expect(calls[1]).toMatch(/page=2/);
  });

  test("stops paginating when a short page indicates the end of the list", async () => {
    // page 1 returns < page size with no desktop release. We should
    // NOT issue a page-2 request.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(url.toString());
      return new Response(
        JSON.stringify([
          { tag_name: "web-v1", assets: [], draft: false, prerelease: false },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(fetchLatestRelease({ maxPages: 5 })).rejects.toThrow(
      /desktop-v/,
    );
    expect(calls.length).toBe(1);
  });

  test("respects maxPages cap and reports how many it scanned", async () => {
    // Every page is full of non-desktop releases; we should walk
    // exactly maxPages then throw.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(url.toString());
      const fullPage = Array.from({ length: 30 }, () => ({
        tag_name: "web-v1",
        assets: [],
        draft: false,
        prerelease: false,
      }));
      return new Response(JSON.stringify(fullPage), { status: 200 });
    }) as typeof fetch;

    await expect(fetchLatestRelease({ maxPages: 3 })).rejects.toThrow(
      /3 page/,
    );
    expect(calls.length).toBe(3);
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
    await expect(fetchLatestRelease()).rejects.toThrow(/desktop-v/);
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

// ---- installStarterPet (Finding 1: starter pet on default flow) ----
//
// installStarterPet is the new safety net in `petdex install desktop`
// for the user who installs the binary, hooks, and runs `desktop start`
// without ever running `petdex install <slug>`. Without it the binary
// would exit "No pets found". The test surface targets:
//   - URL allowlist: untrusted hosts in the manifest must abort the
//     install instead of writing attacker-controlled bytes
//   - manifest fetch failure → returns null, no files touched
//   - happy path → files land in both ~/.petdex/pets and ~/.codex/pets
//   - partial download failure → rollback removes orphan directories

const TRUSTED_HOST =
  "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev";

describe("installStarterPet", () => {
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "petdex-starter-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = realHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function petsDir(): string {
    return join(tmpHome, ".petdex", "pets");
  }
  function codexPetsDir(): string {
    return join(tmpHome, ".codex", "pets");
  }

  function makeFetch(
    handler: (url: string) => Response | Promise<Response>,
  ): typeof fetch {
    return (async (url: string | URL) => {
      return handler(url.toString());
    }) as typeof fetch;
  }

  test("aborts when the manifest's spritesheetUrl is on an untrusted host", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: "https://evil.example.com/track.gif",
                petJsonUrl: `${TRUSTED_HOST}/pets/boba/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      // Should never reach asset URLs; fail loud if we do.
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBeNull();
    // No directories created — the host check happens before mkdir.
    expect(existsSync(join(petsDir(), "boba"))).toBe(false);
    expect(existsSync(join(codexPetsDir(), "boba"))).toBe(false);
  });

  test("aborts when petJsonUrl is on an untrusted host", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: `${TRUSTED_HOST}/pets/boba/spritesheet.webp`,
                petJsonUrl: "http://attacker.lan/pet.json",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBeNull();
  });

  test("returns null when the manifest fetch fails", async () => {
    const fetchImpl = makeFetch(() => new Response("nope", { status: 503 }));
    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });
    expect(result).toBeNull();
  });

  test("returns null when the manifest has no pets", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(JSON.stringify({ pets: [] }), { status: 200 });
      }
      return new Response("not allowed", { status: 500 });
    });
    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });
    expect(result).toBeNull();
  });

  test("happy path: writes pet.json + spritesheet to both roots", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: `${TRUSTED_HOST}/pets/boba/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/boba/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/spritesheet.webp")) {
        return new Response("WEBP-BYTES", { status: 200 });
      }
      if (url.endsWith("/pet.json")) {
        return new Response('{"displayName":"Boba"}', { status: 200 });
      }
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBe("boba");
    for (const root of [petsDir(), codexPetsDir()]) {
      const slugDir = join(root, "boba");
      expect(existsSync(join(slugDir, "pet.json"))).toBe(true);
      expect(existsSync(join(slugDir, "spritesheet.webp"))).toBe(true);
      expect(readFileSync(join(slugDir, "pet.json"), "utf8")).toBe(
        '{"displayName":"Boba"}',
      );
    }
  });

  test("partial failure: rolls back created directories", async () => {
    let manifestCalls = 0;
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        manifestCalls += 1;
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: `${TRUSTED_HOST}/pets/boba/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/boba/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      // Spritesheet download fails — pet.json may have already
      // landed.
      if (url.endsWith("/spritesheet.webp")) {
        return new Response("err", { status: 500 });
      }
      if (url.endsWith("/pet.json")) {
        return new Response('{"displayName":"Boba"}', { status: 200 });
      }
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBeNull();
    expect(manifestCalls).toBe(1);
    // Rollback must remove BOTH target directories so the next retry
    // doesn't see a half-installed pet.
    expect(existsSync(join(petsDir(), "boba"))).toBe(false);
    expect(existsSync(join(codexPetsDir(), "boba"))).toBe(false);
  });

  test("refuses to overwrite a pre-existing slug directory", async () => {
    // User has an existing pet folder (maybe partial, maybe complete,
    // maybe with custom files). The previous rollback path would have
    // mkdir'd over it and rm-rf'd on failure — destroying user data.
    // Now we abort before touching anything if the dir exists.
    mkdirSync(join(petsDir(), "boba"), { recursive: true });
    writeFileSync(join(petsDir(), "boba", "user-custom.txt"), "DO NOT TOUCH");

    let manifestCalls = 0;
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        manifestCalls += 1;
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: `${TRUSTED_HOST}/pets/boba/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/boba/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBeNull();
    // Manifest was consulted (the function got far enough to know
    // there's a slug to install), but the user's existing file is
    // intact.
    expect(manifestCalls).toBe(1);
    expect(existsSync(join(petsDir(), "boba", "user-custom.txt"))).toBe(true);
    expect(readFileSync(join(petsDir(), "boba", "user-custom.txt"), "utf8")).toBe(
      "DO NOT TOUCH",
    );
  });

  test("falls through to a different manifest pet when boba's slug dir is taken", async () => {
    // User has a stale ~/.petdex/pets/boba folder (maybe from a
    // previous incomplete install). The desktop binary won't accept
    // it because hasSpritesheet rejects empty/oversized sprites,
    // but the dir blocks the canonical starter slug. The CLI must
    // try the next manifest entry rather than dead-end.
    mkdirSync(join(petsDir(), "boba"), { recursive: true });
    // No spritesheet inside — desktop would skip it on startup.

    let bobaPetJsonFetched = 0;
    let foxAssetsFetched = 0;
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: `${TRUSTED_HOST}/pets/boba/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/boba/pet.json`,
              },
              {
                slug: "fox",
                displayName: "Fox",
                spritesheetUrl: `${TRUSTED_HOST}/pets/fox/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/fox/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/pets/boba/")) {
        bobaPetJsonFetched += 1;
        // Should never be called — boba slug is taken, candidate
        // skipped before any download starts.
        return new Response("should not have been called", { status: 500 });
      }
      if (url.includes("/pets/fox/spritesheet.webp")) {
        foxAssetsFetched += 1;
        return new Response("WEBP", { status: 200 });
      }
      if (url.includes("/pets/fox/pet.json")) {
        foxAssetsFetched += 1;
        return new Response('{"displayName":"Fox"}', { status: 200 });
      }
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBe("fox");
    // We never even tried to download boba's assets — we saw the
    // existing dir during the dir-free check and moved on.
    expect(bobaPetJsonFetched).toBe(0);
    expect(foxAssetsFetched).toBe(2);
    // Stale boba dir is preserved untouched.
    expect(existsSync(join(petsDir(), "boba"))).toBe(true);
    // Fox lands in both roots.
    expect(existsSync(join(petsDir(), "fox", "spritesheet.webp"))).toBe(true);
    expect(existsSync(join(codexPetsDir(), "fox", "spritesheet.webp"))).toBe(
      true,
    );
  });

  test("returns null when every manifest candidate's slug dir is taken", async () => {
    // Edge case: every pet in the manifest already has a stale dir.
    // We can't pick anything to install — the function returns null
    // and the caller surfaces a hint to the user.
    mkdirSync(join(petsDir(), "boba"), { recursive: true });
    mkdirSync(join(petsDir(), "fox"), { recursive: true });

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: `${TRUSTED_HOST}/pets/boba/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/boba/pet.json`,
              },
              {
                slug: "fox",
                displayName: "Fox",
                spritesheetUrl: `${TRUSTED_HOST}/pets/fox/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/fox/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("should not have been called", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBeNull();
  });

  test("skips candidates with untrusted asset URLs and tries the next one", async () => {
    // Manifest serves a poisoned first row (host outside the
    // allowlist) — we must skip it AND try the next candidate
    // rather than aborting the whole starter flow.
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "boba",
                displayName: "Boba",
                spritesheetUrl: "https://attacker.example.com/spritesheet.webp",
                petJsonUrl: "https://attacker.example.com/pet.json",
              },
              {
                slug: "fox",
                displayName: "Fox",
                spritesheetUrl: `${TRUSTED_HOST}/pets/fox/spritesheet.webp`,
                petJsonUrl: `${TRUSTED_HOST}/pets/fox/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("attacker.example.com")) {
        return new Response("should not be reached", { status: 500 });
      }
      if (url.includes("/pets/fox/spritesheet.webp")) {
        return new Response("WEBP", { status: 200 });
      }
      if (url.includes("/pets/fox/pet.json")) {
        return new Response('{"displayName":"Fox"}', { status: 200 });
      }
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBe("fox");
    expect(existsSync(join(petsDir(), "fox", "spritesheet.webp"))).toBe(true);
    // The poisoned slug must NOT have been touched.
    expect(existsSync(join(petsDir(), "boba"))).toBe(false);
  });

  test("falls back to the first manifest entry when boba is missing", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/api/manifest")) {
        return new Response(
          JSON.stringify({
            pets: [
              {
                slug: "fox",
                displayName: "Fox",
                spritesheetUrl: `${TRUSTED_HOST}/pets/fox/spritesheet.png`,
                petJsonUrl: `${TRUSTED_HOST}/pets/fox/pet.json`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/spritesheet.png")) {
        return new Response("PNG", { status: 200 });
      }
      if (url.endsWith("/pet.json")) {
        return new Response('{"displayName":"Fox"}', { status: 200 });
      }
      return new Response("not allowed", { status: 500 });
    });

    const result = await _installStarterPetForTest({
      fetchOverride: fetchImpl,
      petdexUrl: "https://petdex.test",
    });

    expect(result).toBe("fox");
    expect(existsSync(join(petsDir(), "fox", "spritesheet.png"))).toBe(true);
  });
});

// ---- isTrustedAssetUrl ---------------------------------------------
//
// Used by both installStarterPet and cmdInstall to gate manifest URLs
// before downloading bytes into ~/.petdex / ~/.codex. Mirrors
// src/lib/url-allowlist.ts on the server side; if these drift the CLI
// could either reject legit installs or accept attacker bytes.

describe("isTrustedAssetUrl", () => {
  test("accepts the R2 public bucket", () => {
    expect(
      isTrustedAssetUrl(
        "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/boba/spritesheet.webp",
      ),
    ).toBe(true);
  });

  test("accepts the legacy UploadThing host (pre-R2 migration)", () => {
    expect(isTrustedAssetUrl("https://yu2vz9gndp.ufs.sh/f/abc123")).toBe(true);
  });

  test("rejects http (must be https)", () => {
    expect(
      isTrustedAssetUrl(
        "http://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/pets/boba/spritesheet.webp",
      ),
    ).toBe(false);
  });

  test("rejects an unknown host even on https", () => {
    expect(
      isTrustedAssetUrl("https://attacker.example.com/pet.json"),
    ).toBe(false);
  });

  test("rejects javascript: / data: / file: pseudo-URLs", () => {
    expect(isTrustedAssetUrl("javascript:alert(1)")).toBe(false);
    expect(isTrustedAssetUrl("data:text/html,evil")).toBe(false);
    expect(isTrustedAssetUrl("file:///etc/passwd")).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(isTrustedAssetUrl("not a url")).toBe(false);
    expect(isTrustedAssetUrl("")).toBe(false);
  });

  test("rejects subdomain spoof attempts", () => {
    // attacker.r2.dev is not the same as our specific bucket
    expect(isTrustedAssetUrl("https://attacker.r2.dev/x")).toBe(false);
    // Check that a hostname suffix attack (substring match) doesn't slip through
    expect(
      isTrustedAssetUrl(
        "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev.attacker.com/x",
      ),
    ).toBe(false);
  });
});

// ---- hasAnyInstalledPet (Finding: usability mirror desktop) --------
//
// hasAnyInstalledPet decides whether `petdex install desktop` should
// download a starter. It used to accept "spritesheet path exists" as
// good enough — but the desktop binary requires the file to be both
// openable AND <= MAX_PET_BYTES. A stale 50 MB sprite would let
// hasAnyInstalledPet return true, so the starter never downloaded,
// and `petdex desktop start` then crashed on the unreadable file.
// These tests pin the size + presence + emptiness checks.

describe("hasAnyInstalledPet usability", () => {
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "petdex-usable-test-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    process.env.HOME = realHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function petsDir(): string {
    return join(tmpHome, ".petdex", "pets");
  }

  test("returns false when no pets root exists", async () => {
    expect(await _hasAnyInstalledPetForTest()).toBe(false);
  });

  test("returns false when a pet dir has only an empty spritesheet", async () => {
    mkdirSync(join(petsDir(), "ghost"), { recursive: true });
    writeFileSync(join(petsDir(), "ghost", "spritesheet.webp"), "");
    expect(await _hasAnyInstalledPetForTest()).toBe(false);
  });

  test("returns false when the only spritesheet exceeds MAX_PET_BYTES", async () => {
    // 16 MiB cap; a 17 MiB sprite is treated as "no usable pet" so
    // the CLI knows to install a starter rather than relying on a
    // file the desktop will refuse to load.
    mkdirSync(join(petsDir(), "huge"), { recursive: true });
    const oversize = 16 * 1024 * 1024 + 1;
    writeFileSync(
      join(petsDir(), "huge", "spritesheet.webp"),
      Buffer.alloc(oversize, 0),
    );
    expect(await _hasAnyInstalledPetForTest()).toBe(false);
  });

  test("returns true when a usable webp exists", async () => {
    mkdirSync(join(petsDir(), "boba"), { recursive: true });
    writeFileSync(
      join(petsDir(), "boba", "spritesheet.webp"),
      Buffer.from("WEBP-SMALL"),
    );
    expect(await _hasAnyInstalledPetForTest()).toBe(true);
  });

  test("returns true when a usable png exists", async () => {
    mkdirSync(join(petsDir(), "boba"), { recursive: true });
    writeFileSync(
      join(petsDir(), "boba", "spritesheet.png"),
      Buffer.from("PNG-SMALL"),
    );
    expect(await _hasAnyInstalledPetForTest()).toBe(true);
  });

  test("returns true if at least one pet is usable, ignoring oversized siblings", async () => {
    mkdirSync(join(petsDir(), "huge"), { recursive: true });
    writeFileSync(
      join(petsDir(), "huge", "spritesheet.webp"),
      Buffer.alloc(16 * 1024 * 1024 + 1, 0),
    );
    mkdirSync(join(petsDir(), "small"), { recursive: true });
    writeFileSync(
      join(petsDir(), "small", "spritesheet.webp"),
      Buffer.from("OK"),
    );
    expect(await _hasAnyInstalledPetForTest()).toBe(true);
  });
});

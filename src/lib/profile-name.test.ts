import { expect, test } from "bun:test";

test("saved profile names reach header, requests API and static page", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "./src/lib/profile-name.integration.tsx",
      "--timeout",
      "30000",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PETDEX_MOCK: "1",
        DATABASE_URL: "postgres://test:test@profile-tests.invalid/test",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({
    code: 0,
    output: "",
  });
  // The child allows each of its five tests 30s, so it can legitimately run
  // 150s plus a PGlite boot before any single test is over its own budget. A
  // wrapper shorter than that fails the spec on the harness rather than on the
  // work: the child would still be inside its limits when the wrapper cut it
  // off. Sized just above the child's worst case rather than to a round number,
  // so a failure here always means the child failed.
}, 180000);

import { expect, test } from "bun:test";

for (const driver of ["pglite", "neon"]) {
  test(`collection routes preserve data with ${driver}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "./src/lib/collection-write.integration.ts",
        "--timeout",
        "30000",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PETDEX_TEST_DB: driver,
          PETDEX_MOCK: driver === "pglite" ? "1" : "0",
          DATABASE_URL: "postgres://test:test@collection-tests.invalid/test",
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
  }, 60000);
}

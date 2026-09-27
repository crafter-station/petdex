import { expect, test } from "bun:test";

const suites = [
  "./src/app/api/profile/collection/route.integration.ts",
  "./src/app/api/profile/collections/[id]/route.integration.ts",
  "./src/app/api/cli/collections/route.integration.ts",
  "./src/app/api/cli/collections/[id]/route.integration.ts",
  "./src/lib/takedown-paths.integration.ts",
];

for (const suite of suites) {
  test(suite, async () => {
    const child = Bun.spawn(
      [process.execPath, "test", suite, "--timeout", "60000"],
      {
        cwd: process.cwd(),
        env: process.env,
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
  }, 90000);
}

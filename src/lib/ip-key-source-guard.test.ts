import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every rate limiter that keys on an address must go through
// `publicTrafficGuardKey`, which prefers the platform-set `x-real-ip` over a
// client-supplied `x-forwarded-for`. A route that reads the header itself can
// hand itself a fresh bucket per request just by rotating the header — the
// pre-auth `cliVerifyRatelimit` gate on the CLI submit/edit paths was the
// worst instance: twelve routes each had their own local copy of the raw
// parse, and one feedback route had already been converted while the rest
// silently kept the spoofable form.
//
// This is a source guard, the same shape as `locale-redirect.test.ts`: an
// integration suite per route would need a stubbed limiter and a Request per
// file, while the defect was always the two-line helper being copied around.
const SRC = join(import.meta.dir, "..");

const SELF = join(SRC, "lib", "public-traffic-guard.ts");

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectTsFiles(path, out);
    } else if (
      /\.tsx?$/.test(entry) &&
      !/\.(test|integration|spec)\.tsx?$/.test(entry)
    ) {
      out.push(path);
    }
  }
  return out;
}

describe("rate limit keys come from publicTrafficGuardKey", () => {
  test("no source file reads x-forwarded-for outside the guard helper", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SRC)) {
      if (file === SELF) continue;
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        // Comments may discuss the header freely; only real reads count.
        const code = line.replace(/\/\/.*$/, "");
        if (!code.includes('"x-forwarded-for"')) return;
        offenders.push(
          `${file.replace(SRC, "src")}:${index + 1}: ${line.trim()}`,
        );
      });
    }
    expect(
      offenders,
      "route-local x-forwarded-for parsing is spoofable — call " +
        "publicTrafficGuardKey(req.headers) from @/lib/public-traffic-guard " +
        "so x-real-ip wins",
    ).toEqual([]);
  });
});

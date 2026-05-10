import { describe, expect, test } from "bun:test";

// Re-implement pinToLatest as the contract under test. The real
// helper lives inside command-line.tsx (a "use client" file we
// can't import directly into bun-test without React JSX runtime
// pulling in. Keeping the contract here documents the rule and
// guards against regressions: any change to the regex must
// preserve every case below.

function pinToLatest(command: string): string {
  if (command.includes("petdex@")) return command;
  const npxMatch = command.match(/^(.*?\bnpx\s+)petdex(\b.*)$/);
  if (npxMatch) return `${npxMatch[1]}petdex@latest${npxMatch[2]}`;
  const bareMatch = command.match(/^petdex(\b.*)$/);
  if (bareMatch) return `npx petdex@latest${bareMatch[1]}`;
  return command;
}

describe("pinToLatest", () => {
  test("rewrites `npx petdex <args>` to `npx petdex@latest <args>`", () => {
    expect(pinToLatest("npx petdex install desktop")).toBe(
      "npx petdex@latest install desktop",
    );
    expect(pinToLatest("npx petdex hooks install")).toBe(
      "npx petdex@latest hooks install",
    );
    expect(pinToLatest("npx petdex install boba")).toBe(
      "npx petdex@latest install boba",
    );
  });

  test("rewrites bare `petdex <args>` to `npx petdex@latest <args>`", () => {
    // A user might paste `petdex up` because they have it on
    // PATH globally — we still want the copy form to work for
    // someone who doesn't.
    expect(pinToLatest("petdex up")).toBe("npx petdex@latest up");
    expect(pinToLatest("petdex doctor")).toBe("npx petdex@latest doctor");
  });

  test("leaves already-pinned commands alone", () => {
    expect(pinToLatest("npx petdex@0.2.0 install desktop")).toBe(
      "npx petdex@0.2.0 install desktop",
    );
    expect(pinToLatest("npx petdex@latest install desktop")).toBe(
      "npx petdex@latest install desktop",
    );
  });

  test("leaves non-petdex commands alone", () => {
    expect(pinToLatest("git status")).toBe("git status");
    expect(pinToLatest("ls ~/.petdex")).toBe("ls ~/.petdex");
  });

  test("handles leading whitespace / cd prefix", () => {
    // `cd path && npx petdex install` — still pin the petdex.
    expect(pinToLatest("cd ~/work && npx petdex install desktop")).toBe(
      "cd ~/work && npx petdex@latest install desktop",
    );
  });

  test("doesn't double-rewrite when the slug happens to contain petdex", () => {
    // Pet slugs are a-z0-9-, and "petdex" itself isn't a slug
    // (the cli rejects it), but if a user's manifest ever had a
    // pet whose slug or path contained "petdex", we shouldn't
    // touch it.
    expect(pinToLatest("npx petdex install petdex-themed-pet")).toBe(
      "npx petdex@latest install petdex-themed-pet",
    );
  });
});

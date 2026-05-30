import { describe, expect, test } from "bun:test";

import { AGENTS } from "./agents";
import { shouldInstallSlashCommand } from "./install";

describe("hooks install slash command selection", () => {
  test("does not install Gemini slash command when Antigravity is selected", () => {
    const gemini = AGENTS.find((a) => a.id === "gemini");
    if (!gemini) throw new Error("gemini agent missing from registry");

    expect(
      shouldInstallSlashCommand(gemini, new Set(["gemini", "antigravity"])),
    ).toBe(false);
  });

  test("keeps Gemini slash command when Antigravity is not selected", () => {
    const gemini = AGENTS.find((a) => a.id === "gemini");
    if (!gemini) throw new Error("gemini agent missing from registry");

    expect(shouldInstallSlashCommand(gemini, new Set(["gemini"]))).toBe(true);
  });
});

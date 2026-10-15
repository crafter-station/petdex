import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./profile-pinning-surface.tsx", import.meta.url),
  "utf8",
);

// The non-owner view of the pinned section. The owner's grid
// (`pinned-reorder-grid.tsx`) already read `pinnedReorder.heading` and
// `pinnedReorder.count` — both present in all three locales — but this file
// kept the literals, so /es and /zh visitors read "★ Pinned" and "1 of 6",
// and a screen reader heard "<name> animated" under a translated page.
describe("profile pinning surface labels", () => {
  test("the pinned header and count come from messages", () => {
    expect(source).not.toContain("★ Pinned");
    expect(source).not.toMatch(/\}\s*of\s*\{MAX_PINNED_PETS\}/);
    expect(source).toContain('tPinned("heading")');
    expect(source).toContain('tPinned("count"');
  });

  test("the animated sprite's accessible name is not English prose", () => {
    expect(source).not.toMatch(/`\$\{[^}]+\} animated`/);
    expect(source).toContain('tGallery("spriteAnimated"');
  });
});

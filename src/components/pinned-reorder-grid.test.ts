import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./pinned-reorder-grid.tsx", import.meta.url),
  "utf8",
);

describe("PinnedReorderGrid behavior contract", () => {
  it("uses pointer events for desktop and touch drag", () => {
    expect(source).toContain("onPointerDown");
    expect(source).toContain("onPointerMove");
    expect(source).toContain("onPointerUp");
    expect(source).toContain("touch-none");
  });

  it("keeps reorder changes auto-saved instead of using an explicit save step", () => {
    expect(source).toContain("Drops are saved automatically.");
    expect(source).toContain("Done");
    expect(source).not.toContain("Click Save");
    expect(source).not.toContain(">Save<");
  });

  it("keeps failure recovery visible", () => {
    expect(source).toContain("Could not save order");
    expect(source).toContain("Retry");
    expect(source).toContain("Restore saved order");
  });
});

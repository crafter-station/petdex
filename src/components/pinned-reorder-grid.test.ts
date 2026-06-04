import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./pinned-reorder-grid.tsx", import.meta.url),
  "utf8",
);

describe("PinnedReorderGrid behavior contract", () => {
  it("uses dnd-kit sensors for desktop, touch, and keyboard drag", () => {
    expect(source).toContain("PointerSensor");
    expect(source).toContain("KeyboardSensor");
    expect(source).toContain("DragOverlay");
    expect(source).toContain("touch-none");
  });

  it("keeps reorder changes auto-saved instead of using an explicit save step", () => {
    expect(source).toContain("Changes save when you drop.");
    expect(source).not.toContain("Click Save");
    expect(source).not.toContain(">Reorder<");
    expect(source).not.toContain("Done");
    expect(source).not.toContain(">Save<");
  });

  it("clears the transient saved state after showing success feedback", () => {
    expect(source).toContain('saveState !== "saved"');
    expect(source).toContain("window.setTimeout");
    expect(source).toContain('current === "saved" ? "idle" : current');
    expect(source).toContain("window.clearTimeout");
  });

  it("keeps failure recovery visible", () => {
    expect(source).toContain('useTranslations("pinnedReorder")');
    expect(source).toContain('t("saveError", { error })');
    expect(source).toContain("Retry");
    expect(source).toContain("Restore saved order");
  });
});

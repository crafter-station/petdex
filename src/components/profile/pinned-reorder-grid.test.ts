import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import en from "@/i18n/messages/en.json";

const source = readFileSync(
  new URL("./pinned-reorder-grid.tsx", import.meta.url),
  "utf8",
);

// The contract is about behaviour, not the English copy: the component
// localizes its recovery strings, so the assertions read the keys and
// check en.json for them rather than grepping the .tsx for words that
// translation would move out from under the test.
describe("PinnedReorderGrid behavior contract", () => {
  it("uses dnd-kit sensors for desktop, touch, and keyboard drag", () => {
    expect(source).toContain("PointerSensor");
    expect(source).toContain("KeyboardSensor");
    expect(source).toContain("DragOverlay");
    expect(source).toContain("touch-none");
  });

  it("keeps reorder changes auto-saved instead of using an explicit save step", () => {
    // The hint that used to read "Changes save when you drop." is a message.
    expect(en.pinnedReorder.dragHint).toContain("save");
    // No explicit-save affordance, whatever the locale calls it.
    expect(source).not.toContain("Click Save");
    expect(source).not.toContain(">Reorder<");
    expect(source).not.toMatch(/>Done</);
    expect(source).not.toMatch(/>Save</);
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
    expect(source).toContain('t("retry")');
    expect(source).toContain('t("restore")');
    expect(en.pinnedReorder.retry).toBeTruthy();
    expect(en.pinnedReorder.restore).toBeTruthy();
    expect(en.pinnedReorder.saveError).toContain("{error}");
  });

  it("maps known save codes to a localized message, not the raw code", () => {
    // The sibling gallery-reorder-grid maps /api/profile's codes through
    // ERROR_KEYS; this grid used to interpolate the raw code into the
    // sentence, so a failure read "Could not save order:
    // pet_not_owned_or_not_approved". The raw code stays only as the
    // unknown-code fallback.
    expect(source).toContain("ERROR_KEYS");
    expect(source).toMatch(/t\(`errors\.\$\{ERROR_KEYS\[error\]\}`\)/);
    // Every code the PATCH route can return for this call is mapped.
    for (const code of [
      "unauthorized",
      "rate_limited",
      "invalid_featured",
      "pet_not_owned_or_not_approved",
      "pin_cap_reached",
    ]) {
      expect(source).toContain(`${code}:`);
    }
    // Every key ERROR_KEYS maps to exists in the catalogue, so the render
    // (t(`errors.${ERROR_KEYS[error]}`)) cannot fall through to a missing-key
    // error. Iterating the catalogue instead would pass even if ERROR_KEYS
    // pointed at a key that is not in it — which is the failure this guards.
    const mapped = source.match(
      /ERROR_KEYS: Record<string, string> = \{([^}]*)\}/,
    );
    const keys = [...(mapped?.[1] ?? "").matchAll(/:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(en.pinnedReorder.errors[key]).toBeTruthy();
    }
  });
});

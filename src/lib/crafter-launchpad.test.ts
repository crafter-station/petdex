import { describe, expect, test } from "bun:test";

import {
  CRAFTER_LAUNCHPAD_APPS,
  type CrafterLaunchpadApp,
  getActiveLaunchpadDrops,
  getFeaturedLaunchpadDrop,
  getLaunchpadDismissKey,
} from "@/lib/crafter-launchpad";

describe("crafter-launchpad", () => {
  test("declares the canonical Crafter Station apps with unique IDs", () => {
    const ids = CRAFTER_LAUNCHPAD_APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["crafter-run", "ui-sdk", "hack0", "wterm"]);
  });

  test("every app has a valid HTTPS URL and non-empty metadata", () => {
    for (const app of CRAFTER_LAUNCHPAD_APPS) {
      const parsed = new URL(app.url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname.length).toBeGreaterThan(0);
      expect(app.name.trim().length).toBeGreaterThan(0);
      expect(app.tagline.trim().length).toBeGreaterThan(0);
      expect(app.badge.trim().length).toBeGreaterThan(0);
    }
  });

  test("getActiveLaunchpadDrops filters to active apps only", () => {
    const active = getActiveLaunchpadDrops();
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((app) => app.active)).toBe(true);

    const mixed: CrafterLaunchpadApp[] = [
      {
        id: "inactive-one",
        name: "Inactive",
        tagline: "Hidden drop",
        url: "https://example.com/inactive",
        badge: "Hidden",
        active: false,
      },
      {
        id: "active-one",
        name: "Active",
        tagline: "Visible drop",
        url: "https://example.com/active",
        badge: "Live",
        active: true,
        crossPetSlug: "boba",
      },
    ];

    expect(getActiveLaunchpadDrops(mixed).map((app) => app.id)).toEqual([
      "active-one",
    ]);
  });

  test("getFeaturedLaunchpadDrop returns the first active drop or null", () => {
    const featured = getFeaturedLaunchpadDrop();
    expect(featured).not.toBeNull();
    expect(featured?.id).toBe("crafter-run");
    expect(featured?.crossPetSlug).toBe("boba");

    const allInactive: CrafterLaunchpadApp[] = CRAFTER_LAUNCHPAD_APPS.map(
      (app) => ({ ...app, active: false }),
    );
    expect(getFeaturedLaunchpadDrop(allInactive)).toBeNull();
  });

  test("getLaunchpadDismissKey builds the localStorage key format", () => {
    expect(getLaunchpadDismissKey("crafter-run")).toBe(
      "petdex:launchpad:dismissed:crafter-run",
    );
  });
});

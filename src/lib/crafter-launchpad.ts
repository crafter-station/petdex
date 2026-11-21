export interface CrafterLaunchpadApp {
  id: string;
  name: string;
  tagline: string;
  url: string;
  badge: string;
  active: boolean;
  crossPetSlug?: string;
}

export const LAUNCHPAD_DISMISS_PREFIX = "petdex:launchpad:dismissed:";

export const CRAFTER_LAUNCHPAD_APPS: readonly CrafterLaunchpadApp[] = [
  {
    id: "crafter-run",
    name: "Crafter Station",
    tagline:
      "Open-source developer tools, AI apps, and playful software crafted in Peru.",
    url: "https://crafter.run",
    badge: "Ecosystem",
    active: true,
    crossPetSlug: "boba",
  },
  {
    id: "ui-sdk",
    name: "ui-sdk",
    tagline:
      "Accessible React primitives and composable design-system blocks powering Petdex.",
    url: "https://ui-sdk.dev",
    badge: "React UI",
    active: true,
    crossPetSlug: "mallow",
  },
  {
    id: "hack0",
    name: "hack0",
    tagline:
      "Discover, organize, and ship at hackathons across Latin America and beyond.",
    url: "https://hack0.dev",
    badge: "Hackathons",
    active: true,
  },
  {
    id: "wterm",
    name: "wterm",
    tagline:
      "Fast, scriptable web terminal built for modern coding and agent workflows.",
    url: "https://wterm.dev",
    badge: "Terminal",
    active: true,
  },
] as const;

export function getActiveLaunchpadDrops(
  apps: readonly CrafterLaunchpadApp[] = CRAFTER_LAUNCHPAD_APPS,
): CrafterLaunchpadApp[] {
  return apps.filter((app) => app.active);
}

export function getFeaturedLaunchpadDrop(
  apps: readonly CrafterLaunchpadApp[] = CRAFTER_LAUNCHPAD_APPS,
): CrafterLaunchpadApp | null {
  return getActiveLaunchpadDrops(apps)[0] ?? null;
}

export function getLaunchpadDismissKey(id: string): string {
  return `${LAUNCHPAD_DISMISS_PREFIX}${id}`;
}
